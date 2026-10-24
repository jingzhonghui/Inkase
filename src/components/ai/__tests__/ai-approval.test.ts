// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { ConversationApprovalRecord } from '../../../../shared/ai/types'
import AiApprovalCard from '../AiApprovalCard.vue'
import AiApprovalGroup from '../AiApprovalGroup.vue'
import { useAiStore } from '../../../stores/ai'

function approval(overrides: Partial<ConversationApprovalRecord> = {}): ConversationApprovalRecord {
  return {
    id: 'approval-1',
    runId: 'run-1',
    toolCallId: 'tool-1',
    toolName: 'replace_document',
    title: '更新文档',
    description: '将修改当前文档',
    reason: '修正内容',
    effect: 'write',
    riskLevel: 'medium',
    preview: { type: 'markdown-diff', title: 'README', before: '保留\n删除', after: '保留\n新增' },
    createdAt: 1,
    messageId: 'msg_1',
    ...overrides
  }
}

describe('AI approval card', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('shows markdown line differences, reason, and counts', () => {
    const wrapper = mount(AiApprovalCard, { props: { record: approval() } })

    expect(wrapper.text()).toContain('README')
    expect(wrapper.text()).toContain('修正内容')
    expect(wrapper.get('[data-testid="diff-added-count"]').text()).toContain('1')
    expect(wrapper.get('[data-testid="diff-deleted-count"]').text()).toContain('1')
    expect(wrapper.get('[data-testid="diff-added"]').text()).toContain('新增')
    expect(wrapper.get('[data-testid="diff-deleted"]').text()).toContain('删除')
  })

  it('shows a full generated Markdown document', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({ preview: { type: 'document', title: '新文档', content: '# 标题\n\n**正文**' } }) }
    })

    expect(wrapper.text()).toContain('新文档')
    expect(wrapper.get('[data-testid="document-preview"]').html()).toContain('<h1>标题</h1>')
    expect(wrapper.get('[data-testid="document-preview"]').html()).toContain('<strong>正文</strong>')
  })

  it('renders generated Markdown without raw HTML or navigating links', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({ preview: {
        type: 'document', title: '新文档',
        content: '<script>alert(1)</script> [web](https://example.test) [relative](/draft) [mail](mailto:a@example.test) [bad](javascript:alert(1))'
      } }) }
    })
    const preview = wrapper.get('[data-testid="document-preview"]')

    expect(preview.find('script').exists()).toBe(false)
    expect(preview.text()).toContain('<script>alert(1)</script>')
    expect(preview.find('a').exists()).toBe(false)
    expect(preview.text()).toContain('web')
    expect(preview.text()).toContain('relative')
    expect(preview.text()).toContain('mail')
  })

  it('summarizes a network request with its reason without performing it', () => {
    const store = useAiStore()
    const resolve = vi.spyOn(store, 'resolveApproval')
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({
        preview: {
          type: 'network-request', method: 'GET', url: 'https://example.test/api',
          reason: '读取参考资料', bodySummary: '{"name":"doc"}'
        }
      }) }
    })

    expect(wrapper.text()).toContain('GET')
    expect(wrapper.text()).toContain('https://example.test/api')
    expect(wrapper.text()).toContain('读取参考资料')
    expect(wrapper.text()).toContain('{"name":"doc"}')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('shows local-file read details and formats the optional size', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({
        preview: {
          type: 'local-file-read',
          requestedPath: '.\\notes\\draft.md',
          normalizedPath: 'C:\\workspace\\notes\\draft.md',
          fileType: 'markdown',
          size: 1536,
          reason: '引用本地草稿'
        }
      }) }
    })

    expect(wrapper.text()).toContain('.\\notes\\draft.md')
    expect(wrapper.text()).toContain('C:\\workspace\\notes\\draft.md')
    expect(wrapper.text()).toContain('markdown')
    expect(wrapper.text()).toContain('1.5 KB')
    expect(wrapper.text()).toContain('引用本地草稿')
  })

  it('fails closed for an unsupported runtime preview', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({ preview: { type: 'model-component' } as never }) }
    })

    expect(wrapper.get('[data-testid="unsupported-preview"]').text()).toContain('不支持')
    expect(wrapper.find('[data-testid="approval-allow"]').exists()).toBe(false)
  })

  it.each([
    null,
    {},
    { type: 'document', title: '缺少正文' },
    { type: 'network-request', method: 'GET', url: 'https://example.test' },
    {
      type: 'local-file-read', requestedPath: 'a.md', normalizedPath: 'C:\\a.md',
      fileType: 'markdown', size: '10', reason: '读取'
    },
    {
      type: 'local-file-read', requestedPath: 'a.md', normalizedPath: 'C:\\a.md',
      fileType: 'binary', reason: '读取'
    },
    {
      type: 'local-file-read', requestedPath: 'a.md', normalizedPath: 'C:\\a.md',
      fileType: 'markdown'
    }
  ])(
    'fails closed for malformed runtime preview %#',
    (preview) => {
      const wrapper = mount(AiApprovalCard, {
        props: { record: approval({ preview: preview as never }) }
      })

      expect(wrapper.get('[data-testid="unsupported-preview"]').text()).toContain('不支持')
      expect(wrapper.find('[data-testid="approval-allow"]').exists()).toBe(false)
    }
  )

  it('rejects without applying', async () => {
    const store = useAiStore()
    const resolve = vi.spyOn(store, 'resolveApproval').mockResolvedValue()
    const wrapper = mount(AiApprovalCard, { props: { record: approval() } })

    await wrapper.get('[data-testid="approval-reject"]').trigger('click')
    expect(resolve).toHaveBeenCalledWith('approval-1', { status: 'rejected' })
  })

  it('delegates allow to the store and prevents duplicate submissions while resolving', async () => {
    const store = useAiStore()
    let finish!: () => void
    const resolve = vi.spyOn(store, 'resolveApproval').mockImplementation(() => new Promise<void>((done) => { finish = done }))
    const wrapper = mount(AiApprovalCard, { props: { record: approval() } })
    const allow = wrapper.get('[data-testid="approval-allow"]')

    await allow.trigger('click')
    await allow.trigger('click')
    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith('approval-1', { status: 'approved', scope: 'once' })
    expect(wrapper.get('[data-testid="approval-allow"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="approval-reject"]').attributes('disabled')).toBeDefined()
    finish()
    await nextTick()
  })

  it('stays in the conversation after a decision and reports it', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({
        decision: { status: 'approved', scope: 'once' },
        decidedAt: 2,
        outcome: 'applied'
      }) }
    })

    expect(wrapper.get('[data-testid="ai-approval-card"]').classes()).toContain('is-approved')
    expect(wrapper.get('[data-testid="approval-state"]').text()).toBe('已允许 · 已应用')
    // 判定之后不再提供按钮，避免重复提交
    expect(wrapper.find('[data-testid="approval-allow"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-reject"]').exists()).toBe(false)
  })

  it('spells out a rejected decision and its reason', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({
        decision: { status: 'rejected', reason: '不需要改动' },
        decidedAt: 2
      }) }
    })

    expect(wrapper.get('[data-testid="ai-approval-card"]').classes()).toContain('is-rejected')
    expect(wrapper.get('[data-testid="approval-state"]').text()).toBe('已拒绝 · 不需要改动')
  })

  it('warns that an approved write did not land when the document conflicted', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({
        decision: { status: 'approved', scope: 'once' },
        decidedAt: 2,
        outcome: 'conflict'
      }) }
    })

    expect(wrapper.get('[data-testid="approval-state"]').text()).toContain('未写入')
  })

  it('shows a pending request as waiting for approval', () => {
    const wrapper = mount(AiApprovalCard, { props: { record: approval() } })

    expect(wrapper.get('[data-testid="ai-approval-card"]').classes()).toContain('is-pending')
    expect(wrapper.get('[data-testid="approval-state"]').text()).toBe('等待批准')
    expect(wrapper.get('[data-testid="approval-allow"]').exists()).toBe(true)
  })

  it('offers session-wide approval only when the tool supports it', () => {
    const supported = mount(AiApprovalCard, {
      props: { record: approval({ supportsRememberDecision: true, approvalTier: 'confirm' }) }
    })
    const unsupported = mount(AiApprovalCard, {
      props: { record: approval({ supportsRememberDecision: false }) }
    })

    expect(supported.get('[data-testid="approval-allow-session"]').text()).toContain('本会话')
    expect(supported.get('.approval__meta').text()).toContain('逐次审批')
    expect(unsupported.find('[data-testid="approval-allow-session"]').exists()).toBe(false)
  })

  it('submits a session-scoped decision with the tool name', async () => {
    const store = useAiStore()
    const resolve = vi.spyOn(store, 'resolveApproval').mockResolvedValue()
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({ supportsRememberDecision: true }) }
    })

    await wrapper.get('[data-testid="approval-allow-session"]').trigger('click')

    expect(resolve).toHaveBeenCalledWith('approval-1', {
      status: 'approved',
      scope: 'session',
      toolName: 'replace_document'
    })
  })

  it('reports that a session-wide approval was remembered', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({
        decision: { status: 'approved', scope: 'session', toolName: 'replace_document' },
        decidedAt: 2,
        outcome: 'applied'
      }) }
    })

    expect(wrapper.get('[data-testid="approval-state"]').text()).toContain('本次会话已记住')
  })

  it('fails closed for an empty batch preview', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({
        approvalTier: 'batch',
        supportsRememberDecision: true,
        preview: { type: 'batch', title: '空批量', files: [] }
      }) }
    })

    expect(wrapper.get('[data-testid="unsupported-preview"]').text()).toContain('不能被允许')
    expect(wrapper.find('[data-testid="approval-allow"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-allow-session"]').exists()).toBe(false)
  })

  it('renders a batch checklist with per-file summaries and diffs', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({
        approvalTier: 'batch',
        supportsRememberDecision: true,
        preview: {
          type: 'batch',
          title: '修复断链',
          description: '涉及 2 个文件',
          totalChanges: 3,
          files: [
            {
              path: 'notes/a.md',
              summary: '替换 2 处链接',
              additions: 2,
              deletions: 2,
              diff: '@@ -1 +1 @@\n-[[旧]]\n+[[新]]'
            },
            { path: 'notes/b.md', summary: '插入 1 处链接', additions: 1 }
          ]
        }
      }) }
    })

    const preview = wrapper.get('[data-testid="batch-preview"]')
    expect(preview.text()).toContain('2 个文件')
    expect(preview.text()).toContain('3 处变更')
    expect(preview.text()).toContain('notes/a.md')
    expect(preview.text()).toContain('替换 2 处链接')
    expect(preview.get('[data-testid="batch-file-diff"]').text()).toContain('[[旧]]')
    expect(wrapper.get('.approval__meta').text()).toContain('批量审批')
    // 批量操作只批准一次，不提供「本会话自动批准」
    expect(wrapper.find('[data-testid="approval-allow-session"]').exists()).toBe(false)
  })

  it('folds open while waiting so the request can be acted on', () => {
    const wrapper = mount(AiApprovalCard, { props: { record: approval() } })

    expect(details(wrapper).open).toBe(true)
  })

  it('starts folded for an already-decided record but keeps the verdict on the summary line', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({ decision: { status: 'approved', scope: 'once' }, decidedAt: 2 }) }
    })

    // 收起来也不该丢信息：结论留在摘要行上
    expect(details(wrapper).open).toBe(false)
    expect(wrapper.get('[data-testid="approval-state"]').text()).toBe('已允许')
    expect(wrapper.get('summary').text()).toContain('更新文档')
    expect(wrapper.get('summary').text()).toContain('replace_document')
  })

  it('stays folded once the user collapses it', async () => {
    const wrapper = mount(AiApprovalCard, { props: { record: approval() } })
    const element = details(wrapper)

    element.open = false
    await nextTick()

    expect(element.open).toBe(false)
  })

  it('keeps the body reachable when folded', () => {
    const wrapper = mount(AiApprovalCard, {
      props: { record: approval({ decision: { status: 'rejected' }, decidedAt: 2 }) }
    })

    // details 的内容仍在 DOM 里，展开即可回看当时批准的到底是什么
    expect(wrapper.get('[data-testid="diff-added"]').text()).toContain('新增')
  })
})

