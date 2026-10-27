import { randomUUID } from 'crypto'
import type {
  AiConversationMessage,
  AiRunEvent,
  AiRunInput,
  AiRuntimeConfig,
  ApprovalDecision,
  ApprovalPreview,
  ToolApprovalRequest,
  ToolExecutionResult
} from '../../shared/ai/types'
import {
  mapProviderError,
  type AiProviderEvent,
  type LlmProvider,
  type ProviderTool
} from './provider'
import { evaluateToolPolicy } from './policy-engine'
import { ApprovalManager } from './approval-manager'
import { ToolRegistry, type ToolExecutionContext, type ToolDefinition } from './tool-registry'
import type { SourceAccessService } from './source-access-service'
import type { WorkspaceSearchService } from '../workspace/workspace-search-service'
import { createSourceAuthorizationContext } from './source-authorization'
import { createDocumentTools } from './tools/document-tools'
import { createSourceAccessTools } from './tools/source-access-tools'
import { createTimeTools } from './tools/time-tools'
import { SYSTEM_PROMPT } from './prompts'

type AnyToolDefinition = ToolDefinition<any, unknown>

export interface AiRuntimeDeps {
  provider: LlmProvider
  registry: ToolRegistry
  approvalManager: ApprovalManager
  sourceAccessService: SourceAccessService
  searchService: WorkspaceSearchService
  config: AiRuntimeConfig
  maxSteps?: number
  toolTimeoutMs?: number
  approvalTimeoutMs?: number
}

interface ActiveRun {
  runId: string
  abort: AbortController
  toolCallCount: number
  failed: boolean
}

const TOOL_TIMEOUT_MESSAGE = '工具执行超时'

export class AiRuntime {
  private readonly provider: LlmProvider
  private readonly registry: ToolRegistry
  private readonly approvalManager: ApprovalManager
  private readonly config: AiRuntimeConfig
  private readonly systemPrompt: string
  private readonly maxSteps: number
  private readonly toolTimeoutMs: number
  private readonly approvalTimeoutMs: number

  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly pendingResults = new Map<string, (result: ToolExecutionResult) => void>()

  constructor(deps: AiRuntimeDeps) {
    this.provider = deps.provider
    this.registry = deps.registry
    this.approvalManager = deps.approvalManager
    this.config = deps.config
    this.systemPrompt = SYSTEM_PROMPT
    this.maxSteps = deps.maxSteps ?? 20
    this.toolTimeoutMs = deps.toolTimeoutMs ?? 60_000
    this.approvalTimeoutMs = deps.approvalTimeoutMs ?? 300_000

    this.registerTools(deps.sourceAccessService, deps.searchService)
  }

  private registerTools(
    sourceAccessService: SourceAccessService,
    searchService: WorkspaceSearchService
  ): void {
    const docTools = createDocumentTools(searchService)
    const sourceTools = createSourceAccessTools(sourceAccessService)
    const timeTools = createTimeTools()
    const all: AnyToolDefinition[] = [
      docTools.searchWorkspace,
      docTools.listWorkspaceRoot,
      docTools.readWorkspaceDirectory,
      docTools.readWorkspaceFile,
      docTools.readSelectedText,
      timeTools.getCurrentDatetime,
      sourceTools.readWebUrl,
      sourceTools.readLocalFile,
      docTools.replaceCurrentDocument,
      docTools.insertIntoCurrentDocument,
      docTools.createDocument,
      docTools.createMindmap,
      docTools.updateMindmap
    ]
    for (const def of all) {
      this.registry.register(def)
    }
  }

  start(input: AiRunInput, emit: (event: AiRunEvent) => void): Promise<{ runId: string }> {
    if (this.activeRuns.size > 0) {
      return Promise.reject(new Error('已有激活的 AI 运行'))
    }

    const runId = randomUUID()
    const abort = new AbortController()
    const run: ActiveRun = { runId, abort, toolCallCount: 0, failed: false }
    this.activeRuns.set(runId, run)

    const sourceAuthorization = createSourceAuthorizationContext(input)
    const context: ToolExecutionContext = Object.freeze({
      snapshot: input.snapshot,
      sourceAuthorization
    })
    const messages: AiConversationMessage[] = [
      ...input.history,
      { id: randomUUID(), role: 'user', content: input.message }
    ]
    const tools = this.buildProviderTools(context, run, emit)

    emit({ type: 'run-started', runId })

    void this.runLoop(run, messages, tools, emit).catch(() => {})
    return Promise.resolve({ runId })
  }

