// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TabBar from '../TabBar.vue'
import EditorPanel from '../EditorPanel.vue'
import AppHeader from '../../layout/AppHeader.vue'
import { useAiStore } from '../../../stores/ai'
import { useFileStore } from '../../../stores/file'
import { createMdxDocument } from '../../../types/mdx'

function mountTabBar() {
  return mount(TabBar)
}

describe('AI tab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
  })

  it('is absent by default and remains available without file tabs', async () => {
    const wrapper = mountTabBar()
    const aiStore = useAiStore()

    expect(wrapper.find('[data-testid="ai-tab"]').exists()).toBe(false)

    aiStore.openPanel()
    await nextTick()

    expect(wrapper.get('[data-testid="ai-tab"]').text()).toContain('AI 助手')
    expect(wrapper.get('[data-testid="ai-tab"]').classes()).toContain('active')
  })

  it('closes from its close button and middle click', async () => {
    const wrapper = mountTabBar()
    const aiStore = useAiStore()
    const close = vi.spyOn(aiStore, 'requestClosePanel').mockResolvedValue()
    aiStore.openPanel()
    await nextTick()

    await wrapper.get('[data-testid="ai-tab-close"]').trigger('click')
    expect(close).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-testid="ai-tab"]').trigger('mousedown', { button: 1 })
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('deactivates AI and activates the selected file tab', async () => {
    const wrapper = mountTabBar()
    const aiStore = useAiStore()
    const fileStore = useFileStore()
    const tab = fileStore.createGeneratedDocument('文档', 'content', 'markdown')
    aiStore.openPanel()
    await nextTick()

    await wrapper.get(`[data-tab-id="${tab.id}"]`).trigger('click')

    expect(aiStore.panelActive).toBe(false)
    expect(fileStore.activeTabId).toBe(tab.id)
  })

  it('deactivates AI when a file is opened while the AI tab is active', async () => {
    const fileStore = useFileStore()
    const aiStore = useAiStore()
    aiStore.openPanel()
    await nextTick()

    const originalElectronApi = window.electronAPI
    window.electronAPI = {
      openFile: vi.fn().mockResolvedValue({
        success: true,
        data: { document: createMdxDocument('已打开', 'hi'), filePath: '/tmp/已打开.mdx', format: 'mdx' }
      }),
      getRecentFiles: vi.fn().mockResolvedValue({ success: true, data: [] })
    }
    try {
      await fileStore.openFile('/tmp/已打开.mdx')

      expect(fileStore.activeTabId).not.toBeNull()
      expect(aiStore.panelActive).toBe(false)

      const wrapper = mountTabBar()
      await nextTick()
      expect(wrapper.get(`[data-tab-id="${fileStore.activeTabId}"]`).classes()).toContain('active')
      expect(wrapper.get('[data-testid="ai-tab"]').classes()).not.toContain('active')
    } finally {
      window.electronAPI = originalElectronApi
    }
  })

  it('shows distinct running and pending-approval markers', async () => {
    const wrapper = mountTabBar()
    const aiStore = useAiStore()
    aiStore.openPanel()
    aiStore.running = true
    await nextTick()
    expect(wrapper.find('[data-testid="ai-running-marker"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ai-approval-marker"]').exists()).toBe(false)

    aiStore.running = false
    aiStore.pendingApprovals.push({} as never)
    await nextTick()
    expect(wrapper.find('[data-testid="ai-running-marker"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ai-approval-marker"]').exists()).toBe(true)
  })

  it('can be dragged to a position before the file tabs', async () => {
    const wrapper = mountTabBar()
    const aiStore = useAiStore()
    const fileStore = useFileStore()
    const first = fileStore.createGeneratedDocument('一', 'a', 'markdown')
    const second = fileStore.createGeneratedDocument('二', 'b', 'markdown')
    aiStore.openPanel()
    await nextTick()

    const order = () =>
      wrapper.findAll('.tab').map((tab) => tab.attributes('data-testid') ?? tab.attributes('data-tab-id'))

    expect(order()).toEqual([first.id, second.id, 'ai-tab'])

    await wrapper.get('[data-testid="ai-tab"]').trigger('dragstart')
    const firstTab = wrapper.get(`[data-tab-id="${first.id}"]`)
    await firstTab.trigger('dragover', { clientX: 0 })
    await firstTab.trigger('drop')

    expect(aiStore.tabIndex).toBe(0)
    expect(order()).toEqual(['ai-tab', first.id, second.id])
    // AI 位置变化不应打乱文件标签相对顺序
    expect(fileStore.tabs.map((tab) => tab.id)).toEqual([first.id, second.id])
  })

  it('can be dragged to a position between file tabs', async () => {
    const wrapper = mountTabBar()
    const aiStore = useAiStore()
    const fileStore = useFileStore()
    const first = fileStore.createGeneratedDocument('一', 'a', 'markdown')
    const second = fileStore.createGeneratedDocument('二', 'b', 'markdown')
    aiStore.openPanel()
    await nextTick()

    await wrapper.get('[data-testid="ai-tab"]').trigger('dragstart')
    const secondTab = wrapper.get(`[data-tab-id="${second.id}"]`)
    await secondTab.trigger('dragover', { clientX: 0 })
    await secondTab.trigger('drop')

    expect(aiStore.tabIndex).toBe(1)
    expect(
      wrapper.findAll('.tab').map((tab) => tab.attributes('data-testid') ?? tab.attributes('data-tab-id'))
    ).toEqual([first.id, 'ai-tab', second.id])
  })

  it('moves a file tab across the AI tab', async () => {
    const wrapper = mountTabBar()
    const aiStore = useAiStore()
    const fileStore = useFileStore()
    const first = fileStore.createGeneratedDocument('一', 'a', 'markdown')
    const second = fileStore.createGeneratedDocument('二', 'b', 'markdown')
    aiStore.openPanel()
    aiStore.setTabIndex(1)
    await nextTick()

    const order = () =>
      wrapper.findAll('.tab').map((tab) => tab.attributes('data-testid') ?? tab.attributes('data-tab-id'))
    expect(order()).toEqual([first.id, 'ai-tab', second.id])

    const firstTab = wrapper.get(`[data-tab-id="${first.id}"]`)
    await firstTab.trigger('dragstart')
    const secondTab = wrapper.get(`[data-tab-id="${second.id}"]`)
    await secondTab.trigger('dragover', { clientX: 100 })
    await secondTab.trigger('drop')

    expect(aiStore.tabIndex).toBe(0)
    expect(order()).toEqual(['ai-tab', second.id, first.id])
  })
})

