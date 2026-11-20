<script setup lang="ts">
import { ref, reactive, provide, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { IconChevronRight, IconFolderOpen } from '@tabler/icons-vue'
import { useFileStore, type FileTreeNode } from '../../stores/file'
import { useWorkspaceStore } from '../../stores/workspace'
import { requestDialog } from '../../utils/dialog'
import { requestPrompt } from '../../utils/prompt'
import { validateWindowsFolderName, validateWindowsFileName } from '../../utils/windows-filename'
import { dedupeTopLevelPaths } from '../../../shared/fs/dedupe'
import { MINDMAP_EXTENSION } from '../../types/mindmap'
import { DIAGRAM_EXTENSION } from '../../../shared/diagram/document'
import FileTreeItem from './FileTreeItem.vue'

const fileStore = useFileStore()
const workspaceStore = useWorkspaceStore()

// ========== 拖拽移动 ==========
const dragState = reactive<{
  sourcePaths: string[]
  sourcePath: string | null
  hoverPath: string | null
}>({
  sourcePaths: [],
  sourcePath: null,
  hoverPath: null
})
const isListDragOver = ref(false)

function normalizePath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

function getParentDir(filePath: string): string {
  const normalized = normalizePath(filePath)
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

async function handleDropToFolder(targetDir: string): Promise<void> {
  const sources =
    dragState.sourcePaths.length > 0
      ? [...dragState.sourcePaths]
      : dragState.sourcePath
        ? [dragState.sourcePath]
        : []
  const source = sources[0]
  dragState.sourcePaths = []
  dragState.sourcePath = null
  dragState.hoverPath = null
  isListDragOver.value = false
  if (!source || !fileStore.openedFolderPath) return
  const movableSources = dedupeTopLevelPaths(sources).filter(
    (item) => normalizePath(targetDir) !== getParentDir(item)
  )
  if (movableSources.length === 0) return
  const ok = await fileStore.moveItems(movableSources, targetDir)
  if (!ok) {
    await requestDialog({
      title: '无法移动',
      message: fileStore.error || '移动失败',
      buttons: [{ label: '确定', value: 0, primary: true }]
    })
  }
}

function onListDragOver(event: DragEvent): void {
  if (!dragState.sourcePath || !fileStore.openedFolderPath) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragState.hoverPath = null
  isListDragOver.value = true
}

function onListDragLeave(event: DragEvent): void {
  const el = event.currentTarget as HTMLElement
  if (el.contains(event.relatedTarget as Node)) return
  isListDragOver.value = false
}

async function onListDrop(): Promise<void> {
  if (!dragState.sourcePath || !fileStore.openedFolderPath) return
  await handleDropToFolder(fileStore.openedFolderPath)
}

provide('fileTreeDragState', dragState)
provide('fileTreeOnDropToFolder', handleDropToFolder)

async function scrollToActiveFile(): Promise<boolean> {
  await nextTick()
  const filePath = fileStore.currentFile?.path
  if (!filePath) return false
  const normalize = (value: string): string =>
    value
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase()
  const targetPath = normalize(filePath)

  const nodes = document.querySelectorAll<HTMLElement>('[data-file-path]')
  for (const node of nodes) {
    if (node.dataset.filePath && normalize(node.dataset.filePath) === targetPath) {
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      return true
    }
  }
  return false
}

// 标签激活后需要把文件树定位到激活文件。父目录可能尚未展开
//（setActiveTab 会异步 revealFileInTree），定位期间文件树会变化多次；
// 通过“待定位”标志只在激活后尚未命中前响应树变化，命中一次即解除，
// 避免用户手动折叠/展开目录时视图被拉回当前文件。
let scrollRevealPending = false
let scrollRevealTimer: number | undefined

function isInsideOpenedFolder(filePath: string): boolean {
  const folderPath = fileStore.openedFolderPath
  if (!folderPath) return false
  const normalize = (value: string): string =>
    value
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase()
  return normalize(filePath).startsWith(`${normalize(folderPath)}/`)
}

async function tryScrollToActiveFile(): Promise<void> {
  if (await scrollToActiveFile()) {
    scrollRevealPending = false
    clearTimeout(scrollRevealTimer)
  }
}

function armScrollReveal(): void {
  clearTimeout(scrollRevealTimer)
  const filePath = fileStore.currentFile?.path
  // 未打开文件夹或文件不在其中时，树中不存在对应行，无需等待定位
  if (!filePath || !isInsideOpenedFolder(filePath)) return
  scrollRevealPending = true
  void tryScrollToActiveFile()
  // 兜底：目标行始终未出现（如目录加载失败）时解除待命，避免后续树变化误触发滚动
  scrollRevealTimer = window.setTimeout(() => {
    scrollRevealPending = false
  }, 3000)
}

watch(
  () => fileStore.activeTabId,
  () => {
    armScrollReveal()
  }
)

watch(
  () => fileStore.fileTree,
  () => {
    if (scrollRevealPending) void tryScrollToActiveFile()
  },
  { deep: true }
)

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'inkase:close-context-menus'

// ========== 右键菜单状态 ==========
/**
 * 右键菜单项。
 * `children` 有值时渲染成二级菜单入口（新建 / 导入 / 打开 这类聚合项），
 * `divider` 为 true 时渲染分隔线——两者配合能把十几项平铺的菜单收成几组。
 */
interface ContextMenuItem {
  label?: string
  action?: () => void
  disabled?: () => boolean
  children?: ContextMenuItem[]
  divider?: boolean
}

/** 分隔线（同一个对象可以重复引用，渲染时按序号做 key） */
const CONTEXT_MENU_DIVIDER: ContextMenuItem = { divider: true }

/** 聚合入口：父项只负责标题，动作都在二级菜单里 */
function contextSubmenu(label: string, children: ContextMenuItem[]): ContextMenuItem {
  return { label, children }
}

const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  items: [] as ContextMenuItem[]
})

