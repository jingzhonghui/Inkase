// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import AiPanel from '../AiPanel.vue'
import { useAiStore } from '../../../stores/ai'
import type { ConversationApprovalRecord } from '../../../../shared/ai/types'

const electronAPI = {
  getAiConfig: vi.fn(),
  startAiRun: vi.fn(),
  cancelAiRun: vi.fn(),
  onAiRunEvent: vi.fn(() => () => undefined)
}

function approvalRecord(
  overrides: Partial<ConversationApprovalRecord> = {}
): ConversationApprovalRecord {
  return {
    id: 'approval-1',
    runId: 'run-1',
    toolCallId: 'tool-1',
    toolName: 'read_document',
    title: '读取文件',
    description: '读取当前文档',
    effect: 'read',
    riskLevel: 'low',
    preview: { type: 'document', title: 'content.md', content: '# 标题' },
    createdAt: 1,
    messageId: 'msg-1',
    ...overrides
  }
}

function mountPanel(ready = true) {
  return mount(AiPanel, { props: { ready }, attachTo: document.body })
}

describe('AI panel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: { baseUrl: 'https://example.test/v1', model: 'writer', temperature: 0.4, hasApiKey: true }
    })
    // clearAllMocks 不还原实现，每个用例都从干净的订阅函数开始
    electronAPI.onAiRunEvent.mockImplementation(() => () => undefined)
    vi.stubGlobal('electronAPI', electronAPI)
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: electronAPI })
  })

  it('renders ordered user and assistant Markdown while streaming remains one message', async () => {
    const store = useAiStore()
    store.messages.push(
      { id: 'u1', role: 'user', content: '**提问**' },
      { id: 'a1', role: 'assistant', content: '第一段' }
    )
    const wrapper = mountPanel()
    await nextTick()

    const messages = wrapper.findAll('[data-testid="ai-message"]')
    expect(messages).toHaveLength(2)
    expect(messages[0].html()).toContain('<strong>提问</strong>')
    expect(messages[1].text()).toContain('第一段')

    store.activeRunId = 'run-1'
    store.running = true
    store.$state.messages[1].content += '，第二段'
    await nextTick()
    expect(wrapper.findAll('[data-testid="ai-message"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="ai-message"]')[1].text()).toContain('第一段，第二段')
  })

  it('streams analysis content into the analysis card instead of the answer body', async () => {
    const store = useAiStore()
    store.messages.push({ id: 'a1', role: 'assistant', content: '正在探索工作区结构。' })
    const wrapper = mountPanel()
    await nextTick()

    store.activeRunId = 'run-1'
    store.running = true
    store.$state.messages[0].content += '\n继续查找工作记录。'
    await nextTick()

    const analysisCard = wrapper.get('[data-testid="ai-analysis-card"]')
    expect(analysisCard.text()).toContain('正在分析...')
    expect(analysisCard.text()).toContain('正在探索工作区结构。')
    expect(analysisCard.text()).toContain('继续查找工作记录。')
    expect(wrapper.find('.message-body').exists()).toBe(false)
  })

  it('moves analysis into the card and answer into the body once end-analysis appears', async () => {
    const store = useAiStore()
    store.messages.push({ id: 'a1', role: 'assistant', content: '<!-- analysis -->\n已找到记录。\n<!-- end-analysis -->\n**正式回答**' })
    const wrapper = mountPanel()
    await nextTick()

    const analysisCard = wrapper.get('[data-testid="ai-analysis-card"]')
    expect(analysisCard.text()).toContain('分析过程')
    expect(analysisCard.text()).toContain('已找到记录')
    expect(wrapper.get('.message-body').text()).toContain('正式回答')
  })

  it('parses variant analysis tags so raw markers never leak into the card or body', async () => {
    const store = useAiStore()
    store.messages.push({
      id: 'a1',
      role: 'assistant',
      content: '当前日期是 2026-08-20。\n<!-- analysis -- >\n当前日期为 2026-08-20。\n<!-- end-analysis -->\n根据记录回答如下。'
    })
    const wrapper = mountPanel()
    await nextTick()

    const analysisCard = wrapper.get('[data-testid="ai-analysis-card"]')
    expect(analysisCard.text()).toContain('当前日期是 2026-08-20。')
    expect(analysisCard.text()).toContain('当前日期为 2026-08-20。')
    expect(analysisCard.text()).not.toContain('<!-- analysis')
    expect(wrapper.get('.message-body').text()).toContain('根据记录回答如下。')
    expect(wrapper.get('.message-body').text()).not.toContain('<!-- end-analysis')
  })

  it('keeps multiple analysis blocks in the card and only the final answer in the body', async () => {
    const store = useAiStore()
    store.messages.push({
      id: 'a1',
      role: 'assistant',
      content: '<!-- analysis -->\n第一次分析。\n<!-- end-analysis --><!-- analysis -->\n第二次分析。\n<!-- end-analysis -->\n\n根据工作记录正式回答。'
    })
    const wrapper = mountPanel()
    await nextTick()

    const analysisCard = wrapper.get('[data-testid="ai-analysis-card"]')
    expect(analysisCard.text()).toContain('第一次分析。')
    expect(analysisCard.text()).toContain('第二次分析。')
    expect(analysisCard.text()).not.toContain('<!-- analysis')
    expect(wrapper.get('.message-body').text()).toBe('根据工作记录正式回答。')
    expect(wrapper.get('.message-body').text()).not.toContain('<!--')
  })

  it('escapes raw HTML and renders every URL as non-navigating text', async () => {
    const store = useAiStore()
    store.messages.push({
      id: 'a1', role: 'assistant',
      content: '<img src=x onerror="alert(1)"> [web](https://example.com) [relative](/docs) [protocol](//example.com) [mail](mailto:test@example.com) [bad](javascript:alert(1))'
    })
    const body = mountPanel().get('.message-body')

    expect(body.find('img').exists()).toBe(false)
    expect(body.text()).toContain('<img src=x onerror=')
    expect(body.text()).toContain('alert(1)')
    expect(body.find('a').exists()).toBe(false)
    expect(body.text()).toContain('web')
    expect(body.text()).toContain('relative')
    expect(body.text()).toContain('protocol')
    expect(body.text()).toContain('mail')
  })

  it('reacts to readiness changes and disables send during an active run', async () => {
    const wrapper = mountPanel()
    const send = wrapper.get('[data-testid="ai-send"]')
    expect(send.attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="ai-input"]').setValue('请续写')
    await nextTick()
    expect(send.attributes('disabled')).toBeUndefined()

    await wrapper.setProps({ ready: false })
    expect(send.attributes('disabled')).toBeDefined()
    await wrapper.setProps({ ready: true })
    expect(send.attributes('disabled')).toBeUndefined()

    const store = useAiStore()
    store.running = true
    await nextTick()
    expect(wrapper.find('[data-testid="ai-send"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="ai-stop"]').exists()).toBe(true)
  })

  it('does not submit Enter while an IME composition is active', async () => {
    const store = useAiStore()
    const send = vi.spyOn(store, 'sendMessage').mockResolvedValue()
    const wrapper = mountPanel()
    const input = wrapper.get('[data-testid="ai-input"]')
    await input.setValue('中文输入')

    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(send).not.toHaveBeenCalled()
    await input.trigger('keydown', { key: 'Enter', isComposing: false })
    expect(send).toHaveBeenCalledWith('中文输入')
  })

  it('stops generation through cancelRun and renders tool name and status', async () => {
    const store = useAiStore()
    const cancel = vi.spyOn(store, 'cancelRun').mockResolvedValue(true)
    store.running = true
    store.messages.push({ id: 'msg-1', role: 'assistant', content: '' })
    store.toolCalls.push({ toolCallId: 'tool-1', toolName: 'read_document', status: 'running', messageId: 'msg-1' })
    const wrapper = mountPanel()
    await wrapper.get('[data-testid="ai-stop"]').trigger('click')

    expect(cancel).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-testid="ai-tool-call"]').text()).toContain('read_document')
    expect(wrapper.get('[data-testid="ai-tool-call"]').text()).toContain('运行中')
  })

  it('renders a meaningful tool result instead of an object coercion', () => {
    const store = useAiStore()
    store.messages.push({ id: 'msg-2', role: 'assistant', content: '' })
    store.toolCalls.push({
      toolCallId: 'tool-1', toolName: 'read_document', status: 'completed',
      result: { status: 'completed', data: { title: '研究笔记', characterCount: 42 } },
      messageId: 'msg-2'
    })
    const card = mountPanel().get('[data-testid="ai-tool-call"]')

    expect(card.text()).toContain('研究笔记')
    expect(card.text()).toContain('42')
    expect(card.text()).not.toContain('[object Object]')
  })

  it('renders without a clear button', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('[data-testid="ai-clear"]').exists()).toBe(false)
  })

  it('renders conversation sidebar and workbench side by side without source registration controls', () => {
    const wrapper = mountPanel()

    const panel = wrapper.get('.ai-panel')
    expect(panel.element.children).toHaveLength(2)
    expect(panel.element.firstElementChild).toBe(wrapper.get('aside').element)
    expect(wrapper.get('aside').element.nextElementSibling).toBe(wrapper.get('.workbench').element)
    expect(wrapper.find('[data-testid="material-url-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="material-add-url"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="material-dropzone"]').exists()).toBe(false)
    expect(wrapper.find('input[type="file"]').exists()).toBe(false)
  })

  it('emits settings while preserving the conversation workbench', async () => {
    const wrapper = mountPanel()

    await wrapper.get('[data-testid="ai-settings"]').trigger('click')

    expect(wrapper.emitted('openSettings')).toHaveLength(1)
    expect(wrapper.get('.workbench').exists()).toBe(true)
  })

  it('auto-scrolls the message list to the bottom when messages change', async () => {
    const store = useAiStore()
    store.messages.push({ id: 'm1', role: 'user', content: '提问' })
    const wrapper = mountPanel()
    await nextTick()

    const list = wrapper.get('.message-list').element as HTMLElement
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 })
    list.scrollTop = 0

    store.messages.push({ id: 'm2', role: 'assistant', content: '回答' })
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(list.scrollTop).toBe(2000)
  })

  it('renders a pending approval inline inside its assistant message, not as a modal', async () => {
    const store = useAiStore()
    store.messages.push({ id: 'msg-1', role: 'assistant', content: '我先读一下当前文档。' })
    store.approvalHistory.push(approvalRecord())
    const wrapper = mountPanel()
    await nextTick()

    const card = wrapper.get('[data-testid="ai-approval-card"]')
    // 卡片必须落在助手消息内部，才会随会话一起滚动、一起留存
    expect(wrapper.get('[data-testid="ai-message"]').element.contains(card.element)).toBe(true)
    expect(card.get('[data-testid="approval-state"]').text()).toBe('等待批准')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })

  it('keeps a decided approval visible in the conversation', async () => {
    const store = useAiStore()
    store.messages.push({ id: 'msg-1', role: 'assistant', content: '读完了。' })
    store.approvalHistory.push(approvalRecord({
      decision: { status: 'approved', scope: 'once' },
      decidedAt: 2,
      outcome: 'completed'
    }))
    const wrapper = mountPanel()
    await nextTick()

    expect(wrapper.get('[data-testid="approval-state"]').text()).toBe('已允许 · 已执行')
    expect(wrapper.find('[data-testid="approval-allow"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-reject"]').exists()).toBe(false)
  })

  it('still shows an approval whose owning message is gone', async () => {
    const store = useAiStore()
    store.approvalHistory.push(approvalRecord({ messageId: 'msg-missing' }))
    const wrapper = mountPanel()
    await nextTick()

    expect(wrapper.get('[data-testid="ai-approval-card"]').text()).toContain('读取文件')
  })

  it('keeps an approval inside its message even though it arrives before the tool call', async () => {
    const store = useAiStore()
    let handler: ((event: never) => void) | null = null
    electronAPI.onAiRunEvent.mockImplementation((cb: (event: never) => void) => {
      handler = cb
      return () => undefined
    })
    store.init()
    const emit = (event: unknown): void => (handler as unknown as (e: unknown) => void)(event)

    // 主进程的真实顺序：审批先到，tool-call-started 后到
    emit({ type: 'run-started', runId: 'r1' })
    emit({ type: 'text-delta', runId: 'r1', text: '我先读一下当前文档。' })
    emit({ type: 'approval-required', runId: 'r1', approval: approvalRecord() })
    emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'tool-1', toolName: 'read_document' })

    const wrapper = mountPanel()
    await nextTick()

    const card = wrapper.get('[data-testid="ai-approval-card"]')
    expect(wrapper.get('[data-testid="ai-message"]').element.contains(card.element)).toBe(true)
  })

  it('marks each speaker with its own avatar and bubble', async () => {
    const store = useAiStore()
    store.messages.push(
      { id: 'msg-1', role: 'user', content: '把这段改成被动语态。' },
      { id: 'msg-2', role: 'assistant', content: '改好了。' }
    )
    const wrapper = mountPanel()
    await nextTick()

    // 头像取代了文字标签，读屏用户只能靠 aria-label 知道谁在说话
    const items = wrapper.findAll('[data-testid="ai-message"]')
    expect(items[0].get('[data-testid="ai-avatar"]').attributes('aria-label')).toBe('你')
    expect(items[1].get('[data-testid="ai-avatar"]').attributes('aria-label')).toBe('AI 助手')
    // 两边都是气泡，靠位置和样式区分：用户实底靠右，助手描边靠左
    expect(items[0].find('.bubble-user').exists()).toBe(true)
    expect(items[0].find('.bubble-assistant').exists()).toBe(false)
    expect(items[1].find('.bubble-assistant').exists()).toBe(true)
    expect(items[1].find('.bubble-user').exists()).toBe(false)
  })

  it('gives the two avatars different glyphs, not just different colours', async () => {
    const store = useAiStore()
    store.messages.push(
      { id: 'msg-1', role: 'user', content: '你好' },
      { id: 'msg-2', role: 'assistant', content: '你好。' }
    )
    const wrapper = mountPanel()
    await nextTick()

    // 图形不同，色觉障碍或灰度下依然分得清
    const [userIcon, assistantIcon] = wrapper
      .findAll('[data-testid="ai-avatar"] svg')
      .map((svg) => svg.html())
    expect(userIcon).not.toBe(assistantIcon)
  })

  it('folds several approvals of one turn into a single group', async () => {
    const store = useAiStore()
    store.messages.push({ id: 'msg-1', role: 'assistant', content: '做完了。' })
    store.approvalHistory.push(
      approvalRecord({ id: 'a1', messageId: 'msg-1', decision: { status: 'approved', scope: 'once' }, decidedAt: 2 }),
      approvalRecord({ id: 'a2', messageId: 'msg-1', decision: { status: 'rejected' }, decidedAt: 3 })
    )
    const wrapper = mountPanel()
    await nextTick()

    // 一张卡片一条审批，会话会被刷屏，收进一个分组里
    expect(wrapper.findAll('[data-testid="ai-approval-group"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="ai-approval-card"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="approval-group-state"]').text()).toBe('已允许 1 · 已拒绝 1')
    // 分组本身要落在助手气泡里，跟着这条消息走
    expect(wrapper.get('.bubble-assistant').element.contains(
      wrapper.get('[data-testid="ai-approval-group"]').element
    )).toBe(true)
  })

  it('leaves a lone approval as a plain card rather than a group of one', async () => {
    const store = useAiStore()
    store.messages.push({ id: 'msg-1', role: 'assistant', content: '读完了。' })
    store.approvalHistory.push(approvalRecord({ id: 'a1', messageId: 'msg-1' }))
    const wrapper = mountPanel()
    await nextTick()

    expect(wrapper.find('[data-testid="ai-approval-group"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="ai-approval-card"]').exists()).toBe(true)
  })

  it('still offers recall on a user turn, and keeps it out of the flex row', async () => {
    const store = useAiStore()
    store.messages.push(
      { id: 'msg-1', role: 'user', content: '改一下。' },
      { id: 'msg-2', role: 'assistant', content: '好的。' }
    )
    const wrapper = mountPanel()
    await nextTick()

    // Tooltip 的根节点是 flex:1 的 span，直接当 flex 项会把整行撑坏
    const message = wrapper.get('[data-testid="ai-message"]')
    expect(message.element.querySelector(':scope > .tooltip-trigger')).toBeNull()
    expect(message.element.querySelector(':scope > .recall-slot')).not.toBeNull()

    await wrapper.get('[data-testid="ai-recall"]').trigger('click')

    expect(store.messages).toHaveLength(0)
  })
})
