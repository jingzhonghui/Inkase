// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import App from '../../../App.vue'
import { useAiStore } from '../../../stores/ai'
import { useFileStore } from '../../../stores/file'

const electronAPI = {
  getAiConfig: vi.fn(),
  setAiConfig: vi.fn(),
  testAiConfig: vi.fn(),
  onAiRunEvent: vi.fn(() => () => undefined),
  onUpdateAvailable: vi.fn(() => () => undefined),
  onUpdateNotAvailable: vi.fn(() => () => undefined),
  onUpdateError: vi.fn(() => () => undefined),
  checkForUpdates: vi.fn(async () => ({ success: true })),
  syncAttachFolder: vi.fn(async () => ({ success: true })),
  syncDetachFolder: vi.fn(async () => ({ success: true })),
  getSyncStatus: vi.fn(async () => ({ success: true, data: null })),
  onSyncEvent: vi.fn(() => () => undefined),
  onSyncFileChanged: vi.fn(() => () => undefined)
}

/**
 * App 对 AI 的两条责任，与「设置面板长什么样」无关：
 * 1. 就绪状态只认主进程给的证据（存下来的 capabilities），不靠猜；
 * 2. 设置中心改完配置后能把新的就绪状态送回来。
 *
 * 配置表单本身（Key 不回显、探测竞态、「测通 ≠ 就绪」）在
 * `settings/__tests__/ai-settings.test.ts` 里守着，这里不重复。
 */
describe('App AI ownership', () => {
  const editorPanelStub = {
    props: ['aiReady'],
    emits: ['openAiSettings'],
    template:
      '<div data-testid="editor-panel" :data-ready="aiReady">' +
      '<button data-testid="open-settings" @click="$emit(\'openAiSettings\')" /></div>'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() })
    electronAPI.getAiConfig.mockResolvedValue({
      success: true,
      data: { baseUrl: 'https://example.test/v1', model: 'writer', temperature: 0.3, hasApiKey: true }
    })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: electronAPI })
  })

  function mountApp() {
    return mount(App, {
      global: {
        stubs: {
          AppHeader: true,
          SideBar: true,
          StatusBar: true,
          ConfirmDialog: true,
          PdfExportView: true,
          PdfBatchProgressDialog: true,
          EditorPanel: editorPanelStub
        }
      }
    })
  }

  it('restores readiness from stored capability evidence', async () => {
    electronAPI.getAiConfig.mockResolvedValueOnce({
      success: true,
      data: {
        baseUrl: 'https://example.test/v1', model: 'writer', temperature: 0.3,
        hasApiKey: true, ready: true,
        capabilities: { textGeneration: true, toolCalling: true }
      }
    })
    const aiStore = useAiStore()
    vi.spyOn(useFileStore(), 'init').mockResolvedValue()
    const init = vi.spyOn(aiStore, 'init')
    const dispose = vi.spyOn(aiStore, 'dispose')
    const wrapper = mountApp()

    expect(init).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(wrapper.get('[data-testid="editor-panel"]').attributes('data-ready')).toBe('true'))
    wrapper.unmount()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('stays not-ready when stored capability evidence is absent', async () => {
    vi.spyOn(useFileStore(), 'init').mockResolvedValue()
    const wrapper = mountApp()

    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.get('[data-testid="editor-panel"]').attributes('data-ready')).toBe('false')
  })

  it('applies the readiness reported by the settings center', async () => {
    vi.spyOn(useFileStore(), 'init').mockResolvedValue()
    const wrapper = mountApp()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.get('[data-testid="editor-panel"]').attributes('data-ready')).toBe('false')

    window.dispatchEvent(new CustomEvent('ai:readiness', { detail: true }))
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="editor-panel"]').attributes('data-ready')).toBe('true')
    )

    window.dispatchEvent(new CustomEvent('ai:readiness', { detail: false }))
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="editor-panel"]').attributes('data-ready')).toBe('false')
    )
    wrapper.unmount()
  })

  it('asks the settings center to open on the AI section instead of a private dialog', async () => {
    vi.spyOn(useFileStore(), 'init').mockResolvedValue()
    const listener = vi.fn()
    window.addEventListener('inkase:open-settings', listener)
    const wrapper = mountApp()

    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
    await wrapper.get('[data-testid="open-settings"]').trigger('click')

    expect(listener).toHaveBeenCalledOnce()
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: 'ai' })
    wrapper.unmount()
    window.removeEventListener('inkase:open-settings', listener)
  })
})
