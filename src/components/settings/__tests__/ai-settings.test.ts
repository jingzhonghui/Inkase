// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AiSection from '../sections/AiSection.vue'

const electronAPI = {
  getAiConfig: vi.fn(),
  setAiConfig: vi.fn(),
  testAiConfig: vi.fn()
}

/**
 * AI 配置现在住在设置中心的「AI 助手」节里（原先是一个独立对话框）。
 * 这些用例守的是**契约**而不是外观：Key 不回显、留空保留、能力探测的竞态、
 * 「测通 ≠ 就绪」。搬家不该改变其中任何一条。
 */
describe('AI settings', () => {
  const mountSection = () => mount(AiSection)
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

  it('loads no plaintext key and indicates a saved key', async () => {
    const wrapper = mountSection()
    // 等加载真正落地（模型名回填），而不是只等 IPC 被调用
    await vi.waitFor(() =>
      expect((wrapper.get('[data-testid="ai-model"]').element as HTMLInputElement).value).toBe('writer-pro')
    )

    expect((wrapper.get('[data-testid="ai-api-key"]').element as HTMLInputElement).value).toBe('')
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
    const wrapper = mountSection()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())

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
    const wrapper = mountSection()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
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
    const wrapper = mountSection()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())

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
    const wrapper = mountSection()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())

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
    const wrapper = mountSection()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
    await clickTest(wrapper)
    await vi.waitFor(() => expect(electronAPI.testAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.emitted('readiness')?.at(-1)).toEqual([true])

    await saveSection(wrapper)

    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.emitted('readiness')?.at(-1)).toEqual([true])
  })

  it('toggles the API key visibility with an eye button', async () => {
    const wrapper = mountSection()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())

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
})
