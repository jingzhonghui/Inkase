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
import { normalizeAiPermissionMode, type AiPermissionMode } from '../../shared/ai/permission'
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
import { SYSTEM_PROMPT, buildPermissionInstruction } from './prompts'

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

/** 只读模式下拦下修改类工具时回给模型的话，顺带告诉它怎么继续。 */
const READONLY_MODE_MESSAGE =
  '当前为「只读」权限模式：AI 不能修改、新建、移动或删除工作区文件。' +
  '请让用户把输入框左下角的权限切换为「标准」或「完全控制」后再试。'

export class AiRuntime {
  private readonly provider: LlmProvider
  private readonly registry: ToolRegistry
  private readonly approvalManager: ApprovalManager
  private readonly config: AiRuntimeConfig
  private readonly systemPrompt: string
  private readonly maxSteps: number
  private readonly toolTimeoutMs: number
  private readonly approvalTimeoutMs: number
  /**
   * 权限模式可以运行中切换（面板里的下拉），所以不是 readonly：
   * 构造时从配置取初值，之后由 `setPermissionMode` 更新。
   */
  private permissionMode: AiPermissionMode

  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly pendingResults = new Map<string, (result: ToolExecutionResult) => void>()

  constructor(deps: AiRuntimeDeps) {
    this.provider = deps.provider
    this.registry = deps.registry
    this.approvalManager = deps.approvalManager
    this.config = deps.config
    this.systemPrompt = SYSTEM_PROMPT
    // 20 步只够「搜一次、读两篇、改一处」；整理目录这类任务动辄几十步，
    // 默认放宽到 50 步，仍由用户在设置里调整上限。
    this.maxSteps = deps.maxSteps ?? 50
    // 工具超时管的是单次工具执行（搜索、读文件、解包），给足 3 分钟；
    // 审批等待不走这个计时，避免用户思考时间被算成工具超时。
    this.toolTimeoutMs = deps.toolTimeoutMs ?? 180_000
    this.approvalTimeoutMs = deps.approvalTimeoutMs ?? 600_000
    this.permissionMode = normalizeAiPermissionMode(deps.config.permissionMode)

    this.registerTools(deps.sourceAccessService, deps.searchService)
  }

  /**
   * 切换权限模式，运行中立即生效。
   *
   * 不重建 runtime：重建会把正在跑的会话一起拆掉。已经发出的审批请求保持原样
   * （用户已经看到的那一次仍由用户决定），只有「下一次工具调用」按新模式判定。
   */
  setPermissionMode(mode: AiPermissionMode): void {
    this.permissionMode = normalizeAiPermissionMode(mode)
  }

  getPermissionMode(): AiPermissionMode {
    return this.permissionMode
  }

  private registerTools(
    sourceAccessService: SourceAccessService,
    searchService: WorkspaceSearchService
  ): void {
    const docTools = createDocumentTools(searchService, {
      maxReadBytes: this.config.maxReadBytes
    })
    const sourceTools = createSourceAccessTools(sourceAccessService)
    const timeTools = createTimeTools()
    const all: AnyToolDefinition[] = [
      docTools.searchWorkspace,
      docTools.listWorkspaceRoot,
      docTools.readWorkspaceDirectory,
      docTools.readWorkspaceFile,
      docTools.getWorkspaceFileSize,
      docTools.createWorkspaceDirectory,
      docTools.moveWorkspaceEntry,
      docTools.writeWorkspaceFile,
      docTools.readSelectedText,
      timeTools.getCurrentDatetime,
      sourceTools.readWebUrl,
      sourceTools.readLocalFile,
      docTools.replaceCurrentDocument,
      docTools.insertIntoCurrentDocument,
      docTools.createDocument,
      docTools.createMindmap,
      docTools.updateMindmap,
      docTools.deleteWorkspaceFile
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
    // 权限模式写进系统提示：工具列表已经按模式筛过，但模型仍可能凭记忆调用被剔掉的工具
    const system = this.systemPrompt + buildPermissionInstruction(this.permissionMode)

    emit({ type: 'run-started', runId })

    void this.runLoop(run, messages, tools, emit, system).catch(() => {})
    return Promise.resolve({ runId })
  }

  private async runLoop(
    run: ActiveRun,
    messages: AiConversationMessage[],
    tools: Record<string, ProviderTool>,
    emit: (event: AiRunEvent) => void,
    system: string
  ): Promise<{ runId: string }> {
    const { runId, abort } = run
    try {
      const stream = this.provider.run({
        config: this.config,
        system,
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
      // 只读模式下不把修改类工具递给模型：它不必看到注定会被拒绝的工具，
      // 少一次「试了才知道不行」的往返。真正执行前还有一道 deny 兜底。
      if (evaluateToolPolicy(def.policy, this.permissionMode) === 'deny') continue
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
    const policyDecision = evaluateToolPolicy(def.policy, this.permissionMode)

    // 只读模式：修改类工具在进审批通道之前就拒掉。不能先弹窗再拒绝——
    // 那会让用户以为「点了允许就能改」，而权限模式的边界不该由一次点击突破。
    if (policyDecision === 'deny') {
      return { status: 'rejected', message: READONLY_MODE_MESSAGE }
    }

    const requiresApproval = policyDecision === 'ask'
    const auto = this.permissionMode === 'auto'

    // 主进程工具在不需要批准时直接执行
    if (def.execution === 'main' && !requiresApproval) {
      const data = await this.withTimeout(def.execute(input, context), this.toolTimeoutMs, () =>
        callAbort.abort(new Error(TOOL_TIMEOUT_MESSAGE))
      )
      return { status: 'completed', data }
    }

    // 渲染进程类操作没有旁路：改动必须由渲染层应用（冲突检测、标签、图谱都在那边）。
    // 完全控制模式省掉的是「等用户点一下」，不是执行本身——所以照样发请求，
    // 只是带上 auto 标记，渲染层收到后立即认领并应用。
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

    // 先登记结果槽、再发审批请求：`request()` 在队列空时会同步发布该审批
    // （onPublish → emit）。顺序反过来时，一旦发布路径同步触发了响应，
    // 取结果时就找不到 resolver，execute 会返回一个永不落定的 Promise，
    // 整个 SDK 流于是永远不关闭——表现就是「AI 假死 + 卡片停在运行中」。
    let rendererResult: ToolExecutionResult | undefined
    let resolveRenderer: ((result: ToolExecutionResult) => void) | undefined
    if (def.execution === 'renderer') {
      const resultPromise = new Promise<ToolExecutionResult>((resolve) => {
        resolveRenderer = (value) => {
          rendererResult = value
          resolve(value)
        }
        this.pendingResults.set(approvalId, resolveRenderer)
      })
      void resultPromise
    }

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
      expiresAt: Date.now() + this.approvalTimeoutMs,
      ...(auto ? { auto: true } : {})
    }

    const decisionPromise = this.approvalManager.request(request, (req) => {
      emit({ type: 'approval-required', runId: run.runId, approval: req })
    })

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
    // 结果槽没被填写（渲染层回传丢失）时绝不能返回那个悬挂的 Promise：
    // 它会让 SDK 认为这个工具永不结束，整轮运行既不失败也不继续。
    return rendererResult ?? { status: 'failed', message: '渲染进程执行结果缺失' }
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
