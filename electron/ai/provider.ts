import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { getErrorMessage, isAbortError } from '@ai-sdk/provider-utils'
import {
  APICallError,
  generateText,
  stepCountIs,
  streamText,
  tool,
  type FlexibleSchema,
  type LanguageModel,
  type ModelMessage,
  type ToolSet
} from 'ai'
import { z } from 'zod'
import type {
  AiConnectionTestResult,
  AiConversationMessage,
  AiError,
  AiErrorCode,
  AiRuntimeConfig,
  ToolExecutionResult
} from '../../shared/ai/types'
import { CONVERSATION_TITLE_SYSTEM_PROMPT, CAPABILITY_PROBE_SYSTEM_PROMPT } from './prompts'

export interface LlmRunInput {
  config: AiRuntimeConfig
  system: string
  messages: AiConversationMessage[]
  tools: Record<string, ProviderTool>
  maxSteps: number
  abortSignal: AbortSignal
}

export interface ProviderTool {
  description: string
  inputSchema: z.ZodType
  execute(
    input: unknown,
    options?: { toolCallId: string; abortSignal?: AbortSignal }
  ): Promise<ToolExecutionResult>
}

export type AiProviderEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-started'; toolCallId: string; toolName: string }
  | { type: 'tool-call-completed'; toolCallId: string; result: ToolExecutionResult }
  | { type: 'completed' }

export interface LlmProvider {
  run(input: LlmRunInput): AsyncIterable<AiProviderEvent>
  testConnection(config: AiRuntimeConfig): Promise<AiConnectionTestResult>
  summarize(config: AiRuntimeConfig, text: string): Promise<string>
}

export interface ProviderOptions {
  firstEventTimeoutMs?: number
  totalTimeoutMs?: number
  maxRetries?: number
}

export class AiProviderError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AiProviderError'
  }
}

class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderTimeoutError'
  }
}

const CAPABILITY_PROBE_TOOL = 'markdown_plus_capability_probe'

function isRetryableHttpError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false
  const status = error.statusCode
  return status === 429 || (status !== undefined && status >= 500)
}

export function mapProviderError(error: unknown): AiError {
  if (error instanceof AiProviderError) {
    return { code: error.code, message: error.message }
  }

  if (error instanceof ProviderTimeoutError) {
    return { code: 'REQUEST_TIMEOUT', message: '请求超时：AI 服务长时间无响应' }
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode
    if (status === 401) return { code: 'AUTH_FAILED', message: '鉴权失败：API Key 无效或未授权' }
    if (status === 404)
      return { code: 'MODEL_NOT_FOUND', message: '模型不存在：请检查模型名称配置' }
    if (status === 429) return { code: 'RATE_LIMITED', message: '请求过于频繁：已触发速率限制' }
    if (status === 400) {
      const message = error.message.toLowerCase()
      if (message.includes('tool')) {
        return { code: 'TOOLS_NOT_SUPPORTED', message: 'AI 服务不支持工具调用' }
      }
      return { code: 'TOOL_INPUT_INVALID', message: error.message }
    }
    if (status !== undefined && status >= 500) {
      return { code: 'PROVIDER_UNAVAILABLE', message: 'AI 服务暂时不可用：服务器错误' }
    }
    return { code: 'PROVIDER_UNAVAILABLE', message: '无法连接到 AI 服务' }
  }

  if (isAbortError(error)) {
    return { code: 'RUN_CANCELLED', message: '运行已取消' }
  }

  return {
    code: 'STREAM_INVALID',
    message: getErrorMessage(error) || 'AI 服务返回了无法解析的数据流'
  }
}

function toSdkMessages(messages: AiConversationMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId ?? '',
            toolName: message.toolName ?? '',
            output: { type: 'json', value: message.content }
          }
        ]
      }
    }
    return { role: message.role, content: message.content }
  })
}

function toSdkTools(tools: Record<string, ProviderTool>): ToolSet {
  const result: Record<string, unknown> = {}
  for (const [name, providerTool] of Object.entries(tools)) {
    result[name] = tool({
      description: providerTool.description,
      inputSchema: providerTool.inputSchema as unknown as FlexibleSchema<unknown>,
      execute: async (input: unknown, options) => providerTool.execute(input, options)
    })
  }
  return result as unknown as ToolSet
}

export class VercelAiSdkProvider implements LlmProvider {
  private readonly firstEventTimeoutMs: number
  private readonly totalTimeoutMs: number
  private readonly maxRetries: number

  constructor(options: ProviderOptions = {}) {
    this.firstEventTimeoutMs = options.firstEventTimeoutMs ?? 30_000
    this.totalTimeoutMs = options.totalTimeoutMs ?? 5 * 60_000
    this.maxRetries = options.maxRetries ?? 2
  }