function closeContextMenu(): void {
  contextMenu.visible = false
}

function onContextMenuItemClick(item: ContextMenuItem): void {
  // 聚合项自身没有动作，点它不应该关菜单（真正的动作在二级菜单里）
  if (!item.action || item.disabled?.()) return
  closeContextMenu()
  item.action()
}

function showContextMenu(event: MouseEvent, items: ContextMenuItem[]): void {
  void fileStore.refreshClipboardState()
  window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
  contextMenu.items = items
  contextMenu.x = event.clientX
  contextMenu.y = event.clientY
  contextMenu.visible = true

  // 菜单打开后，下个 tick 调整位置防止超出视口
  nextTick(() => {
    const menuEl = document.querySelector('.context-menu') as HTMLElement | null
    if (!menuEl) return
    const rect = menuEl.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      contextMenu.x = window.innerWidth - rect.width - 8
    }
    if (rect.bottom > window.innerHeight) {
      contextMenu.y = window.innerHeight - rect.height - 8
    }
  })
}

const fileListRef = ref<HTMLElement | null>(null)

function refocusExplorer(): void {
  requestAnimationFrame(() => fileListRef.value?.focus())
}

async function pasteHere(targetDir: string | null): Promise<void> {
  if (!targetDir) return
  const ok = await fileStore.pasteInto(targetDir)
  if (!ok && fileStore.error) {
    await requestDialog({
      title: '无法粘贴',
      message: fileStore.error,
      buttons: [{ label: '确定', value: 0, primary: true }]
    })
  }
}

function onListClick(event: MouseEvent): void {
  fileListRef.value?.focus()
  if (event.target === event.currentTarget) fileStore.clearSelection()
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return (
    element?.tagName === 'INPUT' ||
    element?.tagName === 'TEXTAREA' ||
    element?.isContentEditable === true
  )
}

/** 按路径在文件树里找节点（含展开与未展开的子树） */
function findTreeNode(path: string): FileTreeNode | null {
  const visit = (nodes: FileTreeNode[]): FileTreeNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node
      if (node.isDirectory) {
        const found = visit(node.children)
        if (found) return found
      }
    }
    return null
  }
  return visit(fileStore.fileTree)
}

