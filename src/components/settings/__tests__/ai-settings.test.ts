// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import AiSection from '../sections/AiSection.vue'

const electronAPI = {
  getAiConfig: vi.fn(),
  setAiConfig: vi.fn(),
  testAiConfig: vi.fn(),
  fetchAiModels: vi.fn(),
  revealAiApiKey: vi.fn()
}

/**
 * AI 配置现在住在设置中心的「AI 助手」节里（原先是一个独立对话框）。
 * 这些用例守的是**契约**而不是外观：Key 不回显、留空保留、能力探测的竞态、
 * 「测通 ≠ 就绪」。搬家不该改变其中任何一条。
 */
describe('AI settings', () => {
  const mountSection = () => mount(AiSection)
  /**
   * 挂载并等到**加载真的落地**。
   *
   * `getAiConfig` 被调用只代表请求发出去了：只等这个的话，`fillForm` 还没回填，
   * 这时候改表单会被随后的回填整份覆盖，测试就在测一个没生效的改动。
   * 用「模型输入框已经显示已存模型」当作落地信号。
   */
  const mountLoaded = async () => {
    const wrapper = mountSection()
    await vi.waitFor(() =>
      expect((wrapper.get('[data-testid="ai-model"]').element as HTMLInputElement).value).toBe('writer-pro')
    )
    return wrapper
  }
  /**
   * 保存由外壳触发：本节的表单回车只发 `submit` 信号，真正落盘的是
   * `SettingsDialog` 的「保存」（它还要一起保存其他节）。单测直接调这个方法。
   */
  const saveSection = (wrapper: ReturnType<typeof mountSection>) =>
    (wrapper.vm as unknown as { save: () => Promise<boolean> }).save()
  /**
   * 点「测试连接」。
   *
   * 加载期间这个按钮是 `disabled` 的（探测与加载共用一把 `loading` 锁），
   * 而 `getAiConfig` 被调用只代表 load 开始，不代表已经结束。所以要等到
   * 按钮真正可点再点，否则 jsdom 会把这次点击直接丢掉。
   */
  const clickTest = async (wrapper: ReturnType<typeof mountSection>) => {
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-test-config"]').attributes('disabled')).toBeUndefined()
    )
    await wrapper.get('[data-testid="ai-test-config"]').trigger('click')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://provider.example/v1', model: 'writer-pro', temperature: 0.3,
        maxOutputTokens: 2048, contextWindow: 32000, hasApiKey: true
      }
    })
    vi.stubGlobal('electronAPI', electronAPI)
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: electronAPI })
  })

  /*
   * 弹窗与下拉都用 `Teleport` 挂到 body，而这里每个用例只 mount 不 unmount：
   * 不清掉的话，上一个用例留在 body 里的弹窗会被下一个用例的
   * `document.body.querySelector` 查到，断言就会张冠李戴。
   */
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads no plaintext key and shows a masked placeholder for a saved key', async () => {
    const wrapper = mountSection()
    // 等加载真正落地（模型名回填），而不是只等 IPC 被调用
    await vi.waitFor(() =>
      expect((wrapper.get('[data-testid="ai-model"]').element as HTMLInputElement).value).toBe('writer-pro')
    )

    const keyInput = wrapper.get('[data-testid="ai-api-key"]').element as HTMLInputElement
    /*
     * 已存 Key 时输入框不能是空的：一片空白让人以为 Key 没保存成功。
     * 显示的是固定长度的掩码（密码模式），真实明文只在点小眼睛后才出现。
     */
    expect(keyInput.type).toBe('password')
    expect(keyInput.value).toBe('••••••••••')
    expect(wrapper.text()).toContain('已保存 Key')
    expect(JSON.stringify(electronAPI.getAiConfig.mock.results[0].value)).not.toContain('secret')
  })

  it('omits an unchanged apiKey when saving so the encrypted key is preserved', async () => {
    electronAPI.setAiConfig.mockResolvedValue({ success: true, data: { hasApiKey: true } })
    const wrapper = mountSection()
    await vi.waitFor(() => expect((wrapper.get('[data-testid="ai-model"]').element as HTMLInputElement).value).toBe('writer-pro'))
    await saveSection(wrapper)

    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())
    expect(electronAPI.setAiConfig.mock.calls[0][0]).not.toHaveProperty('apiKey')
  })

  it('does not expose or submit a custom system prompt', async () => {
    electronAPI.setAiConfig.mockResolvedValue({ success: true, data: { hasApiKey: true } })
    const wrapper = await mountLoaded()

    expect(wrapper.text()).not.toContain('系统提示')
    await saveSection(wrapper)
    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())
    expect(electronAPI.setAiConfig.mock.calls[0][0]).not.toHaveProperty('systemPrompt')
  })

  it('exposes and saves the model context window', async () => {
    electronAPI.setAiConfig.mockResolvedValue({ success: true, data: { hasApiKey: true } })
    const wrapper = mountSection()
    await vi.waitFor(() => expect((wrapper.get('[data-testid="ai-context-window"]').element as HTMLInputElement).value).toBe('32000'))

    const contextWindow = wrapper.get('[data-testid="ai-context-window"]')
    await contextWindow.setValue('64000')
    await saveSection(wrapper)
    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())
    expect(electronAPI.setAiConfig.mock.calls[0][0]).toMatchObject({ contextWindow: 64000 })
  })

  it('shows text and tool capability results separately and rejects a no-tools model as ready', async () => {
    electronAPI.testAiConfig.mockResolvedValue({
      success: true,
      data: { textGeneration: true, toolCalling: false }
    })
    const wrapper = await mountLoaded()
    await clickTest(wrapper)
    await vi.waitFor(() => expect(electronAPI.testAiConfig).toHaveBeenCalledOnce())

    expect(wrapper.get('[data-testid="text-capability"]').text()).toContain('通过')
    expect(wrapper.get('[data-testid="tools-capability"]').text()).toContain('不支持')
    expect(wrapper.get('[data-testid="config-readiness"]').text()).toContain('尚未就绪')
    expect(wrapper.text()).toContain('每条用户消息都会发送给你配置的第三方 Provider')
    expect(wrapper.text()).toContain('无需源读取审批')
    expect(wrapper.text()).toContain('源正文需要逐次一次性批准')
    expect(wrapper.text()).toContain('由主进程授权读取')
  })

  it('shows successful capability evidence without marking unsaved form values ready', async () => {
    electronAPI.testAiConfig.mockResolvedValue({
      success: true,
      data: { textGeneration: true, toolCalling: true }
    })
    const wrapper = await mountLoaded()

    await wrapper.get('[data-testid="ai-model"]').setValue('unsaved-model')
    await clickTest(wrapper)
    await vi.waitFor(() => expect(electronAPI.testAiConfig).toHaveBeenCalledOnce())

    expect(wrapper.emitted('readiness')?.at(-1)).toEqual([false])
    expect(wrapper.get('[data-testid="text-capability"]').text()).toContain('通过')
    expect(wrapper.get('[data-testid="tools-capability"]').text()).toContain('通过')
    expect(wrapper.get('[data-testid="config-readiness"]').text()).toContain('尚未就绪')
  })

  it('ignores a successful probe when the form changes before it resolves', async () => {
    let finishProbe!: (value: { success: true; data: { textGeneration: true; toolCalling: true } }) => void
    electronAPI.testAiConfig.mockImplementation(() => new Promise((resolve) => { finishProbe = resolve }))
    const wrapper = await mountLoaded()

    await clickTest(wrapper)
    await wrapper.get('[data-testid="ai-model"]').setValue('changed-during-probe')
    finishProbe({ success: true, data: { textGeneration: true, toolCalling: true } })
    await vi.waitFor(() => expect(electronAPI.testAiConfig).toHaveBeenCalledOnce())

    expect(wrapper.emitted('readiness')?.at(-1)).toEqual([false])
    expect(wrapper.find('[data-testid="config-readiness"]').exists()).toBe(false)
  })

  it('keeps exact capability evidence ready when those settings are saved', async () => {
    electronAPI.testAiConfig.mockResolvedValue({
      success: true,
      data: { textGeneration: true, toolCalling: true }
    })
    electronAPI.setAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://provider.example/v1', model: 'writer-pro', temperature: 0.3,
        maxOutputTokens: 2048, contextWindow: 32000, hasApiKey: true,
        ready: true, capabilities: { textGeneration: true, toolCalling: true }
      }
    })
    const wrapper = await mountLoaded()
    await clickTest(wrapper)
    await vi.waitFor(() => expect(electronAPI.testAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.emitted('readiness')?.at(-1)).toEqual([true])

    await saveSection(wrapper)

    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.emitted('readiness')?.at(-1)).toEqual([true])
  })

  /*
   * 这两个值在配置里是字节/毫秒，界面上按 KB/分钟展示：
   * 让用户填 262144 这种数字属于设计事故。
   */
  it('round-trips the read limit and idle timeout in human units', async () => {
    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://provider.example/v1', model: 'writer-pro', temperature: 0.3,
        hasApiKey: true, maxReadBytes: 512 * 1024, idleTimeoutMs: 10 * 60_000
      }
    })
    electronAPI.setAiConfig.mockResolvedValue({ success: true, data: { hasApiKey: true } })
    const wrapper = mountSection()
    await vi.waitFor(() =>
      expect((wrapper.get('[data-testid="ai-max-read-kb"]').element as HTMLInputElement).value).toBe('512')
    )
    expect((wrapper.get('[data-testid="ai-idle-timeout"]').element as HTMLInputElement).value).toBe('10')

    await saveSection(wrapper)

    expect(electronAPI.setAiConfig).toHaveBeenCalledWith(expect.objectContaining({
      maxReadBytes: 512 * 1024,
      idleTimeoutMs: 10 * 60_000
    }))
  })

  it('keeps the composer ready from the saved config without a capability probe', async () => {
    // 配置齐备就算就绪：探测只是验证，不是使用的前置条件
    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://provider.example/v1', model: 'writer-pro', temperature: 0.3,
        hasApiKey: true, ready: true
      }
    })
    const wrapper = await mountLoaded()

    expect(wrapper.emitted('readiness')?.at(-1)).toEqual([true])
  })

  it('toggles the API key visibility with an eye button', async () => {
    const wrapper = await mountLoaded()

    const keyInput = () => wrapper.get('[data-testid="ai-api-key"]')
    const toggle = () => wrapper.get('[data-testid="ai-api-key-toggle"]')
    const type = () => (keyInput().element as HTMLInputElement).type

    expect(type()).toBe('password')
    expect(toggle().attributes('aria-label')).toBe('显示密钥')

    await toggle().trigger('click')
    expect(type()).toBe('text')
    expect(toggle().attributes('aria-label')).toBe('隐藏密钥')

    await toggle().trigger('click')
    expect(type()).toBe('password')
    expect(toggle().attributes('aria-label')).toBe('显示密钥')
  })

  /*
   * 下面这几组守的是这次新增的三件事：
   * ① 模型与 API Key 换位、接口格式单独一行（地址 → 格式 → Key → 模型）；
   * ② 「获取模型」勾选出来的目录既决定面板下拉，也随保存一起落盘；
   * ③ 小眼睛能真的看到已保存的 Key（否则「显示」只是一片空白）。
   */
  it('orders the rows as address, format, key, then model', async () => {
    const wrapper = await mountLoaded()

    const titles = wrapper.findAll('.settings-row strong').map((node) => node.text())
    expect(titles.slice(0, 4)).toEqual(['API 地址', '接口格式', 'API Key', '模型'])
  })

  it('switches the API format and persists it', async () => {
    electronAPI.setAiConfig.mockResolvedValue({
      success: true,
      data: { hasApiKey: true, models: [], apiFormat: 'openai-responses' }
    })
    const wrapper = await mountLoaded()

    const trigger = wrapper.get('[data-testid="ai-api-format"]')
    expect(trigger.text()).toContain('OpenAI 兼容')

    await trigger.trigger('click')
    await nextTick()
    const options = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-testid="ai-api-format-option"]')
    )
    expect(options.map((option) => option.dataset.option)).toEqual([
      'openai-compatible',
      'openai-responses'
    ])

    options[1].click()
    await nextTick()
    expect(wrapper.get('[data-testid="ai-api-format"]').text()).toContain('Responses')

    await saveSection(wrapper)
    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())
    expect(electronAPI.setAiConfig.mock.calls[0][0]).toMatchObject({
      apiFormat: 'openai-responses'
    })
  })

  it('hints the address example after the selected API format', async () => {
    const wrapper = await mountLoaded()

    const address = () => wrapper.get('[data-testid="ai-base-url"]').element as HTMLInputElement
    expect(address().placeholder).toBe('https://api.example.com/v1')

    await wrapper.get('[data-testid="ai-api-format"]').trigger('click')
    await nextTick()
    const options = document.body.querySelectorAll<HTMLElement>('[data-testid="ai-api-format-option"]')
    options[1].click()
    await nextTick()

    // 换成 Responses 后示例地址不能再是普通兼容端点那一条
    expect(address().placeholder).not.toBe('https://api.example.com/v1')
    expect(address().placeholder).toContain('https://')
  })

  it('clears the mask on focus so typing starts a fresh key', async () => {
    electronAPI.setAiConfig.mockResolvedValue({ success: true, data: { hasApiKey: true } })
    const wrapper = mountSection()
    await vi.waitFor(() =>
      expect((wrapper.get('[data-testid="ai-api-key"]').element as HTMLInputElement).value).toBe('••••••••••')
    )

    const keyInput = wrapper.get('[data-testid="ai-api-key"]')
    await keyInput.trigger('focus')
    // 聚焦即清空：否则接着敲会变成「••••••••••sk-xxx」
    expect((keyInput.element as HTMLInputElement).value).toBe('')

    await keyInput.setValue('sk-brand-new')
    // 输入了新 Key：提交时带上这一把
    await saveSection(wrapper)
    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())
    expect(electronAPI.setAiConfig.mock.calls[0][0]).toMatchObject({ apiKey: 'sk-brand-new' })
  })

  it('restores the mask on blur when nothing was typed', async () => {
    const wrapper = mountSection()
    await vi.waitFor(() =>
      expect((wrapper.get('[data-testid="ai-api-key"]').element as HTMLInputElement).value).toBe('••••••••••')
    )

    const keyInput = wrapper.get('[data-testid="ai-api-key"]')
    await keyInput.trigger('focus')
    await keyInput.trigger('blur')

    expect((keyInput.element as HTMLInputElement).value).toBe('••••••••••')
  })

  it('reveals the saved key only after clicking the eye', async () => {
    electronAPI.revealAiApiKey.mockResolvedValue({
      success: true,
      data: { apiKey: 'sk-live-revealed' }
    })
    const wrapper = await mountLoaded()

    const keyInput = () => wrapper.get('[data-testid="ai-api-key"]').element as HTMLInputElement
    const toggle = () => wrapper.get('[data-testid="ai-api-key-toggle"]')

    // 平时只有掩码，也不主动去取明文
    expect(keyInput().value).toBe('••••••••••')
    expect(electronAPI.revealAiApiKey).not.toHaveBeenCalled()

    await toggle().trigger('click')
    await vi.waitFor(() => expect(keyInput().value).toBe('sk-live-revealed'))
    expect(keyInput().type).toBe('text')
    expect(electronAPI.revealAiApiKey).toHaveBeenCalledOnce()

    // 收起后回到掩码（不是一片空白），再点开也不会重复请求
    await toggle().trigger('click')
    expect(keyInput().value).toBe('••••••••••')
    expect(keyInput().type).toBe('password')
    expect(electronAPI.revealAiApiKey).toHaveBeenCalledOnce()
  })

  it('fetches the model catalog, ticks several models in a dialog and saves them', async () => {
    electronAPI.fetchAiModels.mockResolvedValue({
      success: true,
      data: { models: ['model-a', 'model-b', 'model-c'] }
    })
    electronAPI.setAiConfig.mockResolvedValue({ success: true, data: { hasApiKey: true } })
    const wrapper = await mountLoaded()

    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-fetch-models"]').attributes('disabled')).toBeUndefined()
    )
    await wrapper.get('[data-testid="ai-fetch-models"]').trigger('click')

    await vi.waitFor(() =>
      expect(electronAPI.fetchAiModels).toHaveBeenCalledWith({
        baseUrl: 'https://provider.example/v1',
        apiKey: undefined
      })
    )

    /*
     * 获取结果先进弹窗：候选 = 当前模型 + 拉回来的清单，当前模型预勾上
     * （否则用户一确认就把正在用的模型删了）。
     */
    const options = await vi.waitFor(() => {
      const found = Array.from(
        document.body.querySelectorAll<HTMLElement>('[data-testid="ai-model-catalog-option"]')
      )
      expect(found).toHaveLength(4)
      return found
    })
    expect(options.map((option) => option.dataset.option)).toEqual([
      'writer-pro', 'model-a', 'model-b', 'model-c'
    ])

    // 勾上 a 和 c（writer-pro 已预勾，model-b 不勾）
    options[1].querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await nextTick()
    options[3].querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await nextTick()

    // 确认按钮在 Teleport 出去的弹窗里，得从 body 上取
    const confirm = document.body.querySelector<HTMLElement>('[data-testid="ai-model-catalog-confirm"]')!
    confirm.click()
    await nextTick()

    // 弹窗关掉，清单按「一行一个」落进设置页
    expect(document.body.querySelectorAll('[data-testid="ai-model-catalog-option"]')).toHaveLength(0)
    const rows = wrapper.findAll<HTMLInputElement>('.model-row__input')
    expect(rows.map((row) => row.element.value)).toEqual(['writer-pro', 'model-a', 'model-c'])

    await saveSection(wrapper)
    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())
    expect(electronAPI.setAiConfig.mock.calls[0][0]).toMatchObject({
      model: 'writer-pro',
      models: ['writer-pro', 'model-a', 'model-c']
    })
  })

  it('keeps the dialog contents when the user cancels', async () => {
    electronAPI.fetchAiModels.mockResolvedValue({
      success: true,
      data: { models: ['model-a', 'model-b'] }
    })
    const wrapper = await mountLoaded()
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-fetch-models"]').attributes('disabled')).toBeUndefined()
    )
    await wrapper.get('[data-testid="ai-fetch-models"]').trigger('click')

    await vi.waitFor(() =>
      expect(document.body.querySelectorAll('[data-testid="ai-model-catalog-option"]').length).toBe(3)
    )
    document.body.querySelector<HTMLElement>('[data-testid="ai-model-catalog-cancel"]')!.click()
    await nextTick()

    expect(document.body.querySelectorAll('[data-testid="ai-model-catalog-option"]')).toHaveLength(0)
    // 取消不该动清单
    expect(wrapper.findAll<HTMLInputElement>('.model-row__input').map((row) => row.element.value))
      .toEqual(['writer-pro'])
  })

  it('adds and removes model rows by hand', async () => {
    const wrapper = await mountLoaded()

    /*
     * 单行的排布与多行必须让输入框等宽：
     *   一行：[输入框] [+]  (空)
     *   两行：[输入框] [−]  (空) / [输入框] [−] [+]
     * 所以单行时「+」上移顶到删除位（`model-row--single`），空出来的添加位由
     * ghost 顶住。少了 ghost，点「+」加出一行后输入框会突然窄一个按钮宽。
     */
    const firstRow = () => wrapper.get('.model-row')
    expect(firstRow().classes()).toContain('model-row--single')
    expect(wrapper.find('.model-row__ghost').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ai-model-remove-0"]').exists()).toBe(false)

    // 「+」是纯图标按钮：带上「添加」两个字会把行挤窄，悬停提示承担解释
    const add = wrapper.get('[data-testid="ai-model-add"]')
    expect(add.text()).toBe('')
    expect(add.attributes('aria-label')).toBe('添加一个模型')

    await add.trigger('click')
    await nextTick()
    expect(wrapper.findAll('.model-row__input')).toHaveLength(2)
    // 有了删除按钮就不需要占位，也不再是单行特例
    expect(wrapper.find('.model-row__ghost').exists()).toBe(false)
    expect(firstRow().classes()).not.toContain('model-row--single')

    const second = wrapper.findAll<HTMLInputElement>('.model-row__input')[1]
    expect(second.element.value).toBe('')
    await second.setValue('model-hand-written')
    await nextTick()
    expect(wrapper.findAll<HTMLInputElement>('.model-row__input').map((row) => row.element.value))
      .toEqual(['writer-pro', 'model-hand-written'])

    // 删除也只剩图标（一条减号），靠 danger 底色区分
    const remove = wrapper.get('[data-testid="ai-model-remove-1"]')
    expect(remove.text()).toBe('')
    expect(remove.attributes('aria-label')).toBe('移除 model-hand-written')

    // 只有一行时不该出现删除按钮，避免把清单删成空的
    await remove.trigger('click')
    await nextTick()
    expect(wrapper.findAll('.model-row__input')).toHaveLength(1)
    expect(wrapper.find('[data-testid="ai-model-remove-0"]').exists()).toBe(false)
    expect(wrapper.find('.model-row__ghost').exists()).toBe(true)
  })

  it('shows why fetching the model catalog failed', async () => {
    electronAPI.fetchAiModels.mockResolvedValue({
      success: false,
      error: '鉴权失败：API Key 无效或未授权'
    })
    const wrapper = await mountLoaded()

    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-fetch-models"]').attributes('disabled')).toBeUndefined()
    )
    await wrapper.get('[data-testid="ai-fetch-models"]').trigger('click')

    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ai-fetch-models-error"]').text()).toContain('鉴权失败')
    )
    // 失败不打开弹窗，也不动清单
    expect(document.body.querySelector('[data-testid="ai-model-catalog-option"]')).toBeNull()
    expect(wrapper.findAll('.model-row__input')).toHaveLength(1)
  })
})
