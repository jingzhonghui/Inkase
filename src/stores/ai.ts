import { ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AiConversationMessage,
  AiRunEvent,
  AiRunInput,
  ApprovalDecision,
  ConversationApprovalRecord,
  ConversationMeta,
  ConversationRecord,
  ToolApprovalRequest,
  ToolExecutionResult
} from '../../shared/ai/types'
import { applyDocumentOperation, createExecutionSnapshot } from '../utils/ai/workspace-context'
import { ANALYSIS_END_RE, ANALYSIS_START_RE, findIndex } from '../utils/ai/analysis-block'
import { useFileStore } from './file'
import { loadSessionState } from './session'
import { requestDialog } from '../utils/dialog'

interface ToolCallEntry {
  toolCallId: string
  toolName: string
  status: 'running' | 'completed' | 'failed'
  result?: ToolExecutionResult
  messageId?: string
}

/**
 * 生成一次会话内稳定的会话 ID。
 */
function generateConversationId(): string {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * AI 助手状态 Store。
 *
 * 负责 AI 面板标签页生命周期（默认隐藏、可关闭）、会话消息、运行事件归约，
 * 以及审批与主进程（preload AI API）的协调。
 */
export const useAiStore = defineStore('ai', () => {
  // ===== 面板 / 标签页状态 =====
  const panelOpen = ref(false)
  const panelActive = ref(false)
  /** AI 标签在标签栏中的位置（0 基）；null 表示始终排在文件标签之后 */
  const tabIndex = ref<number | null>(null)

  function setTabIndex(index: number | null): void {
    tabIndex.value = index
  }

  // ===== 会话状态 =====
  const messages = ref<AiConversationMessage[]>([])
  const toolCalls = ref<ToolCallEntry[]>([])
  const activeRunId = ref<string | null>(null)
  const running = ref(false)
  const pendingApprovals = ref<ToolApprovalRequest[]>([])
  /**
   * 会话内出现过的全部审批（含仍在等待的）。
   *
   * pendingApprovals 只服务于「还需要用户点一下」的判断；一旦判定就被移出，
   * 于是会话里再也看不到「当时问了什么」。这份记录是给人看的，会随会话落盘。
   */
  const approvalHistory = ref<ConversationApprovalRecord[]>([])
  const conversations = ref<ConversationMeta[]>([])
  const activeConversationId = ref<string | null>(null)
  const storageRoot = ref<string | null>(null)
  const conversationTitle = ref('新会话')
  const conversationCreatedAt = ref(0)
  const titleSource = ref<'truncated' | 'llm' | 'custom'>('truncated')
  const error = ref<string | null>(null)

  // ===== 内部状态 =====
  let unsubscribe: (() => void) | null = null
  let initialized = false
  let idCounter = 0
  let pendingTitleGeneration = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let streamingAssistantMessageId: string | null = null
  let lastToolCallContentLength = -1
  let startRequestPending = false
  let pendingStartPromise: Promise<void> | null = null
  const terminalRunsDuringStart = new Set<string>()
  interface ApprovalResolutionState {
    approval: ToolApprovalRequest
    decision: ApprovalDecision
    result?: ToolExecutionResult
    claimed: boolean
    promise: Promise<void> | null
  }
  const approvalResolutions = new Map<string, ApprovalResolutionState>()
  /** 审批 → 承载它的助手消息 id（ToolApprovalRequest 由主进程构造，不含此信息） */
  const approvalMessageIds = new Map<string, string>()

  function nextId(prefix: string): string {
    idCounter += 1
    return `${prefix}_${idCounter}`
  }

  function syncIdCounterFromMessages(): void {
    let maxNum = 0
    for (const message of messages.value) {
      const match = /^msg_(\d+)$/.exec(message.id)
      if (match) {
        const num = Number(match[1])
        if (num > maxNum) maxNum = num
      }
    }
    idCounter = maxNum
  }

  function finalizeStreamingAssistantMessage(): void {
    if (streamingAssistantMessageId) {
      const message = messages.value.find((m) => m.id === streamingAssistantMessageId)
      if (message) {
        const A_START = '<!-- analysis -->'
        const A_END = '<!-- end-analysis -->'

        const aStartIdx = findIndex(message.content, ANALYSIS_START_RE)

        if (aStartIdx === -1) {
          const insertPos =
            lastToolCallContentLength >= 0
              ? lastToolCallContentLength
              : message.content.length
          const head = message.content.slice(0, insertPos).replace(/\s+$/, '')
          const tail = message.content.slice(insertPos).replace(/^\s+/, '')
          message.content =
            A_START + '\n' + head + '\n' + A_END + (tail ? '\n' + tail : '')
        } else {
          const aEndMatch = message.content.slice(aStartIdx).match(ANALYSIS_END_RE)
          if (!aEndMatch) {
            const insertPos =
              lastToolCallContentLength >= 0 && lastToolCallContentLength >= aStartIdx + A_START.length
                ? lastToolCallContentLength
                : message.content.length
            const head = message.content.slice(0, insertPos).replace(/\s+$/, '')
            const tail = message.content.slice(insertPos).replace(/^\s+/, '')
            message.content =
              head + '\n' + A_END + (tail ? '\n' + tail : '')
          }
        }
      }
    }
    streamingAssistantMessageId = null
    lastToolCallContentLength = -1
  }

  function toApprovalRecord(
    request: ToolApprovalRequest,
    messageId?: string
  ): ConversationApprovalRecord {
    return {
      id: request.id,
      runId: request.runId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      title: request.title,
      description: request.description,
      reason: request.reason,
      effect: request.effect,
      riskLevel: request.riskLevel,
      preview: JSON.parse(JSON.stringify(request.preview)),
      createdAt: request.createdAt,
      messageId
    }
  }

  /**
   * 写入一次审批的判定结果。
   *
   * 审批解析带重试与去重，这里必须幂等：同一 id 重复调用只覆盖判定，不再插入一条。
   */
  function settleApprovalRecord(
    request: ToolApprovalRequest,
    decision: ApprovalDecision,
    outcome?: ToolExecutionResult['status']
  ): void {
    const index = approvalHistory.value.findIndex((record) => record.id === request.id)
    const base = index === -1
      ? toApprovalRecord(request, approvalMessageIds.get(request.id))
      : approvalHistory.value[index]
    const next: ConversationApprovalRecord = {
      ...base,
      decision: { ...decision },
      decidedAt: Date.now()
    }
    if (outcome) next.outcome = outcome
    if (index === -1) approvalHistory.value.push(next)
    else approvalHistory.value[index] = next
    approvalMessageIds.delete(request.id)
  }

  function discardApprovalsForRun(runId: string): void {
    const discarded = pendingApprovals.value.filter((approval) => approval.runId === runId)
    pendingApprovals.value = pendingApprovals.value.filter((approval) => approval.runId !== runId)
    for (const approval of discarded) {
      approvalResolutions.delete(approval.id)
      // 运行已经结束，这些审批不会再有结果；但会话里要留下「曾请求过、被取消」
      settleApprovalRecord(approval, { status: 'cancelled' })
    }
  }

  function discardAllApprovals(): void {
    pendingApprovals.value = []
    approvalResolutions.clear()
    // 换会话或撤回消息导致的丢弃：这些审批不是「有结论」，不该留在会话里
    approvalHistory.value = approvalHistory.value.filter((record) => record.decision !== undefined)
    approvalMessageIds.clear()
  }

  // ===== 标签页生命周期 =====

  function openPanel(): void {
    panelOpen.value = true
    panelActive.value = true
    useFileStore().persistSession()
  }

  function activatePanel(): void {
    panelActive.value = true
    useFileStore().persistSession()
  }

  function deactivatePanel(): void {
    panelActive.value = false
    useFileStore().persistSession()
  }

  async function cancelRun(): Promise<boolean> {
    if (!activeRunId.value && pendingStartPromise) await pendingStartPromise
    const runId = activeRunId.value
    if (!runId) return true
    try {
      const result = await window.electronAPI.cancelAiRun(runId)
      if (!result.success) {
        error.value = result.error || '取消 AI 运行失败'
        return false
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '取消 AI 运行失败'
      return false
    }
    running.value = false
    activeRunId.value = null
    discardApprovalsForRun(runId)
    finalizeStreamingAssistantMessage()
    return true
  }

  async function requestClosePanel(): Promise<void> {
    if (running.value || pendingStartPromise || pendingApprovals.value.length > 0) {
      const choice = await requestDialog({
        title: '关闭 AI 面板',
        message: 'AI 助手正在运行，确定要关闭吗？',
        detail: '关闭将取消当前运行并清除待审批的操作。',
        buttons: [
          { label: '取消', value: 1 },
          { label: '关闭', value: 0, primary: true }
        ]
      })
      if (choice !== 0) return

      if (!activeRunId.value && pendingStartPromise) await pendingStartPromise
      if (!(await cancelRun())) return
      discardAllApprovals()
    }

    panelOpen.value = false
    panelActive.value = false
    useFileStore().persistSession()
  }

  // ===== 会话记录 =====

  function truncateTitle(text: string): string {
    const cleaned = text.replace(/\s+/g, ' ').trim()
    if (!cleaned) return '新会话'
    return cleaned.length > 20 ? `${cleaned.slice(0, 20)}…` : cleaned
  }

  function buildRecord(id: string): ConversationRecord {
    return {
      version: 1,
      id,
      title: conversationTitle.value,
      createdAt: conversationCreatedAt.value || Date.now(),
      updatedAt: Date.now(),
      messageCount: messages.value.length,
      messages: JSON.parse(JSON.stringify(messages.value)),
      toolSummaries: toolCalls.value.map((c) => ({
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        status: c.status,
        messageId: c.messageId
      })),
      approvals: JSON.parse(JSON.stringify(approvalHistory.value))
    }
  }

  async function refreshConversationsList(): Promise<void> {
    try {
      const result = await window.electronAPI.listAiConversations(storageRoot.value)
      if (result.success && result.data) conversations.value = result.data
    } catch {
      // 忽略
    }
  }

  function persistConversation(): void {
    const id = activeConversationId.value
    if (!id) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void (async () => {
        try {
          const result = await window.electronAPI.saveAiConversation(storageRoot.value, buildRecord(id))
          if (!result.success) {
            error.value = result.error || '保存会话失败'
            return
          }
          await refreshConversationsList()
        } catch (err) {
          error.value = err instanceof Error ? err.message : '保存会话失败'
        }
      })()
    }, 300)
  }

  function newConversation(): void {
    activeConversationId.value = null
    conversationTitle.value = '新会话'
    conversationCreatedAt.value = 0
    titleSource.value = 'truncated'
    messages.value = []
    toolCalls.value = []
    approvalHistory.value = []
    discardAllApprovals()
    idCounter = 0
  }

  async function openConversation(id: string): Promise<void> {
    if (running.value || pendingStartPromise) return
    try {
      const result = await window.electronAPI.loadAiConversation(storageRoot.value, id)
      if (!result.success || !result.data) {
        error.value = result.error || '加载会话失败'
        return
      }
      const record = result.data
      activeConversationId.value = record.id
      conversationTitle.value = record.title
      conversationCreatedAt.value = record.createdAt
      titleSource.value = 'custom'
      messages.value = record.messages.map((m) => ({ ...m }))
      syncIdCounterFromMessages()
      // 兜底：旧数据可能缺少 messageId，按顺序挂到 assistant 消息（无 assistant 则保持 undefined）
      const assistantIds = messages.value.filter((m) => m.role === 'assistant').map((m) => m.id)
      let nextAssistant = 0
      toolCalls.value = record.toolSummaries.map((s) => {
        let messageId = s.messageId
        if (!messageId && assistantIds.length > 0) {
          if (nextAssistant >= assistantIds.length) nextAssistant = assistantIds.length - 1
          messageId = assistantIds[nextAssistant]
          nextAssistant += 1
        }
        return {
          toolCallId: s.toolCallId,
          toolName: s.toolName,
          status: s.status === 'failed' ? 'failed' : 'completed',
          messageId
        }
      })
      discardAllApprovals()
      // 早期版本没能记下审批归属的消息（那时审批比 tool-call 先到，反查不到），
      // 靠 toolCallId 从工具调用摘要里补回来，否则这些卡片会掉到会话末尾。
      approvalHistory.value = (record.approvals ?? []).map((approval) => {
        if (approval.messageId) return { ...approval }
        const owner = toolCalls.value.find((call) => call.toolCallId === approval.toolCallId)
        return { ...approval, messageId: owner?.messageId }
      })
      useFileStore().persistSession()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载会话失败'
    }
  }

  async function loadConversations(root: string | null): Promise<void> {
    storageRoot.value = root
    try {
      const result = await window.electronAPI.listAiConversations(root)
      if (!result.success || !result.data) return
      conversations.value = result.data
      const lastId = loadSessionState()?.aiActiveConversationId ?? null
      if (lastId && conversations.value.some((c) => c.id === lastId)) {
        await openConversation(lastId)
      } else {
        newConversation()
      }
    } catch {
      // 忽略
    }
  }

  async function deleteConversation(id: string): Promise<void> {
    try {
      const result = await window.electronAPI.deleteAiConversation(storageRoot.value, id)
      if (!result.success) {
        error.value = result.error || '删除会话失败'
        return
      }
      conversations.value = conversations.value.filter((c) => c.id !== id)
      if (activeConversationId.value === id) {
        newConversation()
        useFileStore().persistSession()
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '删除会话失败'
    }
  }

  async function renameConversation(id: string, title: string): Promise<void> {
    const cleaned = title.trim()
    if (!cleaned) return
    if (activeConversationId.value === id) {
      conversationTitle.value = cleaned
      titleSource.value = 'custom'
      persistConversation()
      return
    }
    try {
      const loaded = await window.electronAPI.loadAiConversation(storageRoot.value, id)
      if (!loaded.success || !loaded.data) return
      loaded.data.title = cleaned
      const result = await window.electronAPI.saveAiConversation(storageRoot.value, loaded.data)
      if (result.success) await refreshConversationsList()
      else error.value = result.error || '重命名会话失败'
    } catch (err) {
      error.value = err instanceof Error ? err.message : '重命名会话失败'
    }
  }

  async function maybeGenerateTitle(): Promise<void> {
    if (!pendingTitleGeneration || titleSource.value !== 'truncated') return
    pendingTitleGeneration = false
    const firstUser = messages.value.find((m) => m.role === 'user')
    if (!firstUser) return
    try {
      const result = await window.electronAPI.summarizeAiConversation(firstUser.content)
      if (result.success && result.data?.title && titleSource.value === 'truncated') {
        conversationTitle.value = result.data.title
        titleSource.value = 'llm'
        persistConversation()
      }
    } catch {
      // 保留占位标题
    }
  }

  // ===== 事件订阅 =====

  function init(): void {
    if (initialized) return
    initialized = true
    unsubscribe = window.electronAPI.onAiRunEvent((event) => handleRunEvent(event))
  }

  function dispose(): void {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    initialized = false
  }

  // ===== 运行事件归约 =====

  function ensureStreamingAssistantMessage(): AiConversationMessage {
    if (streamingAssistantMessageId) {
      const existing = messages.value.find((m) => m.id === streamingAssistantMessageId)
      if (existing) return existing
    }
    const message: AiConversationMessage = {
      id: nextId('msg'),
      role: 'assistant',
      content: ''
    }
    messages.value.push(message)
    streamingAssistantMessageId = message.id
    return message
  }

  function handleRunEvent(event: AiRunEvent): void {
    if (event.type === 'run-started') {
      activeRunId.value = event.runId
      running.value = true
      return
    }

    if (event.runId !== activeRunId.value) return

    switch (event.type) {
      case 'text-delta': {
        const message = ensureStreamingAssistantMessage()
        message.content += event.text
        break
      }
      case 'tool-call-started':
        // 确保有消息容器来承载工具调用（某些模型先发工具调用再发文本）
        ensureStreamingAssistantMessage()
        toolCalls.value.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'running',
          messageId: streamingAssistantMessageId ?? undefined
        })
        break
      case 'tool-call-completed': {
        const message = messages.value.find((m) => m.id === streamingAssistantMessageId)
        lastToolCallContentLength = message ? message.content.length : -1
        const call = toolCalls.value.find((c) => c.toolCallId === event.toolCallId)
        if (call) {
          call.status = event.result.status === 'completed' || event.result.status === 'applied' ? 'completed' : 'failed'
          call.result = event.result
        }
        break
      }
      case 'approval-required': {
        // 不能靠工具调用反查归属消息：主进程是先执行工具、后上报 tool-call，
        // 审批事件比 tool-call-started 先到（见 electron/ai/__tests__/e2e.test.ts E4）。
        // 审批一定属于当前正在流式输出的这条助手消息，直接挂上去。
        const message = ensureStreamingAssistantMessage()
        approvalMessageIds.set(event.approval.id, message.id)
        pendingApprovals.value.push(event.approval)
        // 立刻写进会话记录，卡片从「等待批准」就地变成「已允许/已拒绝」
        approvalHistory.value.push(toApprovalRecord(event.approval, message.id))
        persistConversation()
        break
      }
      case 'run-completed':
        if (startRequestPending) terminalRunsDuringStart.add(event.runId)
        running.value = false
        activeRunId.value = null
        finalizeStreamingAssistantMessage()
        discardApprovalsForRun(event.runId)
        persistConversation()
        void maybeGenerateTitle()
        break
      case 'run-failed':
        if (startRequestPending) terminalRunsDuringStart.add(event.runId)
        running.value = false
        activeRunId.value = null
        finalizeStreamingAssistantMessage()
        discardApprovalsForRun(event.runId)
        messages.value.push({
          id: nextId('msg'),
          role: 'assistant',
          content: event.error.message
        })
        persistConversation()
        void maybeGenerateTitle()
        break
      case 'run-cancelled':
        if (startRequestPending) terminalRunsDuringStart.add(event.runId)
        running.value = false
        activeRunId.value = null
        finalizeStreamingAssistantMessage()
        discardApprovalsForRun(event.runId)
        persistConversation()
        void maybeGenerateTitle()
        break
    }
  }

  // ===== 发送消息 =====

  async function sendMessage(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || running.value || pendingStartPromise) return

    if (!activeConversationId.value) {
      activeConversationId.value = generateConversationId()
      conversationTitle.value = truncateTitle(trimmed)
      conversationCreatedAt.value = Date.now()
      titleSource.value = 'truncated'
    }

    messages.value.push({
      id: nextId('msg'),
      role: 'user',
      content: text,
      createdAt: Date.now()
    })

    const isFirstTurn = messages.value.filter((m) => m.role === 'user').length === 1
    if (isFirstTurn) pendingTitleGeneration = true

    const fileStore = useFileStore()
    // history 不包含刚追加的用户消息（用户消息通过 message 字段单独传递）
    // 深拷贝去除 Vue 响应式代理，避免 IPC 结构化克隆失败
    const history = JSON.parse(JSON.stringify(messages.value.slice(0, -1))) as AiConversationMessage[]

    const snapshot = createExecutionSnapshot(fileStore)

    const input: AiRunInput = {
      conversationId: activeConversationId.value!,
      message: text,
      history,
      snapshot: { ...snapshot, conversationId: activeConversationId.value! }
    }

    persistConversation()
    running.value = true
    startRequestPending = true
    const startOperation = async (): Promise<void> => {
      try {
        const result = await window.electronAPI.startAiRun(input)
        if (result.success && result.data) {
          if (terminalRunsDuringStart.delete(result.data.runId)) return
          activeRunId.value = result.data.runId
        } else {
          running.value = false
          activeRunId.value = null
          finalizeStreamingAssistantMessage()
          messages.value.push({
            id: nextId('msg'),
            role: 'assistant',
            content: result.error || '启动 AI 运行失败'
          })
        }
      } catch (err) {
        running.value = false
        activeRunId.value = null
        finalizeStreamingAssistantMessage()
        messages.value.push({
          id: nextId('msg'),
          role: 'assistant',
          content: err instanceof Error ? err.message : '启动 AI 运行失败'
        })
      } finally {
        startRequestPending = false
        terminalRunsDuringStart.clear()
        pendingStartPromise = null
      }
    }
    pendingStartPromise = startOperation()
    await pendingStartPromise
  }

  // ===== 消息撤回 =====

  /**
   * 撤回一条用户消息：删除该消息及其后所有消息（含 assistant 回复、工具调用、待审批），
   * 把原文回填到输入框供用户修改后重发。运行中或存在待审批时不允许撤回。
   * 返回被撤回消息的 content；不可撤回时返回 null。
   */
  function recallMessage(messageId: string): string | null {
    if (running.value || pendingStartPromise || pendingApprovals.value.length > 0) return null

    const index = messages.value.findIndex((m) => m.id === messageId && m.role === 'user')
    if (index === -1) return null

    const recalled = messages.value[index]
    const removedIds = new Set(messages.value.slice(index).map((m) => m.id))
    messages.value = messages.value.slice(0, index)
    toolCalls.value = toolCalls.value.filter((c) => !c.messageId || !removedIds.has(c.messageId))
    approvalHistory.value = approvalHistory.value.filter(
      (record) => !record.messageId || !removedIds.has(record.messageId)
    )
    discardAllApprovals()
    syncIdCounterFromMessages()
    persistConversation()
    return recalled.content
  }

  // ===== 审批解析 =====

  async function resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    result?: ToolExecutionResult
  ): Promise<void> {
    const approval = pendingApprovals.value.find((a) => a.id === approvalId)
    if (!approval) return

    if (decision.status === 'approved' && Date.now() >= approval.expiresAt) {
      try {
        const response = await window.electronAPI.resolveAiApproval(approvalId, { status: 'expired' })
        if (!response.success) {
          error.value = response.error || '提交审批结果失败'
          return
        }
        pendingApprovals.value = pendingApprovals.value.filter((item) => item.id !== approvalId)
        settleApprovalRecord(approval, { status: 'expired' })
        persistConversation()
      } catch (err) {
        error.value = err instanceof Error ? err.message : '提交审批结果失败'
      }
      return
    }

    let state = approvalResolutions.get(approvalId)
    if (state && state.approval !== approval) {
      approvalResolutions.delete(approvalId)
      state = undefined
    }
    if (!state) {
      state = { approval, decision: { ...decision }, result, claimed: false, promise: null }
      approvalResolutions.set(approvalId, state)
    }
    if (state.promise) return state.promise

    const resolutionState = state
    const resolution = async (): Promise<void> => {
      try {
        let actualResult = resolutionState.result
        if (resolutionState.decision.status === 'approved' && approval.execution.location === 'renderer') {
          if (!resolutionState.claimed) {
            const claim = await window.electronAPI.claimAiApproval(approvalId)
            if (!claim.success) {
              error.value = claim.error || '认领审批失败'
              return
            }
            resolutionState.claimed = true
          }
          if (!actualResult) {
            const fileStore = useFileStore()
            actualResult = await applyDocumentOperation(
              fileStore,
              approval.execution.operation,
              deactivatePanel
            )
            if (approvalResolutions.get(approvalId) !== resolutionState) return
            resolutionState.result = actualResult
          }
        }

        const response = actualResult === undefined
          ? await window.electronAPI.resolveAiApproval(approvalId, resolutionState.decision)
          : await window.electronAPI.resolveAiApproval(approvalId, resolutionState.decision, actualResult)
        if (!response.success) {
          error.value = response.error || '提交审批结果失败'
          return
        }
      } catch (err) {
        error.value = err instanceof Error ? err.message : '提交审批结果失败'
        return
      }

      if (approvalResolutions.get(approvalId) !== resolutionState) return
      approvalResolutions.delete(approvalId)
      pendingApprovals.value = pendingApprovals.value.filter((item) => item.id !== approvalId)
      settleApprovalRecord(approval, resolutionState.decision, resolutionState.result?.status)
      persistConversation()
    }

    resolutionState.promise = resolution().finally(() => {
      if (approvalResolutions.get(approvalId) === resolutionState) resolutionState.promise = null
    })
    return resolutionState.promise
  }

  return {
    // state
    panelOpen,
    panelActive,
    tabIndex,
    messages,
    toolCalls,
    activeRunId,
    running,
    pendingApprovals,
    approvalHistory,
    conversations,
    activeConversationId,
    storageRoot,
    conversationTitle,
    conversationCreatedAt,
    titleSource,
    error,
    // actions
    openPanel,
    activatePanel,
    deactivatePanel,
    setTabIndex,
    requestClosePanel,
    loadConversations,
    openConversation,
    newConversation,
    deleteConversation,
    renameConversation,
    persistConversation,
    sendMessage,
    cancelRun,
    recallMessage,
    resolveApproval,
    init,
    dispose
  }
})
