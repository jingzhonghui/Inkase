<script setup lang="ts">
import { ref, reactive, provide, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { IconChevronsLeft, IconFolderOpen } from '@tabler/icons-vue'
import { useFileStore, type FileTreeNode } from '../../stores/file'
import { requestDialog } from '../../utils/dialog'
import Tooltip from '../common/Tooltip.vue'
import { validateWindowsFolderName, validateWindowsFileName } from '../../utils/windows-filename'
import { dedupeTopLevelPaths } from '../../../shared/fs/dedupe'
import FileTreeItem from './FileTreeItem.vue'

const fileStore = useFileStore()

// ========== 拖拽移动 ==========
const dragState = reactive<{ sourcePaths: string[]; sourcePath: string | null; hoverPath: string | null }>({
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
  const sources = dragState.sourcePaths.length > 0
    ? [...dragState.sourcePaths]
    : dragState.sourcePath ? [dragState.sourcePath] : []
  const source = sources[0]
  dragState.sourcePaths = []
  dragState.sourcePath = null
  dragState.hoverPath = null
  isListDragOver.value = false
  if (!source || !fileStore.openedFolderPath) return
  const movableSources = dedupeTopLevelPaths(sources)
    .filter((item) => normalizePath(targetDir) !== getParentDir(item))
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
  const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
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
  const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
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

watch(() => fileStore.activeTabId, () => {
  armScrollReveal()
})

watch(() => fileStore.fileTree, () => {
  if (scrollRevealPending) void tryScrollToActiveFile()
}, { deep: true })

const emit = defineEmits<{
  (e: 'collapse'): void
}>()

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'inkase:close-context-menus'

// ========== 右键菜单状态 ==========
interface ContextMenuItem {
  label: string
  action: () => void
  disabled?: () => boolean
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
  if (item.disabled?.()) return
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
  return element?.tagName === 'INPUT' || element?.tagName === 'TEXTAREA' || element?.isContentEditable === true
}

async function onListKeydown(event: KeyboardEvent): Promise<void> {
  if (isEditableTarget(event.target)) return
  if (event.key === 'F2') {
    if (document.activeElement !== fileListRef.value) return
    event.preventDefault()
    if (fileStore.selectedPaths.length !== 1) return
    const findNode = (nodes: FileTreeNode[]): FileTreeNode | null => {
      for (const node of nodes) {
        if (node.path === fileStore.selectedPaths[0]) return node
        if (node.isDirectory) {
          const found = findNode(node.children)
          if (found) return found
        }
      }
      return null
    }
    const node = findNode(fileStore.fileTree)
    if (node) await promptRename(node)
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
  const items: ContextMenuItem[] = folderPath
    ? [
        { label: '新建文件', action: () => promptCreateFile(folderPath) },
        { label: '新建文件夹', action: () => promptCreateFolder(folderPath) },
        { label: '导入 Markdown', action: () => fileStore.importMarkdown() },
        { label: '导入 Word 文档', action: () => fileStore.importDocx() },
        { label: '导入文件夹', action: () => fileStore.importFolder() },
        { label: '打开文件', action: () => openFile() },
        { label: '打开文件夹', action: () => openFolder() },
        { label: '快速打开文件', action: () => window.dispatchEvent(new Event('inkase:quick-open')) },
        { label: '刷新', action: () => fileStore.readFolder(folderPath) },
        { label: '关闭文件夹', action: () => { void fileStore.closeFolder() } },
        { label: '粘贴', action: () => { void pasteHere(folderPath) }, disabled: () => !fileStore.clipboardFiles && !fileStore.hasSystemClipboardFiles }
      ]
    : [
        { label: '导入 Markdown', action: () => fileStore.importMarkdown() },
        { label: '导入 Word 文档', action: () => fileStore.importDocx() },
        { label: '导入文件夹', action: () => fileStore.importFolder() },
        { label: '打开文件', action: () => openFile() },
        { label: '打开文件夹', action: () => openFolder() }
      ]
  showContextMenu(event, items)
}

function onFileContextMenu(event: MouseEvent, node: FileTreeNode): void {
  const items: ContextMenuItem[] = [
    { label: '打开', action: () => fileStore.openFile(node.path, { addToRecent: false }) },
    { label: '保存', action: () => saveFileNode(node) },
    { label: '另存为', action: () => saveFileNodeAs(node) },
    ...(/\.(md|mdx|txt)$/i.test(node.name)
      ? [{ label: '导出 PDF', action: () => { void fileStore.exportFileToPdf(node.path) } }]
      : []),
    { label: '重命名', action: () => promptRename(node) },
    { label: '删除', action: () => promptDelete(node) },
    { label: '复制', action: () => { void fileStore.copySelection('copy') } },
    { label: '剪切', action: () => { void fileStore.copySelection('cut') } },
    { label: '粘贴到同级目录', action: () => { void pasteHere(getParentDir(node.path)) }, disabled: () => !fileStore.clipboardFiles && !fileStore.hasSystemClipboardFiles },
    { label: '复制路径', action: () => fileStore.copyPath(node.path) },
    { label: '打开文件所在位置', action: () => { void fileStore.revealInExplorer(node.path) } }
  ]
  showContextMenu(event, items)
}

function onFolderContextMenu(event: MouseEvent, node: FileTreeNode): void {
  const items: ContextMenuItem[] = [
    { label: '新建文件', action: () => promptCreateFile(node.path) },
    { label: '新建文件夹', action: () => promptCreateFolder(node.path) },
    { label: '导入文件', action: () => { void importFilesToFolder(node) } },
    { label: '导入 Word 文档', action: () => { void importDocxToFolder(node) } },
    { label: '导入文件夹', action: () => { void importDirectoryToFolder(node) } },
    { label: '批量导出 PDF', action: () => { void fileStore.exportFolderToPdf(node.path) } },
    { label: '复制', action: () => { void fileStore.copySelection('copy') } },
    { label: '剪切', action: () => { void fileStore.copySelection('cut') } },
    { label: '粘贴', action: () => { void pasteHere(node.path) }, disabled: () => !fileStore.clipboardFiles && !fileStore.hasSystemClipboardFiles },
    { label: '刷新', action: () => fileStore.loadChildren(node) },
    { label: '重命名', action: () => promptRename(node) },
    { label: '删除', action: () => promptDelete(node) },
    { label: '复制路径', action: () => fileStore.copyPath(node.path) },
    ...(node.path === fileStore.openedFolderPath
      ? [{ label: '关闭文件夹', action: () => { void fileStore.closeFolder() } }]
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

// ========== 输入对话框 ==========
const showInputDialog = ref(false)
const inputDialogTitle = ref('')
const inputValue = ref('')
const inputPlaceholder = ref('')
const inputError = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
let inputResolve: ((value: string | null) => void) | null = null

const showConfirmDialog = ref(false)
const confirmDialogTitle = ref('')
const confirmDialogMessage = ref('')
let confirmResolve: ((value: boolean) => void) | null = null

function openInputDialog(title: string, initialValue: string, placeholder: string): Promise<string | null> {
  return new Promise((resolve) => {
    inputDialogTitle.value = title
    inputValue.value = initialValue
    inputPlaceholder.value = placeholder
    inputError.value = ''
    showInputDialog.value = true
    inputResolve = resolve
    nextTick(() => inputRef.value?.focus())
  })
}

// ========== 新建文件对话框（文件名，后缀自由输入） ==========
const showCreateFileDialog = ref(false)
const createFileName = ref('')
const createFileError = ref('')
const createFileInputRef = ref<HTMLInputElement | null>(null)
let createFileResolve: ((value: string | null) => void) | null = null

function openCreateFileDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    createFileName.value = ''
    createFileError.value = ''
    showCreateFileDialog.value = true
    createFileResolve = resolve
    nextTick(() => createFileInputRef.value?.focus())
  })
}

function confirmCreateFile(): void {
  // 文件名（含后缀）原样使用，不做默认后缀补全
  const name = createFileName.value.trim()
  const validationError = validateWindowsFileName(name)
  if (validationError) {
    createFileError.value = validationError
    createFileInputRef.value?.focus()
    return
  }
  createFileError.value = ''
  showCreateFileDialog.value = false
  createFileResolve?.(name)
  createFileResolve = null
}

function cancelCreateFile(): void {
  showCreateFileDialog.value = false
  createFileResolve?.(null)
  createFileResolve = null
}

function confirmInput(): void {
  const validationError = validateWindowsFolderName(inputValue.value)
  if (validationError) {
    inputError.value = validationError
    return
  }
  const val = inputValue.value.trim()
  inputError.value = ''
  showInputDialog.value = false
  inputResolve?.(val)
  inputResolve = null
}

function cancelInput(): void {
  showInputDialog.value = false
  inputResolve?.(null)
  inputResolve = null
}

function openConfirmDialog(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmDialogTitle.value = title
    confirmDialogMessage.value = message
    showConfirmDialog.value = true
    confirmResolve = resolve
  })
}

function resolveConfirmDialog(value: boolean): void {
  showConfirmDialog.value = false
  confirmResolve?.(value)
  confirmResolve = null
}

// ========== 操作函数 ==========
async function promptCreateFile(dirPath: string): Promise<void> {
  const name = await openCreateFileDialog()
  if (!name) return
  await fileStore.createFile(dirPath, name)
}

async function promptCreateFolder(dirPath: string): Promise<void> {
  const name = await openInputDialog('新建文件夹', '', '请输入文件夹名称')
  if (!name) return
  await fileStore.createFolder(dirPath, name)
}

async function promptRename(node: FileTreeNode): Promise<void> {
  const name = await openInputDialog('重命名', node.name, '新名称')
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

async function promptDelete(node: FileTreeNode): Promise<void> {
  const type = node.isDirectory ? '文件夹' : '文件'
  const confirmed = await openConfirmDialog(
    `删除${type}`,
    `确定要删除${type}“${node.name}”吗？此操作不可恢复。`
  )
  if (confirmed) await fileStore.deleteItem(node.path)
}

// ========== 基础操作 ==========
async function openFile(): Promise<void> {
  if (!await fileStore.confirmSaveBeforeAction()) return
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
    <!-- 资源管理器标题栏 -->
    <div class="explorer-titlebar">
      <span class="explorer-title">资源管理器</span>
      <Tooltip content="收起侧边栏">
        <button
          class="explorer-collapse-btn"
          type="button"
          aria-label="收起侧边栏"
          @click="emit('collapse')"
        >
          <IconChevronsLeft />
        </button>
      </Tooltip>
    </div>

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
        <div
          v-for="(item, index) in contextMenu.items"
          :key="index"
          class="context-menu-item"
          :class="{ 'is-disabled': item.disabled?.() }"
          @click="onContextMenuItemClick(item)"
        >
          {{ item.label }}
        </div>
      </div>
    </teleport>

    <!-- ====== 删除确认对话框 ====== -->
    <teleport to="body">
      <div
        v-if="showConfirmDialog"
        class="dialog-overlay"
      >
        <div
          class="dialog"
          @click.stop
        >
          <h3 class="dialog-title">
            {{ confirmDialogTitle }}
          </h3>
          <p class="dialog-message">
            {{ confirmDialogMessage }}
          </p>
          <div class="dialog-actions">
            <button
              class="dialog-btn dialog-btn-cancel"
              @click="resolveConfirmDialog(false)"
            >
              取消
            </button>
            <button
              class="dialog-btn dialog-btn-confirm"
              @click="resolveConfirmDialog(true)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </teleport>

    <!-- ====== 输入对话框（新建文件夹/重命名） ====== -->
    <teleport to="body">
      <div
        v-if="showInputDialog"
        class="dialog-overlay"
      >
        <div
          class="dialog"
          @click.stop
        >
          <h3 class="dialog-title">
            {{ inputDialogTitle }}
          </h3>
          <input
            ref="inputRef"
            v-model="inputValue"
            type="text"
            spellcheck="false"
            class="dialog-input"
            :class="{ 'dialog-input-error': inputError }"
            :placeholder="inputPlaceholder"
            @keyup.enter="confirmInput"
          >
          <p
            v-if="inputError"
            class="dialog-error"
          >
            {{ inputError }}
          </p>
          <div class="dialog-actions">
            <button
              class="dialog-btn dialog-btn-cancel"
              @click="cancelInput"
            >
              取消
            </button>
            <button
              class="dialog-btn dialog-btn-confirm"
              @click="confirmInput"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </teleport>

    <!-- ====== 新建文件对话框（文件名，后缀自由输入） ====== -->
    <teleport to="body">
      <div
        v-if="showCreateFileDialog"
        class="dialog-overlay"
        @keyup.esc="cancelCreateFile"
      >
        <div
          class="dialog"
          @click.stop
        >
          <h3 class="dialog-title">
            新建文件
          </h3>
          <input
            ref="createFileInputRef"
            v-model="createFileName"
            type="text"
            spellcheck="false"
            class="dialog-input"
            :class="{ 'dialog-input-error': createFileError }"
            placeholder="例如：笔记.mdx、deploy.sh、config.json"
            @keyup.enter="confirmCreateFile"
            @input="createFileError = ''"
          >
          <p
            v-if="createFileError"
            class="dialog-error"
          >
            {{ createFileError }}
          </p>
          <div class="dialog-actions">
            <button
              class="dialog-btn dialog-btn-cancel"
              @click="cancelCreateFile"
            >
              取消
            </button>
            <button
              class="dialog-btn dialog-btn-confirm"
              @click="confirmCreateFile"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.file-explorer {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.explorer-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.explorer-title {
  font-size: calc(var(--ui-font-size) - 1px);
  font-weight: 600;
  color: var(--color-text-secondary);
  letter-spacing: 0.3px;
}

.explorer-titlebar :deep(.tooltip-trigger) {
  flex: none;
}

.explorer-collapse-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.explorer-collapse-btn:hover {
  color: var(--color-text);
  background-color: var(--color-bg-secondary);
}

.explorer-collapse-btn svg {
  width: 16px;
  height: 16px;
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

.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.dialog {
  min-width: 360px;
  padding: 20px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 8px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.dialog-title {
  margin: 0 0 12px;
  font-size: calc(var(--ui-font-size) + 2px);
  font-weight: 600;
  color: var(--color-text);
}

.dialog-message {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--ui-font-size);
  line-height: 1.6;
}

.dialog-input {
  width: 100%;
  padding: 8px 12px;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  outline: none;
  box-sizing: border-box;
}

.dialog-input:focus {
  border-color: var(--color-primary);
}

.dialog-input-error {
  border-color: var(--color-error);
}

.dialog-input-error:focus {
  border-color: var(--color-error);
}

.dialog-error {
  margin: 6px 0 0;
  color: var(--color-error);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.4;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.dialog-btn {
  padding: 6px 16px;
  font-size: var(--ui-font-size);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.dialog-btn-cancel {
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
}

.dialog-btn-cancel:hover {
  color: var(--color-text);
}

.dialog-btn-confirm {
  color: #fff;
  background: var(--color-primary);
}

.dialog-btn-confirm:hover {
  background: var(--color-primary-hover);
}
</style>
