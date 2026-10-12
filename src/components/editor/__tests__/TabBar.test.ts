// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TabBar from '../TabBar.vue'
import { useFileStore } from '../../../stores/file'
import { createMdxDocument } from '../../../types/mdx'

function stubElectronAPI(): void {
  const api = {
    openFile: vi.fn().mockImplementation(async (filePath: string) => ({
      success: true,
      data: { document: createMdxDocument(`Doc ${filePath}`, `# ${filePath}`), filePath, format: 'mdx' }
    })),
    clearRecovery: vi.fn(async () => ({ success: true })),
    addRecentFile: vi.fn(async () => ({ success: true }))
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn()
  })
  vi.stubGlobal('navigator', { userAgent: 'Windows', clipboard: { writeText: vi.fn() } })
}

async function openManyTabs(count: number): Promise<ReturnType<typeof useFileStore>> {
  const store = useFileStore()
  store.setMaxOpenTabs(100)
  for (let i = 0; i < count; i++) {
    await store.openFile(`C:/ws/f${i}.mdx`)
  }
  return store
}

describe('TabBar closing with many tabs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubElectronAPI()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('closeAllTabs via context menu closes every tab', async () => {
    const store = await openManyTabs(50)
    expect(store.tabs).toHaveLength(50)

    const wrapper = mount(TabBar)
    await wrapper.findAll('.tab')[0].trigger('contextmenu')
    await nextTick()
    const closeAll = clickMenuItem('关闭全部')
    expect(closeAll).toBe(true)

    await vi.waitFor(() => expect(store.tabs).toHaveLength(0))
  })

  it('closeOtherTabs via context menu keeps only the target tab', async () => {
    const store = await openManyTabs(10)
    const keep = store.tabs[3]

    const wrapper = mount(TabBar)
    await wrapper.findAll('.tab')[3].trigger('contextmenu')
    await nextTick()
    expect(clickMenuItem('关闭其他')).toBe(true)

    await vi.waitFor(() => expect(store.tabs).toHaveLength(1))
    expect(store.tabs[0].id).toBe(keep.id)
  })

  it('closeFolder closes folder tabs and clears the folder', async () => {
    const store = await openManyTabs(20)
    store.openedFolderPath = 'C:/ws'

    const wrapper = mount(TabBar)
    await wrapper.findAll('.tab')[0].trigger('contextmenu')
    await nextTick()
    expect(clickMenuItem('关闭全部')).toBe(true)

    await vi.waitFor(() => expect(store.tabs).toHaveLength(0))
  })
})

describe('TabBar drag reorder', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubElectronAPI()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  function tabNames(store: ReturnType<typeof useFileStore>): string[] {
    return store.tabs.map((t) => t.fileInfo?.name ?? '')
  }

  it('moves a tab dropped on the right half of a later tab', async () => {
    const store = await openManyTabs(3)
    const wrapper = mount(TabBar)
    const tabs = wrapper.findAll('.tab')

    await tabs[0].trigger('dragstart')
    await tabs[2].trigger('dragover', { clientX: 100 })
    await tabs[2].trigger('drop')

    expect(tabNames(store)).toEqual(['f1.mdx', 'f2.mdx', 'f0.mdx'])
  })

  it('moves a tab dropped on the left half of an earlier tab', async () => {
    const store = await openManyTabs(3)
    const wrapper = mount(TabBar)
    const tabs = wrapper.findAll('.tab')

    await tabs[2].trigger('dragstart')
    await tabs[0].trigger('dragover', { clientX: 0 })
    await tabs[0].trigger('drop')

    expect(tabNames(store)).toEqual(['f2.mdx', 'f0.mdx', 'f1.mdx'])
  })

  it('does not reorder after dragend clears the drag state', async () => {
    const store = await openManyTabs(3)
    const wrapper = mount(TabBar)
    const tabs = wrapper.findAll('.tab')

    await tabs[0].trigger('dragstart')
    await tabs[0].trigger('dragend')
    await tabs[1].trigger('dragover', { clientX: 100 })
    await tabs[1].trigger('drop')

    expect(tabNames(store)).toEqual(['f0.mdx', 'f1.mdx', 'f2.mdx'])
  })
})

describe('TabBar label for read-only media', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubElectronAPI()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('shows the original filename for a pdf tab instead of a .mdx title', async () => {
    ;(window.electronAPI.openFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        document: createMdxDocument('季度报告', ''),
        filePath: 'C:/ws/季度报告.pdf',
        format: 'pdf',
        isNew: false,
        largeFileWarning: false,
        pdfBase64: 'data'
      }
    })
    const store = useFileStore()
    await store.openFile('C:/ws/季度报告.pdf')
    expect(store.activeTab?.fileInfo?.format).toBe('pdf')

    const wrapper = mount(TabBar)
    expect(wrapper.find('.tab-label').text()).toBe('季度报告.pdf')
    vi.useFakeTimers()
    await wrapper.find('.tab-label').trigger('mouseover')
    vi.advanceTimersByTime(400)
    await nextTick()
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('季度报告.pdf')
    vi.useRealTimers()
  })

  it('shows the original filename for an image tab instead of a .mdx title', async () => {
    ;(window.electronAPI.openFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        document: createMdxDocument('截图', ''),
        filePath: 'C:/ws/截图.png',
        format: 'image',
        isNew: false,
        largeFileWarning: false,
        imageDataUrl: 'data:image/png;base64,'
      }
    })
    const store = useFileStore()
    await store.openFile('C:/ws/截图.png')
    expect(store.activeTab?.fileInfo?.format).toBe('image')

    const wrapper = mount(TabBar)
    expect(wrapper.find('.tab-label').text()).toBe('截图.png')
  })
})

function clickMenuItem(label: string): boolean {
  const items = Array.from(document.querySelectorAll('.context-menu-item'))
  const item = items.find((el) => el.textContent?.includes(label))
  if (!item) return false
  ;(item as HTMLElement).click()
  return true
}
