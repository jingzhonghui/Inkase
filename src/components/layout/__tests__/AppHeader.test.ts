// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AppHeader from '../AppHeader.vue'
import { useFileStore } from '../../../stores/file'
import { useDailyStore } from '../../../stores/daily'
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

    const recentItem = document.querySelector('.submenu .menu-entry') as HTMLElement
    expect(recentItem).toBeTruthy()
    expect(recentItem.querySelector('.recent-remove')).toBeNull()
    expect(document.querySelector('.submenu')?.textContent).toContain('清空最近文件')

    await recentItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await wrapper.vm.$nextTick()

    const removeButton = recentItem.querySelector('.recent-remove') as HTMLButtonElement
    expect(removeButton).toBeTruthy()
    removeButton.click()

    await vi.waitFor(() => expect(removeRecentFile).toHaveBeenCalledWith('C:/ws/a.md'))
    expect(fileStore.recentFiles).toHaveLength(0)
  })
})

describe('AppHeader 每日笔记设置', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('edits and saves daily note directory, filename and template', async () => {
    const wrapper = mountHeader()

    const viewMenu = wrapper.findAll('.menu-item').find((item) => item.text() === '视图')!
    await viewMenu.trigger('click')
    await wrapper.vm.$nextTick()
    const settingsEntry = [...document.querySelectorAll<HTMLElement>('.menu-dropdown .menu-entry')]
      .find((entry) => entry.textContent?.includes('设置'))
    expect(settingsEntry).toBeTruthy()
    settingsEntry!.click()
    await wrapper.vm.$nextTick()

    const rows = [...document.querySelectorAll<HTMLElement>('.settings-row')]
    const rowFor = (label: string): HTMLElement => rows.find((row) => row.textContent?.includes(label))!
    const directory = rowFor('每日笔记目录').querySelector('input')!
    const filename = rowFor('每日笔记文件名').querySelector('input')!
    const template = rowFor('每日笔记模板').querySelector('textarea')!
    directory.value = 'journal'
    directory.dispatchEvent(new Event('input', { bubbles: true }))
    filename.value = 'YYYYMMDD'
    filename.dispatchEvent(new Event('input', { bubbles: true }))
    template.value = '# {{date}} 日记'
    template.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()

    const save = [...document.querySelectorAll<HTMLButtonElement>('.settings-actions button')]
      .find((button) => button.textContent?.trim() === '完成')!
    save.click()
    await wrapper.vm.$nextTick()

    expect(useDailyStore().config).toMatchObject({
      directory: 'journal',
      filenamePattern: 'YYYYMMDD',
      template: '# {{date}} 日记'
    })
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

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect((window.electronAPI as { searchFiles: ReturnType<typeof vi.fn> }).searchFiles).toHaveBeenCalledWith('C:/ws')
    expect(document.body.querySelectorAll('.quick-open-item:not(.is-command)').length).toBe(1)
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

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true }))
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

    expect((window.electronAPI as { searchFiles: ReturnType<typeof vi.fn> }).searchFiles).toHaveBeenCalledWith('C:/ws')
    expect(document.body.querySelectorAll('.quick-open-item:not(.is-command)').length).toBe(1)
  })
})

describe('AppHeader 标签切换快捷键', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('Alt+ArrowRight 和 Alt+ArrowLeft 循环切换当前标签', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    const first = fileStore.tabs.push({ id: 'tab-1', fileInfo: null, document: null, content: '', revision: 0 })
    const second = fileStore.tabs.push({ id: 'tab-2', fileInfo: null, document: null, content: '', revision: 0 })
    expect(first).toBe(1)
    expect(second).toBe(2)
    fileStore.activeTabId = 'tab-1'

    const nextEvent = new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, cancelable: true })
    window.dispatchEvent(nextEvent)
    await wrapper.vm.$nextTick()
    expect(fileStore.activeTabId).toBe('tab-2')
    expect(nextEvent.defaultPrevented).toBe(true)

    const previousEvent = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, cancelable: true })
    window.dispatchEvent(previousEvent)
    await wrapper.vm.$nextTick()
    expect(fileStore.activeTabId).toBe('tab-1')
    expect(previousEvent.defaultPrevented).toBe(true)

    const wrapEvent = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, cancelable: true })
    window.dispatchEvent(wrapEvent)
    await wrapper.vm.$nextTick()
    expect(fileStore.activeTabId).toBe('tab-2')
  })

  it('在输入框中不拦截 Alt+方向键', async () => {
    const wrapper = mountHeader()
    const fileStore = useFileStore()
    fileStore.tabs.push({ id: 'tab-1', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.tabs.push({ id: 'tab-2', fileInfo: null, document: null, content: '', revision: 0 })
    fileStore.activeTabId = 'tab-1'

    const input = document.createElement('input')
    document.body.appendChild(input)
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, cancelable: true, bubbles: true })
    input.dispatchEvent(event)
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
