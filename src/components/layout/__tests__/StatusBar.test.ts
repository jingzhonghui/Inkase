// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import StatusBar from '../StatusBar.vue'
import { useFileStore } from '../../../stores/file'
import { createMdxDocument } from '../../../types/mdx'

describe('StatusBar 文档统计', () => {
  const originalElectronAPI = window.electronAPI

  afterEach(() => {
    window.electronAPI = originalElectronAPI
    document.body.innerHTML = ''
  })

  it('不显示文件名，打开文件后显示正确字数', async () => {
    setActivePinia(createPinia())
    window.electronAPI = {
      openFile: vi.fn(async (filePath: string) => ({
        success: true,
        data: {
          document: createMdxDocument('Note', '# heading\n\nbody'),
          filePath,
          format: 'markdown'
        }
      })),
      getVersion: vi.fn(async () => 'test')
    } as unknown as typeof window.electronAPI

    const store = useFileStore()
    await store.openFile('C:/ws/note.md')
    const wrapper = mount(StatusBar)
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('note.md')
    expect(wrapper.text()).toContain('字数: 12')
  })

  it('Markdown 文件把编辑模式拆成三个按钮，点哪个切哪个（不用循环）', async () => {
    setActivePinia(createPinia())
    window.electronAPI = {
      openFile: vi.fn(async (filePath: string) => ({
        success: true,
        data: {
          document: createMdxDocument('Note', '# heading\n\nbody'),
          filePath,
          format: 'markdown'
        }
      })),
      getVersion: vi.fn(async () => 'test')
    } as unknown as typeof window.electronAPI

    const store = useFileStore()
    await store.openFile('C:/ws/note.md')
    const wrapper = mount(StatusBar)
    await wrapper.vm.$nextTick()

    const buttons = wrapper.findAll('.mode-switch-btn')
    expect(buttons).toHaveLength(3)
    // 默认即时渲染；其余两项未选中
    expect(buttons[0].attributes('aria-pressed')).toBe('true')
    expect(buttons[1].attributes('aria-pressed')).toBe('false')

    // 直接从第一个跳到第三个：不需要按循环顺序点两遍
    await buttons[2].trigger('click')
    expect(store.editorMode).toBe('split')
    expect(wrapper.findAll('.mode-switch-btn')[2].attributes('aria-pressed')).toBe('true')

    // 再直接回到中间一项
    await wrapper.findAll('.mode-switch-btn')[1].trigger('click')
    expect(store.editorMode).toBe('source')
  })

  it('不可切换的文件（纯文本）只显示只读模式标签，不渲染三个按钮', async () => {
    setActivePinia(createPinia())
    window.electronAPI = {
      openFile: vi.fn(async (filePath: string) => ({
        success: true,
        data: {
          document: createMdxDocument('Note', 'body'),
          filePath,
          format: 'markdown'
        }
      })),
      getVersion: vi.fn(async () => 'test')
    } as unknown as typeof window.electronAPI

    const store = useFileStore()
    await store.openFile('C:/ws/note.txt')
    const wrapper = mount(StatusBar)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.mode-switch').exists()).toBe(false)
    const readonlyButton = wrapper.find('.mode-toggle-btn')
    expect(readonlyButton.exists()).toBe(true)
    expect(readonlyButton.attributes('disabled')).toBeDefined()
  })

  it('右下角显示缩放读数，+/- 每次 25%，并按标签页各自保留', async () => {
    setActivePinia(createPinia())
    window.electronAPI = {
      openFile: vi.fn(async (filePath: string) => ({
        success: true,
        data: {
          document: createMdxDocument('Note', '# heading\n\nbody'),
          filePath,
          format: 'markdown'
        }
      })),
      getVersion: vi.fn(async () => 'test')
    } as unknown as typeof window.electronAPI

    const store = useFileStore()
    await store.openFile('C:/ws/a.md')
    const wrapper = mount(StatusBar)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.zoom-control').exists()).toBe(true)
    expect(wrapper.find('.zoom-percent').text()).toBe('100%')

    const stepButtons = wrapper.findAll('.zoom-step')
    await stepButtons[1].trigger('click')
    expect(wrapper.find('.zoom-percent').text()).toBe('125%')
    await stepButtons[0].trigger('click')
    await stepButtons[0].trigger('click')
    expect(wrapper.find('.zoom-percent').text()).toBe('75%')

    // 另一个标签是独立的 100%
    await store.openFile('C:/ws/b.md')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.zoom-percent').text()).toBe('100%')

    // 切回来恢复 75%
    const firstTab = store.tabs[0]
    store.activeTabId = firstTab.id
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.zoom-percent').text()).toBe('75%')
  })

  it('图表与 HTML 预览不显示缩放控件', async () => {
    setActivePinia(createPinia())
    window.electronAPI = {
      openFile: vi.fn(async (filePath: string) => ({
        success: true,
        data: {
          document: createMdxDocument('Note', 'body'),
          filePath,
          format: filePath.endsWith('.drawio') ? 'diagram' : 'markdown'
        }
      })),
      getVersion: vi.fn(async () => 'test')
    } as unknown as typeof window.electronAPI

    const store = useFileStore()
    await store.openFile('C:/ws/graph.drawio')
    const wrapper = mount(StatusBar)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.zoom-control').exists()).toBe(false)
  })
})