async function onListKeydown(event: KeyboardEvent): Promise<void> {
  if (isEditableTarget(event.target)) return
  /*
   * F2 / Delete 都只在「文件列表本体持有焦点」时响应：
   * 焦点在编辑器或对话框输入框里时，这两个键属于那边（Del 是删字）。
   */
  const listFocused = document.activeElement === fileListRef.value
  if (event.key === 'F2') {
    if (!listFocused) return
    event.preventDefault()
    if (fileStore.selectedPaths.length !== 1) return
    const node = findTreeNode(fileStore.selectedPaths[0])
    if (node) await promptRename(node)
    return
  }
  if (event.key === 'Delete') {
    if (!listFocused) return
    event.preventDefault()
    await promptDeleteSelection()
    return
  }
  const modifier = event.ctrlKey || event.metaKey
  if (!modifier) {
    if (event.key === 'Escape') fileStore.clearSelection()
    return
  }
  const key = event.key.toLowerCase()
  if (key === 'a') {
    event.preventDefault()
    fileStore.selectAllVisible()
    return
  }
  if (key === 'c' || key === 'x') {
    event.preventDefault()
    await fileStore.copySelection(key === 'x' ? 'cut' : 'copy')
    return
  }
  if (key === 'v') {
    event.preventDefault()
    await fileStore.pasteIntoSelection()
  }
}

function onEmptyContextMenu(event: MouseEvent): void {
  const folderPath = fileStore.openedFolderPath

  // 「快速打开」检索的是工作区文件，没有打开文件夹时无处可查，因此按需出现
  const openSubmenu = contextSubmenu('打开', [
    { label: '文件', action: () => openFile() },
    { label: '文件夹', action: () => openFolder() },
    ...(folderPath
      ? [
          {
            label: '快速打开',
            action: () => window.dispatchEvent(new Event('inkase:quick-open'))
          }
        ]
      : [])
  ])

  const importSubmenu = contextSubmenu('导入', [
    { label: 'Markdown', action: () => fileStore.importMarkdown() },
    { label: 'Word 文档', action: () => fileStore.importDocx() },
    { label: '文件夹', action: () => fileStore.importFolder() }
  ])

  // 没有打开文件夹时无处新建/粘贴/刷新，只留「导入」「打开」这两组对外操作的入口
  const items: ContextMenuItem[] = folderPath
    ? [
        contextSubmenu('新建', [
          { label: '文件', action: () => promptCreateFile(folderPath) },
          { label: '思维导图', action: () => promptCreateMindMap(folderPath) },
          { label: '图表', action: () => promptCreateDiagram(folderPath) },
          { label: '文件夹', action: () => promptCreateFolder(folderPath) }
        ]),
        importSubmenu,
        openSubmenu,
        CONTEXT_MENU_DIVIDER,
        {
          label: '粘贴',
          action: () => {
            void pasteHere(folderPath)
          },
          disabled: () => !fileStore.clipboardFiles && !fileStore.hasSystemClipboardFiles
        },
        { label: '刷新', action: () => fileStore.readFolder(folderPath) },
        {
          label: '关闭文件夹',
          action: () => {
            void fileStore.closeFolder()
          }
        }
      ]
    : [importSubmenu, openSubmenu]
  showContextMenu(event, items)
}

