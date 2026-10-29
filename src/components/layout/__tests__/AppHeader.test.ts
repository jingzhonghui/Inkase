// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AppHeader from '../AppHeader.vue'
import { useFileStore } from '../../../stores/file'
import { useWorkspaceStore } from '../../../stores/workspace'
import { useSyncStore } from '../../../stores/sync'
import { dialogState, resolveDialogRequest } from '../../../utils/dialog'

function mountHeader() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(AppHeader, {
    global: {
      plugins: [pinia],
      stubs: { SyncPanel: true }
    }
  })
}

/**
 * 按标题找二级菜单容器。
 * 文件菜单里「新建」「打开」「最近文件」都带子菜单，只按 `.submenu` 取第一个会取错。
 */
function submenuByLabel(label: string): HTMLElement | null {
  const parents = Array.from(document.querySelectorAll<HTMLElement>('.menu-entry.has-sub'))
  const parent = parents.find((el) => el.firstElementChild?.textContent?.trim() === label)
  return parent?.querySelector<HTMLElement>('.submenu') ?? null
}

describe('AppHeader 插入对话框事件', () => {
  it('响应 editor:showLinkDialog 打开插入链接对话框', async () => {
    const wrapper = mountHeader()
    window.dispatchEvent(new Event('editor:showLinkDialog'))
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('插入链接')
    expect(document.body.querySelectorAll('.insert-dialog').length).toBeGreaterThan(0)
  })

  it('响应 editor:showImageDialog 打开插入图片对话框', async () => {
    const wrapper = mountHeader()
    window.dispatchEvent(new Event('editor:showImageDialog'))
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('插入图片')
    expect(document.body.querySelectorAll('.insert-dialog').length).toBeGreaterThan(0)
  })
})

describe('AppHeader 最近文件操作', () => {
  const originalElectronAPI = window.electronAPI

  afterEach(() => {
    window.electronAPI = originalElectronAPI
    document.body.innerHTML = ''
  })

  it('删除按钮仅在悬停最近文件项时显示，并删除对应记录', async () => {
    const removeRecentFile = vi.fn(async () => ({ success: true }))
    window.electronAPI = {
      removeRecentFile,
      windowIsMaximized: vi.fn(async () => false),
      getVersion: vi.fn(async () => 'test'),
      onWindowMaximized: vi.fn(() => () => {}),
      onWindowUnmaximized: vi.fn(() => () => {})
    } as unknown as typeof window.electronAPI

    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.recentFiles = [{ path: 'C:/ws/a.md', type: 'file' }]

    await wrapper.find('.menu-item').trigger('click')
    await wrapper.vm.$nextTick()

    const recentItem = submenuByLabel('最近文件')?.querySelector('.menu-entry') as HTMLElement
    expect(recentItem).toBeTruthy()
    expect(recentItem.querySelector('.recent-remove')).toBeNull()
    expect(submenuByLabel('最近文件')?.textContent).toContain('清空最近文件')

    await recentItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await wrapper.vm.$nextTick()

    const removeButton = recentItem.querySelector('.recent-remove') as HTMLButtonElement
    expect(removeButton).toBeTruthy()
    removeButton.click()

    await vi.waitFor(() => expect(removeRecentFile).toHaveBeenCalledWith('C:/ws/a.md'))
    expect(fileStore.recentFiles).toHaveLength(0)
  })
})

describe('AppHeader 快速打开（Ctrl+P）', () => {
  const originalElectronAPI = window.electronAPI

  afterEach(() => {
    ;(window as { electronAPI?: unknown }).electronAPI = originalElectronAPI
    document.body.innerHTML = ''
    if (dialogState.visible) resolveDialogRequest(0)
  })

  it('Ctrl+P 打开快速打开面板并列出文件', async () => {
    ;(window as { electronAPI?: unknown }).electronAPI = {
      searchFiles: vi.fn(async () => ({
        success: true,
        data: [{ name: 'a.md', path: 'C:/ws/a.md' }]
      })),
      windowIsMaximized: vi.fn(async () => false),
      getVersion: vi.fn(async () => 'test'),
      onWindowMaximized: vi.fn(() => () => {}),
      onWindowUnmaximized: vi.fn(() => () => {})
    }
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/ws'
    await wrapper.vm.$nextTick()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true })
    )
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(
      (window.electronAPI as { searchFiles: ReturnType<typeof vi.fn> }).searchFiles
    ).toHaveBeenCalledWith('C:/ws')
    expect(document.body.querySelectorAll('.quick-open-item').length).toBe(1)
  })

  it('未打开文件夹时 Ctrl+P 弹出提示', async () => {
    ;(window as { electronAPI?: unknown }).electronAPI = {
      searchFiles: vi.fn(),
      windowIsMaximized: vi.fn(async () => false),
      getVersion: vi.fn(async () => 'test'),
      onWindowMaximized: vi.fn(() => () => {}),
      onWindowUnmaximized: vi.fn(() => () => {})
    }
    const wrapper = mountHeader()
    await wrapper.vm.$nextTick()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true })
    )
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(dialogState.visible).toBe(true)
    expect(dialogState.message).toContain('请先打开文件夹')
  })

  it('响应 inkase:quick-open 事件打开面板', async () => {
    ;(window as { electronAPI?: unknown }).electronAPI = {
      searchFiles: vi.fn(async () => ({
        success: true,
        data: [{ name: 'a.md', path: 'C:/ws/a.md' }]
      })),
      windowIsMaximized: vi.fn(async () => false),
      getVersion: vi.fn(async () => 'test'),
      onWindowMaximized: vi.fn(() => () => {}),
      onWindowUnmaximized: vi.fn(() => () => {})
    }
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/ws'
    await wrapper.vm.$nextTick()

    window.dispatchEvent(new Event('inkase:quick-open'))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(
      (window.electronAPI as { searchFiles: ReturnType<typeof vi.fn> }).searchFiles
    ).toHaveBeenCalledWith('C:/ws')
    expect(document.body.querySelectorAll('.quick-open-item').length).toBe(1)
  })
})

