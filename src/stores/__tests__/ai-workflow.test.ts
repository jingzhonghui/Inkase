import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AiRunEvent, ToolApprovalRequest } from '../../../shared/ai/types'
import { useAiStore } from '../ai'
import { useFileStore } from '../file'
import { createExecutionSnapshot } from '../../utils/ai/workspace-context'
import { requestDialog } from '../../utils/dialog'

vi.mock('../../utils/dialog', () => ({ requestDialog: vi.fn() }))

describe('renderer AI workflow', () => {
  let emit: (event: AiRunEvent) => void
  const electronAPI = {
    onAiRunEvent: vi.fn(),
    cancelAiRun: vi.fn(),
    claimAiApproval: vi.fn().mockResolvedValue({ success: true }),
    resolveAiApproval: vi.fn(),
    startAiRun: vi.fn(),
    listAiConversations: vi.fn(async () => ({ success: true, data: [] })),
    loadAiConversation: vi.fn(),
    saveAiConversation: vi.fn(async () => ({ success: true })),
    deleteAiConversation: vi.fn(async () => ({ success: true })),
    summarizeAiConversation: vi.fn(async () => ({ success: true, data: { title: '标题' } }))
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    electronAPI.onAiRunEvent.mockImplementation((handler: (event: AiRunEvent) => void) => {
      emit = handler
      return vi.fn()
    })
    vi.stubGlobal('window', { electronAPI })
  })

  function rendererReplace(runId = 'run-1'): { approval: ToolApprovalRequest; targetId: string } {
    const files = useFileStore()
    const target = files.createGeneratedDocument('Target', 'before', 'markdown')
    const snapshot = createExecutionSnapshot(files)
    return {
      targetId: target.id,
      approval: {
        id: 'approval-1',
        runId,
        toolCallId: 'tool-1',
        toolName: 'edit_document',
        title: 'Replace document',
        description: 'Replace the snapshotted document',
        effect: 'write',
        riskLevel: 'medium',
        preview: { type: 'markdown-diff', title: 'Changes', before: 'before', after: 'after' },
        execution: {
          location: 'renderer',
          operation: {
            type: 'replace-document',
            target: snapshot.activeDocument!,
            content: 'after',
            reason: 'requested'
          }
        },
        createdAt: Date.now(),
        expiresAt: Date.now() + 10_000
      }
    }
  }

  function mainSourceApproval(expiresAt = Date.now() + 10_000): ToolApprovalRequest {
    return {
      id: 'source-approval', runId: 'run-1', toolCallId: 'source-1', toolName: 'read_web_url',
      title: 'read_web_url', description: 'Read approved web source', reason: 'Summarize',
      effect: 'network', riskLevel: 'medium',
      preview: { type: 'network-request', method: 'GET', url: 'https://example.com/report', reason: 'Summarize' },
      execution: { location: 'main' }, createdAt: Date.now(), expiresAt
    }
  }

  it('accumulates streamed summary deltas into one assistant message', () => {
    const ai = useAiStore()
    ai.init()
    emit({ type: 'run-started', runId: 'run-1' })
    emit({ type: 'text-delta', runId: 'run-1', text: 'Updated ' })
    emit({ type: 'text-delta', runId: 'run-1', text: 'the document.' })
    emit({ type: 'run-completed', runId: 'run-1' })

    expect(ai.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: '<!-- analysis -->\nUpdated the document.\n<!-- end-analysis -->'
      })
    ])
  })

  it('keeps approved replacement unchanged before approval, then mutates only the snapshotted tab and reports applied', async () => {
    const files = useFileStore()
    const { approval, targetId } = rendererReplace()
    const target = files.tabs.find((tab) => tab.id === targetId)!
    const other = files.createGeneratedDocument('Other', 'other', 'markdown')
    const ai = useAiStore()
    ai.pendingApprovals.push(approval)
    electronAPI.resolveAiApproval.mockResolvedValue({ success: true })

    expect(target.content).toBe('before')
    expect(other.content).toBe('other')
    await ai.resolveApproval(approval.id, { status: 'approved', scope: 'once' })

    expect(target.content).toBe('after')
    expect(target.revision).toBe(1)
    expect(other.content).toBe('other')
    expect(electronAPI.resolveAiApproval).toHaveBeenCalledWith(
      approval.id,
      { status: 'approved', scope: 'once' },
      { status: 'applied' }
    )
  })

  it('leaves the document unchanged when replacement is rejected', async () => {
    const files = useFileStore()
    const { approval, targetId } = rendererReplace()
    const ai = useAiStore()
    ai.pendingApprovals.push(approval)
    electronAPI.resolveAiApproval.mockResolvedValue({ success: true })

    await ai.resolveApproval(approval.id, { status: 'rejected', reason: 'No' })

    expect(files.tabs.find((tab) => tab.id === targetId)!.content).toBe('before')
    expect(electronAPI.resolveAiApproval).toHaveBeenCalledWith(
      approval.id,
      { status: 'rejected', reason: 'No' }
    )
  })

  it('resolves an approved Main source read without claiming or supplying a renderer result', async () => {
    const ai = useAiStore()
    const approval = mainSourceApproval()
    ai.pendingApprovals.push(approval)
    electronAPI.resolveAiApproval.mockResolvedValue({ success: true })

    await ai.resolveApproval(approval.id, { status: 'approved', scope: 'once' })

    expect(electronAPI.claimAiApproval).not.toHaveBeenCalled()
    expect(electronAPI.resolveAiApproval).toHaveBeenCalledWith(
      approval.id,
      { status: 'approved', scope: 'once' }
    )
    expect(ai.pendingApprovals).toEqual([])
  })

  it('reports an expired Main source approval without claiming or executing it', async () => {
    const ai = useAiStore()
    const approval = mainSourceApproval(Date.now() - 1)
    ai.pendingApprovals.push(approval)
    electronAPI.resolveAiApproval.mockResolvedValue({ success: true })

    await ai.resolveApproval(approval.id, { status: 'approved', scope: 'once' })

    expect(electronAPI.claimAiApproval).not.toHaveBeenCalled()
    expect(electronAPI.resolveAiApproval).toHaveBeenCalledWith(approval.id, { status: 'expired' })
    expect(ai.pendingApprovals).toEqual([])
  })

  it('reports a revision conflict without overwriting newer content', async () => {
    const files = useFileStore()
    const { approval, targetId } = rendererReplace()
    files.updateTabContent(targetId, 'user edit')
    const ai = useAiStore()
    ai.pendingApprovals.push(approval)
    electronAPI.resolveAiApproval.mockResolvedValue({ success: true })

    await ai.resolveApproval(approval.id, { status: 'approved', scope: 'once' })

    expect(files.tabs.find((tab) => tab.id === targetId)!.content).toBe('user edit')
    expect(electronAPI.resolveAiApproval).toHaveBeenCalledWith(
      approval.id,
      { status: 'approved', scope: 'once' },
      { status: 'conflict', message: '文档已被修改' }
    )
  })

  it('cancels the run, clears approvals, and starts later streaming in a new message', async () => {
    const ai = useAiStore()
    const { approval } = rendererReplace()
    ai.init()
    emit({ type: 'run-started', runId: 'run-1' })
    emit({ type: 'text-delta', runId: 'run-1', text: 'partial' })
    ai.pendingApprovals.push(approval)
    electronAPI.cancelAiRun.mockResolvedValue({ success: true })

    await ai.cancelRun()
    emit({ type: 'run-started', runId: 'run-2' })
    emit({ type: 'text-delta', runId: 'run-2', text: 'next' })

    expect(ai.pendingApprovals).toEqual([])
    expect(ai.messages.map((message) => message.content)).toEqual([
      '<!-- analysis -->\npartial\n<!-- end-analysis -->',
      'next'
    ])
  })

  it('uses the same cancellation path when closing the AI dock panel', async () => {
    const ai = useAiStore()
    const { approval } = rendererReplace()
    ai.init()
    emit({ type: 'run-started', runId: 'run-1' })
    emit({ type: 'text-delta', runId: 'run-1', text: 'partial' })
    ai.pendingApprovals.push(approval)
    vi.mocked(requestDialog).mockResolvedValue(0)
    electronAPI.cancelAiRun.mockResolvedValue({ success: true })

    await expect(ai.requestClose()).resolves.toBe(true)
    emit({ type: 'run-started', runId: 'run-2' })
    emit({ type: 'text-delta', runId: 'run-2', text: 'next' })

    expect(electronAPI.cancelAiRun).toHaveBeenCalledWith('run-1')
    expect(ai.pendingApprovals).toEqual([])
    expect(ai.messages.map((message) => message.content)).toEqual([
      '<!-- analysis -->\npartial\n<!-- end-analysis -->',
      'next'
    ])
  })
})