function onFileContextMenu(event: MouseEvent, node: FileTreeNode): void {
  const items: ContextMenuItem[] = [
    { label: '打开', action: () => fileStore.openFile(node.path, { addToRecent: false }) },
    { label: '保存', action: () => saveFileNode(node) },
    { label: '另存为', action: () => saveFileNodeAs(node) },
    // 只有能渲染的文本类文件才提供单项导出；导图/图片等交给「另存为」
    ...(/\.(md|mdx|txt)$/i.test(node.name)
      ? [
          {
            label: '导出 PDF',
            action: () => {
              void fileStore.exportFileToPdf(node.path)
            }
          }
        ]
      : []),
    CONTEXT_MENU_DIVIDER,
    {
      label: '复制',
      action: () => {
        void fileStore.copySelection('copy')
      }
    },
    {
      label: '剪切',
      action: () => {
        void fileStore.copySelection('cut')
      }
    },
    {
      label: '粘贴到同级目录',
      action: () => {
        void pasteHere(getParentDir(node.path))
      },
      disabled: () => !fileStore.clipboardFiles && !fileStore.hasSystemClipboardFiles
    },
    CONTEXT_MENU_DIVIDER,
    { label: '重命名', action: () => promptRename(node) },
    { label: '删除', action: () => promptDelete(node) },
    { label: '复制路径', action: () => fileStore.copyPath(node.path) },
    {
      label: '打开文件所在位置',
      action: () => {
        void fileStore.revealInExplorer(node.path)
      }
    },
    CONTEXT_MENU_DIVIDER,
    {
      // 直接进局部模式：以所选文件为中心看它连着谁（设计 §4.1）
      label: '显示图谱',
      action: () => {
        workspaceStore.open('graph', { centerFilePath: node.path })
      }
    }
  ]
  showContextMenu(event, items)
}

function onFolderContextMenu(event: MouseEvent, node: FileTreeNode): void {
  const items: ContextMenuItem[] = [
    contextSubmenu('新建', [
      { label: '文件', action: () => promptCreateFile(node.path) },
      { label: '思维导图', action: () => promptCreateMindMap(node.path) },
      { label: '图表', action: () => promptCreateDiagram(node.path) },
      { label: '文件夹', action: () => promptCreateFolder(node.path) }
    ]),
    contextSubmenu('导入', [
      {
        label: '文件',
        action: () => {
          void importFilesToFolder(node)
        }
      },
      {
        label: 'Word 文档',
        action: () => {
          void importDocxToFolder(node)
        }
      },
      {
        label: '文件夹',
        action: () => {
          void importDirectoryToFolder(node)
        }
      }
    ]),
    {
      label: '批量导出 PDF',
      action: () => {
        void fileStore.exportFolderToPdf(node.path)
      }
    },
    CONTEXT_MENU_DIVIDER,
    {
      label: '复制',
      action: () => {
        void fileStore.copySelection('copy')
      }
    },
    {
      label: '剪切',
      action: () => {
        void fileStore.copySelection('cut')
      }
    },
    {
      label: '粘贴',
      action: () => {
        void pasteHere(node.path)
      },
      disabled: () => !fileStore.clipboardFiles && !fileStore.hasSystemClipboardFiles
    },
    CONTEXT_MENU_DIVIDER,
    { label: '刷新', action: () => fileStore.loadChildren(node) },
    CONTEXT_MENU_DIVIDER,
    { label: '重命名', action: () => promptRename(node) },
    { label: '删除', action: () => promptDelete(node) },
    { label: '复制路径', action: () => fileStore.copyPath(node.path) },
    ...(node.path === fileStore.openedFolderPath
      ? [
          {
            label: '关闭文件夹',
            action: () => {
              void fileStore.closeFolder()
            }
          }
        ]
      : [])
  ]
  showContextMenu(event, items)
}

async function importFilesToFolder(node: FileTreeNode): Promise<void> {
  if (await fileStore.importFilesInto(node.path)) await fileStore.loadChildren(node)
}

async function importDocxToFolder(node: FileTreeNode): Promise<void> {
  if (await fileStore.importDocx(node.path)) await fileStore.loadChildren(node)
}

async function importDirectoryToFolder(node: FileTreeNode): Promise<void> {
  if (await fileStore.importDirectoryInto(node.path)) await fileStore.loadChildren(node)
}

// ========== 操作函数 ==========
/**
 * 新建文件。
 *
 * 文件名（含后缀）由用户自由输入，主进程按它在 `dirPath` 下落盘，不做默认后缀补全。
 * 对话框本身在 `App.vue` 挂载（`PromptDialog`），这里只发请求——
 * 文件菜单的「新建 ▸ 文件」走的是同一个入口（store 的 `newFile`）。
 */
