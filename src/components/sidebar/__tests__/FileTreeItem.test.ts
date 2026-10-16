// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'
import FileTreeItem from '../FileTreeItem.vue'
import { dialogState, resolveDialogRequest } from '../../../utils/dialog'
import type { FileTreeNode } from '../../../stores/file/types'
import { useFileStore } from '../../../stores/file'

function makeDir(path: string, name: string, children: FileTreeNode[] = []): FileTreeNode {
  return { name, path, isDirectory: true, isExpanded: true, isLoading: false, children }
}

function makeFile(path: string, name: string): FileTreeNode {
  return { name, path, isDirectory: false, isExpanded: false, isLoading: false, children: [] }
}

async function dispatchDrag(wrapper: ReturnType<typeof mount>, path: string, type: string): Promise<void> {
  const el = wrapper.find(`[data-file-path="${path}"]`)
  el.element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  await nextTick()
}

describe('FileTreeItem drag & drop', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function mountTree(onDropToFolder: ReturnType<typeof vi.fn> = vi.fn()) {
    const dragState = reactive<{ sourcePaths: string[]; sourcePath: string | null; hoverPath: string | null }>({
      sourcePaths: [],
      sourcePath: 'C:/docs/X.md',
      hoverPath: null
    })
    const wrapper = mount(FileTreeItem, {
      props: {
        node: makeDir('C:/docs/A', 'A', [
          makeFile('C:/docs/A/A-1.md', 'A-1.md'),
          makeDir('C:/docs/A/B', 'B')
        ])
      },
      global: {
        plugins: [createPinia()],
        provide: {
          fileTreeDragState: dragState,
          fileTreeOnDropToFolder: onDropToFolder
        }
      }
    })
    return { wrapper, dragState, onDropToFolder }
  }

  it('bubbles a drop on a child FILE up to the parent directory', async () => {
    const { wrapper, onDropToFolder } = mountTree()
    await dispatchDrag(wrapper, 'C:/docs/A/A-1.md', 'drop')
    expect(onDropToFolder).toHaveBeenCalledWith('C:/docs/A')
  })

  it('handles a drop directly on the directory row', async () => {
    const { wrapper, onDropToFolder } = mountTree()
    await dispatchDrag(wrapper, 'C:/docs/A', 'drop')
    expect(onDropToFolder).toHaveBeenCalledWith('C:/docs/A')
  })

  it('handles a drop on the expanded children area (tree-children node)', async () => {
    const { wrapper, onDropToFolder } = mountTree()
    const childrenArea = wrapper.find('.tree-children')
    expect(childrenArea.exists()).toBe(true)
    childrenArea.element.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true }))
    expect(onDropToFolder).toHaveBeenCalledWith('C:/docs/A')
  })

  it('highlights a directory when dragging over its children area', async () => {
    const { wrapper } = mountTree()
    await dispatchDrag(wrapper, 'C:/docs/A/A-1.md', 'dragover')
    expect(wrapper.find('[data-file-path="C:/docs/A"]').classes()).toContain('is-drag-over')
  })

  it('stops dragover propagation so only the innermost directory is highlighted', async () => {
    const { wrapper } = mountTree()
    await dispatchDrag(wrapper, 'C:/docs/A/B', 'dragover')
    expect(wrapper.find('[data-file-path="C:/docs/A/B"]').classes()).toContain('is-drag-over')
    expect(wrapper.find('[data-file-path="C:/docs/A"]').classes()).not.toContain('is-drag-over')
  })

  it('only highlights the innermost directory, never its ancestors', async () => {
    const node = makeDir('C:/R', 'R', [makeDir('C:/R/A', 'A', [makeDir('C:/R/A/B', 'B')])])
    const dragState = reactive<{ sourcePaths: string[]; sourcePath: string | null; hoverPath: string | null }>({
      sourcePaths: [],
      sourcePath: 'C:/X.md',
      hoverPath: null
    })
    const onDropToFolder = vi.fn()
    const wrapper = mount(FileTreeItem, {
      props: { node },
      global: {
        plugins: [createPinia()],
        provide: {
          fileTreeDragState: dragState,
          fileTreeOnDropToFolder: onDropToFolder
        }
      }
    })
    await dispatchDrag(wrapper, 'C:/R/A/B', 'dragover')
    expect(wrapper.find('[data-file-path="C:/R/A/B"]').classes()).toContain('is-drag-over')
    expect(wrapper.find('[data-file-path="C:/R/A"]').classes()).not.toContain('is-drag-over')
    expect(wrapper.find('[data-file-path="C:/R"]').classes()).not.toContain('is-drag-over')
  })

  it('does not move when dropping onto the source parent directory (no-op)', async () => {
    const { wrapper, dragState, onDropToFolder } = mountTree()
    dragState.sourcePath = 'C:/docs/A/A-1.md'
    await dispatchDrag(wrapper, 'C:/docs/A', 'drop')
    expect(onDropToFolder).not.toHaveBeenCalled()
  })

  it('starts dragging all selected nodes when dragging a selected node', async () => {
    const { wrapper, dragState } = mountTree()
    const store = useFileStore()
    store.selectOnly('C:/docs/A/A-1.md')
    store.toggleSelected('C:/docs/A/B')
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' }
    await wrapper.find('[data-file-path="C:/docs/A/A-1.md"]').trigger('dragstart', { dataTransfer })
    expect(dragState.sourcePaths).toEqual(['C:/docs/A/A-1.md', 'C:/docs/A/B'])
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'C:/docs/A/A-1.md\nC:/docs/A/B')
  })
})

