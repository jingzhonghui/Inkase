<script setup lang="ts">
import { computed, inject } from 'vue'
import {
  IconBraces,
  IconChevronRight,
  IconFile,
  IconFileCode,
  IconFileDescription,
  IconFileText,
  IconFileTypePdf,
  IconFileTypeZip,
  IconFolder,
  IconPhoto,
  type Icon
} from '@tabler/icons-vue'
import { useFileStore, type FileTreeNode } from '../../stores/file'
import { requestDialog } from '../../utils/dialog'
import { getFileIconType } from '../../utils/file-icons'
import Tooltip from '../common/Tooltip.vue'

interface DragState {
  sourcePaths?: string[]
  sourcePath: string | null
  /** 当前悬停的合法目标目录路径（只高亮最内层/第一级目标） */
  hoverPath: string | null
}

const props = defineProps<{
  node: FileTreeNode
  depth?: number
}>()

const emit = defineEmits<{
  contextMenu: [event: MouseEvent, node: FileTreeNode]
}>()

const fileStore = useFileStore()

const dragState = inject<DragState | null>('fileTreeDragState', null)
const onDropToFolder = inject<((targetDir: string) => void) | null>('fileTreeOnDropToFolder', null)

// 高亮由共享 hoverPath 决定：dragover 在内层目录 stopPropagation，
// 因此 hoverPath 只会是最内层的合法目标，祖先目录不会同时高亮
const isDragOver = computed(() => dragState?.hoverPath === props.node.path)

const depth = computed(() => props.depth ?? 0)

const fileIcons: Record<string, Icon> = {
  folder: IconFolder,
  markdown: IconFileText,
  pdf: IconFileTypePdf,
  image: IconPhoto,
  archive: IconFileTypeZip,
  data: IconBraces,
  code: IconFileCode,
  text: IconFileDescription,
  file: IconFile
}

const iconType = computed(() => getFileIconType(props.node.name, props.node.isDirectory))
const iconComponent = computed(() => fileIcons[iconType.value])

function normalizePath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

function getParentDir(filePath: string): string {
  const normalized = normalizePath(filePath)
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

function isValidDropTarget(): boolean {
  if (!props.node.isDirectory || !dragState) return false
  const sources = dragState.sourcePaths && dragState.sourcePaths.length > 0
    ? dragState.sourcePaths
    : dragState.sourcePath ? [dragState.sourcePath] : []
  if (sources.length === 0) return false
  const normalizedNode = normalizePath(props.node.path)
  // 不能拖到任一源目录自身或其子目录；同目录项目会在执行时作为无操作过滤。
  return sources.every((source) => {
    const normalizedSource = normalizePath(source)
    return normalizedNode !== normalizedSource &&
      !normalizedNode.startsWith(`${normalizedSource}/`) &&
      (sources.length > 1 || normalizedNode !== getParentDir(source))
  })
}

function isActiveFile(node: FileTreeNode): boolean {
  return !node.isDirectory && fileStore.currentFile?.path === node.path
}

function isModifiedFile(node: FileTreeNode): boolean {
  return isActiveFile(node) && fileStore.isModified
}

async function onClick(event: MouseEvent): Promise<void> {
  if (event.ctrlKey || event.metaKey) {
    fileStore.toggleSelected(props.node.path)
    return
  }
  if (event.shiftKey) {
    fileStore.selectRange(props.node.path)
    return
  }
  fileStore.selectOnly(props.node.path)
  if (props.node.isDirectory) {
    await fileStore.toggleNode(props.node)
  } else {
    const ok = await fileStore.openFile(props.node.path, { addToRecent: false, preview: true })
    if (!ok && fileStore.error) {
      // 不支持打开的文件（二进制/过大等）：明确告知用户原因，而非静默失败
      const ext = props.node.name.includes('.') ? props.node.name.split('.').pop()!.toUpperCase() : props.node.name
      await requestDialog({
        title: '无法打开文件',
        message: `暂不支持 ${ext} 类型文件打开`,
        buttons: [{ label: '确定', value: 0, primary: true }]
      })
    }
  }
  window.dispatchEvent(new Event('inkase:explorer-refocus'))
}

async function onDblClick(): Promise<void> {
  if (props.node.isDirectory) return
  await fileStore.openFile(props.node.path, { addToRecent: false, preview: false })
}

function onContextMenu(event: MouseEvent): void {
  if (!fileStore.isSelected(props.node.path)) fileStore.selectOnly(props.node.path)
  emit('contextMenu', event, props.node)
}

function onExpandClick(): void {
  if (props.node.isDirectory) {
    fileStore.toggleNode(props.node)
  }
}

function onDragStart(event: DragEvent): void {
  if (!dragState) return
  if (!fileStore.isSelected(props.node.path)) fileStore.selectOnly(props.node.path)
    dragState.sourcePaths = [...fileStore.selectedPaths]
  dragState.sourcePath = props.node.path
  dragState.hoverPath = null
  if (event.dataTransfer) {
    event.dataTransfer.setData('text/plain', dragState.sourcePaths.join('\n'))
    event.dataTransfer.effectAllowed = 'move'
  }
}

function onDragEnd(): void {
  if (dragState) {
    dragState.sourcePaths = []
    dragState.sourcePath = null
    dragState.hoverPath = null
  }
}

function onDragOver(event: DragEvent): void {
  // 文件节点不处理也不拦截，让 dragover 冒泡到父目录统一处理
  if (!props.node.isDirectory) return
  // 目录节点总是停止冒泡，避免拖到其展开区域时误高亮列表空白区
  event.stopPropagation()
  if (!isValidDropTarget()) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  // 只记录最内层的合法目标（外层目录收不到被 stop 的事件，天然不会同时高亮）
  dragState!.hoverPath = props.node.path
}

function onDragLeave(event: DragEvent): void {
  if (!dragState) return
  const el = event.currentTarget as HTMLElement
  if (el.contains(event.relatedTarget as Node)) return
  // 鼠标离开当前悬停的节点后清除高亮；下一个 dragover 会立即设置新的目标
  if (dragState.hoverPath === props.node.path) dragState.hoverPath = null
}

function onDrop(event: DragEvent): void {
  // 文件节点不拦截 drop，让事件冒泡到父目录节点处理
  if (!props.node.isDirectory) return
  // 目录节点总是停止冒泡，避免拖到其展开区域时误落到列表空白区（移动到根目录）
  event.stopPropagation()
  dragState!.hoverPath = null
  if (!isValidDropTarget() || !onDropToFolder) return
  void onDropToFolder(props.node.path)
}
</script>

<template>
  <!-- dragover/drop 绑定在外层 tree-item 上：子节点的事件冒泡经过父级 tree-item，
       但不经过父级 item-content（二者是兄弟），故不能绑在 item-content 上 -->
  <div
    class="tree-item"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div
      class="item-content"
      :data-file-path="node.path"
      :class="{
        'is-directory': node.isDirectory,
        'is-active': !node.isDirectory && isActiveFile(node),
        'is-selected': fileStore.isSelected(node.path),
        'is-cut': fileStore.clipboardFiles?.mode === 'cut' && fileStore.clipboardFiles.paths.includes(node.path),
        'is-drag-over': isDragOver,
      }"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      draggable="true"
      @click="onClick"
      @dblclick="onDblClick"
      @contextmenu.prevent.stop="onContextMenu"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
    >
      <!-- 展开/折叠图标 -->
      <span
        v-if="node.isDirectory"
        class="expand-icon"
        :class="{ 'is-expanded': node.isExpanded }"
        @click.stop="onExpandClick"
      >
        <IconChevronRight
          :size="12"
          stroke="2"
        />
      </span>
      <span
        v-else
        class="expand-icon-placeholder"
      />

      <!-- 文件夹/文件图标 -->
      <span
        class="node-icon"
        :class="`node-icon-${iconType}`"
      >
        <component
          :is="iconComponent"
          :size="16"
          stroke="1.8"
        />
      </span>

      <!-- 名称 -->
      <Tooltip :content="node.path">
        <span class="node-name">{{ node.name }}</span>
      </Tooltip>

      <!-- 加载中指示器 -->
      <span
        v-if="node.isLoading"
        class="loading-indicator"
      >
        <span class="loading-dot" />
      </span>

      <!-- 修改标记 -->
      <span
        v-if="isModifiedFile(node)"
        class="modified-indicator"
      >●</span>
    </div>

    <!-- 递归渲染子节点 -->
    <div
      v-if="node.isExpanded && node.children.length > 0"
      class="tree-children"
    >
      <FileTreeItem
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        @context-menu="(e, n) => $emit('contextMenu', e, n)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-item {
  user-select: none;
}

