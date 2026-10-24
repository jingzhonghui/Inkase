import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiStore } from '../ai'
import { useFileStore } from '../file'
import { createExecutionSnapshot } from '../../utils/ai/workspace-context'
import * as workspaceContext from '../../utils/ai/workspace-context'
import { requestDialog } from '../../utils/dialog'
import type { AiRunEvent, ToolApprovalRequest } from '../../../shared/ai/types'
import { aiRunInputSchema } from '../../../shared/ai/contracts'

vi.mock('../../utils/dialog', () => ({
  requestDialog: vi.fn()
}))

function makeApproval(overrides: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest {
  return {
    id: 'approval-1',
    runId: 'r1',
    toolCallId: 'tc1',
    toolName: 'edit_document',
    title: '编辑文档',
    description: 'desc',
    effect: 'write',
    riskLevel: 'medium',
    preview: { type: 'markdown-diff', title: 'diff', before: '', after: '' },
    execution: { location: 'main' },
    createdAt: Date.now(),
    expiresAt: Date.now() + 10_000,
    ...overrides
  }
}

describe('ai store', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let electronApi: Record<string, any>
  let eventHandler: ((event: AiRunEvent) => void) | null

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })

    eventHandler = null
    electronApi = {
      getAiConfig: vi.fn(),
      setAiConfig: vi.fn(),
      testAiConfig: vi.fn(),
      startAiRun: vi.fn(),
      cancelAiRun: vi.fn(),
      claimAiApproval: vi.fn(),
      resolveAiApproval: vi.fn(),
      listAiConversations: vi.fn(async () => ({ success: true, data: [] })),
      loadAiConversation: vi.fn(),
      saveAiConversation: vi.fn(async () => ({ success: true })),
      deleteAiConversation: vi.fn(async () => ({ success: true })),
      summarizeAiConversation: vi.fn(async () => ({ success: true, data: { title: '标题' } })),
      createAiSnapshot: vi.fn(),
      listAiSnapshots: vi.fn(async () => ({ success: true, data: [] })),
      rollbackAiSnapshot: vi.fn(),
      onAiRunEvent: vi.fn((cb: (event: AiRunEvent) => void) => {
        eventHandler = cb
        return () => {
          eventHandler = null
        }
      })
    }
    electronApi.claimAiApproval.mockResolvedValue({ success: true })
    vi.stubGlobal('window', { electronAPI: electronApi })
  })

  const emit = (event: AiRunEvent): void => {
    eventHandler!(event)
  }

  describe('panel lifecycle', () => {
    it('starts with an empty conversation state', () => {
      const store = useAiStore()

      // 面板开关归 dock store，AI store 不再持有 panelOpen / panelActive
      expect(store).not.toHaveProperty('panelOpen')
      expect(store).not.toHaveProperty('panelActive')
      expect(store.messages).toEqual([])
      expect(store).not.toHaveProperty('materials')
      expect(store.activeRunId).toBeNull()
      expect(store.running).toBe(false)
      expect(store.pendingApprovals).toEqual([])
      expect(store.activeConversationId).toBeNull()
      expect(store.conversations).toEqual([])
    })

    it('always allows closing when idle, keeping the session intact', async () => {
      const store = useAiStore()
      store.messages.push({ id: 'm1', role: 'user', content: 'hi' })

      await expect(store.requestClose()).resolves.toBe(true)

      // 关闭只收起面板，会话内容留在 store 里
      expect(store.messages).toHaveLength(1)
      expect(electronApi.cancelAiRun).not.toHaveBeenCalled()
    })
  })

  describe('requestClose while running', () => {
    it('refuses to close when the dialog is cancelled', async () => {
      const store = useAiStore()
      store.activeRunId = 'r1'
      store.running = true
      vi.mocked(requestDialog).mockResolvedValue(1) // 取消

      await expect(store.requestClose()).resolves.toBe(false)

      expect(store.running).toBe(true)
      expect(store.activeRunId).toBe('r1')
      expect(electronApi.cancelAiRun).not.toHaveBeenCalled()
    })

    it('confirms, cancels the run, then reports it may close', async () => {
      const store = useAiStore()
      store.activeRunId = 'r1'
      store.running = true
      store.pendingApprovals.push(makeApproval({ id: 'a1', runId: 'r1' }))
      vi.mocked(requestDialog).mockResolvedValue(0) // 确认关闭
      electronApi.cancelAiRun.mockResolvedValue({ success: true })

      await expect(store.requestClose()).resolves.toBe(true)

      expect(electronApi.cancelAiRun).toHaveBeenCalledWith('r1')
      expect(store.pendingApprovals).toEqual([])
      expect(store.running).toBe(false)
    })

    it('keeps the run state when cancellation is rejected', async () => {
      const store = useAiStore()
      store.activeRunId = 'r1'
      store.running = true
      store.pendingApprovals.push(makeApproval({ id: 'a1', runId: 'r1' }))
      vi.mocked(requestDialog).mockResolvedValue(0)
      electronApi.cancelAiRun.mockResolvedValue({ success: false, error: 'cancel failed' })

      await expect(store.requestClose()).resolves.toBe(false)

      expect(store.running).toBe(true)
      expect(store.activeRunId).toBe('r1')
      expect(store.pendingApprovals).toHaveLength(1)
      expect(store.error).toBe('cancel failed')
    })

    it('waits for a pending start and cancels its eventual run before closing', async () => {
      const store = useAiStore()
      vi.mocked(requestDialog).mockResolvedValue(0)
      let resolveStart!: (value: { success: true; data: { runId: string } }) => void
      electronApi.startAiRun.mockImplementation(
        () => new Promise((resolve) => {
          resolveStart = resolve
        })
      )
      electronApi.cancelAiRun.mockResolvedValue({ success: true })

      const sendPromise = store.sendMessage('hello')
      const closePromise = store.requestClose()
      await Promise.resolve()

      resolveStart({ success: true, data: { runId: 'r1' } })
      const [closed] = await Promise.all([closePromise, sendPromise])

      expect(closed).toBe(true)
      expect(electronApi.cancelAiRun).toHaveBeenCalledWith('r1')
      expect(store.activeRunId).toBeNull()
      expect(store.running).toBe(false)
    })

    it('waits for start ownership before closing after an early terminal event', async () => {
      const store = useAiStore()
      store.init()
      vi.mocked(requestDialog).mockResolvedValue(0)
      let resolveStart!: (value: { success: true; data: { runId: string } }) => void
      electronApi.startAiRun.mockImplementation(
        () => new Promise((resolve) => {
          resolveStart = resolve
        })
      )
      electronApi.cancelAiRun.mockResolvedValue({ success: true })

      const send = store.sendMessage('hello')
      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'run-completed', runId: 'r1' })
      const close = store.requestClose()
      await Promise.resolve()

      resolveStart({ success: true, data: { runId: 'r1' } })
      const [closed] = await Promise.all([close, send])
      expect(closed).toBe(true)
    })
  })

  describe('init / dispose', () => {
    it('subscribes once on init and unsubscribes on dispose', () => {
      const store = useAiStore()

      store.init()
      store.init()

      expect(electronApi.onAiRunEvent).toHaveBeenCalledTimes(1)
      expect(eventHandler).not.toBeNull()

      store.dispose()
      expect(eventHandler).toBeNull()
    })
  })

  describe('run event reduction', () => {
    it('reduces run-started/text-delta/tool-call/approval/run-completed events', () => {
      const store = useAiStore()
      store.init()

      emit({ type: 'run-started', runId: 'r1' })
      expect(store.activeRunId).toBe('r1')
      expect(store.running).toBe(true)

      emit({ type: 'text-delta', runId: 'r1', text: 'Hello' })
      emit({ type: 'text-delta', runId: 'r1', text: ' world' })
      expect(store.messages).toHaveLength(1)
      expect(store.messages[0].role).toBe('assistant')
      expect(store.messages[0].content).toBe('Hello world')

      emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'tc1', toolName: 'search' })
      expect(store.toolCalls).toHaveLength(1)
      expect(store.toolCalls[0].toolName).toBe('search')
      expect(store.toolCalls[0].status).toBe('running')

      emit({ type: 'tool-call-completed', runId: 'r1', toolCallId: 'tc1', result: { status: 'completed' } })
      expect(store.toolCalls[0].status).toBe('completed')
      expect(store.toolCalls[0].result).toEqual({ status: 'completed' })

      emit({ type: 'approval-required', runId: 'r1', approval: makeApproval() })
      expect(store.pendingApprovals).toHaveLength(1)

      emit({ type: 'run-completed', runId: 'r1' })
      expect(store.running).toBe(false)
      expect(store.activeRunId).toBeNull()
      expect(store.pendingApprovals).toEqual([])
    })

    it('inserts a missing analysis end marker before text generated after the last tool call', () => {
      const store = useAiStore()
      store.init()

      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'text-delta', runId: 'r1', text: '<!-- analysis -->\n正在查找工作记录。' })
      emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'tc1', toolName: 'search' })
      emit({ type: 'tool-call-completed', runId: 'r1', toolCallId: 'tc1', result: { status: 'completed' } })
      emit({ type: 'text-delta', runId: 'r1', text: '\n今天的工作内容是完成文档修改。' })
      emit({ type: 'run-completed', runId: 'r1' })

      expect(store.messages[0].content).toBe(
        '<!-- analysis -->\n正在查找工作记录。\n<!-- end-analysis -->\n今天的工作内容是完成文档修改。'
      )
    })

    it('inserts both analysis markers when LLM outputs no markers at all', () => {
      const store = useAiStore()
      store.init()

      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'text-delta', runId: 'r1', text: '正在查找工作记录。' })
      emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'tc1', toolName: 'search' })
      emit({ type: 'tool-call-completed', runId: 'r1', toolCallId: 'tc1', result: { status: 'completed' } })
      emit({ type: 'text-delta', runId: 'r1', text: '\n今天的工作内容是完成文档修改。' })
      emit({ type: 'run-completed', runId: 'r1' })

      expect(store.messages[0].content).toBe(
        '<!-- analysis -->\n正在查找工作记录。\n<!-- end-analysis -->\n今天的工作内容是完成文档修改。'
      )
    })

    it('recognizes a variant opening tag and only inserts the missing end marker', () => {
      const store = useAiStore()
      store.init()

      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'text-delta', runId: 'r1', text: '<!-- analysis -- >\n正在查找工作记录。' })
      emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'tc1', toolName: 'search' })
      emit({ type: 'tool-call-completed', runId: 'r1', toolCallId: 'tc1', result: { status: 'completed' } })
      emit({ type: 'text-delta', runId: 'r1', text: '\n今天的工作内容是完成文档修改。' })
      emit({ type: 'run-completed', runId: 'r1' })

      expect(store.messages[0].content).toBe(
        '<!-- analysis -- >\n正在查找工作记录。\n<!-- end-analysis -->\n今天的工作内容是完成文档修改。'
      )
    })

    it('leaves a complete variant tag pair untouched', () => {
      const store = useAiStore()
      store.init()

      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'text-delta', runId: 'r1', text: '<!-- analysis -- >\n分析内容。\n<!-- end-analysis -- >\n正式回答。' })
      emit({ type: 'run-completed', runId: 'r1' })

      expect(store.messages[0].content).toBe(
        '<!-- analysis -- >\n分析内容。\n<!-- end-analysis -- >\n正式回答。'
      )
    })

    it('reduces run-failed to an error message and stops running', () => {
      const store = useAiStore()
      store.init()

      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'text-delta', runId: 'r1', text: 'partial' })
      emit({ type: 'run-failed', runId: 'r1', error: { code: 'PROVIDER_UNAVAILABLE', message: 'boom' } })

      expect(store.running).toBe(false)
      expect(store.activeRunId).toBeNull()
      const last = store.messages[store.messages.length - 1]
      expect(last.role).toBe('assistant')
      expect(last.content).toBe('boom')
      expect(store.pendingApprovals).toEqual([])
    })

    it('reduces run-cancelled and clears approvals for that run', () => {
      const store = useAiStore()
      store.init()

      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'approval-required', runId: 'r1', approval: makeApproval({ id: 'a1', runId: 'r1' }) })
      emit({ type: 'run-cancelled', runId: 'r1' })

      expect(store.running).toBe(false)
      expect(store.activeRunId).toBeNull()
      expect(store.pendingApprovals).toEqual([])
    })

    it('ignores events whose runId is not the active run', () => {
      const store = useAiStore()
      store.init()

      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'text-delta', runId: 'r2', text: 'stale' })
      expect(store.messages).toHaveLength(0)

      emit({ type: 'run-started', runId: 'r2' })
      expect(store.activeRunId).toBe('r2')
    })
  })

  describe('sendMessage', () => {
    it('appends user message, builds snapshot, and starts the run', async () => {
      const store = useAiStore()
      store.init()
      electronApi.startAiRun.mockImplementation(async (input: unknown) => {
        const parsed = aiRunInputSchema.safeParse(input)
        return parsed.success
          ? { success: true, data: { runId: 'r1' } }
          : { success: false, error: parsed.error.message }
      })

      await store.sendMessage('hello')

      expect(store.messages).toHaveLength(1)
      expect(store.messages[0].role).toBe('user')
      expect(store.messages[0].content).toBe('hello')

      expect(electronApi.startAiRun).toHaveBeenCalledTimes(1)
      const input = electronApi.startAiRun.mock.calls[0][0]
      expect(input.conversationId).toBe(store.activeConversationId)
      expect(input.message).toBe('hello')
      expect(input.history).toEqual([])
      expect(input.snapshot).not.toHaveProperty('materialIds')
      expect(input.snapshot.conversationId).toBe(store.activeConversationId)
      expect(input.snapshot).not.toHaveProperty('runId')

      expect(store.activeRunId).toBe('r1')
      expect(store.running).toBe(true)
    })

    it('carries the opened workspace root into the snapshot without fetching a summary', async () => {
      const store = useAiStore()
      store.init()
      const fileStore = useFileStore()
      fileStore.openedFolderPath = 'C:\\ws'
      electronApi.startAiRun.mockResolvedValue({ success: true, data: { runId: 'r1' } })

      await store.sendMessage('k8s 如何安装')

      expect(electronApi.ensureWorkspaceSummary).toBeUndefined()
      const input = electronApi.startAiRun.mock.calls[0][0]
      expect(input.snapshot.workspaceRoot).toBe('C:\\ws')
      expect(input.workspaceSummary).toBeUndefined()
    })

    it('keeps workspaceRoot null when no workspace folder is open', async () => {
      const store = useAiStore()
      store.init()
      electronApi.startAiRun.mockResolvedValue({ success: true, data: { runId: 'r1' } })

      await store.sendMessage('hello')

      const input = electronApi.startAiRun.mock.calls[0][0]
      expect(input.snapshot.workspaceRoot).toBeNull()
      expect(input.workspaceSummary).toBeUndefined()
    })

    it('is a no-op for empty text or when already running', async () => {
      const store = useAiStore()
      store.init()

      await store.sendMessage('   ')
      expect(electronApi.startAiRun).not.toHaveBeenCalled()
      expect(store.messages).toHaveLength(0)

      store.running = true
      await store.sendMessage('hello')
      expect(electronApi.startAiRun).not.toHaveBeenCalled()
    })

    it('passes URL and path text to Main byte-for-byte without source metadata', async () => {
      const store = useAiStore()
      const message = '结合 `C:\\Docs\\Quarterly Report.pdf` 与 https://example.com/a?x=1 总结'
      electronApi.startAiRun.mockResolvedValue({ success: true, data: { runId: 'r1' } })

      await store.sendMessage(message)

      const input = electronApi.startAiRun.mock.calls[0][0]
      expect(input.message).toBe(message)
      expect(input.history).toEqual([])
      expect(input).not.toHaveProperty('attachments')
      expect(input.snapshot).not.toHaveProperty('materialIds')
      expect(JSON.stringify(input)).toContain(message.replaceAll('\\', '\\\\'))
    })

    it('surfaces an error message when starting the run fails', async () => {
      const store = useAiStore()
      store.init()
      electronApi.startAiRun.mockResolvedValue({ success: false, error: 'no config' })

      await store.sendMessage('hello')

      expect(store.running).toBe(false)
      expect(store.activeRunId).toBeNull()
      const last = store.messages[store.messages.length - 1]
      expect(last.role).toBe('assistant')
      expect(last.content).toBe('no config')
    })

    it('does not overwrite a synchronous terminal event with the start response', async () => {
      const store = useAiStore()
      store.init()
      electronApi.startAiRun.mockImplementation(async () => {
        emit({ type: 'run-started', runId: 'r1' })
        emit({ type: 'run-completed', runId: 'r1' })
        return { success: true, data: { runId: 'r1' } }
      })

      await store.sendMessage('hello')

      expect(store.running).toBe(false)
      expect(store.activeRunId).toBeNull()
    })

    it('blocks a second send while the first start request is pending', async () => {
      const store = useAiStore()
      store.init()
      let resolveStart!: (value: { success: true; data: { runId: string } }) => void
      electronApi.startAiRun.mockImplementation(
        () => new Promise((resolve) => {
          resolveStart = resolve
        })
      )

      const first = store.sendMessage('first')
      await store.sendMessage('second')

      expect(electronApi.startAiRun).toHaveBeenCalledTimes(1)
      expect(store.messages.filter((message) => message.role === 'user')).toHaveLength(1)

      resolveStart({ success: true, data: { runId: 'r1' } })
      await first
    })

    it('keeps ownership and blocks a second send after a terminal event while start IPC is pending', async () => {
      const store = useAiStore()
      store.init()
      let resolveStart!: (value: { success: true; data: { runId: string } }) => void
      electronApi.startAiRun.mockImplementation(
        () => new Promise((resolve) => {
          resolveStart = resolve
        })
      )

      const first = store.sendMessage('first')
      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'run-completed', runId: 'r1' })
      const second = store.sendMessage('second')
      await Promise.resolve()

      expect(electronApi.startAiRun).toHaveBeenCalledTimes(1)
      expect(store.messages.filter((message) => message.role === 'user')).toHaveLength(1)

      resolveStart({ success: true, data: { runId: 'r1' } })
      await Promise.all([first, second])
    })

    it('does not retain a terminal run id after a failed start response', async () => {
      const store = useAiStore()
      store.init()
      electronApi.startAiRun
        .mockImplementationOnce(async () => {
          emit({ type: 'run-started', runId: 'r1' })
          emit({ type: 'run-completed', runId: 'r1' })
          return { success: false, error: 'failed' }
        })
        .mockResolvedValueOnce({ success: true, data: { runId: 'r1' } })

      await store.sendMessage('first')
      await store.sendMessage('second')

      expect(store.running).toBe(true)
      expect(store.activeRunId).toBe('r1')
    })
  })

  describe('cancelRun', () => {
    it('clears approvals for the cancelled run immediately after successful IPC', async () => {
      const store = useAiStore()
      store.activeRunId = 'r1'
      store.running = true
      store.pendingApprovals.push(makeApproval({ id: 'a1', runId: 'r1' }))
      electronApi.cancelAiRun.mockResolvedValue({ success: true })

      await store.cancelRun()

      expect(store.pendingApprovals).toEqual([])
      expect(store.activeRunId).toBeNull()
      expect(store.running).toBe(false)
    })

    it('waits for a pending start and cancels its eventual run id', async () => {
      const store = useAiStore()
      let resolveStart!: (value: { success: true; data: { runId: string } }) => void
      electronApi.startAiRun.mockImplementation(
        () => new Promise((resolve) => {
          resolveStart = resolve
        })
      )
      electronApi.cancelAiRun.mockResolvedValue({ success: true })

      const send = store.sendMessage('hello')
      const cancel = store.cancelRun()
      await Promise.resolve()
      expect(electronApi.cancelAiRun).not.toHaveBeenCalled()

      resolveStart({ success: true, data: { runId: 'r1' } })
      await Promise.all([send, cancel])

      expect(electronApi.cancelAiRun).toHaveBeenCalledWith('r1')
      expect(store.running).toBe(false)
    })
  })

  describe('recallMessage', () => {
    it('deletes the target user message and all subsequent messages, returns the content', () => {
      const store = useAiStore()
      store.messages.push(
        { id: 'msg_1', role: 'user', content: 'first' },
        { id: 'msg_2', role: 'assistant', content: 'reply 1' },
        { id: 'msg_3', role: 'user', content: 'second' },
        { id: 'msg_4', role: 'assistant', content: 'reply 2' }
      )
      store.toolCalls.push({ toolCallId: 'tc1', toolName: 'search_workspace', status: 'completed', messageId: 'msg_2' })

      const content = store.recallMessage('msg_3')

      expect(content).toBe('second')
      expect(store.messages).toEqual([
        { id: 'msg_1', role: 'user', content: 'first' },
        { id: 'msg_2', role: 'assistant', content: 'reply 1' }
      ])
      expect(store.toolCalls).toHaveLength(1)
    })

    it('returns null when running', () => {
      const store = useAiStore()
      store.messages.push({ id: 'msg_1', role: 'user', content: 'hi' })
      store.running = true

      expect(store.recallMessage('msg_1')).toBeNull()
      expect(store.messages).toHaveLength(1)
    })

    it('returns null when there are pending approvals', () => {
      const store = useAiStore()
      store.messages.push({ id: 'msg_1', role: 'user', content: 'hi' })
      store.pendingApprovals.push(makeApproval())

      expect(store.recallMessage('msg_1')).toBeNull()
      expect(store.messages).toHaveLength(1)
    })

    it('returns null for a non-user message', () => {
      const store = useAiStore()
      store.messages.push({ id: 'msg_1', role: 'user', content: 'hi' },
        { id: 'msg_2', role: 'assistant', content: 'reply' })

      expect(store.recallMessage('msg_2')).toBeNull()
      expect(store.messages).toHaveLength(2)
    })

    it('returns null for an unknown message id', () => {
      const store = useAiStore()
      store.messages.push({ id: 'msg_1', role: 'user', content: 'hi' })

      expect(store.recallMessage('msg_999')).toBeNull()
      expect(store.messages).toHaveLength(1)
    })

    it('persists the conversation after recall', async () => {
      const store = useAiStore()
      store.activeConversationId = 'conv_1'
      store.messages.push(
        { id: 'msg_1', role: 'user', content: 'hi' },
        { id: 'msg_2', role: 'assistant', content: 'reply' }
      )
      electronApi.saveAiConversation.mockClear()

      store.recallMessage('msg_1')

      await vi.waitFor(() => expect(electronApi.saveAiConversation).toHaveBeenCalled())
    })
  })

  describe('resolveApproval', () => {
    it('remembers a session approval and auto-resolves later calls for the same tool', async () => {
      const store = useAiStore()
      store.init()
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })
      emit({ type: 'run-started', runId: 'r1' })
      emit({
        type: 'approval-required',
        runId: 'r1',
        approval: makeApproval({
          id: 'a1',
          supportsRememberDecision: true,
          execution: { location: 'main' }
        })
      })

      await store.resolveApproval('a1', {
        status: 'approved',
        scope: 'session',
        toolName: 'edit_document'
      })
      expect(store.pendingApprovals).toEqual([])

      emit({
        type: 'approval-required',
        runId: 'r1',
        approval: makeApproval({
          id: 'a2',
          toolCallId: 'tc2',
          supportsRememberDecision: true,
          execution: { location: 'main' }
        })
      })

      await vi.waitFor(() => expect(electronApi.resolveAiApproval).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(store.pendingApprovals).toEqual([]))
      expect(electronApi.resolveAiApproval.mock.calls[1][1]).toEqual({
        status: 'approved',
        scope: 'session',
        toolName: 'edit_document'
      })
    })

    it('does not carry session approvals into a new conversation', async () => {
      const store = useAiStore()
      store.init()
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })
      emit({ type: 'run-started', runId: 'r1' })
      emit({
        type: 'approval-required',
        runId: 'r1',
        approval: makeApproval({ id: 'a1', supportsRememberDecision: true, execution: { location: 'main' } })
      })
      await store.resolveApproval('a1', {
        status: 'approved',
        scope: 'session',
        toolName: 'edit_document'
      })

      store.newConversation()
      emit({
        type: 'approval-required',
        runId: 'r1',
        approval: makeApproval({ id: 'a2', supportsRememberDecision: true, execution: { location: 'main' } })
      })

      expect(store.pendingApprovals).toHaveLength(1)
      expect(electronApi.resolveAiApproval).toHaveBeenCalledTimes(1)
    })

    it('approves a main approval without claiming or returning a renderer result', async () => {
      const store = useAiStore()
      const apply = vi.spyOn(workspaceContext, 'applyDocumentOperation')
      store.pendingApprovals.push(makeApproval({ id: 'a1', execution: { location: 'main' } }))
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      expect(electronApi.resolveAiApproval).toHaveBeenCalledWith(
        'a1',
        { status: 'approved', scope: 'once' }
      )
      expect(electronApi.claimAiApproval).not.toHaveBeenCalled()
      expect(apply).not.toHaveBeenCalled()
      expect(store.pendingApprovals).toEqual([])
    })

    it.each(['main', 'renderer'] as const)(
      'rejects a %s approval without claiming or applying it',
      async (location) => {
        const store = useAiStore()
        const apply = vi.spyOn(workspaceContext, 'applyDocumentOperation')
        const execution = location === 'main'
          ? { location } as const
          : {
              location,
              operation: {
                type: 'create-document' as const,
                title: '标题',
                content: '正文',
                format: 'markdown' as const,
                reason: ''
              }
            }
        store.pendingApprovals.push(makeApproval({ id: 'a1', execution }))
        electronApi.resolveAiApproval.mockResolvedValue({ success: true })

        await store.resolveApproval('a1', { status: 'rejected' })

        expect(electronApi.resolveAiApproval).toHaveBeenCalledWith('a1', { status: 'rejected' })
        expect(electronApi.claimAiApproval).not.toHaveBeenCalled()
        expect(apply).not.toHaveBeenCalled()
      }
    )

    it('rejects an expired renderer approval before mutating the document', async () => {
      const fileStore = useFileStore()
      const tab = fileStore.createGeneratedDocument('标题', 'old', 'markdown')
      const snap = createExecutionSnapshot(fileStore)
      const store = useAiStore()
      store.pendingApprovals.push(makeApproval({
        id: 'a1',
        expiresAt: Date.now() - 1,
        execution: {
          location: 'renderer',
          operation: { type: 'replace-document', target: snap.activeDocument!, content: 'new', reason: '' }
        }
      }))
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      expect(tab.content).toBe('old')
      expect(electronApi.resolveAiApproval).toHaveBeenCalledWith('a1', { status: 'expired' })
      expect(store.pendingApprovals).toEqual([])
    })

    it('forwards a rejected decision and removes the approval', async () => {
      const store = useAiStore()
      store.init()
      store.pendingApprovals.push(makeApproval({ id: 'a1' }))
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })

      await store.resolveApproval('a1', { status: 'rejected', reason: 'no' })

      expect(electronApi.resolveAiApproval).toHaveBeenCalledWith('a1', { status: 'rejected', reason: 'no' })
      expect(store.pendingApprovals).toEqual([])
    })

    it('snapshots the document before a renderer write', async () => {
      const fileStore = useFileStore()
      fileStore.openedFolderPath = 'C:/vault'
      const tab = fileStore.createGeneratedDocument('标题', 'old', 'markdown')
      const snap = createExecutionSnapshot(fileStore)
      const store = useAiStore()
      store.pendingApprovals.push(makeApproval({
        id: 'a1',
        runId: 'r1',
        toolName: 'replace_current_document',
        execution: {
          location: 'renderer',
          operation: { type: 'replace-document', target: snap.activeDocument!, content: 'new', reason: '' }
        }
      }))
      electronApi.claimAiApproval.mockResolvedValue({ success: true })
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })
      electronApi.createAiSnapshot.mockResolvedValue({
        success: true,
        data: {
          version: 1,
          runId: 'r1',
          conversationId: '',
          toolName: 'replace_current_document',
          createdAt: 1,
          files: []
        }
      })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      expect(electronApi.createAiSnapshot).toHaveBeenCalledWith({
        runId: 'r1',
        conversationId: '',
        toolName: 'replace_current_document',
        files: [expect.objectContaining({
          path: null,
          documentId: tab!.id,
          content: 'old',
          scope: 'memory'
        })]
      })
      expect(tab!.content).toBe('new')
    })

    it('claims an approved renderer approval before applying the operation', async () => {
      const fileStore = useFileStore()
      const tab = fileStore.createGeneratedDocument('标题', 'old', 'markdown')
      const snap = createExecutionSnapshot(fileStore)

      const store = useAiStore()
      store.init()
      store.pendingApprovals.push(
        makeApproval({
          id: 'a1',
          runId: 'r1',
          execution: {
            location: 'renderer',
            operation: {
              type: 'replace-document',
              target: snap.activeDocument!,
              content: 'new',
              reason: ''
            }
          }
        })
      )
      electronApi.claimAiApproval.mockResolvedValue({ success: true })
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      expect(tab.content).toBe('new')
      expect(electronApi.claimAiApproval).toHaveBeenCalledWith('a1')
      expect(electronApi.claimAiApproval.mock.invocationCallOrder[0]).toBeLessThan(
        electronApi.resolveAiApproval.mock.invocationCallOrder[0]
      )
      expect(electronApi.resolveAiApproval).toHaveBeenCalledWith(
        'a1',
        { status: 'approved', scope: 'once' },
        { status: 'applied' }
      )
      expect(store.pendingApprovals).toEqual([])
    })

    it('does not mutate when the renderer approval claim is rejected', async () => {
      const fileStore = useFileStore()
      const tab = fileStore.createGeneratedDocument('标题', 'old', 'markdown')
      const snap = createExecutionSnapshot(fileStore)
      const store = useAiStore()
      store.pendingApprovals.push(makeApproval({
        id: 'a1',
        execution: {
          location: 'renderer',
          operation: { type: 'replace-document', target: snap.activeDocument!, content: 'new', reason: '' }
        }
      }))
      electronApi.claimAiApproval.mockResolvedValue({ success: false, error: '审批不存在或已失效' })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      expect(tab.content).toBe('old')
      expect(electronApi.resolveAiApproval).not.toHaveBeenCalled()
      expect(store.pendingApprovals).toHaveLength(1)
    })

    it('keeps an approval and resends the applied result when IPC resolution fails', async () => {
      const fileStore = useFileStore()
      const tab = fileStore.createGeneratedDocument('标题', 'old', 'markdown')
      const snap = createExecutionSnapshot(fileStore)

      const store = useAiStore()
      store.pendingApprovals.push(
        makeApproval({
          id: 'a1',
          execution: {
            location: 'renderer',
            operation: {
              type: 'replace-document',
              target: snap.activeDocument!,
              content: 'new',
              reason: ''
            }
          }
        })
      )
      electronApi.resolveAiApproval
        .mockResolvedValueOnce({ success: false, error: 'resolve failed' })
        .mockResolvedValueOnce({ success: true })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      expect(tab.content).toBe('new')
      expect(tab.revision).toBe(1)
      expect(store.pendingApprovals).toHaveLength(1)
      expect(store.error).toBe('resolve failed')

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      expect(tab.revision).toBe(1)
      expect(electronApi.resolveAiApproval).toHaveBeenLastCalledWith(
        'a1',
        { status: 'approved', scope: 'once' },
        { status: 'applied' }
      )
      expect(store.pendingApprovals).toEqual([])
    })

    it('clears cached renderer results when a terminal event discards an approval', async () => {
      const fileStore = useFileStore()
      const tab = fileStore.createGeneratedDocument('标题', 'old', 'markdown')
      const firstSnap = createExecutionSnapshot(fileStore)

      const store = useAiStore()
      store.init()
      emit({ type: 'run-started', runId: 'r1' })
      store.pendingApprovals.push(
        makeApproval({
          id: 'a1',
          runId: 'r1',
          execution: {
            location: 'renderer',
            operation: {
              type: 'replace-document',
              target: firstSnap.activeDocument!,
              content: 'new',
              reason: ''
            }
          }
        })
      )
      electronApi.resolveAiApproval.mockResolvedValueOnce({ success: false, error: 'resolve failed' })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })
      emit({ type: 'run-failed', runId: 'r1', error: { code: 'PROVIDER_UNAVAILABLE', message: 'boom' } })

      const secondSnap = createExecutionSnapshot(fileStore)
      store.pendingApprovals.push(
        makeApproval({
          id: 'a1',
          runId: 'r2',
          execution: {
            location: 'renderer',
            operation: {
              type: 'replace-document',
              target: secondSnap.activeDocument!,
              content: 'newer',
              reason: ''
            }
          }
        })
      )
      electronApi.resolveAiApproval.mockResolvedValueOnce({ success: true })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      expect(tab.content).toBe('newer')
      expect(tab.revision).toBe(2)
    })

    it('removes a resolved approval by id when the list changes during IPC', async () => {
      const store = useAiStore()
      store.pendingApprovals.push(makeApproval({ id: 'a1' }), makeApproval({ id: 'a2' }))
      let resolveIpc!: (value: { success: true }) => void
      electronApi.resolveAiApproval.mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveIpc = resolve
        })
      )

      const resolving = store.resolveApproval('a2', { status: 'rejected', reason: 'no' })
      store.pendingApprovals.splice(0, 1)
      store.pendingApprovals.push(makeApproval({ id: 'a3' }))
      resolveIpc({ success: true })
      await resolving

      expect(store.pendingApprovals.map((approval) => approval.id)).toEqual(['a3'])
    })

    it('locks the first approval decision while it is in flight', async () => {
      const fileStore = useFileStore()
      const tab = fileStore.createGeneratedDocument('标题', 'old', 'markdown')
      const snap = createExecutionSnapshot(fileStore)
      const store = useAiStore()
      store.pendingApprovals.push(makeApproval({
        id: 'a1',
        execution: {
          location: 'renderer',
          operation: { type: 'replace-document', target: snap.activeDocument!, content: 'new', reason: '' }
        }
      }))
      const resolvers: Array<(value: { success: true }) => void> = []
      electronApi.resolveAiApproval.mockImplementation(
        () => new Promise((resolve) => {
          resolvers.push(resolve)
        })
      )

      const approved = store.resolveApproval('a1', { status: 'approved', scope: 'once' })
      const rejected = store.resolveApproval('a1', { status: 'rejected', reason: 'too late' })
      await vi.waitFor(() => expect(resolvers).toHaveLength(1))
      resolvers.forEach((resolve) => resolve({ success: true }))
      await Promise.all([approved, rejected])

      expect(tab.content).toBe('new')
      expect(tab.revision).toBe(1)
      expect(electronApi.resolveAiApproval).toHaveBeenCalledTimes(1)
      expect(electronApi.resolveAiApproval.mock.calls[0][1]).toEqual({ status: 'approved', scope: 'once' })
    })

    it('snapshots the approval decision before awaiting renderer work', async () => {
      const fileStore = useFileStore()
      fileStore.createGeneratedDocument('标题', 'old', 'markdown')
      const snap = createExecutionSnapshot(fileStore)
      const store = useAiStore()
      store.pendingApprovals.push(makeApproval({
        id: 'a1',
        execution: {
          location: 'renderer',
          operation: { type: 'replace-document', target: snap.activeDocument!, content: 'new', reason: '' }
        }
      }))
      const decision = { status: 'approved', scope: 'once' } as const
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })

      const resolving = store.resolveApproval('a1', decision)
      ;(decision as { status: string }).status = 'rejected'
      await resolving

      expect(electronApi.resolveAiApproval.mock.calls[0][1]).toEqual({ status: 'approved', scope: 'once' })
    })

    it('does not cache a renderer result after a terminal event discarded its approval', async () => {
      const fileStore = useFileStore()
      fileStore.createGeneratedDocument('标题', 'old', 'markdown')
      const snap = createExecutionSnapshot(fileStore)
      let resolveApply!: (value: { status: 'applied' }) => void
      const apply = vi.spyOn(workspaceContext, 'applyDocumentOperation')
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveApply = resolve
        }))
        .mockResolvedValueOnce({ status: 'applied' })
      const store = useAiStore()
      store.init()
      emit({ type: 'run-started', runId: 'r1' })
      const approval = makeApproval({
        id: 'a1',
        runId: 'r1',
        execution: {
          location: 'renderer',
          operation: { type: 'replace-document', target: snap.activeDocument!, content: 'new', reason: '' }
        }
      })
      store.pendingApprovals.push(approval)
      electronApi.resolveAiApproval.mockResolvedValue({ success: false, error: 'stale' })

      const staleResolution = store.resolveApproval('a1', { status: 'approved', scope: 'once' })
      await vi.waitFor(() => expect(resolveApply).toBeTypeOf('function'))
      emit({ type: 'run-cancelled', runId: 'r1' })
      resolveApply({ status: 'applied' })
      await staleResolution

      store.pendingApprovals.push({ ...approval, runId: 'r2' })
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })
      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      expect(apply).toHaveBeenCalledTimes(2)
    })

    it('reveals an approved generated document as the active tab', async () => {
      const store = useAiStore()
      store.pendingApprovals.push(makeApproval({
        id: 'a1',
        execution: {
          location: 'renderer',
          operation: {
            type: 'create-document',
            title: 'Generated',
            content: 'visible content',
            format: 'markdown',
            reason: ''
          }
        }
      }))
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      // AI 住在停靠区，不再需要「让出内容区」；新文档直接成为当前标签
      const fileStore = useFileStore()
      expect(fileStore.fileContent).toBe('visible content')
      expect(fileStore.activeTab?.fileInfo?.name).toBe('Generated.md')
    })
  })

  describe('approval records in the conversation', () => {
    /** 起一个已产生工具调用、正等待审批的运行 */
    function raiseApproval(store: ReturnType<typeof useAiStore>, approval = makeApproval({ id: 'a1', runId: 'r1' })): void {
      store.init()
      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'tc1', toolName: 'edit_document' })
      emit({ type: 'approval-required', runId: 'r1', approval })
    }

    /**
     * 主进程的真实顺序：工具先执行、后上报 tool-call，
     * 所以审批事件比 tool-call-started 先到（e2e E4 有断言）。
     * 这条路径必须照样能把审批挂到消息上，否则卡片会掉到会话末尾。
     */
    function raiseApprovalBeforeToolCall(store: ReturnType<typeof useAiStore>): void {
      store.init()
      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'text-delta', runId: 'r1', text: '我先读一下当前文档。' })
      emit({ type: 'approval-required', runId: 'r1', approval: makeApproval({ id: 'a1', runId: 'r1' }) })
      emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'tc1', toolName: 'edit_document' })
    }

    it('records the request as soon as it is raised, attached to its assistant message', () => {
      const store = useAiStore()
      raiseApproval(store)

      expect(store.approvalHistory).toHaveLength(1)
      expect(store.approvalHistory[0]).toMatchObject({
        id: 'a1',
        toolName: 'edit_document',
        title: '编辑文档',
        effect: 'write',
        riskLevel: 'medium',
        messageId: store.messages[0].id
      })
      expect(store.approvalHistory[0].decision).toBeUndefined()
    })

    it('attaches the request even when it arrives before tool-call-started', () => {
      const store = useAiStore()
      raiseApprovalBeforeToolCall(store)

      // 审批和随后的工具调用落在同一条助手消息上
      expect(store.approvalHistory).toHaveLength(1)
      expect(store.approvalHistory[0].messageId).toBe(store.messages[0].id)
      expect(store.toolCalls[0].messageId).toBe(store.messages[0].id)
    })

    it('creates the owning message when an approval is the very first event', () => {
      const store = useAiStore()
      store.init()
      emit({ type: 'run-started', runId: 'r1' })
      emit({ type: 'approval-required', runId: 'r1', approval: makeApproval({ id: 'a1', runId: 'r1' }) })

      expect(store.messages).toHaveLength(1)
      expect(store.messages[0].role).toBe('assistant')
      expect(store.approvalHistory[0].messageId).toBe(store.messages[0].id)
    })

    it('keeps the record and its verdict after the run ends', async () => {
      const store = useAiStore()
      raiseApproval(store)
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })
      emit({ type: 'run-completed', runId: 'r1' })

      expect(store.pendingApprovals).toEqual([])
      expect(store.approvalHistory).toHaveLength(1)
      expect(store.approvalHistory[0].decision).toEqual({ status: 'approved', scope: 'once' })
      expect(store.approvalHistory[0].decidedAt).toBeTypeOf('number')
    })

    it('records a rejection with its reason', async () => {
      const store = useAiStore()
      raiseApproval(store)
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })

      await store.resolveApproval('a1', { status: 'rejected', reason: '不需要' })
      emit({ type: 'run-completed', runId: 'r1' })

      expect(store.approvalHistory[0].decision).toEqual({ status: 'rejected', reason: '不需要' })
    })

    it('records the execution outcome for an approved renderer operation', async () => {
      const fileStore = useFileStore()
      fileStore.createGeneratedDocument('标题', 'old', 'markdown')
      const snap = createExecutionSnapshot(fileStore)
      const store = useAiStore()
      raiseApproval(store, makeApproval({
        id: 'a1',
        runId: 'r1',
        execution: {
          location: 'renderer',
          operation: { type: 'replace-document', target: snap.activeDocument!, content: 'new', reason: '' }
        }
      }))
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })

      await store.resolveApproval('a1', { status: 'approved', scope: 'once' })

      expect(store.approvalHistory[0].outcome).toBe('applied')
    })

    it('marks approvals still pending when the run ends as cancelled instead of dropping them', () => {
      const store = useAiStore()
      raiseApproval(store)

      emit({ type: 'run-cancelled', runId: 'r1' })

      expect(store.pendingApprovals).toEqual([])
      expect(store.approvalHistory).toHaveLength(1)
      expect(store.approvalHistory[0].decision).toEqual({ status: 'cancelled' })
    })

    it('persists approvals with the conversation and restores them on reload', async () => {
      const store = useAiStore()
      store.activeConversationId = 'conv_1'
      raiseApproval(store)
      electronApi.resolveAiApproval.mockResolvedValue({ success: true })
      await store.resolveApproval('a1', { status: 'rejected', reason: 'no' })
      emit({ type: 'run-completed', runId: 'r1' })

      store.persistConversation()
      await vi.waitFor(() => expect(electronApi.saveAiConversation).toHaveBeenCalled())
      const saved = electronApi.saveAiConversation.mock.calls[0][1]
      expect(saved.approvals).toHaveLength(1)
      expect(saved.approvals[0].decision).toEqual({ status: 'rejected', reason: 'no' })

      electronApi.listAiConversations.mockResolvedValueOnce({
        success: true,
        data: [{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 2, messageCount: 1 }]
      })
      electronApi.loadAiConversation.mockResolvedValueOnce({ success: true, data: saved })
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => JSON.stringify({ aiActiveConversationId: 'conv_1' })),
        setItem: vi.fn(),
        removeItem: vi.fn()
      })

      await store.loadConversations(null)

      expect(store.approvalHistory).toHaveLength(1)
      expect(store.approvalHistory[0]).toMatchObject({ title: '编辑文档', toolName: 'edit_document' })
      expect(store.approvalHistory[0].decision).toEqual({ status: 'rejected', reason: 'no' })
    })

    it('tolerates conversation files written before approvals were recorded', async () => {
      const store = useAiStore()
      store.activeConversationId = 'conv_1'
      store.approvalHistory.push({
        ...makeApproval({ id: 'a1' }),
        decision: { status: 'approved', scope: 'once' }
      } as never)
      electronApi.listAiConversations.mockResolvedValueOnce({
        success: true,
        data: [{ id: 'conv_2', title: '旧会话', createdAt: 1, updatedAt: 2, messageCount: 0 }]
      })
      electronApi.loadAiConversation.mockResolvedValueOnce({
        success: true,
        data: {
          version: 1, id: 'conv_2', title: '旧会话', createdAt: 1, updatedAt: 2,
          messageCount: 0, messages: [], toolSummaries: []
        }
      })
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => JSON.stringify({ aiActiveConversationId: 'conv_2' })),
        setItem: vi.fn(),
        removeItem: vi.fn()
      })

      await store.loadConversations(null)

      expect(store.approvalHistory).toEqual([])
    })

    it('reattaches an approval saved without an owning message', async () => {
      const store = useAiStore()
      electronApi.listAiConversations.mockResolvedValueOnce({
        success: true,
        data: [{ id: 'conv_2', title: '旧会话', createdAt: 1, updatedAt: 2, messageCount: 1 }]
      })
      electronApi.loadAiConversation.mockResolvedValueOnce({
        success: true,
        data: {
          version: 1, id: 'conv_2', title: '旧会话', createdAt: 1, updatedAt: 2,
          messageCount: 1,
          messages: [{ id: 'msg_1', role: 'assistant', content: '读完了。' }],
          toolSummaries: [{ toolCallId: 'tc1', toolName: 'edit_document', status: 'completed', messageId: 'msg_1' }],
          // 早期版本没记下 messageId，直接落盘的就是这种记录
          approvals: [{
            ...makeApproval({ id: 'a1' }),
            decision: { status: 'approved', scope: 'once' }
          }]
        }
      })
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => JSON.stringify({ aiActiveConversationId: 'conv_2' })),
        setItem: vi.fn(),
        removeItem: vi.fn()
      })

      await store.loadConversations(null)

      // 靠 toolCallId 从工具调用摘要里补回归属，卡片才不会掉到会话末尾
      expect(store.approvalHistory).toHaveLength(1)
      expect(store.approvalHistory[0].messageId).toBe('msg_1')
    })

    it('clears approval records when starting a new conversation', () => {
      const store = useAiStore()
      raiseApproval(store)

      store.newConversation()

      expect(store.approvalHistory).toEqual([])
    })

    it('drops approval records that belong to recalled messages', () => {
      const store = useAiStore()
      store.messages.push({ id: 'msg_1', role: 'user', content: 'hi' })
      store.messages.push({ id: 'msg_2', role: 'assistant', content: 'ok' })
      store.approvalHistory.push({
        ...makeApproval({ id: 'a1' }),
        messageId: 'msg_2',
        decision: { status: 'approved', scope: 'once' }
      } as never)

      expect(store.recallMessage('msg_1')).toBe('hi')
      expect(store.approvalHistory).toEqual([])
    })
  })
})
