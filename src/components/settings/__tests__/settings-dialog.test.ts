// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import SettingsDialog from '../SettingsDialog.vue'

/**
 * 设置中心这一层只负责三件事，都是「AI 节搬进来」之后才存在的：
 * 1. 从 AI 面板点进来时，落在「AI 助手」节（不是每次都从「外观」开始）；
 * 2. AI 配置的就绪状态要送到面板那边（窗口事件）；
 * 3. AI 保存失败时不关面板——错误留在这一节里，关掉就等于把原因也关了。
 */
describe('设置中心与 AI 节', () => {
  const electronAPI = {
    getAiConfig: vi.fn(),
    setAiConfig: vi.fn(),
    testAiConfig: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() })
    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://provider.example/v1', model: 'writer-pro',
        temperature: 0.3, hasApiKey: true, ready: false
      }
    })
    electronAPI.setAiConfig.mockResolvedValue({ success: true, data: { hasApiKey: true } })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: electronAPI })
  })

  it('默认落在「外观」，指定时直接落在「AI 助手」', async () => {
    const plain = mount(SettingsDialog)
    expect(plain.get('.settings-main__head h2').text()).toBe('外观')
    plain.unmount()

    const ai = mount(SettingsDialog, { props: { initialSection: 'ai' } })
    expect(ai.get('.settings-main__head h2').text()).toBe('AI 助手')
    expect(ai.find('[data-testid="ai-settings-form"]').exists()).toBe(true)
    // 7 行：API 地址 / 模型 / API Key / 温度 / 最大输出 / 上下文窗口 / 最大工具步骤
    expect(ai.findAll('.settings-row')).toHaveLength(7)
    ai.unmount()
  })

  it('把 AI 就绪状态经窗口事件转给面板', async () => {
    const listener = vi.fn()
    window.addEventListener('ai:readiness', listener)
    const wrapper = mount(SettingsDialog, { props: { initialSection: 'ai' } })
    await vi.waitFor(() =>
      expect((wrapper.get('[data-testid="ai-model"]').element as HTMLInputElement).value).toBe('writer-pro')
    )

    // 加载完成会回报一次「未就绪」（mock 里 ready: false）
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())
    expect((listener.mock.calls.at(-1)![0] as CustomEvent).detail).toBe(false)
    wrapper.unmount()
    window.removeEventListener('ai:readiness', listener)
  })

  it('AI 配置保存失败时不关闭面板，并把落点留在 AI 节', async () => {
    electronAPI.setAiConfig.mockResolvedValue({ success: false, error: '地址无效' })
    const wrapper = mount(SettingsDialog, { props: { initialSection: 'editor' } })

    await wrapper.findAll('.settings-rail__item').find((b) => b.text().includes('AI 助手'))!.trigger('click')
    await vi.waitFor(() =>
      expect((wrapper.get('[data-testid="ai-model"]').element as HTMLInputElement).value).toBe('writer-pro')
    )

    const saveButton = wrapper.findAll('.settings-foot button').find((b) => b.text() === '保存')!
    await saveButton.trigger('click')
    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())

    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.get('.settings-main__head h2').text()).toBe('AI 助手')
    expect(wrapper.text()).toContain('地址无效')
    wrapper.unmount()
  })
})
