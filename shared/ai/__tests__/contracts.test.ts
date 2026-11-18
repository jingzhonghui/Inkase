import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { aiRunInputSchema, approvalResolutionSchema } from '../contracts'
import { useFileStore } from '../../../src/stores/file'
import { createExecutionSnapshot } from '../../../src/utils/ai/workspace-context'

describe('AI IPC contracts', () => {
  it('accepts a run without registered source IDs', () => {
    expect(
      aiRunInputSchema.parse({
        conversationId: 'conv-1',
        message: '鎬荤粨 https://example.com/report',
        history: [],
        snapshot: {
          conversationId: 'conv-1',
          activeDocument: null,
          selection: null,
          cursor: null,
          workspaceRoot: null

        }
      }).message
    ).toBe('鎬荤粨 https://example.com/report')
  })

  it('preserves leading and trailing message whitespace exactly', () => {
    const message = ' \t鎬荤粨 https://example.com/report\r\n '

    expect(
      aiRunInputSchema.parse({
        conversationId: 'conv-1',
        message,
        history: [],
        snapshot: {
          conversationId: 'conv-1',
          activeDocument: null,
          selection: null,
          cursor: null,
          workspaceRoot: null

        }
      }).message
    ).toBe(message)
  })

  it('rejects a whitespace-only message without transforming nonempty messages', () => {
    expect(() =>
      aiRunInputSchema.parse({
        conversationId: 'conv-1',
        message: ' \t\r\n ',
        history: [],
        snapshot: {
          conversationId: 'conv-1',
          activeDocument: null,
          selection: null,
          cursor: null,
          workspaceRoot: null

        }
      })
    ).toThrow()
  })

  it('rejects legacy materialIds because the snapshot is strict', () => {
    expect(() =>
      aiRunInputSchema.parse({
        conversationId: 'conv-1',
        message: 'hello',
        history: [],
        snapshot: {
          conversationId: 'conv-1',
          activeDocument: null,
          selection: null,
          cursor: null,
          materialIds: ['legacy-id']
        }
      })
    ).toThrow()
  })

  it('rejects renderer-supplied source authorization candidates', () => {
    expect(() =>
      aiRunInputSchema.parse({
        conversationId: 'conv-1',
        message: 'summarize the source',
        history: [],
        snapshot: {
          conversationId: 'conv-1',
          activeDocument: null,
          selection: null,
          cursor: null,
          workspaceRoot: null

        },
        sourceCandidates: ['https://example.com/report']
      })
    ).toThrow()
  })

  it('accepts a snapshot with an authorized workspace root', () => {
    const result = aiRunInputSchema.parse({
      conversationId: 'conv-1',
      message: 'summarize notes',
      history: [],
      snapshot: {
        conversationId: 'conv-1',
        activeDocument: null,
        selection: null,
        cursor: null,
        workspaceRoot: 'C:\\workspace'
      }
    })
    expect(result.snapshot.workspaceRoot).toBe('C:\\workspace')
  })

  it('accepts a snapshot without a workspace root', () => {
    const result = aiRunInputSchema.parse({
      conversationId: 'conv-1',
      message: 'summarize notes',
      history: [],
      snapshot: {
        conversationId: 'conv-1',
        activeDocument: null,
        selection: null,
        cursor: null,
        workspaceRoot: null
      }
    })
    expect(result.snapshot.workspaceRoot).toBeNull()
  })

  it('rejects a non-string workspace root', () => {
    expect(() =>
      aiRunInputSchema.parse({
        conversationId: 'conv-1',
        message: 'summarize notes',
        history: [],
        snapshot: {
          conversationId: 'conv-1',
          activeDocument: null,
          selection: null,
          cursor: null,
          workspaceRoot: 42
        }
      })
    ).toThrow()
  })

  it('accepts the real renderer start payload without a renderer-owned run id', () => {
    setActivePinia(createPinia())
    const fileStore = useFileStore()
    fileStore.createGeneratedDocument('Draft', 'hello', 'markdown')
    const conversationId = 'conv-renderer-1'
    const snapshot = createExecutionSnapshot(fileStore)
    const contractSnapshot = {
      conversationId,
      activeDocument: snapshot.activeDocument,
      selection: snapshot.selection,
      cursor: snapshot.cursor,
      workspaceRoot: snapshot.workspaceRoot
    }

    const result = aiRunInputSchema.safeParse({
      conversationId,
      message: 'continue',
      history: [],
      snapshot: contractSnapshot
    })

    expect(snapshot).not.toHaveProperty('runId')
    expect(result.success).toBe(true)
  })

  it('rejects unknown run input fields', () => {
    expect(() =>
      aiRunInputSchema.parse({
        conversationId: 'conv-1',
        message: 'hello',
        history: [],
        snapshot: {
          runId: 'run-1',
          conversationId: 'conv-1',
          activeDocument: null,
          selection: null,
          cursor: null,
          materialIds: []
        },
        unexpected: true
      })
    ).toThrow()
  })

  it('rejects an execution result when the approval was not approved', () => {
    expect(() =>
      approvalResolutionSchema.parse({
        id: 'approval-1',
        decision: { status: 'rejected' },
        result: { status: 'applied' }
      })
    ).toThrow()
  })

  it('accepts an approved Main decision without an execution result', () => {
    expect(
      approvalResolutionSchema.parse({
        id: 'approval-main-1',
        decision: { status: 'approved', scope: 'once' }
      })
    ).not.toHaveProperty('result')
  })

  it.each(['applied', 'conflict', 'failed'] as const)(
    'accepts an approved Renderer decision with a %s result',
    (status) => {
      const result =
        status === 'applied'
          ? { status }
          : { status, message: `Renderer operation ${status}` }

      expect(
        approvalResolutionSchema.parse({
          id: 'approval-renderer-1',
          decision: { status: 'approved', scope: 'once' },
          result
        }).result?.status
      ).toBe(status)
    }
  )

  it.each(['rejected', 'cancelled', 'expired'] as const)(
    'rejects an execution result attached to a %s decision',
    (status) => {
      expect(() =>
        approvalResolutionSchema.parse({
          id: 'approval-1',
          decision: { status },
          result: { status: 'applied' }
        })
      ).toThrow()
    }
  )

  it('rejects unknown fields inside approval decisions', () => {
    expect(() =>
      approvalResolutionSchema.parse({
        id: 'approval-1',
        decision: { status: 'approved', scope: 'once', unexpected: true },
        result: { status: 'applied' }
      })
    ).toThrow()
  })

  /*
   * 回归：格式枚举曾只允许 markdown/mdx，而渲染层会对 .inkmind 发送 mindmap。
   * 结果是打开思维导图后连消息都发不出去（RUN.START 直接被契约挡下）。
   */
  it.each(['markdown', 'mdx', 'mindmap', 'diagram', 'image', 'pdf'] as const)(
    'accepts a %s active document format',
    (format) => {
      const result = aiRunInputSchema.safeParse({
        conversationId: 'conv-1',
        message: 'hello',
        history: [],
        snapshot: {
          conversationId: 'conv-1',
          activeDocument: {
            id: 'tab-1',
            title: '文档',
            path: null,
            format,
            content: '',
            revision: 0,
            contentHash: 'hash',
            modified: false
          },
          selection: null,
          cursor: null,
          workspaceRoot: null
        }
      })

      expect(result.success).toBe(true)
    }
  )

  it('rejects an unknown active document format', () => {
    expect(() =>
      aiRunInputSchema.parse({
        conversationId: 'conv-1',
        message: 'hello',
        history: [],
        snapshot: {
          conversationId: 'conv-1',
          activeDocument: {
            id: 'tab-1',
            title: '文档',
            path: null,
            format: 'html',
            content: '',
            revision: 0,
            contentHash: 'hash',
            modified: false
          },
          selection: null,
          cursor: null,
          workspaceRoot: null
        }
      })
    ).toThrow()
  })
})
