import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../ipc/channels'
import { AiConfigService, normalizeAiBaseUrl } from './config'
import { AiRuntime } from './runtime'
import { fetchModelCatalog } from './model-catalog'
import { SourceAccessService } from './source-access-service'
import { VercelAiSdkProvider, mapProviderError } from './provider'
import { ToolRegistry } from './tool-registry'
import { ApprovalManager } from './approval-manager'
import { ConversationStore } from './conversation-store'
import { generateConversationTitle } from './conversation-title'
import {
  authorizeWorkspaceRoot,
  getAuthorizedWorkspaceRoot,
  revokeSenderWorkspace
} from '../workspace/workspace-authorization'
import { WorkspaceSearchService } from '../workspace/workspace-search-service'
import { migrateLegacyConfigDir } from '../sync/legacy-migration'
import type {
  AiConfigInput,
  AiRunInput,
  AiRuntimeConfig,
  ApprovalDecision,
  ConversationRecord,
  ToolExecutionResult
} from '../../shared/ai/types'
import { MAX_AI_MODEL_ID_LENGTH, MAX_AI_MODELS } from '../../shared/ai/types'
import { aiRunInputSchema, approvalResolutionSchema, runIdSchema } from '../../shared/ai/contracts'
import { DEFAULT_AI_TEMPERATURE } from '../../shared/ai/defaults'
import { z } from 'zod'

const { AI } = IPC_CHANNELS

const aiPermissionModeSchema = z.enum(['readonly', 'standard', 'auto'])
const aiApiFormatSchema = z.enum(['openai-compatible', 'openai-responses'])
const aiModelIdSchema = z.string().trim().min(1).max(MAX_AI_MODEL_ID_LENGTH)

const aiConfigInputSchema = z.object({
  baseUrl: z.string().trim().min(1),
  /** 接口格式；缺省按 openai-compatible 处理（旧配置没有这个字段） */
  apiFormat: aiApiFormatSchema.optional(),
  model: aiModelIdSchema,
  /** 可选模型目录；缺省表示「本次不改变」，显式空数组表示清空 */
  models: z.array(aiModelIdSchema).max(MAX_AI_MODELS).optional(),
  apiKey: z.string().optional(),
  /**
   * 温度：用户可以不填（设置页留空 / 从未配置过），缺省时补默认值。
   *
   * 它必须落在一个数字上，而不是"不传给模型"：各服务商的默认温度并不一致，
   * 不补值会让换 Provider 就换一种输出风格。范围校验仍然保留，越界值照旧拒绝。
   */
  temperature: z.number().min(0).max(2).default(DEFAULT_AI_TEMPERATURE),
  maxOutputTokens: z.number().int().positive().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().max(200).optional(),
  // 4 KiB ~ 4 MiB：与 workspace-search-service 的 MIN/MAX_READ_BYTES 对齐
  maxReadBytes: z.number().int().min(4 * 1024).max(4 * 1024 * 1024).optional(),
  // 30 秒 ~ 60 分钟
  idleTimeoutMs: z.number().int().min(30_000).max(60 * 60_000).optional(),
  /** 只读 / 标准 / 完全控制；缺省表示「本次不改变」（设置中心不携带它） */
  permissionMode: aiPermissionModeSchema.optional()
}).strict()

const aiModelCatalogInputSchema = z
  .object({
    baseUrl: z.string().trim().min(1),
    apiKey: z.string().optional()
  })
  .strict()

let configService: AiConfigService | null = null
let runtime: AiRuntime | null = null
let runtimeConfigSnapshot: AiRuntimeConfig | null = null
const sourceAccessService = new SourceAccessService()
const searchService = new WorkspaceSearchService()
const conversationStore = new ConversationStore()
const runOwners = new Map<string, number>()
const approvalOwners = new Map<string, number>()
const approvalRuns = new Map<string, string>()
const observedSenders = new Set<number>()

function revokeSender(senderId: number): void {
  for (const [id, ownerId] of approvalOwners) {
    if (ownerId === senderId) {
      approvalOwners.delete(id)
      approvalRuns.delete(id)
    }
  }
  for (const [runId, ownerId] of [...runOwners]) {
    if (ownerId === senderId) {
      runOwners.delete(runId)
      void runtime?.cancel(runId)
    }
  }
  revokeSenderWorkspace(senderId)
  observedSenders.delete(senderId)
}

function observeSender(sender: { id: number; once: (event: 'destroyed', callback: () => void) => unknown }): void {
  if (observedSenders.has(sender.id)) return
  observedSenders.add(sender.id)
  sender.once('destroyed', () => revokeSender(sender.id))
}