describe('AppHeader 标签切换快捷键', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('Alt+方向键不再切换标签', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.tabs.push({ id: 'tab-1', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.tabs.push({ id: 'tab-2', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.activeTabId = 'tab-1'

    const nextEvent = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      altKey: true,
      cancelable: true
    })
    window.dispatchEvent(nextEvent)
    await wrapper.vm.$nextTick()
    expect(fileStore.activeTabId).toBe('tab-1')
    expect(nextEvent.defaultPrevented).toBe(false)

    const previousEvent = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      altKey: true,
      cancelable: true
    })
    window.dispatchEvent(previousEvent)
    await wrapper.vm.$nextTick()
    expect(fileStore.activeTabId).toBe('tab-1')
    expect(previousEvent.defaultPrevented).toBe(false)
  })

  it('Ctrl+ArrowRight 和 Ctrl+ArrowLeft 循环切换当前标签', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.tabs.push({ id: 'tab-1', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.tabs.push({ id: 'tab-2', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.activeTabId = 'tab-1'

    const nextEvent = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      ctrlKey: true,
      cancelable: true
    })
    window.dispatchEvent(nextEvent)
    await wrapper.vm.$nextTick()
    expect(fileStore.activeTabId).toBe('tab-2')
    expect(nextEvent.defaultPrevented).toBe(true)

    const previousEvent = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      ctrlKey: true,
      cancelable: true
    })
    window.dispatchEvent(previousEvent)
    await wrapper.vm.$nextTick()
    expect(fileStore.activeTabId).toBe('tab-1')

    // 带 Shift 的组合键不拦截，避免占用编辑器的选区扩展
    const shiftEvent = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true
    })
    window.dispatchEvent(shiftEvent)
    await wrapper.vm.$nextTick()
    expect(fileStore.activeTabId).toBe('tab-1')
    expect(shiftEvent.defaultPrevented).toBe(false)
  })

  it('Ctrl+方向键的循环包含工作台标签', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    const workspaceStore = useWorkspaceStore()
    fileStore.tabs.push({ id: 'tab-1', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.tabs.push({ id: 'tab-2', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.activeTabId = 'tab-1'

    // 标签序列是 [工作台, tab-1, tab-2]：从 tab-1 向左循环到工作台
    const toWorkspace = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      ctrlKey: true,
      cancelable: true
    })
    window.dispatchEvent(toWorkspace)
    await wrapper.vm.$nextTick()
    expect(workspaceStore.active).toBe(true)
    expect(fileStore.activeTabId).toBe('tab-1')

    // 再向右循环回到第一个文件标签，工作台收起
    const toFile = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      ctrlKey: true,
      cancelable: true
    })
    window.dispatchEvent(toFile)
    await wrapper.vm.$nextTick()
    expect(workspaceStore.active).toBe(false)
    expect(fileStore.activeTabId).toBe('tab-1')
  })

  it('在 input 中不拦截 Ctrl+方向键', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.tabs.push({ id: 'tab-1', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.tabs.push({ id: 'tab-2', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.activeTabId = 'tab-1'

    const input = document.createElement('input')
    document.body.appendChild(input)
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      ctrlKey: true,
      cancelable: true,
      bubbles: true
    })
    input.dispatchEvent(event)
    await wrapper.vm.$nextTick()

    expect(fileStore.activeTabId).toBe('tab-1')
    expect(event.defaultPrevented).toBe(false)
  })

  it('编辑器聚焦时 Ctrl+方向键也会切换标签并阻止编辑器继续处理', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.tabs.push({ id: 'tab-1', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.tabs.push({ id: 'tab-2', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.activeTabId = 'tab-1'

    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    document.body.appendChild(editor)
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      ctrlKey: true,
      cancelable: true,
      bubbles: true
    })
    editor.dispatchEvent(event)
    await wrapper.vm.$nextTick()

    expect(fileStore.activeTabId).toBe('tab-2')
    expect(event.defaultPrevented).toBe(true)
  })

  it('在 textarea 中不拦截 Ctrl+方向键', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.tabs.push({ id: 'tab-1', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.tabs.push({ id: 'tab-2', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.activeTabId = 'tab-1'

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      ctrlKey: true,
      cancelable: true,
      bubbles: true
    })
    textarea.dispatchEvent(event)
    await wrapper.vm.$nextTick()

    expect(fileStore.activeTabId).toBe('tab-1')
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('AppHeader 同步按钮', () => {
  const originalElectronAPI = window.electronAPI

  afterEach(() => {
    ;(window as { electronAPI?: unknown }).electronAPI = originalElectronAPI
    document.body.innerHTML = ''
    if (dialogState.visible) resolveDialogRequest(0)
  })

  function mockSyncStatus(status: string): void {
    ;(window as { electronAPI?: unknown }).electronAPI = {
      getSyncStatus: vi.fn(async () => ({
        success: true,
        data: {
          status,
          error: null,
          configured: true,
          isGitRepo: true,
          branch: 'main',
          upstream: 'origin/main'
        }
      })),
      windowIsMaximized: vi.fn(async () => false),
      getVersion: vi.fn(async () => 'test'),
      onWindowMaximized: vi.fn(() => () => {}),
      onWindowUnmaximized: vi.fn(() => () => {})
    }
  }

  it('同步进行中（syncing）时同步按钮图标带旋转样式', async () => {
    mockSyncStatus('syncing')
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/ws'
    await wrapper.vm.$nextTick()

    const syncStore = useSyncStore()
    await syncStore.refresh()
    await wrapper.vm.$nextTick()

    const icon = wrapper.find('.sync-btn svg')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('spinning')
  })

  it('非同步中（upToDate）时同步按钮图标无旋转样式', async () => {
    mockSyncStatus('upToDate')
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/ws'
    await wrapper.vm.$nextTick()

    const syncStore = useSyncStore()
    await syncStore.refresh()
    await wrapper.vm.$nextTick()

    const icon = wrapper.find('.sync-btn svg')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).not.toContain('spinning')
  })

  it('点击同步按钮切换面板开关并显示 active 状态', async () => {
    mockSyncStatus('upToDate')
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/ws'
    await wrapper.vm.$nextTick()

    const syncStore = useSyncStore()
    const button = wrapper.find('.sync-btn')
    expect(button.classes()).not.toContain('active')

    await button.trigger('click')
    expect(syncStore.panelOpen).toBe(true)
    await wrapper.vm.$nextTick()
    expect(button.classes()).toContain('active')

    await button.trigger('click')
    expect(syncStore.panelOpen).toBe(false)
    await wrapper.vm.$nextTick()
    expect(button.classes()).not.toContain('active')
  })

  it('面板打开时菜单「同步」项显示勾选状态', async () => {
    mockSyncStatus('upToDate')
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/ws'
    await wrapper.vm.$nextTick()

    const syncStore = useSyncStore()
    // 打开「文件」菜单后菜单项才渲染（dropdown 挂载在 document 上）
    await wrapper.find('.menu-item').trigger('click')
    await wrapper.vm.$nextTick()

    const findSyncCheck = (): string | undefined =>
      Array.from(document.querySelectorAll('.menu-entry'))
        .find((el) => el.textContent?.includes('同步'))
        ?.querySelector('.menu-check')?.textContent

    expect(findSyncCheck()).toBe('')

    syncStore.openPanel()
    await wrapper.vm.$nextTick()
    expect(findSyncCheck()).toBe('✓')

    syncStore.closePanel()
    await wrapper.vm.$nextTick()
    expect(findSyncCheck()).toBe('')
  })
})

describe('AppHeader 文件菜单聚合为二级菜单', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  async function openFileMenu(): Promise<void> {
    const wrapper = mountHeader()
    await wrapper.find('.menu-item').trigger('click')
    await wrapper.vm.$nextTick()
  }

  it('新建 / 打开 / 导入 / 导出 各自收成一个二级入口', async () => {
    await openFileMenu()

    const topLevelSubmenus = Array.from(
      document.querySelectorAll<HTMLElement>('.menu-entry.has-sub')
    )
      .filter((el) => !el.closest('.submenu'))
      .map((el) => el.firstElementChild?.textContent?.trim())
    expect(topLevelSubmenus).toEqual(['新建', '打开', '最近文件', '导入', '导出'])

    expect(submenuByLabel('新建')?.textContent).toContain('思维导图')
    expect(submenuByLabel('导入')?.textContent).toContain('Word 文档')
    expect(submenuByLabel('导出')?.textContent).toContain('思维导图大纲')
  })

  it('挪进二级菜单的条目仍然显示快捷键', async () => {
    await openFileMenu()

    expect(submenuByLabel('新建')?.querySelector('.shortcut')?.textContent).toBe('Ctrl+N')
    expect(submenuByLabel('打开')?.querySelector('.shortcut')?.textContent).toBe('Ctrl+O')

    // 顶层「保存」没有挪走，快捷键照旧
    const save = Array.from(document.querySelectorAll<HTMLElement>('.menu-entry')).find(
      (el) => el.firstElementChild?.textContent?.trim() === '保存'
    )
    expect(save?.querySelector('.shortcut')?.textContent).toBe('Ctrl+S')
  })

  it('菜单总行数收窄到十余行', async () => {
    await openFileMenu()

    const rows = document.querySelectorAll(
      '.menu-dropdown > .menu-entry, .menu-dropdown > .menu-divider'
    )
    expect(rows.length).toBeLessThanOrEqual(14)
  })
})

describe('AppHeader 导出图片', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  /** 「导出」二级菜单里按文案取命令项 */
  function exportSubItem(label: string): HTMLElement | null {
    const submenu = submenuByLabel('导出')
    if (!submenu) return null
    const entries = Array.from(submenu.querySelectorAll<HTMLElement>('.menu-entry'))
    return entries.find((el) => el.textContent?.trim() === label) ?? null
  }

  async function openFileMenu() {
    const wrapper = mountHeader()
    await wrapper.find('.menu-item').trigger('click')
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('普通文档下 PNG / SVG 置灰，Markdown 与 PDF 可用', async () => {
    await openFileMenu()

    expect(exportSubItem('PNG 图片')?.classList.contains('disabled')).toBe(true)
    expect(exportSubItem('SVG 矢量图')?.classList.contains('disabled')).toBe(true)
    expect(exportSubItem('Markdown')?.classList.contains('disabled')).toBe(false)
    expect(exportSubItem('PDF')?.classList.contains('disabled')).toBe(false)
  })

  it('思维导图下 PNG / SVG 可用，文本类导出置灰', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    await fileStore.newMindMap()

    await wrapper.find('.menu-item').trigger('click')
    await wrapper.vm.$nextTick()

    expect(exportSubItem('PNG 图片')?.classList.contains('disabled')).toBe(false)
    expect(exportSubItem('SVG 矢量图')?.classList.contains('disabled')).toBe(false)
    expect(exportSubItem('思维导图大纲')?.classList.contains('disabled')).toBe(false)
    expect(exportSubItem('Markdown')?.classList.contains('disabled')).toBe(true)
    expect(exportSubItem('PDF')?.classList.contains('disabled')).toBe(true)
    expect(exportSubItem('批量 PDF')?.classList.contains('disabled')).toBe(true)
  })

  it('点击 PNG 图片触发 PNG 导出', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    await fileStore.newMindMap()
    const exportSpy = vi.spyOn(fileStore, 'exportMindMapImage').mockResolvedValue(true)

    await wrapper.find('.menu-item').trigger('click')
    await wrapper.vm.$nextTick()

    // 点完菜单会收起，所以每个用例只点一次
    exportSubItem('PNG 图片')?.click()
    await flushPromises()
    expect(exportSpy).toHaveBeenCalledWith('png')
  })

  it('点击 SVG 矢量图触发 SVG 导出', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    await fileStore.newMindMap()
    const exportSpy = vi.spyOn(fileStore, 'exportMindMapImage').mockResolvedValue(true)

    await wrapper.find('.menu-item').trigger('click')
    await wrapper.vm.$nextTick()

    exportSubItem('SVG 矢量图')?.click()
    await flushPromises()
    expect(exportSpy).toHaveBeenCalledWith('svg')
  })

  it('导出失败时弹出说明对话框', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    await fileStore.newMindMap()
    vi.spyOn(fileStore, 'exportMindMapImage').mockImplementation(async () => {
      fileStore.error = '画布还没有可导出的内容'
      return false
    })

    await wrapper.find('.menu-item').trigger('click')
    await wrapper.vm.$nextTick()
    exportSubItem('PNG 图片')?.click()
    await flushPromises()

    expect(dialogState.title).toBe('导出失败')
    expect(dialogState.message).toContain('画布还没有可导出的内容')
    resolveDialogRequest(0)
  })
})