describe('FileTreeItem icons', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('uses a Tabler chevron for directory expansion', () => {
    const wrapper = mount(FileTreeItem, {
      props: { node: makeDir('C:/docs', 'docs') },
      global: { plugins: [createPinia()] }
    })

    expect(wrapper.find('.expand-icon .tabler-icon-chevron-right').exists()).toBe(true)
  })

  it('renders a Tabler folder icon for a directory row', () => {
    const wrapper = mount(FileTreeItem, {
      props: { node: makeDir('C:/docs', 'docs') },
      global: { plugins: [createPinia()] }
    })

    const icon = wrapper.find('.node-icon svg')
    expect(icon.exists()).toBe(true)
    expect(icon.attributes('class')).toContain('tabler-icon-folder')
  })

  it('renders a Tabler file icon for a plain file row', () => {
    const wrapper = mount(FileTreeItem, {
      props: { node: makeFile('C:/docs/readme.md', 'readme.md') },
      global: { plugins: [createPinia()] }
    })

    const icon = wrapper.find('.node-icon svg')
    expect(icon.exists()).toBe(true)
    expect(icon.attributes('class')).toContain('tabler-icon-markdown')
  })
})

describe('FileTreeItem click unsupported file', () => {
  const originalElectronAPI = (window as { electronAPI?: unknown }).electronAPI

  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    if (dialogState.visible) resolveDialogRequest(0)
    ;(window as { electronAPI?: unknown }).electronAPI = originalElectronAPI
  })

  function mountFileNode(node: FileTreeNode) {
    return mount(FileTreeItem, {
      props: { node },
      global: { plugins: [createPinia()] }
    })
  }

  function stubElectronAPI(electronAPI: unknown): void {
    ;(window as { electronAPI?: unknown }).electronAPI = electronAPI
  }

  it('shows a dialog when clicking a file the app cannot open', async () => {
    stubElectronAPI({
      openFile: vi.fn(async () => ({ success: false, error: '二进制文件无法在编辑器中打开' }))
    })

    const wrapper = mountFileNode(makeFile('C:/docs/app.exe', 'app.exe'))
    await wrapper.find('[data-file-path="C:/docs/app.exe"]').trigger('click')
    await nextTick()

    expect(dialogState.visible).toBe(true)
    expect(dialogState.title).toBe('无法打开文件')
    expect(dialogState.message).toBe('暂不支持 EXE 类型文件打开')
  })

  it('does not show a dialog for a normal successful open', async () => {
    stubElectronAPI({
      openFile: vi.fn(async () => ({
        success: true,
        data: {
          document: { metadata: { title: 'x' }, content: { text: '', assets: { images: [] } } },
          filePath: 'C:/docs/a.md',
          format: 'markdown',
          isNew: false
        }
      }))
    })

    const wrapper = mountFileNode(makeFile('C:/docs/a.md', 'a.md'))
    await wrapper.find('[data-file-path="C:/docs/a.md"]').trigger('click')
    await nextTick()

    expect(dialogState.visible).toBe(false)
  })

  it('does not show a dialog when clicking a directory', async () => {
    const wrapper = mountFileNode(makeDir('C:/docs/A', 'A'))
    await wrapper.find('[data-file-path="C:/docs/A"]').trigger('click')
    await nextTick()

    expect(dialogState.visible).toBe(false)
  })
})

describe('FileTreeItem path tooltip', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('shows the full file path when hovering a file name', async () => {
    const wrapper = mount(FileTreeItem, {
      props: { node: makeFile('C:/workspace/docs/report.pdf', 'report.pdf') },
      attachTo: document.body,
      global: { plugins: [createPinia()] }
    })

    await wrapper.find('.node-name').trigger('mouseover')
    vi.advanceTimersByTime(400)
    await nextTick()

    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('C:/workspace/docs/report.pdf')
  })

  it('shows the full folder path when hovering a folder name', async () => {
    const wrapper = mount(FileTreeItem, {
      props: { node: makeDir('C:/workspace/docs/assets', 'assets') },
      attachTo: document.body,
      global: { plugins: [createPinia()] }
    })

    await wrapper.find('.node-name').trigger('mouseover')
    vi.advanceTimersByTime(400)
    await nextTick()

    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('C:/workspace/docs/assets')
  })
})
