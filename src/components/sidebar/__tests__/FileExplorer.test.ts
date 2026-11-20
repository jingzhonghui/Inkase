// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import FileExplorer from '../FileExplorer.vue'
import PromptDialog from '../../common/PromptDialog.vue'
import ConfirmDialog from '../../common/ConfirmDialog.vue'
import { useFileStore } from '../../../stores/file'
import type { FileTreeNode, TabInfo } from '../../../stores/file/types'
import { validateWindowsFolderName, validateWindowsFileName } from '../../../utils/windows-filename'
import { cancelDialogRequest } from '../../../utils/dialog'
import { cancelPrompt } from '../../../utils/prompt'

function makeDir(path: string, name: string, children: FileTreeNode[] = []): FileTreeNode {
  return { name, path, isDirectory: true, isExpanded: true, isLoading: false, children }
}

function makeFile(path: string, name: string): FileTreeNode {
  return { name, path, isDirectory: false, isExpanded: false, isLoading: false, children: [] }
}

/**
 * 右键菜单里按「聚合项 → 子项」两级定位。
 * 新建与打开下面都有「文件」「文件夹」，单看文字会取错，必须带上父项。
 */
function submenuItem(parentLabel: string, childLabel: string): HTMLElement | undefined {
  const parents = Array.from(
    document.body.querySelectorAll<HTMLElement>('.context-menu-item.has-sub')
  )
  const parent = parents.find((el) => el.firstElementChild?.textContent?.trim() === parentLabel)
  const children = Array.from(
    parent?.querySelectorAll<HTMLElement>('.context-submenu .context-menu-item') ?? []
  )
  return children.find((el) => el.textContent?.trim() === childLabel)
}

/** 菜单里的顶层条目文字（不含二级菜单里的子项） */
function topLevelLabels(): string[] {
  const menu = document.body.querySelector('.context-menu')
  if (!menu) return []
  return Array.from(menu.children).map((el) => {
    // 聚合项的子菜单是嵌套 DOM，直接用 textContent 会把子项文字一起拼进来
    const label = el.querySelector(':scope > span') ?? el
    return label.textContent?.trim() ?? ''
  })
}

/**
 * 挂载文件树，并带上它依赖的两个全局对话框。
 *
 * 输入框（`PromptDialog`）与确认框（`ConfirmDialog`）都挂在 `App.vue` 上：
 * 新建文件 / 重命名也从文件菜单进来，不可能跟着文件树一起被 `v-if` 掉。
 * 所以单挂 `FileExplorer` 是拿不到 `.dialog-input` 的，测试里必须把宿主一起挂。
 */
const mountedHosts: Array<ReturnType<typeof mount>> = []

function mountExplorerWithDialogs(
  tree: FileTreeNode[],
  options: { openedFolderPath?: string | null; attachTo?: HTMLElement } = {}
): { wrapper: ReturnType<typeof mount>; fileStore: ReturnType<typeof useFileStore> } {
  const pinia = createPinia()
  setActivePinia(pinia)
  const fileStore = useFileStore()
  fileStore.openedFolderPath =
    'openedFolderPath' in options ? (options.openedFolderPath ?? null) : 'C:/workspace'
  fileStore.fileTree = tree
  const Host = defineComponent({
    render: () => h('div', [h(FileExplorer), h(PromptDialog), h(ConfirmDialog)])
  })
  const wrapper = mount(Host, {
    global: { plugins: [pinia] },
    attachTo: options.attachTo
  })
  mountedHosts.push(wrapper)
  return { wrapper, fileStore }
}

/**
 * 所有用例统一由这里收尾。
 *
 * 三件事都必须做：
 * 1. 关掉还开着的对话框。`promptState` / `dialogState` 是模块级单例，
 *    跨用例残留会让下一条用例一挂载就弹出「上一条留下的」对话框，
 *    于是 `querySelector('.dialog-input')` 抓到的是别的测试的输入框。
 * 2. 卸载（让 Vue 自己把 teleport 收干净）。
 * 3. 再清空 body。
 *
 * 顺序不能反：直接 `document.body.innerHTML = ''` 之后 Vue 手里还攥着被删掉的
 * teleport 容器，下一次 `v-if` 打开就是
 * `Cannot read properties of null (reading 'insertBefore')`。
 */
