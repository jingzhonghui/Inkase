import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MockOpenAiServer } from './mock-openai-server'
import {
  AiProviderError,
  VercelAiSdkProvider,
  mapProviderError,
  type AiProviderEvent,
  type LlmRunInput,
  type ProviderTool
} from '../provider'
import type { AiRuntimeConfig } from '../../../shared/ai/types'

const TEXT_SSE = [
  '{"choices":[{"delta":{"content":"你"}}]}',
  '{"choices":[{"delta":{"content":"好"}}]}'
]

function config(baseUrl: string): AiRuntimeConfig {
  return { baseUrl, model: 'test-model', apiKey: 'test-key', temperature: 0 }
}

function runInput(baseUrl: string, overrides: Partial<LlmRunInput> = {}): LlmRunInput {
  return {
    config: config(baseUrl),
    system: '你是一个助手。',
    messages: [{ id: 'm1', role: 'user', content: '你好' }],
    tools: {},
    maxSteps: 1,
    abortSignal: new AbortController().signal,
    ...overrides
  }
}

async function collect(iterable: AsyncIterable<AiProviderEvent>): Promise<AiProviderEvent[]> {
  const events: AiProviderEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('VercelAiSdkProvider', () => {
  let server: MockOpenAiServer

  afterEach(async () => {
    await server.stop()
  })

  describe('run', () => {
    it('streams text deltas then completes', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({ sseEvents: TEXT_SSE })
      const provider = new VercelAiSdkProvider()

      const events = await collect(provider.run(runInput(baseUrl)))

      expect(events).toEqual([
        { type: 'text-delta', text: '你' },
        { type: 'text-delta', text: '好' },
        { type: 'completed' }
      ])
    })

    it('emits tool call started and completed events', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          if (server.requestCount === 1) {
            res.write(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\":\\"北京\\"}"}}]}}]}\n\n'
            )
            res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
          } else {
            res.write('data: {"choices":[{"delta":{"content":"晴"},"finish_reason":"stop"}]}\n\n')
          }
          res.write('data: [DONE]\n\n')
          res.end()
        }
      })
      const weatherTool: ProviderTool = {
        description: '获取指定城市的天气',
        inputSchema: z.object({ city: z.string() }),
        execute: async () => ({ status: 'completed', data: { temperature: 25 } })
      }
      const provider = new VercelAiSdkProvider()

      const events = await collect(
        provider.run(runInput(baseUrl, { tools: { get_weather: weatherTool }, maxSteps: 2 }))
      )

      expect(events).toEqual([
        { type: 'tool-call-started', toolCallId: 'call_1', toolName: 'get_weather' },
        {
          type: 'tool-call-completed',
          toolCallId: 'call_1',
          result: { status: 'completed', data: { temperature: 25 } }
        },
        { type: 'text-delta', text: '晴' },
        { type: 'completed' }
      ])
    })

    it('reports TOOL_LIMIT_REACHED when the last allowed step ends with tool calls', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        sseEvents: [
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{}"}}]}}]}',
          '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'
        ]
      })
      const provider = new VercelAiSdkProvider()
      const weatherTool: ProviderTool = {
        description: 'weather',
        inputSchema: z.object({}),
        execute: async () => ({ status: 'completed' })
      }

      await expect(
        collect(
          provider.run(runInput(baseUrl, { tools: { get_weather: weatherTool }, maxSteps: 1 }))
        )
      ).rejects.toMatchObject({ code: 'TOOL_LIMIT_REACHED' })
    })

    it('maps 401 to AUTH_FAILED', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        status: 401,
        body: JSON.stringify({ error: { message: 'Invalid API key' } })
      })
      const provider = new VercelAiSdkProvider({ maxRetries: 0 })

      await expect(collect(provider.run(runInput(baseUrl)))).rejects.toMatchObject({
        code: 'AUTH_FAILED'
      })
    })

    it('maps 404 to MODEL_NOT_FOUND', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        status: 404,
        body: JSON.stringify({ error: { message: 'Model not found' } })
      })
      const provider = new VercelAiSdkProvider({ maxRetries: 0 })

      await expect(collect(provider.run(runInput(baseUrl)))).rejects.toMatchObject({
        code: 'MODEL_NOT_FOUND'
      })
    })

    it('maps 429 to RATE_LIMITED', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        status: 429,
        body: JSON.stringify({ error: { message: 'Too many requests' } })
      })
      const provider = new VercelAiSdkProvider({ maxRetries: 0 })

      await expect(collect(provider.run(runInput(baseUrl)))).rejects.toMatchObject({
        code: 'RATE_LIMITED'
      })
    })

    it('maps 500 to PROVIDER_UNAVAILABLE', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        status: 500,
        body: JSON.stringify({ error: { message: 'Internal server error' } })
      })
      const provider = new VercelAiSdkProvider({ maxRetries: 0 })

      await expect(collect(provider.run(runInput(baseUrl)))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE'
      })
    })

    it('maps malformed SSE to STREAM_INVALID', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        rawBody: 'data: {not valid json\n\n',
        headers: { 'Content-Type': 'text/event-stream' }
      })
      const provider = new VercelAiSdkProvider({ maxRetries: 0 })

      await expect(collect(provider.run(runInput(baseUrl)))).rejects.toMatchObject({
        code: 'STREAM_INVALID'
      })
    })

    it('retries 429/5xx up to maxRetries before streaming begins', async () => {
      server = new MockOpenAiServer()
      let calls = 0
      const baseUrl = await server.start({
        handler: (_req, res) => {
          calls++
          if (calls <= 2) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'transient' } }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
        }
      })
      const provider = new VercelAiSdkProvider({ maxRetries: 2 })

      const events = await collect(provider.run(runInput(baseUrl)))

      expect(events).toEqual([{ type: 'text-delta', text: 'ok' }, { type: 'completed' }])
      expect(server.requestCount).toBe(3)
    })

    it('times out when no first event arrives', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        handler: () => {
          // never respond; the first-event timeout should fire
        }
      })
      const provider = new VercelAiSdkProvider({ maxRetries: 0, firstEventTimeoutMs: 50 })

      await expect(collect(provider.run(runInput(baseUrl)))).rejects.toMatchObject({
        code: 'REQUEST_TIMEOUT'
      })
    })

    /*
     * 复杂任务的关键语义：超时按「模型空闲」算，不按墙钟算。
     * 工具执行（含等用户审批）期间模型确实没有输出，但那是任务在推进，不是卡死。
     */
    it('does not abort while a tool is still running', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          if (server.requestCount === 1) {
            res.write(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_slow","function":{"name":"slow_tool","arguments":"{}"}}]}}]}\n\n'
            )
            res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
          } else {
            res.write('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\n')
          }
          res.write('data: [DONE]\n\n')
          res.end()
        }
      })
      const slowTool: ProviderTool = {
        description: '耗时工具',
        inputSchema: z.object({}),
        execute: async () => {
          // 比空闲超时长得多：若按墙钟计时，这里就会被判超时
          await new Promise((resolve) => setTimeout(resolve, 300))
          return { status: 'completed', data: { ok: true } }
        }
      }
      const provider = new VercelAiSdkProvider({ maxRetries: 0, idleTimeoutMs: 80 })

      const events = await collect(
        provider.run(runInput(baseUrl, { tools: { slow_tool: slowTool }, maxSteps: 2 }))
      )

      expect(events.at(-1)).toEqual({ type: 'completed' })
      expect(events.some((event) => event.type === 'tool-call-completed')).toBe(true)
    })

    it('aborts when the stream goes idle after activity', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          // 先给一段正文证明「模型活着」，然后挂住不再发送
          res.write('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n')
        }
      })
      const provider = new VercelAiSdkProvider({ maxRetries: 0, idleTimeoutMs: 80 })

      await expect(collect(provider.run(runInput(baseUrl)))).rejects.toMatchObject({
        code: 'REQUEST_TIMEOUT'
      })
    })
  })

  describe('testConnection', () => {
    it('reports text generation and tool calling from the probe', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        body: JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_probe',
                    function: { name: 'markdown_plus_capability_probe', arguments: '{}' }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        })
      })
      const provider = new VercelAiSdkProvider()

      await expect(provider.testConnection(config(baseUrl))).resolves.toEqual({
        textGeneration: true,
        toolCalling: true
      })
    })

    it('throws a mapped error when the endpoint is unreachable', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        status: 401,
        body: JSON.stringify({ error: { message: 'bad key' } })
      })
      const provider = new VercelAiSdkProvider()

      await expect(provider.testConnection(config(baseUrl))).rejects.toMatchObject({
        code: 'AUTH_FAILED'
      })
    })
  })

  describe('summarize', () => {
    it('returns the trimmed text of a single chat completion', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        body: JSON.stringify({
          id: 'chatcmpl-1',
          model: 'test-model',
          created: 1,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '  文档主题  ' },
            finish_reason: 'stop'
          }]
        })
      })
      const provider = new VercelAiSdkProvider()

      const title = await provider.summarize(config(baseUrl), '请总结这份文档')

      expect(title).toBe('文档主题')
      expect(server.requestCount).toBe(1)
    })

    it('maps provider errors through AiProviderError', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({ status: 401 })
      const provider = new VercelAiSdkProvider()

      await expect(provider.summarize(config(baseUrl), 'x')).rejects.toMatchObject({
        code: 'AUTH_FAILED'
      })
    })
  })

  describe('generateText', () => {
    it('returns the full generated text with the given system prompt', async () => {
      server = new MockOpenAiServer()
      const baseUrl = await server.start({
        body: JSON.stringify({
          id: 'chatcmpl-1',
          model: 'test-model',
          created: 1,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '该工作区是云原生运维知识库。' },
            finish_reason: 'stop'
          }]
        })
      })
      const provider = new VercelAiSdkProvider()

      const text = await provider.generateText(
        config(baseUrl),
        '你是工作区概要助手',
        'docs/k8s.md\nREADME.md',
        1200
      )

      expect(text).toBe('该工作区是云原生运维知识库。')
      expect(server.requestCount).toBe(1)
    })
  })

  describe('mapProviderError', () => {
    it('unwraps an existing provider error', () => {
      const mapped = mapProviderError(new AiProviderError('AUTH_FAILED', '鉴权失败'))
      expect(mapped).toEqual({ code: 'AUTH_FAILED', message: '鉴权失败' })
    })

    it('maps an abort error to RUN_CANCELLED', () => {
      const mapped = mapProviderError(new DOMException('The operation was aborted', 'AbortError'))
      expect(mapped).toEqual({ code: 'RUN_CANCELLED', message: '运行已取消' })
    })
  })
})
