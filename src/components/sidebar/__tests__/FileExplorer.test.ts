// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import FileExplorer from '../FileExplorer.vue'
import { useFileStore } from '../../../stores/file'
import type { FileTreeNode, TabInfo } from '../../../stores/file/types'
import { validateWindowsFolderName } from '../../../utils/windows-filename'

function makeDir(path: string, name: string, children: FileTreeNode[] = []): FileTreeNode {
  return { name, path, isDirectory: true, isExpanded: true, isLoading: false, children }
}

function makeFile(path: string, name: string): FileTreeNode {
  return { name, path, isDirectory: false, isExpanded: false, isLoading: false, children: [] }
}

describe('validateWindowsFolderName', () => {
  it('accepts normal Windows folder names', () => {
    expect(validateWindowsFolderName('项目资料 2026')).toBeNull()
    expect(validateWindowsFolderName('docs.v2')).toBeNull()
  })

  it('rejects empty names and names ending in spaces or dots', () => {
    expect(validateWindowsFolderName('')).not.toBeNull()
    expect(validateWindowsFolderName('   ')).not.toBeNull()
    expect(validateWindowsFolderName('资料 ')).not.toBeNull()
    expect(validateWindowsFolderName('资料.')).not.toBeNull()
  })

  it('does not ignore trailing spaces before validating', () => {
    expect(validateWindowsFolderName('资料 ')).not.toBeNull()
  })

  it('rejects Windows reserved characters and control characters', () => {
    for (const name of ['a<b', 'a>b', 'a:b', 'a"b', 'a/b', 'a\\b', 'a|b', 'a?b', 'a*b', 'a\u0001b']) {
      expect(validateWindowsFolderName(name)).not.toBeNull()
    }
  })

  it('rejects reserved device names including names with extensions', () => {
    for (const name of ['CON', 'con.txt', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9.data', 'LPT1', 'lpt9.log']) {
      expect(validateWindowsFolderName(name)).not.toBeNull()
    }
  })
})

describe('FileExplorer 空白区右键菜单', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function mountExplorer() {
    const pinia = createPinia()
    setActivePinia(pinia)
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/ws'
    fileStore.fileTree = [makeDir('C:/ws', 'ws', [makeFile('C:/ws/a.md', 'a.md')])]
    return mount(FileExplorer, {
      global: { plugins: [pinia] }
    })
  }

  async function openEmptyAreaMenu(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.find('.file-list').trigger('contextmenu', { clientX: 10, clientY: 10 })
    await nextTick()
  }

  it('offers a quick-open entry that dispatches the global event', async () => {
    const wrapper = mountExplorer()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    await openEmptyAreaMenu(wrapper)

    const items = Array.from(document.body.querySelectorAll('.context-menu-item'))
    const entry = items.find((el) => el.textContent?.trim() === '快速打开文件')
    expect(entry).toBeTruthy()

    entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    const dispatched = dispatchSpy.mock.calls.map((call) => (call[0] as Event).type)
    expect(dispatched).toContain('inkase:quick-open')
  })

  it('does not offer quick-open when no folder is opened', async () => {
    const fileStore = useFileStore()
    fileStore.openedFolderPath = null
    fileStore.fileTree = []
    const wrapper = mount(FileExplorer, {
      global: { plugins: [createPinia()] }
    })
    await openEmptyAreaMenu(wrapper)

    const items = Array.from(document.body.querySelectorAll('.context-menu-item'))
    expect(items.some((el) => el.textContent?.trim() === '快速打开文件')).toBe(false)
  })
})

describe('FileExplorer 新建文件夹输入', () => {
  function mountExplorer() {
    const pinia = createPinia()
    setActivePinia(pinia)
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/workspace'
    fileStore.fileTree = [makeDir('C:/workspace', 'workspace')]
    return { wrapper: mount(FileExplorer, { global: { plugins: [pinia] } }), fileStore }
  }

  async function openCreateFolderDialog(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.find('.file-list').trigger('contextmenu', { clientX: 10, clientY: 10 })
    const menuItem = Array.from(document.body.querySelectorAll('.context-menu-item'))
      .find((el) => el.textContent?.trim() === '新建文件夹')
    menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
  }

  it('starts with an empty value and folder-name placeholder', async () => {
    const { wrapper } = mountExplorer()
    await openCreateFolderDialog(wrapper)

    const input = document.body.querySelector<HTMLInputElement>('.dialog-input')
    expect(input?.value).toBe('')
    expect(input?.placeholder).toBe('请输入文件夹名称')
  })

  it('keeps the dialog open and reports an invalid name', async () => {
    const { wrapper, fileStore } = mountExplorer()
    const createFolder = vi.spyOn(fileStore, 'createFolder').mockResolvedValue(true)
    await openCreateFolderDialog(wrapper)

    const input = document.body.querySelector<HTMLInputElement>('.dialog-input')!
    input.value = 'CON'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    document.body.querySelector<HTMLButtonElement>('.dialog-btn-confirm')?.click()
    await nextTick()

    expect(document.body.querySelector('.dialog-input')).not.toBeNull()
    expect(document.body.querySelector('.dialog-error')?.textContent).toContain('Windows 保留名称')
    expect(createFolder).not.toHaveBeenCalled()
  })
})