afterEach(() => {
  cancelPrompt()
  cancelDialogRequest()
  while (mountedHosts.length > 0) mountedHosts.pop()?.unmount()
  document.body.innerHTML = ''
})

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
    for (const name of [
      'a<b',
      'a>b',
      'a:b',
      'a"b',
      'a/b',
      'a\\b',
      'a|b',
      'a?b',
      'a*b',
      'a\u0001b'
    ]) {
      expect(validateWindowsFolderName(name)).not.toBeNull()
    }
  })

  it('rejects reserved device names including names with extensions', () => {
    for (const name of [
      'CON',
      'con.txt',
      'PRN',
      'AUX',
      'NUL',
      'COM1',
      'COM9.data',
      'LPT1',
      'lpt9.log'
    ]) {
      expect(validateWindowsFolderName(name)).not.toBeNull()
    }
  })
})

describe('validateWindowsFileName', () => {
  it('accepts custom suffixes and extensionless names', () => {
    expect(validateWindowsFileName('deploy.sh')).toBeNull()
    expect(validateWindowsFileName('config.json')).toBeNull()
    expect(validateWindowsFileName('笔记')).toBeNull()
    expect(validateWindowsFileName('data.tar.gz')).toBeNull()
  })

  it('rejects empty names and names ending in spaces or dots', () => {
    expect(validateWindowsFileName('')).not.toBeNull()
    expect(validateWindowsFileName('   ')).not.toBeNull()
    expect(validateWindowsFileName('note ')).not.toBeNull()
    expect(validateWindowsFileName('note.')).not.toBeNull()
  })

  it('rejects reserved characters and control characters', () => {
    for (const name of [
      'a<b',
      'a>b',
      'a:b',
      'a"b',
      'a/b',
      'a\\b',
      'a|b',
      'a?b',
      'a*b',
      'a\u0001b'
    ]) {
      expect(validateWindowsFileName(name)).not.toBeNull()
    }
  })

  it('rejects reserved device names including names with extensions', () => {
    for (const name of ['CON', 'con.txt', 'NUL', 'COM1.sh', 'LPT9.json']) {
      expect(validateWindowsFileName(name)).not.toBeNull()
    }
  })
})

describe('FileExplorer 空白区右键菜单', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function mountExplorer() {
    const { wrapper } = mountExplorerWithDialogs(
      [makeDir('C:/ws', 'ws', [makeFile('C:/ws/a.md', 'a.md')])],
      { openedFolderPath: 'C:/ws' }
    )
    return wrapper
  }

  async function openEmptyAreaMenu(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.find('.file-list').trigger('contextmenu', { clientX: 10, clientY: 10 })
    await nextTick()
  }

  it('offers a quick-open entry that dispatches the global event', async () => {
    const wrapper = mountExplorer()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    await openEmptyAreaMenu(wrapper)

    const entry = submenuItem('打开', '快速打开')
    expect(entry).toBeTruthy()

    entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    const dispatched = dispatchSpy.mock.calls.map((call) => (call[0] as Event).type)
    expect(dispatched).toContain('inkase:quick-open')
  })

  it('does not offer quick-open when no folder is opened', async () => {
    const { wrapper } = mountExplorerWithDialogs([], { openedFolderPath: null })
    await openEmptyAreaMenu(wrapper)

    expect(submenuItem('打开', '快速打开')).toBeUndefined()
  })

  it('把新建 / 导入 / 打开收成二级菜单，顶层只剩几组', async () => {
    const wrapper = mountExplorer()
    await openEmptyAreaMenu(wrapper)

    // 顶层：3 个聚合入口 + 3 个单项，不再是一长串平铺项
    expect(topLevelLabels()).toEqual(['新建', '导入', '打开', '', '粘贴', '刷新', '关闭文件夹'])
    expect(document.body.querySelectorAll('.context-submenu')).toHaveLength(3)
    expect(document.body.querySelectorAll('.context-menu-divider').length).toBeGreaterThan(0)
  })

  it('新建 / 导入 的子项按类型分组', async () => {
    const wrapper = mountExplorer()
    await openEmptyAreaMenu(wrapper)

    const newItems = Array.from(
      document.body
        .querySelectorAll('.context-menu-item.has-sub')[0]
        .querySelectorAll('.context-submenu .context-menu-item')
    ).map((el) => el.textContent?.trim())
    expect(newItems).toEqual(['文件', '思维导图', '图表', '文件夹'])
    expect(submenuItem('导入', 'Markdown')).toBeTruthy()
    expect(submenuItem('导入', 'Word 文档')).toBeTruthy()
  })

  it('点聚合项本身不执行动作，菜单保持打开', async () => {
    const wrapper = mountExplorer()
    await openEmptyAreaMenu(wrapper)

    const parents = Array.from(
      document.body.querySelectorAll<HTMLElement>('.context-menu-item.has-sub')
    )
    parents[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(document.body.querySelector('.context-menu')).not.toBeNull()
  })
})

