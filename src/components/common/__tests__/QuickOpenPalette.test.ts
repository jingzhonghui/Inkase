// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import QuickOpenPalette from '../QuickOpenPalette.vue'
import { useDailyStore } from '../../../stores/daily'
import { useFileStore } from '../../../stores/file'

const FILES = [
  { name: 'readme.md', path: 'C:/ws/readme.md' },
  { name: 'guide.md', path: 'C:/ws/docs/guide.md' },
  { name: 'app.ts', path: 'C:/ws/src/app.ts' }
]

describe('QuickOpenPalette', () => {
  const originalElectronAPI = window.electronAPI
  let searchFilesMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    searchFilesMock = vi.fn(async () => ({ success: true, data: FILES }))
    ;(window as { electronAPI?: unknown }).electronAPI = {
      searchFiles: searchFilesMock
    }
  })

  afterEach(() => {
    ;(window as { electronAPI?: unknown }).electronAPI = originalElectronAPI
    document.body.innerHTML = ''
  })

  function mountPalette(visible = true) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/ws'
    const openFileSpy = vi.spyOn(fileStore, 'openFile').mockResolvedValue(true)
    const wrapper = mount(QuickOpenPalette, {
      props: { visible },
      global: { plugins: [pinia] }
    })
    return { wrapper, openFileSpy, fileStore }
  }

  function qs<T extends Element = HTMLElement>(selector: string): T | null {
    return document.body.querySelector<T>(selector)
  }

  function typeInInput(text: string): void {
    const input = qs<HTMLInputElement>('.quick-open-input')!
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function pressKey(key: string): void {
    const input = qs<HTMLInputElement>('.quick-open-input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }

  it('loads the file list from the opened folder when shown', async () => {
    mountPalette()
    await nextTick()
    await nextTick()

    expect(searchFilesMock).toHaveBeenCalledWith('C:/ws')
    const items = document.body.querySelectorAll('.quick-open-item:not(.is-command)')
    expect(items.length).toBe(3)
  })

  it('filters results as the query changes', async () => {
    mountPalette()
    await nextTick()
    await nextTick()

    typeInInput('guide')
    await nextTick()

    const items = document.body.querySelectorAll('.quick-open-item')
    expect(items.length).toBe(1)
    expect(items[0].textContent).toContain('guide.md')
  })

  it('opens the selected file on Enter and closes', async () => {
    const { wrapper, openFileSpy } = mountPalette()
    await nextTick()
    await nextTick()

    typeInInput('guide')
    await nextTick()
    pressKey('Enter')
    await nextTick()

    expect(openFileSpy).toHaveBeenCalledWith('C:/ws/docs/guide.md', { addToRecent: false, preview: true })
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('closes on Escape', async () => {
    const { wrapper } = mountPalette()
    await nextTick()
    await nextTick()

    pressKey('Escape')
    await nextTick()

    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('moves the selection with ArrowDown / ArrowUp', async () => {
    mountPalette()
    await nextTick()
    await nextTick()

    const activeAt = (): string | undefined =>
      document.body.querySelector('.quick-open-item.is-active')?.textContent
    expect(activeAt()).toContain('readme.md')

    pressKey('ArrowDown')
    await nextTick()
    expect(activeAt()).toContain('guide.md')

    pressKey('ArrowUp')
    pressKey('ArrowUp')
    await nextTick()
    expect(activeAt()).toContain('打开今天的每日笔记')

    pressKey('ArrowUp')
    await nextTick()
    expect(activeAt()).toContain('app.ts')
  })

  it('opens the daily note command from the palette', async () => {
    const { wrapper } = mountPalette()
    const daily = useDailyStore()
    const openToday = vi.spyOn(daily, 'openToday').mockResolvedValue(true)
    await nextTick()
    await nextTick()

    document.body.querySelector<HTMLElement>('[data-testid="quick-open-daily"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(openToday).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('opens a file on click', async () => {
    const { openFileSpy } = mountPalette()
    await nextTick()
    await nextTick()

    const item = document.body.querySelectorAll('.quick-open-item:not(.is-command)')[2]
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(openFileSpy).toHaveBeenCalledWith('C:/ws/src/app.ts', { addToRecent: false, preview: true })
  })

  it('shows a hint when no folder is opened', async () => {
    const fileStore = useFileStore()
    fileStore.openedFolderPath = null
    mount(QuickOpenPalette, {
      props: { visible: true },
      global: { plugins: [createPinia()] }
    })
    await nextTick()
    await nextTick()

    expect(qs('.quick-open-empty')?.textContent).toBeTruthy()
    expect(searchFilesMock).not.toHaveBeenCalled()
  })

  it('shows the path relative to the opened folder even with backslash separators', async () => {
    ;(window as { electronAPI?: unknown }).electronAPI = {
      searchFiles: vi.fn(async () => ({
        success: true,
        data: [{ name: 'guide.md', path: 'C:\\ws\\docs\\guide.md' }]
      }))
    }
    mountPalette()
    await nextTick()
    await nextTick()

    const items = document.body.querySelectorAll('.quick-open-item:not(.is-command)')
    expect(items.length).toBe(1)
    expect(items[0].textContent).toBe('docs/guide.md')
  })

  it('does not render anything when hidden', async () => {
    mountPalette(false)
    await nextTick()

    expect(searchFilesMock).not.toHaveBeenCalled()
    expect(qs('.quick-open-input')).toBeNull()
  })
})
