// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import AiPanel from '../AiPanel.vue'
import { useAiStore } from '../../../stores/ai'
import type { ConversationApprovalRecord } from '../../../../shared/ai/types'

const electronAPI = {
  getAiConfig: vi.fn(),
  setAiPermissionMode: vi.fn(),
  setAiModel: vi.fn(),
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

// 权限菜单与 tooltip 都 teleport 到 body，不卸载会让上一个用例的浮层留在文档里
const mountedPanels: VueWrapper[] = []

function mountPanel(ready = true) {
  const wrapper = mount(AiPanel, { props: { ready }, attachTo: document.body })
  mountedPanels.push(wrapper)
  return wrapper
}

describe('AI panel', () => {
  afterEach(() => {
    while (mountedPanels.length) mountedPanels.pop()!.unmount()
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://example.test/v1',
        model: 'writer',
        models: ['writer', 'writer-mini'],
        temperature: 0.4,
        hasApiKey: true
      }
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

  /*
   * 权限模式是输入框自身的一部分（住在输入框左下角），不是输入框下方另起的一条控件栏；
   * 外面不写「权限」标签、也不常驻解释文字，完整解释在 tooltip 里。
   * 选项列表是自绘的 listbox（原生 select 的系统下拉没法跟深色面板统一）。
   */
  async function openPermissionMenu(wrapper: ReturnType<typeof mountPanel>) {
    await wrapper.get('[data-testid="ai-permission-mode"]').trigger('click')
    await nextTick()
    return Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="ai-permission-option"]'))
  }

  it('renders the permission control inside the composer and defaults to 标准', async () => {
    const wrapper = mountPanel()
    const trigger = wrapper.get('[data-testid="ai-permission-mode"]')

    expect(trigger.text()).toContain('标准')
    expect(trigger.attributes('aria-expanded')).toBe('false')

    // 控件与输入框同在输入框那张卡里，而不是卡片外面的一条独立控件栏
    const composer = wrapper.get('.composer')
    expect(composer.find('[data-testid="ai-input"]').exists()).toBe(true)
    expect(composer.find('[data-testid="ai-permission-mode"]').exists()).toBe(true)
    expect(wrapper.find('.permission-bar').exists()).toBe(false)
    // 不写字：既没有「权限」标签，也没有常驻的说明句
    expect(wrapper.text()).not.toContain('权限')
    expect(wrapper.text()).not.toContain('修改前逐次请求你的批准')
  })

  it('opens a custom listbox with the three modes instead of a native select', async () => {
    const wrapper = mountPanel()
    expect(wrapper.find('select').exists()).toBe(false)

    const options = await openPermissionMenu(wrapper)

    expect(options.map((option) => option.textContent?.trim())).toEqual(['只读', '标准', '完全控制'])
    expect(wrapper.get('[data-testid="ai-permission-mode"]').attributes('aria-expanded')).toBe('true')
    // 选中项带勾，菜单是 listbox 语义
    const listbox = document.body.querySelector('[role="listbox"]')
    expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(3)
    expect(listbox?.querySelector('[aria-selected="true"]')?.textContent).toContain('标准')
  })

  it('explains the current mode through a tooltip instead of permanent copy', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountPanel()
      const trigger = wrapper.get('.permission-trigger').element
      expect(trigger.closest('.tooltip-trigger')).not.toBeNull()

      await wrapper.get('.permission-trigger').trigger('mouseover')
      vi.advanceTimersByTime(400)
      await nextTick()

      expect(document.body.querySelector('[role="tooltip"]')?.textContent)
        .toContain('修改前逐次请求你的批准')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reflects the permission mode persisted in the config', async () => {
    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://example.test/v1',
        model: 'writer',
        temperature: 0.4,
        hasApiKey: true,
        permissionMode: 'readonly'
      }
    })
    const wrapper = mountPanel()

    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-permission-mode"]').text()).toContain('只读')
    )
    expect(wrapper.get('.permission-slot').attributes('data-mode')).toBe('readonly')
  })

  it('switches the permission mode through the main process', async () => {
    electronAPI.setAiPermissionMode.mockResolvedValue({
      success: true,
      data: { permissionMode: 'auto' }
    })
    const wrapper = mountPanel()
    await nextTick()

    const options = await openPermissionMenu(wrapper)
    options[2].click()
    await nextTick()

    expect(electronAPI.setAiPermissionMode).toHaveBeenCalledWith('auto')
    await vi.waitFor(() =>
      expect(wrapper.get('.permission-slot').attributes('data-mode')).toBe('auto')
    )
    // 完全控制要有可见的警示，不能只靠菜单里选中的那一项（这里靠配色与图标）
    expect(wrapper.get('[data-testid="ai-permission-mode"]').text()).toContain('完全控制')
    // 选完就收菜单，不用再点一次
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('supports keyboard selection and Escape in the permission listbox', async () => {
    const wrapper = mountPanel()
    const trigger = wrapper.get('[data-testid="ai-permission-mode"]')

    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await nextTick()
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull()

    // 当前是「标准」，按一下 ↓ 走到「完全控制」，回车选中
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await trigger.trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect(electronAPI.setAiPermissionMode).toHaveBeenCalledWith('auto')

    await trigger.trigger('keydown', { key: 'ArrowUp' })
    await nextTick()
    await trigger.trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('rolls the dropdown back and explains when switching fails', async () => {
    electronAPI.setAiPermissionMode.mockResolvedValue({ success: false, error: '配置写入失败' })
    const wrapper = mountPanel()
    await nextTick()

    const options = await openPermissionMenu(wrapper)
    options[0].click()
    await vi.waitFor(() => expect(wrapper.text()).toContain('配置写入失败'))
    expect(wrapper.get('.permission-slot').attributes('data-mode')).toBe('standard')
    expect(wrapper.get('[data-testid="ai-permission-mode"]').text()).toContain('标准')
  })

  /*
   * 模型下拉与权限胶囊并排住在输入框底栏：它是「这一条消息用哪个模型」，
   * 与 Provider 参数（设置中心）不同。列表来自设置页「获取模型」勾出来的目录。
   */
  async function openModelMenu(wrapper: ReturnType<typeof mountPanel>) {
    // 模型与目录来自 getAiConfig（异步），点之前先等它落到胶囊上
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-model-select"]').text()).not.toContain('未选择模型')
    )
    await wrapper.get('[data-testid="ai-model-select"]').trigger('click')
    await nextTick()
    return Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="ai-model-option"]'))
  }

  it('shows the configured model next to the permission pill', async () => {
    const wrapper = mountPanel()
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-model-select"]').text()).toContain('writer')
    )

    const composer = wrapper.get('.composer')
    expect(composer.find('[data-testid="ai-permission-mode"]').exists()).toBe(true)
    // 模型在权限胶囊右侧
    const actions = composer.get('.composer-actions')
    const html = actions.html()
    expect(html.indexOf('ai-permission-mode')).toBeLessThan(html.indexOf('ai-model-select'))
    expect(wrapper.get('[data-testid="ai-model-select"]').attributes('aria-expanded')).toBe('false')
  })

  it('lists the configured models and switches through the main process', async () => {
    electronAPI.setAiModel.mockResolvedValue({
      success: true,
      data: { model: 'writer-mini', models: ['writer', 'writer-mini'] }
    })
    const wrapper = mountPanel()

    const options = await openModelMenu(wrapper)
    expect(options.map((option) => option.textContent?.trim())).toEqual(['writer', 'writer-mini'])
    // 选中项带勾，菜单是 listbox 语义
    const listbox = document.body.querySelector('[role="listbox"]')
    expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(2)
    expect(listbox?.querySelector('[aria-selected="true"]')?.textContent).toContain('writer')

    options[1].click()
    await nextTick()

    expect(electronAPI.setAiModel).toHaveBeenCalledWith('writer-mini')
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-model-select"]').text()).toContain('writer-mini')
    )
    // 选完就收菜单
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('rolls the model back and explains when switching fails', async () => {
    electronAPI.setAiModel.mockResolvedValue({ success: false, error: '该模型已不在可选列表中，请重新选择' })
    const wrapper = mountPanel()

    const options = await openModelMenu(wrapper)
    options[1].click()
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('该模型已不在可选列表中，请重新选择')
    )
    expect(wrapper.get('[data-testid="ai-model-select"]').text()).toContain('writer')
  })

  it('still opens the model list when there is only one model', async () => {
    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://example.test/v1',
        model: 'writer',
        models: ['writer'],
        temperature: 0.4,
        hasApiKey: true
      }
    })
    const wrapper = mountPanel()
    await nextTick()

    /*
     * 只有一项也要能展开：点下去什么都不发生，用户只会认为这个按钮坏了。
     * 弹出一项、勾在它自己身上，才是「有反馈」的正确答案。
     */
    const options = await openModelMenu(wrapper)
    expect(options.map((option) => option.dataset.option)).toEqual(['writer'])
    expect(options[0].getAttribute('aria-selected')).toBe('true')

    // 再点一次收起
    await wrapper.get('[data-testid="ai-model-select"]').trigger('click')
    await nextTick()
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('opens the model list even when no catalog was ever saved', async () => {
    // 老配置（或只改过温度的保存）里没有 models 字段：主进程会补上当前模型，
    // 面板这边再兜一层——点了必须弹出列表，哪怕里面只有一项
    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://example.test/v1',
        model: 'writer',
        models: [],
        temperature: 0.4,
        hasApiKey: true
      }
    })
    const wrapper = mountPanel()
    await nextTick()

    const options = await openModelMenu(wrapper)
    expect(options.map((option) => option.dataset.option)).toEqual(['writer'])
    expect(options[0].getAttribute('aria-selected')).toBe('true')
  })

  it('refreshes the model list when the settings dialog saves', async () => {
    const wrapper = mountPanel()
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-model-select"]').text()).toContain('writer')
    )

    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://example.test/v1',
        model: 'writer-pro',
        models: ['writer', 'writer-pro'],
        temperature: 0.4,
        hasApiKey: true
      }
    })
    window.dispatchEvent(new CustomEvent('ai:config-changed'))
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-model-select"]').text()).toContain('writer-pro')
    )

    const options = await openModelMenu(wrapper)
    expect(options.map((option) => option.textContent?.trim())).toEqual(['writer', 'writer-pro'])
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

  it('auto-approves an auto-marked request without waiting for a click', async () => {
    const store = useAiStore()
    let handler: ((event: never) => void) | null = null
    electronAPI.onAiRunEvent.mockImplementation((cb: (event: never) => void) => {
      handler = cb
      return () => undefined
    })
    const claimAiApproval = vi.fn(async () => ({ success: true }))
    const resolveAiApproval = vi.fn(async () => ({ success: true }))
    Object.assign(electronAPI, { claimAiApproval, resolveAiApproval })
    store.init()
    const emit = (event: unknown): void => (handler as unknown as (e: unknown) => void)(event)

    emit({ type: 'run-started', runId: 'r1' })
    emit({
      type: 'approval-required',
      runId: 'r1',
      approval: approvalRecord({
        auto: true,
        effect: 'write',
        execution: { location: 'main' }
      })
    })

    // 完全控制：不点任何按钮也应该走完认领 → 回传结果
    await vi.waitFor(() => expect(resolveAiApproval).toHaveBeenCalled())
    expect(claimAiApproval).not.toHaveBeenCalled()
    expect(store.pendingApprovals).toHaveLength(0)
    expect(store.approvalHistory[0]?.auto).toBe(true)
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

  it('settles in-flight tool cards when the run is cancelled', async () => {
    const store = useAiStore()
    let handler: ((event: never) => void) | null = null
    electronAPI.onAiRunEvent.mockImplementation((cb: (event: never) => void) => {
      handler = cb
      return () => undefined
    })
    electronAPI.cancelAiRun.mockResolvedValue({ success: true })
    store.init()
    const emit = (event: unknown): void => (handler as unknown as (e: unknown) => void)(event)

    const wrapper = mountPanel()

    emit({ type: 'run-started', runId: 'r1' })
    emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'tool-1', toolName: 'replace_current_document' })
    emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'tool-2', toolName: 'write_workspace_file' })
    await nextTick()

    // 用户点「停止」：取消后主进程的 run-cancelled 会被 runId 判等挡掉，
    // 所以收尾必须发生在 cancelRun 自己身上
    await store.cancelRun()
    await nextTick()

    expect(store.toolCalls.every((call) => call.status === 'failed')).toBe(true)
    expect(wrapper.findAll('.tool-badge').map((el) => el.text())).toEqual(['已取消', '已取消'])
  })

  it('settles a tool call that never reported a result when the run completes', async () => {
    const store = useAiStore()
    let handler: ((event: never) => void) | null = null
    electronAPI.onAiRunEvent.mockImplementation((cb: (event: never) => void) => {
      handler = cb
      return () => undefined
    })
    store.init()
    const emit = (event: unknown): void => (handler as unknown as (e: unknown) => void)(event)

    const wrapper = mountPanel()

    emit({ type: 'run-started', runId: 'r1' })
    // 模型调用了不存在的工具：SDK 既不给 tool-result 也不给 tool-error
    emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'ghost', toolName: 'edit_workspace_file' })
    emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'real', toolName: 'search_workspace' })
    emit({ type: 'tool-call-completed', runId: 'r1', toolCallId: 'real', result: { status: 'completed', data: {} } })
    emit({ type: 'run-completed', runId: 'r1' })
    await nextTick()

    // 已经正常结束的那张保持原样，缺结果的那张补成失败，不能留「运行中」
    expect(store.toolCalls.map((call) => call.result?.status)).toEqual(['failed', 'completed'])
    expect(wrapper.findAll('.tool-badge').map((el) => el.text())).toEqual(['失败', '已完成'])
  })

  it('keeps tool cards finished when the run ends with an error', async () => {
    const store = useAiStore()
    let handler: ((event: never) => void) | null = null
    electronAPI.onAiRunEvent.mockImplementation((cb: (event: never) => void) => {
      handler = cb
      return () => undefined
    })
    store.init()
    const emit = (event: unknown): void => (handler as unknown as (e: unknown) => void)(event)

    mountPanel()

    emit({ type: 'run-started', runId: 'r1' })
    emit({ type: 'tool-call-started', runId: 'r1', toolCallId: 'tool-1', toolName: 'replace_current_document' })
    emit({ type: 'run-failed', runId: 'r1', error: { code: 'PROVIDER_UNAVAILABLE', message: '服务不可用' } })
    await nextTick()

    expect(store.toolCalls[0]?.status).toBe('failed')
    expect(store.toolCalls[0]?.result?.status).toBe('failed')
  })
})
