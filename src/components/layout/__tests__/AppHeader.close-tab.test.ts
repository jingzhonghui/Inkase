// @vitest-environment jsdom

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import AppHeader from '../AppHeader.vue'
import { useFileStore } from '../../../stores/file'
import { createMdxDocument } from '../../../types/mdx'

/**
 * 关闭当前标签页（Ctrl+W）。
 *
 * 与点标签上的 × 走同一条 store 路径，所以这里验证两点：
 * 1. 有活动标签时能关掉；
 * 2. 有对话框开着时**不关**——那时用户想关的多半是对话框。
 */
describe('AppHeader Ctrl+W 关闭标签页', () => {
  let wrapper: VueWrapper | null = null

  const api = {
    newFile: vi.fn(async () => ({
      success: true,
      data: { document: createMdxDocument('未命名文档', ''), isNew: true }
    })),
    saveFile: vi.fn(async () => ({ success: true, data: 'C:/ws/a.mdx' })),
    getRecentFiles: vi.fn(async () => ({ success: true, data: [] })),
    getVersion: vi.fn(async () => 'test'),
    windowIsMaximized: vi.fn(async () => false),
    clearRecovery: vi.fn(async () => ({ success: true })),
    writeRecovery: vi.fn(async () => ({ success: true })),
    openLink: vi.fn(async () => ({ success: true })),
    onWindowMaximized: vi.fn(() => () => {}),
    onWindowUnmaximized: vi.fn(() => () => {})
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function mountWithSavedTab(): Promise<{ wrapper: VueWrapper; store: ReturnType<typeof useFileStore> }> {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useFileStore()
    await store.newFile()
    // 已落盘的文档：关闭时不会弹「是否保存」
    store.tabs[0].fileInfo = {
      path: 'C:/ws/a.mdx',
      name: 'a.mdx',
      modified: false,
      format: 'mdx'
    }
    const mounted = mount(AppHeader, {
      // 挂到 document 上：菜单栏在组件内、对话框在 teleport 里，这样两边都能查
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { SyncPanel: true } }
    })
    wrapper = mounted
    await nextTick()
    return { wrapper: mounted, store }
  }

  /** 点开顶部菜单（帮助菜单里的「关于 Inkase」） */
  async function openAboutDialog(): Promise<void> {
    const helpMenu = Array.from(document.querySelectorAll<HTMLElement>('.menu-item')).find(
      (el) => el.textContent?.trim() === '帮助'
    )
    expect(helpMenu).toBeTruthy()
    helpMenu!.click()
    await nextTick()

    const aboutEntry = Array.from(document.querySelectorAll<HTMLElement>('.menu-entry')).find(
      (el) => el.textContent?.includes('关于 Inkase')
    )
    expect(aboutEntry).toBeTruthy()
    aboutEntry!.click()
    await nextTick()
  }

  it('Ctrl+W 关掉当前标签', async () => {
    const { store } = await mountWithSavedTab()
    expect(store.tabs).toHaveLength(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }))
    await nextTick()
    await nextTick()

    expect(store.tabs).toHaveLength(0)
  })

  it('对话框开着时 Ctrl+W 不动标签', async () => {
    const { wrapper: mounted, store } = await mountWithSavedTab()

    await openAboutDialog()
    expect(document.body.textContent).toContain('一款以自包含')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }))
    await nextTick()
    await nextTick()

    expect(store.tabs).toHaveLength(1)
    expect(mounted.exists()).toBe(true)
  })

  it('关于对话框里的官网链接走系统浏览器打开', async () => {
    const { wrapper: mounted } = await mountWithSavedTab()

    await openAboutDialog()

    const link = document.body.querySelector<HTMLAnchorElement>('.about-site-link')
    expect(link).toBeTruthy()
    expect(link!.getAttribute('href')).toBe('https://jingzhonghui.github.io/Inkase/')

    link!.click()
    await nextTick()
    expect(api.openLink).toHaveBeenCalledWith('https://jingzhonghui.github.io/Inkase/')
    expect(mounted.exists()).toBe(true)
  })
})