describe('FileExplorer F2 重命名', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  function mountExplorer() {
    const pinia = createPinia()
    setActivePinia(pinia)
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/workspace'
    fileStore.fileTree = [makeDir('C:/workspace', 'workspace', [makeFile('C:/workspace/a.md', 'a.md')])]
    const wrapper = mount(FileExplorer, { global: { plugins: [pinia] }, attachTo: document.body })
    return { wrapper, fileStore }
  }

  it('opens rename input only when the explorer has focus and one item is selected', async () => {
    const { wrapper, fileStore } = mountExplorer()
    fileStore.selectOnly('C:/workspace/a.md')
    const fileList = wrapper.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'F2' })
    await nextTick()
    expect(document.body.querySelector('.dialog-input')).not.toBeNull()
    document.body.querySelector<HTMLButtonElement>('.dialog-btn-cancel')?.click()
    await nextTick()
  })

  it('does not rename when multiple items are selected', async () => {
    const { wrapper, fileStore } = mountExplorer()
    fileStore.selectOnly('C:/workspace/a.md')
    fileStore.toggleSelected('C:/workspace')
    const fileList = wrapper.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'F2' })
    await nextTick()
    expect(document.body.querySelector('.dialog-input')).toBeNull()
  })
})

describe('FileExplorer 文件树自动定位滚动', () => {
  let scrollSpy: ReturnType<typeof vi.fn>
  const mountedWrappers: Array<ReturnType<typeof mount>> = []

  function makeTab(id: string, path: string): TabInfo {
    return {
      id,
      fileInfo: { path, name: path.split('/').pop() || 'untitled', modified: false, format: 'mdx' },
      document: null,
      content: '',
      revision: 0
    }
  }

  function mountWithActiveFile(tree: FileTreeNode[], activePath: string) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'C:/ws'
    fileStore.fileTree = tree
    fileStore.tabs = [makeTab('t1', activePath)]
    fileStore.activeTabId = 't1'
    const wrapper = mount(FileExplorer, {
      global: { plugins: [pinia] },
      attachTo: document.body
    })
    mountedWrappers.push(wrapper)
    return { fileStore }
  }

  function scrollTargets(): Array<string | undefined> {
    return scrollSpy.mock.instances.map((inst) => (inst as HTMLElement | undefined)?.dataset?.filePath)
  }

  beforeEach(() => {
    scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
  })

  afterEach(() => {
    while (mountedWrappers.length > 0) {
      mountedWrappers.pop()?.unmount()
    }
    document.body.innerHTML = ''
  })

  it('激活文件后定位一次；此后折叠/展开其他目录不再触发定位滚动', async () => {
    const { fileStore } = mountWithActiveFile(
      [
        makeDir('C:/ws', 'ws', [
          makeDir('C:/ws/src', 'src', [makeFile('C:/ws/src/a.md', 'a.md')]),
          makeDir('C:/ws/lib', 'lib', [makeFile('C:/ws/lib/b.md', 'b.md')])
        ])
      ],
      'C:/ws/src/a.md'
    )
    const lib = fileStore.fileTree[0].children[1]
    await nextTick()
    await nextTick()

    // 激活文件（a.md 行已渲染）→ 定位滚动一次，目标是该文件
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollTargets()).toEqual(['C:/ws/src/a.md'])

    // 折叠不含 active 文件的 lib 目录：不应再把视图拉回 a.md
    await fileStore.toggleNode(lib)
    await nextTick()
    await nextTick()
    expect(scrollSpy).toHaveBeenCalledTimes(1)

    // 再次展开 lib：同样不应触发定位滚动
    await fileStore.toggleNode(lib)
    await nextTick()
    await nextTick()
    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })

  it('激活文件所在目录未展开时，等待其展开后补定位；命中后不再随目录变化滚动', async () => {
    const srcNode = makeDir('C:/ws/src', 'src')
    srcNode.isExpanded = false
    srcNode.children = [makeFile('C:/ws/src/a.md', 'a.md')]
    const { fileStore } = mountWithActiveFile(
      [makeDir('C:/ws', 'ws', [srcNode])],
      'C:/ws/src/a.md'
    )
    const src = fileStore.fileTree[0].children[0]
    await nextTick()
    await nextTick()

    // 首次定位：src 尚未展开，a.md 行未渲染，不滚动（等待异步 reveal）
    expect(scrollSpy).not.toHaveBeenCalled()

    // 目录被展开（如 setActiveTab 触发 revealFileInTree）→ 行渲染后补定位
    await fileStore.expandNode(src)
    await nextTick()
    await nextTick()
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollTargets()).toEqual(['C:/ws/src/a.md'])

    // 补定位完成后再折叠/展开：不再滚动
    await fileStore.toggleNode(src)
    await nextTick()
    await nextTick()
    await fileStore.toggleNode(src)
    await nextTick()
    await nextTick()
    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })
})