async function promptCreateFile(dirPath: string, initialName = ''): Promise<void> {
  const name = await requestPrompt({
    title: '新建文件',
    initialValue: initialName,
    placeholder: '例如：笔记.mdx、导图.inkmind、deploy.sh、config.json',
    validate: validateWindowsFileName,
    // 预填名字时只选中主干，后缀留着——直接打字就是「改名」
    selection: 'stem'
  })
  if (!name) return
  const ok = await fileStore.createFile(dirPath, name)
  if (!ok) {
    await requestDialog({
      title: '新建文件失败',
      message: fileStore.error || `无法创建“${name}”，请检查名称是否已存在或文件夹是否可写`,
      buttons: [{ label: '确定', value: 0, primary: true }]
    })
  }
}

/** 新建思维导图：预填 `.inkmind` 后缀，主进程会写入一张可解析的空白导图 */
async function promptCreateMindMap(dirPath: string): Promise<void> {
  await promptCreateFile(dirPath, `未命名导图${MINDMAP_EXTENSION}`)
}

async function promptCreateDiagram(dirPath: string): Promise<void> {
  await promptCreateFile(dirPath, `未命名图表${DIAGRAM_EXTENSION}`)
}

async function promptCreateFolder(dirPath: string): Promise<void> {
  const name = await requestPrompt({
    title: '新建文件夹',
    placeholder: '请输入文件夹名称',
    validate: validateWindowsFolderName
  })
  if (!name) return
  await fileStore.createFolder(dirPath, name)
}

async function promptRename(node: FileTreeNode): Promise<void> {
  const name = await requestPrompt({
    title: '重命名',
    initialValue: node.name,
    placeholder: '新名称',
    // 文件默认只选中主文件名：想改名时直接打字，后缀不会被覆盖掉
    selection: node.isDirectory ? 'all' : 'stem',
    validate: node.isDirectory ? validateWindowsFolderName : validateWindowsFileName
  })
  if (!name || name === node.name) return
  const ok = await fileStore.renameItem(node.path, name)
  if (!ok) {
    await requestDialog({
      title: '重命名失败',
      message: fileStore.error || '重命名失败，请检查目标名称是否已存在或文件夹是否被占用',
      buttons: [{ label: '确定', value: 0, primary: true }]
    })
  }
}

/** 删除确认：确认按钮是破坏性动作，所以默认焦点在「取消」侧 */
async function confirmDelete(title: string, message: string): Promise<boolean> {
  const choice = await requestDialog({
    title,
    message,
    buttons: [
      { label: '取消', value: 0 },
      { label: '删除', value: 1, primary: true }
    ]
  })
  return choice === 1
}

async function promptDelete(node: FileTreeNode): Promise<boolean> {
  const type = node.isDirectory ? '文件夹' : '文件'
  const confirmed = await confirmDelete(
    `删除${type}`,
    `确定要删除${type}“${node.name}”吗？将移入回收站。`
  )
  if (!confirmed) return false
  const ok = await fileStore.deleteItem(node.path)
  if (!ok) {
    // 回收站失败（网络盘、只读卷、回收站容量超限）必须说出来：
    // 文件还在磁盘上，静默失败会让用户以为删掉了
    await requestDialog({
      title: '删除失败',
      message: fileStore.error || `无法删除“${node.name}”，请检查文件是否被占用`,
      buttons: [{ label: '确定', value: 0, primary: true }]
    })
  }
  return ok
}

/**
 * Delete 键：删除当前选中的项目。
 *
 * 多选时先把「已被选中目录包含的子项」剔掉（`dedupeTopLevelPaths`），
 * 否则父目录删完再删子项会全部失败，还会多弹一串错误。
 */