describe('FileExplorer 新建文件夹输入', () => {
  function mountExplorer() {
    // 必须带上 PromptDialog：输入框是全局单例（挂载在 App.vue），
    // 只挂文件树时 `.dialog-input` 根本不在 DOM 里
    return mountExplorerWithDialogs([makeDir('C:/workspace', 'workspace')])
  }

  async function openCreateFolderDialog(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.find('.file-list').trigger('contextmenu', { clientX: 10, clientY: 10 })
    submenuItem('新建', '文件夹')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

describe('FileExplorer 新建文件对话框（后缀自由输入）', () => {
  function mountExplorer() {
    return mountExplorerWithDialogs([makeDir('C:/workspace', 'workspace')])
  }

  async function openCreateFileDialog(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.find('.file-list').trigger('contextmenu', { clientX: 10, clientY: 10 })
    submenuItem('新建', '文件')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
  }

  async function fillAndConfirm(name: string): Promise<void> {
    const input = document.body.querySelector<HTMLInputElement>('.dialog-input')!
    input.value = name
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    document.body.querySelector<HTMLButtonElement>('.dialog-btn-confirm')?.click()
    await nextTick()
  }

  it('starts empty with an example placeholder and no extension dropdown', async () => {
    const { wrapper } = mountExplorer()
    await openCreateFileDialog(wrapper)

    const input = document.body.querySelector<HTMLInputElement>('.dialog-input')
    expect(input?.value).toBe('')
    expect(input?.placeholder).toContain('例如')
    expect(document.body.querySelector('.dialog-select')).toBeNull()
  })

  it('creates a file with a custom suffix exactly as typed', async () => {
    const { wrapper, fileStore } = mountExplorer()
    const createFile = vi.spyOn(fileStore, 'createFile').mockResolvedValue(true)
    await openCreateFileDialog(wrapper)
    await fillAndConfirm('deploy.sh')

    expect(createFile).toHaveBeenCalledWith('C:/workspace', 'deploy.sh')
  })

  it('creates an extensionless file exactly as typed (no default suffix)', async () => {
    const { wrapper, fileStore } = mountExplorer()
    const createFile = vi.spyOn(fileStore, 'createFile').mockResolvedValue(true)
    await openCreateFileDialog(wrapper)
    await fillAndConfirm('笔记')

    expect(createFile).toHaveBeenCalledWith('C:/workspace', '笔记')
  })

  it('creates a diagram from 新建 ▸ 图表 with a .drawio suffix prefilled', async () => {
    const { wrapper, fileStore } = mountExplorer()
    const createFile = vi.spyOn(fileStore, 'createFile').mockResolvedValue(true)
    await wrapper.find('.file-list').trigger('contextmenu', { clientX: 10, clientY: 10 })
    submenuItem('新建', '图表')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    const input = document.body.querySelector<HTMLInputElement>('.dialog-input')
    expect(input?.value).toBe('未命名图表.drawio')

    await fillAndConfirm('接口设计.drawio')
    expect(createFile).toHaveBeenCalledWith('C:/workspace', '接口设计.drawio')
  })

  it('keeps the dialog open and reports an invalid name', async () => {
    const { wrapper, fileStore } = mountExplorer()
    const createFile = vi.spyOn(fileStore, 'createFile').mockResolvedValue(true)
    await openCreateFileDialog(wrapper)
    await fillAndConfirm('a/b')

    expect(document.body.querySelector('.dialog-input')).not.toBeNull()
    expect(document.body.querySelector('.dialog-error')?.textContent).toContain('不能包含')
    expect(createFile).not.toHaveBeenCalled()
  })
})

describe('FileExplorer F2 重命名', () => {
  function mountExplorer(children: FileTreeNode[] = [makeFile('C:/workspace/a.md', 'a.md')]) {
    return mountExplorerWithDialogs([makeDir('C:/workspace', 'workspace', children)], {
      attachTo: document.body
    })
  }

  function renameInput(): HTMLInputElement {
    return document.body.querySelector<HTMLInputElement>('.dialog-input')!
  }

  it('opens rename input only when the explorer has focus and one item is selected', async () => {
    const { wrapper: host, fileStore } = mountExplorer()
    fileStore.selectOnly('C:/workspace/a.md')
    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'F2' })
    await nextTick()
    expect(document.body.querySelector('.dialog-input')).not.toBeNull()
    document.body.querySelector<HTMLButtonElement>('.dialog-btn-cancel')?.click()
    await nextTick()
  })

  it('does not rename when multiple items are selected', async () => {
    const { wrapper: host, fileStore } = mountExplorer()
    fileStore.selectOnly('C:/workspace/a.md')
    fileStore.toggleSelected('C:/workspace')
    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'F2' })
    await nextTick()
    expect(document.body.querySelector('.dialog-input')).toBeNull()
  })

  it('默认只选中主文件名，后缀留在选中区之外', async () => {
    const { wrapper: host, fileStore } = mountExplorer()
    fileStore.selectOnly('C:/workspace/a.md')
    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'F2' })
    await nextTick()
    await nextTick()

    const input = renameInput()
    expect(input.value).toBe('a.md')
    // 「a」被选中、「.md」不被选中：直接打字就是改名，后缀不会丢
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 1])
  })

  it('多后缀文件只剥最后一个后缀', async () => {
    const { wrapper: host, fileStore } = mountExplorer([
      makeFile('C:/workspace/archive.tar.gz', 'archive.tar.gz')
    ])
    fileStore.selectOnly('C:/workspace/archive.tar.gz')
    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'F2' })
    await nextTick()
    await nextTick()

    const input = renameInput()
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'archive.tar'.length])
  })

  it('点开头的名字没有后缀可言，整名选中', async () => {
    const { wrapper: host, fileStore } = mountExplorer([
      makeFile('C:/workspace/.gitignore', '.gitignore')
    ])
    fileStore.selectOnly('C:/workspace/.gitignore')
    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'F2' })
    await nextTick()
    await nextTick()

    const input = renameInput()
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, '.gitignore'.length])
  })

  it('文件夹重命名整名选中（目录名里的点不是后缀）', async () => {
    const { wrapper: host, fileStore } = mountExplorer([makeDir('C:/workspace/docs.v2', 'docs.v2')])
    fileStore.selectOnly('C:/workspace/docs.v2')
    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'F2' })
    await nextTick()
    await nextTick()

    const input = renameInput()
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'docs.v2'.length])
  })
})

