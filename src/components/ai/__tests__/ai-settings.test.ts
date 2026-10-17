// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AiSettingsDialog from '../AiSettingsDialog.vue'

const electronAPI = {
  getAiConfig: vi.fn(),
  setAiConfig: vi.fn(),
  testAiConfig: vi.fn()
}

describe('AI settings', () => {
  const mountDialog = () => mount(AiSettingsDialog, {
    props: { open: true },
    global: { stubs: { teleport: true } }
  })

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
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())

    expect((wrapper.get('[data-testid="ai-api-key"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.text()).toContain('已保存 Key')
    expect(JSON.stringify(electronAPI.getAiConfig.mock.results[0].value)).not.toContain('secret')
  })

  it('omits an unchanged apiKey when saving so the encrypted key is preserved', async () => {
    electronAPI.setAiConfig.mockResolvedValue({ success: true, data: { hasApiKey: true } })
    const wrapper = mountDialog()
    await vi.waitFor(() => expect((wrapper.get('[data-testid="ai-model"]').element as HTMLInputElement).value).toBe('writer-pro'))
    await wrapper.get('[data-testid="ai-settings-form"]').trigger('submit')

    expect(electronAPI.setAiConfig).toHaveBeenCalledOnce()
    expect(electronAPI.setAiConfig.mock.calls[0][0]).not.toHaveProperty('apiKey')
  })

  it('does not expose or submit a custom system prompt', async () => {
    electronAPI.setAiConfig.mockResolvedValue({ success: true, data: { hasApiKey: true } })
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())

    expect(wrapper.text()).not.toContain('系统提示')
    await wrapper.get('[data-testid="ai-settings-form"]').trigger('submit')
    expect(electronAPI.setAiConfig.mock.calls[0][0]).not.toHaveProperty('systemPrompt')
  })

  it('exposes and saves the model context window', async () => {
    electronAPI.setAiConfig.mockResolvedValue({ success: true, data: { hasApiKey: true } })
    const wrapper = mountDialog()
    await vi.waitFor(() => expect((wrapper.get('[data-testid="ai-context-window"]').element as HTMLInputElement).value).toBe('32000'))

    const contextWindow = wrapper.get('[data-testid="ai-context-window"]')
    await contextWindow.setValue('64000')
    await wrapper.get('[data-testid="ai-settings-form"]').trigger('submit')
    expect(electronAPI.setAiConfig.mock.calls[0][0]).toMatchObject({ contextWindow: 64000 })
  })

  it('shows text and tool capability results separately and rejects a no-tools model as ready', async () => {
    electronAPI.testAiConfig.mockResolvedValue({
      success: true,
      data: { textGeneration: true, toolCalling: false }
    })
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
    await wrapper.get('[data-testid="ai-test-config"]').trigger('click')
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
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())

    await wrapper.get('[data-testid="ai-model"]').setValue('unsaved-model')
    await wrapper.get('[data-testid="ai-test-config"]').trigger('click')
    await vi.waitFor(() => expect(electronAPI.testAiConfig).toHaveBeenCalledOnce())

    expect(wrapper.emitted('readiness')?.at(-1)).toEqual([false])
    expect(wrapper.get('[data-testid="text-capability"]').text()).toContain('通过')
    expect(wrapper.get('[data-testid="tools-capability"]').text()).toContain('通过')
    expect(wrapper.get('[data-testid="config-readiness"]').text()).toContain('尚未就绪')
  })

  it('ignores a successful probe when the form changes before it resolves', async () => {
    let finishProbe!: (value: { success: true; data: { textGeneration: true; toolCalling: true } }) => void
    electronAPI.testAiConfig.mockImplementation(() => new Promise((resolve) => { finishProbe = resolve }))
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())

    await wrapper.get('[data-testid="ai-test-config"]').trigger('click')
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
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
    await wrapper.get('[data-testid="ai-test-config"]').trigger('click')
    await vi.waitFor(() => expect(electronAPI.testAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.emitted('readiness')?.at(-1)).toEqual([true])

    await wrapper.get('[data-testid="ai-settings-form"]').trigger('submit')

    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.emitted('readiness')?.at(-1)).toEqual([true])
  })

  it('toggles the API key visibility with an eye button', async () => {
    const wrapper = mountDialog()
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