async function promptDeleteSelection(): Promise<void> {
  const paths = dedupeTopLevelPaths([...fileStore.selectedPaths])
  if (paths.length === 0) return
  if (paths.length === 1) {
    const node = findTreeNode(paths[0])
    if (node) await promptDelete(node)
    return
  }
  const confirmed = await confirmDelete(
    '删除所选项目',
    `确定要删除选中的 ${paths.length} 个项目吗？将移入回收站。`
  )
  if (!confirmed) return
  const failed: string[] = []
  for (const path of paths) {
    // 逐个删：某一项失败不该中断其余的
    if (!(await fileStore.deleteItem(path))) failed.push(path.split(/[/\\]/).pop() || path)
  }
  if (failed.length > 0) {
    await requestDialog({
      title: failed.length === paths.length ? '删除失败' : '部分项目删除失败',
      message: `以下项目没能移入回收站：${failed.join('、')}`,
      buttons: [{ label: '确定', value: 0, primary: true }]
    })
  }
}

// ========== 基础操作 ==========
async function openFile(): Promise<void> {
  if (!(await fileStore.confirmSaveBeforeAction())) return
  await fileStore.openFile()
}

async function openFolder(): Promise<void> {
  await fileStore.openFolder()
}

async function activateFileNode(node: FileTreeNode): Promise<boolean> {
  const tab = fileStore.tabs.find((item) => item.fileInfo?.path === node.path)
  if (tab) {
    await fileStore.setActiveTab(tab.id)
    return true
  }
  return fileStore.openFile(node.path, { addToRecent: false })
}

async function saveFileNode(node: FileTreeNode): Promise<void> {
  if (await activateFileNode(node)) await fileStore.saveFile()
}

async function saveFileNodeAs(node: FileTreeNode): Promise<void> {
  if (await activateFileNode(node)) await fileStore.saveAsFile()
}

function handleNodeContextMenu(event: MouseEvent, node: FileTreeNode): void {
  if (node.isDirectory) {
    onFolderContextMenu(event, node)
  } else {
    onFileContextMenu(event, node)
  }
}

onMounted(() => {
  armScrollReveal()
  document.addEventListener('click', closeContextMenu)
  document.addEventListener('contextmenu', closeContextMenu, true)
  window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeContextMenu)
  window.addEventListener('blur', closeContextMenu)
  window.addEventListener('inkase:explorer-refocus', refocusExplorer)
})

onUnmounted(() => {
  clearTimeout(scrollRevealTimer)
  document.removeEventListener('click', closeContextMenu)
  document.removeEventListener('contextmenu', closeContextMenu, true)
  window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeContextMenu)
  window.removeEventListener('blur', closeContextMenu)
  window.removeEventListener('inkase:explorer-refocus', refocusExplorer)
})
</script>