function getConfigService(): AiConfigService {
  if (!configService) {
    configService = new AiConfigService()
  }
  return configService
}

/**
 * 配置项的展示名：Zod 的 issue 只带字段名，直接回显会变成一串 JSON。
 */
const AI_CONFIG_FIELD_LABELS: Record<string, string> = {
  baseUrl: 'API 地址',
  apiFormat: '接口格式',
  model: '模型',
  models: '模型列表',
  apiKey: 'API Key',
  temperature: '温度',
  maxOutputTokens: '最大输出',
  contextWindow: '上下文窗口',
  maxSteps: '最大工具步骤',
  maxReadBytes: '单次读取上限',
  idleTimeoutMs: '空闲超时',
  permissionMode: '权限模式'
}

/**
 * 少数字段的提示语能比「取值不合法」说得更具体，单独给一句。
 * 温度是本次事故的当事字段：`Number(undefined)` 得到的 NaN 就拦在这里。
 */
const AI_CONFIG_FIELD_HINTS: Record<string, string> = {
  temperature: '温度必须是 0–2 之间的数字'
}

/**
 * 把 Zod 的 issue 数组翻译成给人看的一句话。
 *
 * 早先这里直接返回 `error.message`，而 Zod 4 的 message 就是 issues 的 JSON
 * 字符串——用户看到的是 `[{"expected":"number","code":"invalid_type",…}]`，
 * 既不知道是哪一项出了问题，也不知道该怎么改。
 */
function describeConfigIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const field = issue.path.length > 0 ? String(issue.path[0]) : ''
    const hint = AI_CONFIG_FIELD_HINTS[field]
    if (hint) return hint
    const label = AI_CONFIG_FIELD_LABELS[field] ?? '配置项'
    const detail = issue.code === 'unrecognized_keys' ? '存在未知字段' : '取值不合法'
    return `${label}：${detail}`
  })
  return `配置无效：${parts.join('；')}`
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return describeConfigIssues(error)
  return error instanceof Error ? error.message : '未知错误'
}

function toResult<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function configsEqual(a: AiRuntimeConfig, b: AiRuntimeConfig): boolean {
  return (
    a.baseUrl === b.baseUrl &&
    // 接口格式决定用哪套协议，换了就必须重建 provider
    a.apiFormat === b.apiFormat &&
    a.model === b.model &&
    a.apiKey === b.apiKey &&
    a.temperature === b.temperature &&
    a.maxOutputTokens === b.maxOutputTokens &&
    a.contextWindow === b.contextWindow &&
    a.maxSteps === b.maxSteps &&
    a.maxReadBytes === b.maxReadBytes &&
    a.idleTimeoutMs === b.idleTimeoutMs
    // permissionMode 刻意不参与比较：切换模式走 AI.PERMISSION.SET 直接改运行中的
    // runtime，若在这里算作「配置变化」就会重建 runtime，把正在跑的会话打断
  )
}

function createRuntime(config: AiRuntimeConfig): AiRuntime {
  const registry = new ToolRegistry()
  const approvalManager = new ApprovalManager()
  // 空闲超时属于运行语义（工具/审批期间不计时），由配置带进来
  const provider = new VercelAiSdkProvider({ idleTimeoutMs: config.idleTimeoutMs })
  return new AiRuntime({
    provider,
    registry,
    approvalManager,
    sourceAccessService,
    searchService,
    config,
    maxSteps: config.maxSteps
  })
}

/**
 * 「获取模型」用的 API Key：优先表单里刚填的那把；没填就复用已保存的，
 * 但仅限同一服务来源——换了地址还拿旧 Key 去请求，等于把凭据发给别人。
 * 两者都没有时返回空串（不带 Authorization 头），支持本地无鉴权服务。
 */
function resolveCatalogApiKey(baseUrl: string, provided: string | undefined): string {
  const key = provided?.trim()
  if (key) return key
  try {
    const saved = getConfigService().getRuntimeConfig()
    const sameOrigin =
      new URL(normalizeAiBaseUrl(baseUrl)).origin === new URL(saved.baseUrl).origin
    return sameOrigin ? saved.apiKey : ''
  } catch {
    return ''
  }
}

/**
 * 返回复用或按需重建的 runtime 单例。
 * config 变化时先建新 runtime 再拆旧，避免 in-flight run 被杀；
 * config 缺失时抛出 CONFIG_MISSING（由调用方 catch 返回 {success:false}），不影响现有 runtime。
 */
function ensureRuntime(): AiRuntime {
  const config = getConfigService().getRuntimeConfig()
  if (runtime && runtimeConfigSnapshot && configsEqual(runtimeConfigSnapshot, config)) {
    return runtime
  }
  const next = createRuntime(config)
  runtime?.dispose()
  runtime = next
  runtimeConfigSnapshot = config
  return next
}