  private async runLoop(
    run: ActiveRun,
    messages: AiConversationMessage[],
    tools: Record<string, ProviderTool>,
    emit: (event: AiRunEvent) => void
  ): Promise<{ runId: string }> {
    const { runId, abort } = run
    try {
      const stream = this.provider.run({
        config: this.config,
        system: this.systemPrompt,
        messages,
        tools,
        maxSteps: this.maxSteps,
        abortSignal: abort.signal
      })

      for await (const event of stream) {
        this.dispatchProviderEvent(event, run, emit)
      }
    } catch (error) {
      if (run.failed) {
        // 已由 TOOL_LIMIT_REACHED 处理
      } else if (abort.signal.aborted) {
        emit({ type: 'run-cancelled', runId })
      } else {
        emit({ type: 'run-failed', runId, error: mapProviderError(error) })
      }
    } finally {
      this.approvalManager.cancelRun(runId)
      this.activeRuns.delete(runId)
    }
    return { runId }
  }

  private dispatchProviderEvent(
    event: AiProviderEvent,
    run: ActiveRun,
    emit: (event: AiRunEvent) => void
  ): void {
    const { runId } = run
    switch (event.type) {
      case 'text-delta':
        emit({ type: 'text-delta', runId, text: event.text })
        return
      case 'tool-call-started':
        run.toolCallCount += 1
        if (run.toolCallCount > this.maxSteps) {
          run.failed = true
          run.abort.abort()
          emit({
            type: 'run-failed',
            runId,
            error: { code: 'TOOL_LIMIT_REACHED', message: '工具步骤达到上限，任务过于复杂' }
          })
          return
        }
        emit({
          type: 'tool-call-started',
          runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName
        })
        return
      case 'tool-call-completed':
        emit({
          type: 'tool-call-completed',
          runId,
          toolCallId: event.toolCallId,
          result: event.result
        })
        return
      case 'completed':
        emit({ type: 'run-completed', runId })
        return
    }
  }

  private buildProviderTools(
    context: ToolExecutionContext,
    run: ActiveRun,
    emit: (event: AiRunEvent) => void
  ): Record<string, ProviderTool> {
    const tools: Record<string, ProviderTool> = {}
    for (const def of this.registry.all()) {
      tools[def.name] = {
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async (
          input: unknown,
          options?: { toolCallId: string; abortSignal?: AbortSignal }
        ): Promise<ToolExecutionResult> => {
          const parsed = def.inputSchema.safeParse(input)
          if (!parsed.success) {
            return { status: 'failed', message: `工具输入无效：${parsed.error.message}` }
          }
          const callAbort = this.createCallAbortController(run.abort.signal, options?.abortSignal)
          const callContext: ToolExecutionContext = {
            ...context,
            abortSignal: callAbort.controller.signal
          }
          try {
            return await this.executeWithPolicy(
              def,
              parsed.data,
              callContext,
              run,
              options?.toolCallId ?? '',
              emit,
              callAbort.controller
            )
          } catch (error) {
            if (error instanceof Error && error.message === TOOL_TIMEOUT_MESSAGE) {
              run.failed = true
              run.abort.abort()
              emit({
                type: 'run-failed',
                runId: run.runId,
                error: { code: 'REQUEST_TIMEOUT', message: '工具执行超时' }
              })
              throw error
            }
            return {
              status: 'failed',
              message: error instanceof Error ? error.message : '工具执行失败'
            }
          } finally {
            callAbort.cleanup()
          }
        }
      }
    }
    return tools
  }