<template>
  <div class="file-explorer">
    <!-- 文件列表 -->
    <div
      ref="fileListRef"
      class="file-list"
      tabindex="0"
      :class="{ 'is-drag-over': isListDragOver }"
      @click="onListClick"
      @keydown="onListKeydown"
      @contextmenu.prevent.stop="onEmptyContextMenu"
      @dragover="onListDragOver"
      @dragleave="onListDragLeave"
      @drop.prevent.stop="onListDrop"
    >
      <!-- 文件夹浏览 -->
      <div
        v-if="fileStore.openedFolderPath && fileStore.fileTree.length > 0"
        class="file-section"
      >
        <!-- 树形文件列表 -->
        <div class="tree-list">
          <FileTreeItem
            v-for="node in fileStore.fileTree"
            :key="node.path"
            :node="node"
            :depth="0"
            @context-menu="handleNodeContextMenu"
          />
        </div>
      </div>

      <!-- 空状态（未打开文件夹） -->
      <div
        v-if="!fileStore.openedFolderPath"
        class="empty-state"
      >
        <IconFolderOpen
          class="empty-icon"
          :size="48"
          stroke="1.5"
        />
        <p class="empty-text">
          打开文件夹以浏览文件
        </p>
        <button
          class="empty-action"
          @click="openFolder"
        >
          打开文件夹
        </button>
      </div>
    </div>

    <!-- ====== 右键菜单 ====== -->
    <teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
        @contextmenu.prevent.stop
      >
        <template
          v-for="(item, index) in contextMenu.items"
          :key="index"
        >
          <div
            v-if="item.divider"
            class="context-menu-divider"
          />
          <!-- 聚合项：鼠标悬停展开二级菜单，自身不执行动作 -->
          <div
            v-else-if="item.children"
            class="context-menu-item has-sub"
          >
            <span>{{ item.label }}</span>
            <IconChevronRight
              class="context-submenu-indicator"
              :size="12"
            />
            <div class="context-submenu">
              <div
                v-for="(sub, subIndex) in item.children"
                :key="subIndex"
                class="context-menu-item"
                :class="{ 'is-disabled': sub.disabled?.() }"
                @click.stop="onContextMenuItemClick(sub)"
              >
                {{ sub.label }}
              </div>
            </div>
          </div>
          <div
            v-else
            class="context-menu-item"
            :class="{ 'is-disabled': item.disabled?.() }"
            @click="onContextMenuItemClick(item)"
          >
            {{ item.label }}
          </div>
        </template>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.file-explorer {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.file-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.file-list:focus {
  outline: none;
}

.file-list.is-drag-over {
  outline: 2px dashed var(--color-primary);
  outline-offset: -2px;
  border-radius: var(--radius-md);
}

.file-section {
  margin-bottom: 16px;
}

.section-title {
  padding: 0 8px;
  margin-bottom: 4px;
  font-size: calc(var(--ui-font-size) - 2px);
  font-weight: 600;
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.folder-title-actions {
  display: flex;
  gap: 2px;
}

.folder-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
}

.file-item:hover {
  background-color: var(--color-bg-secondary);
}

.file-item.active {
  background-color: var(--color-primary-light);
}

.file-item.active .file-name {
  color: var(--color-primary);
  font-weight: 500;
}

.file-item.is-directory .file-name {
  font-weight: 500;
}

.file-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--color-text-secondary);
}

.file-item.active .file-icon {
  color: var(--color-primary);
}

.folder-icon {
  color: var(--color-accent-yellow, #d4a017);
}

.file-name {
  flex: 1;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modified-indicator {
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-warning);
}

.folder-empty {
  padding: 16px 8px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-secondary);
  text-align: center;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
}

.empty-icon {
  width: 48px;
  height: 48px;
  color: var(--color-text-tertiary);
  margin-bottom: 12px;
}

.empty-text {
  font-size: var(--ui-font-size);
  color: var(--color-text-secondary);
  margin-bottom: 12px;
}

.empty-action {
  padding: 6px 16px;
  font-size: calc(var(--ui-font-size) - 1px);
  font-weight: 500;
  color: var(--color-primary);
  background-color: var(--color-primary-light);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
}

.empty-action:hover {
  background-color: var(--color-primary);
  color: white;
}
</style>

<!-- 全局样式（不受 scoped 限制，用于 teleport 出去的组件） -->
<style>
.context-menu {
  position: fixed;
  z-index: 10000;
  min-width: 160px;
  padding: 4px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}

.context-menu-item {
  padding: 6px 14px;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s;
}

.context-menu-item:hover {
  background: var(--color-bg-secondary);
}

.context-menu-item.is-disabled {
  opacity: 0.45;
  cursor: default;
}

.context-menu-item.is-disabled:hover {
  background: transparent;
}

/* 聚合项：标题在左、箭头在右；二级菜单在右侧展开 */
.context-menu-item.has-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  position: relative;
}

.context-submenu-indicator {
  flex: none;
  opacity: 0.65;
}

.context-submenu {
  display: none;
  position: absolute;
  left: calc(100% - 4px);
  /* 抵消 .context-menu 的 4px 内边距，让二级菜单首项与父项对齐 */
  top: -5px;
  min-width: 160px;
  padding: 4px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}

.context-menu-item.has-sub:hover > .context-submenu {
  display: block;
}

.context-menu-divider {
  height: 1px;
  margin: 4px 8px;
  background: var(--color-border);
}
</style>