/**
 * 注册 AI 相关 IPC 处理器。返回清理器（移除已注册的 handler）。
 */
export function registerAiHandlers(_getWindow: () => BrowserWindow | null): () => void {
  const channels = [
    AI.CONFIG.GET,
    AI.CONFIG.SET,
    AI.CONFIG.TEST,
    AI.CONFIG.MODELS,
    AI.CONFIG.REVEAL_KEY,
    AI.MODEL.SET,
    AI.RUN.START,
    AI.RUN.CANCEL,
    AI.PERMISSION.SET,
    AI.APPROVAL.CLAIM,
    AI.APPROVAL.RESOLVE,
    AI.CONVERSATION.LIST,
    AI.CONVERSATION.LOAD,
    AI.CONVERSATION.SAVE,
    AI.CONVERSATION.DELETE,
    AI.CONVERSATION.SUMMARIZE,
    AI.WORKSPACE.AUTHORIZE
  ]

  ipcMain.handle(AI.CONFIG.GET, () => {
    try {
      return toResult(getConfigService().getView())
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(AI.CONFIG.SET, (_event, input: AiConfigInput) => {
    try {
      return toResult(getConfigService().save(aiConfigInputSchema.parse(input)))
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(AI.CONFIG.TEST, async (_event, input: AiConfigInput) => {
    try {
      const parsed = aiConfigInputSchema.parse(input)
      const provider = new VercelAiSdkProvider()
      let savedKey: string | undefined
      if (!parsed.apiKey) {
        const saved = getConfigService().getRuntimeConfig()
        const testedOrigin = new URL(normalizeAiBaseUrl(parsed.baseUrl)).origin
        if (testedOrigin !== new URL(saved.baseUrl).origin) {
          throw new Error('测试地址与已保存 API Key 的服务来源不匹配')
        }
        savedKey = saved.apiKey
      }
      const result = await provider.testConnection({
        ...parsed,
        apiKey: parsed.apiKey || savedKey || ''
      })
      getConfigService().recordCapabilityTest({
        ...parsed,
        baseUrl: normalizeAiBaseUrl(parsed.baseUrl),
        apiKey: parsed.apiKey || savedKey || ''
      }, result)
      return toResult(result)
    } catch (error) {
      return {
        success: false,
        // ZodError 属于「参数不合法」，要给人看的中文提示；其余才是 Provider 侧的失败
        error: error instanceof z.ZodError ? errorMessage(error) : mapProviderError(error).message
      }
    }
  })

  /**
   * 拉取服务端模型目录（设置页「获取模型」）。
   *
   * 请求在主进程发出：Key 不出主进程，渲染层只拿到模型标识列表。
   */
  ipcMain.handle(AI.CONFIG.MODELS, async (_event, input: unknown) => {
    try {
      const parsed = aiModelCatalogInputSchema.parse(input)
      const models = await fetchModelCatalog({
        baseUrl: parsed.baseUrl,
        apiKey: resolveCatalogApiKey(parsed.baseUrl, parsed.apiKey)
      })
      return toResult({ models })
    } catch (error) {
      return {
        success: false,
        error: error instanceof z.ZodError ? '请求参数无效' : errorMessage(error)
      }
    }
  })

  /**
   * 按需返回明文 Key。
   *
   * 设置页点「小眼睛」时才调它：`AI.CONFIG.GET` 的返回值永远不含明文，
   * 明文暴露面只剩用户显式点击这一个动作。
   */
  ipcMain.handle(AI.CONFIG.REVEAL_KEY, () => {
    try {
      return toResult({ apiKey: getConfigService().revealApiKey() })
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  /**
   * 切换当前模型。
   *
   * 只写配置，不重建 runtime：下一次 `AI.RUN.START` 的 `ensureRuntime` 会发现
   * model 变了并按需重建，正在跑的那一轮不会被切换打断。
   */
  ipcMain.handle(AI.MODEL.SET, (_event, model: unknown) => {
    try {
      const parsed = aiModelIdSchema.parse(model)
      return toResult(getConfigService().setModel(parsed))
    } catch (error) {
      return {
        success: false,
        error: error instanceof z.ZodError ? '模型名无效' : errorMessage(error)
      }
    }
  })

  /**
   * 切换权限模式。
   *
   * 面板里的下拉直接调这里：先写配置（下次启动仍是这个模式），再热更新运行中的
   * runtime（下一次工具调用立即按新模式判定）。不重建 runtime，避免打断会话。
   */
  ipcMain.handle(AI.PERMISSION.SET, (_event, mode: unknown) => {
    try {
      const parsed = aiPermissionModeSchema.parse(mode)
      const view = getConfigService().setPermissionMode(parsed)
      runtime?.setPermissionMode(parsed)
      return toResult(view)
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(AI.RUN.START, async (event, input: AiRunInput) => {
    try {
      const parsed = aiRunInputSchema.parse(input)
      observeSender(event.sender)
      // 工作区根目录只信任主进程授权状态，不信任运行参数携带的绝对路径。
      parsed.snapshot.workspaceRoot = getAuthorizedWorkspaceRoot(event.sender.id) ?? null
      const rt = ensureRuntime()
      const sender = event.sender
      const { runId } = await rt.start(parsed, (aiEvent) => {
        if (aiEvent.type === 'run-started') {
          runOwners.set(aiEvent.runId, sender.id)
        } else if (aiEvent.type === 'approval-required') {
          approvalOwners.set(aiEvent.approval.id, sender.id)
          approvalRuns.set(aiEvent.approval.id, aiEvent.runId)
        } else if (
          aiEvent.type === 'run-completed' ||
          aiEvent.type === 'run-failed' ||
          aiEvent.type === 'run-cancelled'
        ) {
          runOwners.delete(aiEvent.runId)
          for (const [approvalId, runId] of approvalRuns) {
            if (runId === aiEvent.runId) {
              approvalRuns.delete(approvalId)
              approvalOwners.delete(approvalId)
            }
          }
        }
        if (!sender.isDestroyed()) {
          sender.send(AI.EVENT, aiEvent)
        }
      })
      return toResult({ runId })
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(AI.APPROVAL.CLAIM, (event, id: string) => {
    try {
      const parsedId = runIdSchema.parse(id)
      if (approvalOwners.get(parsedId) !== event.sender.id) {
        throw new Error('无权认领此审批')
      }
      if (!runtime) throw new Error('审批不存在或已失效')
      runtime.claimApproval(parsedId)
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(AI.RUN.CANCEL, async (event, runId: string) => {
    try {
      const parsedRunId = runIdSchema.parse(runId)
      if (runOwners.get(parsedRunId) !== event.sender.id) {
        throw new Error('无权取消此 AI 运行')
      }
      if (runtime) {
        await runtime.cancel(parsedRunId)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(
    AI.APPROVAL.RESOLVE,
    (event, id: string, decision: ApprovalDecision, result?: ToolExecutionResult) => {
      try {
        const parsed = approvalResolutionSchema.parse({ id, decision, result })
        if (approvalOwners.get(parsed.id) !== event.sender.id) {
          throw new Error('无权处理此审批')
        }
        if (runtime) {
          runtime.resolveApproval(parsed.id, parsed.decision, parsed.result)
        }
        approvalOwners.delete(parsed.id)
        approvalRuns.delete(parsed.id)
        return { success: true }
      } catch (error) {
        return { success: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle(AI.CONVERSATION.LIST, (_event, root: string | null) => {
    try {
      return toResult(conversationStore.listConversations(root ?? null))
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(AI.CONVERSATION.LOAD, (_event, root: string | null, id: string) => {
    try {
      return toResult(conversationStore.loadConversation(root ?? null, id))
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(AI.CONVERSATION.SAVE, (_event, root: string | null, record: ConversationRecord) => {
    try {
      conversationStore.saveConversation(root ?? null, record)
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(AI.CONVERSATION.DELETE, (_event, root: string | null, id: string) => {
    try {
      conversationStore.deleteConversation(root ?? null, id)
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(AI.CONVERSATION.SUMMARIZE, async (_event, text: string) => {
    try {
      const config = getConfigService().getRuntimeConfig()
      const provider = new VercelAiSdkProvider()
      const title = await generateConversationTitle(provider, config, text)
      if (!title) return { success: false, error: '无法生成会话标题' }
      return toResult({ title })
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(AI.WORKSPACE.AUTHORIZE, (event, root: string | null) => {
    try {
      const parsedRoot = root && typeof root === 'string' && root.length > 0 ? root : null
      if (parsedRoot) migrateLegacyConfigDir(parsedRoot)
      observeSender(event.sender)
      authorizeWorkspaceRoot(event.sender.id, parsedRoot)
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  return () => {
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
    }
  }
}

/**
 * 销毁 AI 服务（取消运行和审批）。幂等。
 */
export function disposeAiServices(): void {
  runtime?.dispose()
  runtime = null
  runtimeConfigSnapshot = null
  runOwners.clear()
  approvalOwners.clear()
  approvalRuns.clear()
  observedSenders.clear()
}
