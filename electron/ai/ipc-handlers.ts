import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../ipc/channels'
import { AiConfigService, normalizeAiBaseUrl } from './config'
import { AiRuntime } from './runtime'
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
import { aiRunInputSchema, approvalResolutionSchema, runIdSchema } from '../../shared/ai/contracts'
import { z } from 'zod'

const { AI } = IPC_CHANNELS

const aiConfigInputSchema = z.object({
  baseUrl: z.string().trim().min(1),
  model: z.string().trim().min(1),
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().positive().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().max(100).optional()
}).strict()

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

function toResult<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function configsEqual(a: AiRuntimeConfig, b: AiRuntimeConfig): boolean {
  return (
    a.baseUrl === b.baseUrl &&
    a.model === b.model &&
    a.apiKey === b.apiKey &&
    a.temperature === b.temperature &&
    a.maxOutputTokens === b.maxOutputTokens &&
    a.contextWindow === b.contextWindow
  )
}

function createRuntime(config: AiRuntimeConfig): AiRuntime {
  const registry = new ToolRegistry()
  const approvalManager = new ApprovalManager()
  const provider = new VercelAiSdkProvider()
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
    AI.RUN.START,
    AI.RUN.CANCEL,
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
      return { success: false, error: mapProviderError(error).message }
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