.item-content {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s ease;
  min-height: 28px;
}

.item-content:hover {
  background-color: var(--color-bg-secondary);
}

.item-content.is-active {
  background-color: var(--color-primary-light);
}

.item-content.is-selected {
  background-color: var(--color-bg-tertiary);
}

.item-content.is-cut {
  opacity: 0.5;
}

.item-content.is-drag-over {
  background-color: var(--color-primary-light);
  outline: 1px dashed var(--color-primary);
}

.item-content.is-active .node-name {
  color: var(--color-primary);
  font-weight: 500;
}

.expand-icon {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-tertiary);
  transition: transform 0.15s ease;
  cursor: pointer;
  border-radius: 3px;
}

.expand-icon:hover {
  background-color: var(--color-bg-tertiary);
}

.expand-icon svg {
  width: 12px;
  height: 12px;
  transition: transform 0.15s ease;
}

.expand-icon.is-expanded svg {
  transform: rotate(90deg);
}

.expand-icon-placeholder {
  width: 16px;
  flex-shrink: 0;
}

.node-icon {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--color-text-secondary);
}

.node-icon svg {
  width: 16px;
  height: 16px;
}

.node-icon-folder { color: var(--color-accent-yellow, #d4a017); }
.node-icon-markdown { color: #2387a8; }
.node-icon-pdf { color: var(--color-error); }
.node-icon-image { color: #9b6dcc; }
.node-icon-archive { color: #d97706; }
.node-icon-data { color: #0f9d8a; }
.node-icon-code { color: #3b82f6; }
.node-icon-text { color: var(--color-text-secondary); }

.item-content.is-active .node-icon {
  color: var(--color-primary);
}

.node-name {
  flex: 1;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.loading-indicator {
  width: 12px;
  height: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.loading-dot {
  width: 6px;
  height: 6px;
  background-color: var(--color-primary);
  border-radius: 50%;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.modified-indicator {
  font-size: 8px;
  color: var(--color-warning);
  flex-shrink: 0;
}

.tree-children {
  /* 子节点容器，递归渲染 */
}
</style>