describe('FileExplorer Delete 键删除', () => {
  function mountExplorer(children: FileTreeNode[]) {
    return mountExplorerWithDialogs([makeDir('C:/workspace', 'workspace', children)], {
      attachTo: document.body
    })
  }

  /** 点确认框里的「删除」 */
  async function confirmDelete(): Promise<void> {
    document.body.querySelector<HTMLButtonElement>('.dialog-btn-confirm')?.click()
    await nextTick()
    await nextTick()
  }

  it('单选按 Delete 先确认，确认后删掉该文件', async () => {
    const { wrapper: host, fileStore } = mountExplorer([
      makeFile('C:/workspace/a.md', 'a.md'),
      makeFile('C:/workspace/b.md', 'b.md')
    ])
    const deleteItem = vi.spyOn(fileStore, 'deleteItem').mockResolvedValue(true)
    fileStore.selectOnly('C:/workspace/a.md')

    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'Delete' })
    await nextTick()

    expect(document.body.querySelector('.dialog-title')?.textContent).toContain('删除文件')
    expect(deleteItem).not.toHaveBeenCalled()

    await confirmDelete()
    expect(deleteItem).toHaveBeenCalledWith('C:/workspace/a.md')
  })

  it('取消时不删除', async () => {
    const { wrapper: host, fileStore } = mountExplorer([makeFile('C:/workspace/a.md', 'a.md')])
    const deleteItem = vi.spyOn(fileStore, 'deleteItem').mockResolvedValue(true)
    fileStore.selectOnly('C:/workspace/a.md')

    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'Delete' })
    await nextTick()
    document.body.querySelector<HTMLButtonElement>('.dialog-btn-cancel')?.click()
    await nextTick()

    expect(deleteItem).not.toHaveBeenCalled()
  })

  it('多选时逐个删除', async () => {
    const { wrapper: host, fileStore } = mountExplorer([
      makeFile('C:/workspace/a.md', 'a.md'),
      makeFile('C:/workspace/b.md', 'b.md'),
      makeFile('C:/workspace/c.md', 'c.md')
    ])
    const deleteItem = vi.spyOn(fileStore, 'deleteItem').mockResolvedValue(true)
    fileStore.selectOnly('C:/workspace/a.md')
    fileStore.toggleSelected('C:/workspace/b.md')

    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'Delete' })
    await nextTick()

    expect(document.body.querySelector('.dialog-title')?.textContent).toContain('删除所选项目')
    await confirmDelete()

    expect(deleteItem.mock.calls.map((call) => call[0])).toEqual([
      'C:/workspace/a.md',
      'C:/workspace/b.md'
    ])
  })

  it('目录与其子项同时选中时只删目录（子项不再单独删一次）', async () => {
    const { wrapper: host, fileStore } = mountExplorer([
      makeDir('C:/workspace/src', 'src', [makeFile('C:/workspace/src/a.md', 'a.md')])
    ])
    const deleteItem = vi.spyOn(fileStore, 'deleteItem').mockResolvedValue(true)
    fileStore.selectOnly('C:/workspace/src')
    fileStore.toggleSelected('C:/workspace/src/a.md')

    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'Delete' })
    await nextTick()
    await confirmDelete()

    expect(deleteItem.mock.calls.map((call) => call[0])).toEqual(['C:/workspace/src'])
  })

  it('列表没有焦点时不响应 Delete（例如焦点在编辑器里）', async () => {
    const { wrapper: host, fileStore } = mountExplorer([makeFile('C:/workspace/a.md', 'a.md')])
    const deleteItem = vi.spyOn(fileStore, 'deleteItem').mockResolvedValue(true)
    fileStore.selectOnly('C:/workspace/a.md')

    const fileList = host.find('.file-list')
    await fileList.trigger('keydown', { key: 'Delete' })
    await nextTick()

    expect(document.body.querySelector('.dialog-input')).toBeNull()
    expect(deleteItem).not.toHaveBeenCalled()
  })

  it('确认框说明是移入回收站，不是永久删除', async () => {
    const { wrapper: host, fileStore } = mountExplorer([makeFile('C:/workspace/a.md', 'a.md')])
    vi.spyOn(fileStore, 'deleteItem').mockResolvedValue(true)
    fileStore.selectOnly('C:/workspace/a.md')

    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'Delete' })
    await nextTick()

    expect(document.body.querySelector('.dialog-message')?.textContent).toContain('回收站')
  })

  it('移入回收站失败时明确提示，不静默吞掉', async () => {
    const { wrapper: host, fileStore } = mountExplorer([makeFile('C:/workspace/a.md', 'a.md')])
    vi.spyOn(fileStore, 'deleteItem').mockResolvedValue(false)
    fileStore.error = '移入回收站失败：recycle bin unavailable'
    fileStore.selectOnly('C:/workspace/a.md')

    const fileList = host.find('.file-list')
    await fileList.element.focus()
    await fileList.trigger('keydown', { key: 'Delete' })
    await nextTick()

    // 第一层是删除确认
    await confirmDelete()
    // 失败提示要等 deleteItem 的 promise 结算后才弹，比成功路径多一轮微任务
    await nextTick()
    await nextTick()

    expect(document.body.querySelector('.dialog-title')?.textContent).toContain('删除失败')
    expect(document.body.querySelector('.dialog-message')?.textContent).toContain('回收站')
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
    return scrollSpy.mock.instances.map(
      (inst) => (inst as HTMLElement | undefined)?.dataset?.filePath
    )
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
    const { fileStore } = mountWithActiveFile([makeDir('C:/ws', 'ws', [srcNode])], 'C:/ws/src/a.md')
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

describe('FileExplorer 节点右键菜单的复制路径', () => {
  let written: string | null = null

  beforeEach(() => {
    written = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written = text
          return Promise.resolve()
        }
      }
    })
  })

  afterEach(() => {
    delete (navigator as { clipboard?: unknown }).clipboard
  })

  /** 根 `C:/ws` 下挂 `docs/b.md`，用于比对相对路径的正斜杠形态 */
  function mountTree() {
    const { wrapper } = mountExplorerWithDialogs(
      [
        makeDir('C:/ws', 'ws', [
          makeDir('C:/ws/docs', 'docs', [makeFile('C:/ws/docs/b.md', 'b.md')])
        ])
      ],
      { openedFolderPath: 'C:/ws' }
    )
    return wrapper
  }

  async function openNodeMenu(wrapper: ReturnType<typeof mount>, path: string): Promise<void> {
    const content = wrapper.find(`.item-content[data-file-path="${path}"]`)
    expect(content.exists()).toBe(true)
    await content.trigger('contextmenu', { clientX: 10, clientY: 10 })
    await nextTick()
  }

  /** 顶层菜单项（排除二级菜单里的同名子项） */
  function menuItem(label: string): HTMLElement | undefined {
    const items = Array.from(
      document.body.querySelectorAll<HTMLElement>('.context-menu > .context-menu-item')
    )
    // 普通项的文字是裸文本节点，聚合项是 `<span>`：两者都看第一个子节点，
    // 这样不会把二级菜单的子项文字一起拼进来
    return items.find((el) => el.firstChild?.textContent?.trim() === label)
  }

  async function clickMenuItem(label: string): Promise<void> {
    const item = menuItem(label)
    expect(item).toBeTruthy()
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
  }

  it('文件节点：「复制相对路径」紧挨在「复制路径」上方', async () => {
    const wrapper = mountTree()
    await openNodeMenu(wrapper, 'C:/ws/docs/b.md')

    const labels = topLevelLabels()
    const relativeIndex = labels.indexOf('复制相对路径')
    expect(relativeIndex).toBeGreaterThan(-1)
    expect(labels[relativeIndex + 1]).toBe('复制路径')
  })

  it('文件节点：「复制相对路径」给的是正斜杠相对路径', async () => {
    const wrapper = mountTree()
    await openNodeMenu(wrapper, 'C:/ws/docs/b.md')

    await clickMenuItem('复制相对路径')

    expect(written).toBe('docs/b.md')
  })

  it('文件节点：「复制路径」仍是绝对路径', async () => {
    const wrapper = mountTree()
    await openNodeMenu(wrapper, 'C:/ws/docs/b.md')

    await clickMenuItem('复制路径')

    // 传进 store 的就是文件树节点的原始路径，原样复制
    expect(written).toBe('C:/ws/docs/b.md')
  })

  it('文件夹节点也有这一对，复制的是目录的相对路径', async () => {
    const wrapper = mountTree()
    await openNodeMenu(wrapper, 'C:/ws/docs')

    const labels = topLevelLabels()
    const relativeIndex = labels.indexOf('复制相对路径')
    expect(relativeIndex).toBeGreaterThan(-1)
    expect(labels[relativeIndex + 1]).toBe('复制路径')

    await clickMenuItem('复制相对路径')
    expect(written).toBe('docs')
  })
})