  async *run(input: LlmRunInput): AsyncIterable<AiProviderEvent> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (input.abortSignal.aborted) {
      onAbort()
    } else {
      input.abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    const totalTimer = setTimeout(
      () => controller.abort(new ProviderTimeoutError('总运行超时')),
      this.totalTimeoutMs
    )
    let firstEventTimer: ReturnType<typeof setTimeout> | undefined

    const clearTimers = (): void => {
      clearTimeout(totalTimer)
      if (firstEventTimer) clearTimeout(firstEventTimer)
      input.abortSignal.removeEventListener('abort', onAbort)
    }

    const model = this.createModel(input.config)
    const sdkTools = toSdkTools(input.tools)
    const sdkMessages = toSdkMessages(input.messages)

    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        let emitted = false
        let finishReason: string | undefined
        try {
          firstEventTimer = setTimeout(
            () => controller.abort(new ProviderTimeoutError('首个事件超时')),
            this.firstEventTimeoutMs
          )

          const result = streamText({
            model,
            system: input.system,
            messages: sdkMessages,
            tools: sdkTools,
            maxOutputTokens: input.config.maxOutputTokens,
            temperature: input.config.temperature,
            stopWhen: stepCountIs(input.maxSteps),
            maxRetries: 0,
            abortSignal: controller.signal,
            onError: () => {}
          })

          for await (const part of result.fullStream) {
            if (part.type === 'error') {
              throw part.error
            }
            if (part.type === 'abort') {
              const reason: unknown = controller.signal.reason
              throw reason instanceof Error ? reason : new Error('运行已中止')
            }
            if (part.type === 'text-delta') {
              emitted = true
              if (firstEventTimer) {
                clearTimeout(firstEventTimer)
                firstEventTimer = undefined
              }
              yield { type: 'text-delta', text: part.text }
            } else if (part.type === 'tool-call') {
              emitted = true
              if (firstEventTimer) {
                clearTimeout(firstEventTimer)
                firstEventTimer = undefined
              }
              yield {
                type: 'tool-call-started',
                toolCallId: part.toolCallId,
                toolName: part.toolName
              }
            } else if (part.type === 'tool-result') {
              emitted = true
              if (firstEventTimer) {
                clearTimeout(firstEventTimer)
                firstEventTimer = undefined
              }
              yield {
                type: 'tool-call-completed',
                toolCallId: part.toolCallId,
                result: part.output as ToolExecutionResult
              }
            } else if (part.type === 'finish') {
              finishReason = part.finishReason
            }
          }

          if (finishReason === 'tool-calls') {
            throw new AiProviderError('TOOL_LIMIT_REACHED', '工具步骤达到上限，任务过于复杂')
          }
          yield { type: 'completed' }
          return
        } catch (error) {
          if (emitted || !isRetryableHttpError(error) || attempt === this.maxRetries) {
            throw this.toProviderError(error)
          }
        } finally {
          if (firstEventTimer) {
            clearTimeout(firstEventTimer)
            firstEventTimer = undefined
          }
        }
      }
    } finally {
      clearTimers()
    }

    throw this.toProviderError(new Error('未知的 AI 服务错误'))
  }

  async testConnection(config: AiRuntimeConfig): Promise<AiConnectionTestResult> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new ProviderTimeoutError('能力测试超时')),
      this.totalTimeoutMs
    )

    try {
      const model = this.createModel(config)
      const result = await generateText({
        model,
        system: CAPABILITY_PROBE_SYSTEM_PROMPT,
        prompt: '请调用能力探测工具。',
        tools: {
          [CAPABILITY_PROBE_TOOL]: tool({
            description: '探测 AI 服务是否支持工具调用',
            inputSchema: z.object({}),
            execute: async () => ({ status: 'completed', data: { ok: true } })
          })
        },
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
        abortSignal: controller.signal
      })

      return {
        textGeneration: true,
        toolCalling: result.toolCalls.some((call) => call.toolName === CAPABILITY_PROBE_TOOL)
      }
    } catch (error) {
      throw this.toProviderError(error)
    } finally {
      clearTimeout(timer)
    }
  }

  async summarize(config: AiRuntimeConfig, text: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new ProviderTimeoutError('标题生成超时')),
      this.totalTimeoutMs
    )
    try {
      const model = this.createModel(config)
      const result = await generateText({
        model,
        system: CONVERSATION_TITLE_SYSTEM_PROMPT,
        prompt: text,
        temperature: 0.3,
        maxOutputTokens: 64,
        abortSignal: controller.signal
      })
      return result.text.trim()
    } catch (error) {
      throw this.toProviderError(error)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 一次性的通用文本生成（用于工作区概要等结构化输出，非标题截断）。
   */
  async generateText(
    config: AiRuntimeConfig,
    system: string,
    prompt: string,
    maxOutputTokens?: number
  ): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new ProviderTimeoutError('文本生成超时')),
      this.totalTimeoutMs
    )
    try {
      const model = this.createModel(config)
      const result = await generateText({
        model,
        system,
        prompt,
        temperature: 0.3,
        maxOutputTokens,
        abortSignal: controller.signal
      })
      return result.text.trim()
    } catch (error) {
      throw this.toProviderError(error)
    } finally {
      clearTimeout(timer)
    }
  }

  private createModel(config: AiRuntimeConfig): LanguageModel {
    return createOpenAICompatible({
      name: 'inkase',
      baseURL: config.baseUrl,
      apiKey: config.apiKey
    })(config.model)
  }

  private toProviderError(error: unknown): AiProviderError {
    if (error instanceof AiProviderError) return error
    const mapped = mapProviderError(error)
    return new AiProviderError(mapped.code, mapped.message)
  }
}