function details(wrapper: ReturnType<typeof mount>): HTMLDetailsElement {
  return wrapper.get('[data-testid="ai-approval-card"]').element as HTMLDetailsElement
}

function groupDetails(wrapper: ReturnType<typeof mount>): HTMLDetailsElement {
  return wrapper.get('[data-testid="ai-approval-group"]').element as HTMLDetailsElement
}

describe('AI approval group', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('summarises the batch and folds it shut once everything is settled', () => {
    const wrapper = mount(AiApprovalGroup, {
      props: {
        records: [
          approval({ id: 'a1', decision: { status: 'approved', scope: 'once' }, decidedAt: 2 }),
          approval({ id: 'a2', decision: { status: 'approved', scope: 'once' }, decidedAt: 3 })
        ]
      }
    })

    expect(wrapper.get('summary').text()).toContain('审批 (2)')
    expect(wrapper.get('[data-testid="approval-group-state"]').text()).toBe('全部已允许')
    expect(groupDetails(wrapper).open).toBe(false)
  })

  it('stays open while something is still waiting', () => {
    const wrapper = mount(AiApprovalGroup, {
      props: {
        records: [
          approval({ id: 'a1', decision: { status: 'approved', scope: 'once' }, decidedAt: 2 }),
          approval({ id: 'a2' })
        ]
      }
    })

    expect(wrapper.get('[data-testid="approval-group-state"]').text()).toBe('1 项待批准')
    expect(groupDetails(wrapper).open).toBe(true)
  })

  it('reopens itself when a new request lands in an already folded batch', async () => {
    const settled = [approval({ id: 'a1', decision: { status: 'approved', scope: 'once' }, decidedAt: 2 })]
    const wrapper = mount(AiApprovalGroup, { props: { records: settled } })
    expect(groupDetails(wrapper).open).toBe(false)

    // 用户可能早把它收起来了，新审批来了必须自己顶开，否则根本看不到
    await wrapper.setProps({ records: [...settled, approval({ id: 'a2' })] })

    expect(groupDetails(wrapper).open).toBe(true)
    expect(wrapper.get('[data-testid="approval-group-state"]').text()).toBe('1 项待批准')
  })

  it('keeps every card reachable inside the fold', () => {
    const wrapper = mount(AiApprovalGroup, {
      props: {
        records: [
          approval({ id: 'a1', decision: { status: 'approved', scope: 'once' }, decidedAt: 2 }),
          approval({ id: 'a2', decision: { status: 'rejected', reason: '不需要' }, decidedAt: 3 })
        ]
      }
    })

    expect(wrapper.findAll('[data-testid="ai-approval-card"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="approval-group-state"]').text()).toBe('已允许 1 · 已拒绝 1')
  })
})
