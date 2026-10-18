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

describe('App AI ownership', () => {
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

  it('restores readiness only from capability evidence for the exact stored config', async () => {
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
    const wrapper = mount(App, { global: { stubs: {
      AppHeader: true, SideBar: true, StatusBar: true, ConfirmDialog: true,
      PdfExportView: true, PdfBatchProgressDialog: true,
      EditorPanel: { props: ['aiReady'], template: '<div data-testid="editor-panel" :data-ready="aiReady" />' },
      AiSettingsDialog: {
        props: ['open'], emits: ['close', 'readiness'],
        template: '<button data-testid="settings" @click="$emit(\'readiness\', false)" />'
      }
    } } })

    expect(init).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(wrapper.get('[data-testid="editor-panel"]').attributes('data-ready')).toBe('true'))
    await wrapper.get('[data-testid="settings"]').trigger('click')
    expect(wrapper.get('[data-testid="editor-panel"]').attributes('data-ready')).toBe('false')
    wrapper.unmount()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('stays not-ready when stored capability evidence is absent', async () => {
    vi.spyOn(useFileStore(), 'init').mockResolvedValue()
    const wrapper = mount(App, { global: { stubs: {
      AppHeader: true, SideBar: true, StatusBar: true, ConfirmDialog: true,
      PdfExportView: true, PdfBatchProgressDialog: true,
      EditorPanel: { props: ['aiReady'], template: '<div data-testid="editor-panel" :data-ready="aiReady" />' },
      AiSettingsDialog: true
    } } })

    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.get('[data-testid="editor-panel"]').attributes('data-ready')).toBe('false')
  })

  it('keeps AI disabled after testing unsaved settings and enables it after saving them', async () => {
    electronAPI.testAiConfig.mockResolvedValue({
      success: true,
      data: { textGeneration: true, toolCalling: true }
    })
    electronAPI.setAiConfig.mockResolvedValue({
      success: true,
      data: {
        baseUrl: 'https://example.test/v1', model: 'unsaved-model', temperature: 0.3,
        hasApiKey: true, ready: true,
        capabilities: { textGeneration: true, toolCalling: true }
      }
    })
    vi.spyOn(useFileStore(), 'init').mockResolvedValue()
    const wrapper = mount(App, { global: { stubs: {
      AppHeader: true, SideBar: true, StatusBar: true, ConfirmDialog: true,
      PdfExportView: true, PdfBatchProgressDialog: true,
      teleport: true,
      EditorPanel: {
        props: ['aiReady'], emits: ['openAiSettings'],
        template: '<div data-testid="editor-panel" :data-ready="aiReady"><button data-testid="open-settings" @click="$emit(\'openAiSettings\')" /></div>'
      }
    } } })
    await vi.waitFor(() => expect(electronAPI.getAiConfig).toHaveBeenCalledOnce())
    await wrapper.get('[data-testid="open-settings"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="ai-settings-form"]').exists()).toBe(true))
    await wrapper.get('[data-testid="ai-model"]').setValue('unsaved-model')

    await wrapper.get('[data-testid="ai-test-config"]').trigger('click')
    await vi.waitFor(() => expect(electronAPI.testAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.get('[data-testid="editor-panel"]').attributes('data-ready')).toBe('false')

    await wrapper.get('[data-testid="ai-settings-form"]').trigger('submit')
    await vi.waitFor(() => expect(electronAPI.setAiConfig).toHaveBeenCalledOnce())
    expect(wrapper.get('[data-testid="editor-panel"]').attributes('data-ready')).toBe('true')
  })
})