describe('AI editor view', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
  })

  it('shows AiPanel while keeping an open document editor mounted', async () => {
    const fileStore = useFileStore()
    fileStore.createGeneratedDocument('文档', 'content', 'markdown')
    const wrapper = mount(EditorPanel, {
      global: {
        stubs: {
          TabBar: true,
          IrEditor: { template: '<div data-testid="document-editor" />' },
          SourceEditor: { template: '<div data-testid="document-editor" />' },
          PreviewPanel: true,
          AiPanel: { template: '<div data-testid="ai-panel" />' }
        }
      }
    })
    const aiStore = useAiStore()
    aiStore.openPanel()
    await nextTick()

    expect(wrapper.get('[data-testid="ai-panel"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="document-editor"]').exists()).toBe(true)
  })

  it('passes reactive readiness to AiPanel and forwards settings requests', async () => {
    const wrapper = mount(EditorPanel, {
      props: { aiReady: false },
      global: { stubs: {
        TabBar: true,
        AiPanel: {
          props: ['ready'], emits: ['open-settings'],
          template: '<button data-testid="ai-panel" :data-ready="ready" @click="$emit(\'open-settings\')" />'
        }
      } }
    })
    const aiStore = useAiStore()
    aiStore.openPanel()
    await nextTick()

    expect(wrapper.get('[data-testid="ai-panel"]').attributes('data-ready')).toBe('false')
    await wrapper.setProps({ aiReady: true })
    expect(wrapper.get('[data-testid="ai-panel"]').attributes('data-ready')).toBe('true')
    await wrapper.get('[data-testid="ai-panel"]').trigger('click')
    expect(wrapper.emitted('openAiSettings')).toHaveLength(1)
  })

  it('returns to the welcome view after closing AI with no files', async () => {
    const wrapper = mount(EditorPanel, {
      global: {
        stubs: { TabBar: true, AiPanel: { template: '<div data-testid="ai-panel" />' } }
      }
    })
    const aiStore = useAiStore()
    aiStore.openPanel()
    await nextTick()
    expect(wrapper.get('[data-testid="ai-panel"]').isVisible()).toBe(true)

    await aiStore.requestClosePanel()
    await nextTick()
    expect(wrapper.get('.welcome-page').isVisible()).toBe(true)
  })
})

describe('AI header entry', () => {
  it('does not auto-open AI and opens it from the View menu', async () => {
    setActivePinia(createPinia())
    const wrapper = mount(AppHeader, {
      global: { stubs: { teleport: true } }
    })
    const aiStore = useAiStore()
    expect(aiStore.panelOpen).toBe(false)

    await wrapper.findAll('.menu-item').find((item) => item.text() === '视图')!.trigger('click')
    await wrapper.findAll('.menu-entry').find((item) => item.text().includes('AI 助手'))!.trigger('click')

    expect(aiStore.panelOpen).toBe(true)
    expect(aiStore.panelActive).toBe(true)
  })

  it('opens AI from the header button and closes it again on a second click', async () => {
    setActivePinia(createPinia())
    const wrapper = mount(AppHeader, {
      global: { stubs: { teleport: true } }
    })
    const aiStore = useAiStore()
    const close = vi.spyOn(aiStore, 'requestClosePanel').mockResolvedValue()
    expect(aiStore.panelOpen).toBe(false)

    const aiButton = wrapper.find('[aria-label="AI 助手"]')
    await aiButton.trigger('click')

    expect(aiStore.panelOpen).toBe(true)
    expect(aiStore.panelActive).toBe(true)
    expect(aiButton.classes()).toContain('active')

    await aiButton.trigger('click')
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith()
  })
})