  private async executeWithPolicy(
    def: AnyToolDefinition,
    input: unknown,
    context: ToolExecutionContext,
    run: ActiveRun,
    toolCallId: string,
    emit: (event: AiRunEvent) => void,
    callAbort: AbortController
  ): Promise<ToolExecutionResult> {
    const needsApproval = evaluateToolPolicy(def.policy)

    if (!needsApproval) {
      if (def.execution === 'main') {
        const data = await this.withTimeout(def.execute(input, context), this.toolTimeoutMs, () =>
          callAbort.abort(new Error(TOOL_TIMEOUT_MESSAGE))
        )
        return { status: 'completed', data }
      }
      const operation = await def.createRendererOperation(input, context)
      return { status: 'completed', data: operation }
    }

    const approvalId = randomUUID()
    const preview: ApprovalPreview = def.createApprovalPreview
      ? await def.createApprovalPreview(input, context)
      : { type: 'document', title: def.name, content: '' }

    let execution: ToolApprovalRequest['execution']
    if (def.execution === 'renderer') {
      const operation = await def.createRendererOperation(input, context)
      execution = { location: 'renderer', operation }
    } else {
      execution = { location: 'main' }
    }

    const reason =
      typeof input === 'object' && input !== null && 'reason' in input
        ? String((input as { reason?: unknown }).reason ?? '')
        : undefined

    const request: ToolApprovalRequest = {
      id: approvalId,
      runId: run.runId,
      toolCallId,
      toolName: def.name,
      title: def.name,
      description: def.description,
      reason: reason || undefined,
      effect: def.policy.effect,
      riskLevel: def.policy.riskLevel,
      preview,
      execution,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.approvalTimeoutMs
    }

    const decisionPromise = this.approvalManager.request(request, (req) => {
      emit({ type: 'approval-required', runId: run.runId, approval: req })
    })

    let resultPromise: Promise<ToolExecutionResult> | undefined
    if (def.execution === 'renderer') {
      resultPromise = new Promise<ToolExecutionResult>((resolve) => {
        this.pendingResults.set(approvalId, resolve)
      })
    }

    const decision = await decisionPromise

    if (decision.status !== 'approved') {
      this.pendingResults.delete(approvalId)
      if (decision.status === 'rejected') {
        return { status: 'rejected', message: decision.reason ?? '用户拒绝了该操作' }
      }
      return {
        status: 'cancelled',
        message: decision.status === 'expired' ? '审批超时' : '运行已取消'
      }
    }

    if (def.execution === 'main') {
      const data = await this.withTimeout(def.execute(input, context), this.toolTimeoutMs, () =>
        callAbort.abort(new Error(TOOL_TIMEOUT_MESSAGE))
      )
      return { status: 'completed', data }
    }

    this.pendingResults.delete(approvalId)
    return resultPromise ?? { status: 'failed', message: '渲染进程执行结果缺失' }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        onTimeout()
        reject(new Error(TOOL_TIMEOUT_MESSAGE))
      }, ms)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  private createCallAbortController(
    runSignal: AbortSignal,
    sdkSignal?: AbortSignal
  ): { controller: AbortController; cleanup: () => void } {
    const controller = new AbortController()
    const signals = sdkSignal ? [runSignal, sdkSignal] : [runSignal]
    const onAbort = (event: Event): void => {
      const signal = event.target as AbortSignal
      controller.abort(signal.reason)
    }
    for (const signal of signals) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    return {
      controller,
      cleanup: () => {
        for (const signal of signals) signal.removeEventListener('abort', onAbort)
      }
    }
  }

  async cancel(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId)
    if (run) {
      run.abort.abort()
    }
    this.approvalManager.cancelRun(runId)
  }

  claimApproval(id: string): ToolApprovalRequest {
    const request = this.approvalManager.get(id)
    if (!request || request.execution.location !== 'renderer') {
      throw new Error('审批不存在、已失效或无需渲染进程执行')
    }
    return this.approvalManager.claim(id)
  }

  resolveApproval(id: string, decision: ApprovalDecision, result?: ToolExecutionResult): void {
    const request = this.approvalManager.get(id)
    if (!request) throw new Error('审批不存在或已失效')
    if (decision.status === 'approved' && request.execution.location === 'renderer' && !result) {
      throw new Error('渲染进程执行结果缺失')
    }
    if (
      decision.status === 'approved' &&
      request.execution.location === 'renderer' &&
      !this.approvalManager.isClaimed(id)
    ) {
      throw new Error('渲染进程审批尚未认领')
    }
    if (
      decision.status === 'approved' &&
      request.execution.location === 'renderer' &&
      result &&
      !['applied', 'conflict', 'failed'].includes(result.status)
    ) {
      throw new Error('渲染进程执行结果无效')
    }
    if (request.execution.location === 'main' && result) {
      throw new Error('主进程审批不接受渲染进程执行结果')
    }
    this.approvalManager.resolve(id, decision)
    if (result) {
      const resolver = this.pendingResults.get(id)
      if (resolver) {
        this.pendingResults.delete(id)
        resolver(result)
      }
    }
  }

  dispose(): void {
    for (const run of [...this.activeRuns.values()]) {
      run.abort.abort()
    }
    this.activeRuns.clear()
    this.pendingResults.clear()
    this.approvalManager.dispose()
  }
}
