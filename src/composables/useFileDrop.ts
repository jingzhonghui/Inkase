import { ref } from 'vue'
import { useFileStore } from '../stores/file'

/**
 * 拖放打开 Composable
 *
 * 在 document 上注册全局拖放监听：
 * - 拦截 Electron 默认的文件拖入导航（file://）
 * - 拖入 .md/.mdx/.inkmind 文件 → 打开为标签页
 * - 拖入文件夹 → 打开文件夹浏览
 * - 其他文件（如图片）忽略，不干扰编辑器内已有的图片插入处理
 */

export type DropItemKind = 'folder' | 'markdown' | 'mindmap' | 'other'

interface FileSystemEntryLike {
  isFile: boolean
  isDirectory: boolean
}

/**
 * 根据文件名和是否为目录分类拖入项（纯函数，便于测试）
 */
export function classifyDropItem(name: string, isDirectory: boolean): DropItemKind {
  if (isDirectory) return 'folder'
  const lower = name.toLowerCase()
  if (lower.endsWith('.inkmind')) return 'mindmap'
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown'
  return 'other'
}

// 模块级共享状态：App.vue 负责 init/dispose，FileDropOverlay 只读取 isDragging
const isDragging = ref(false)
let dragDepth = 0
let mounted = false
// 应用内部元素（文件树、图片拖拽等）发起的拖拽，不显示「松开以打开」覆盖层
let internalDrag = false

function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

function getEntry(item: DataTransferItem): FileSystemEntryLike | null {
  const itemWithEntry = item as DataTransferItem & {
    webkitGetAsEntry?: () => FileSystemEntryLike | null
  }
  return itemWithEntry.webkitGetAsEntry?.() ?? null
}

async function processDrop(e: DragEvent): Promise<void> {
  const fileStore = useFileStore()
  const api = window.electronAPI
  const items = e.dataTransfer?.items
  if (!items || !api?.getPathForFile) return

  for (const item of Array.from(items)) {
    const file = item.getAsFile()
    if (!file) continue
    const entry = getEntry(item)
    const kind = classifyDropItem(file.name, entry?.isDirectory ?? false)
    if (kind === 'other') continue

    const path = api.getPathForFile(file)
    if (!path) continue

    if (kind === 'folder') {
      await fileStore.openFolderPath(path)
    } else {
      await fileStore.openFile(path)
    }
  }
}

function handleDragStart(): void {
  internalDrag = true
}

function handleDragEnd(): void {
  internalDrag = false
}

function handleDragEnter(e: DragEvent): void {
  if (internalDrag || !hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  isDragging.value = true
}

function handleDragOver(e: DragEvent): void {
  if (internalDrag || !hasFiles(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  isDragging.value = true
}

function handleDragLeave(e: DragEvent): void {
  if (!hasFiles(e)) return
  if (e.relatedTarget === null) {
    dragDepth = 0
  } else {
    dragDepth = Math.max(0, dragDepth - 1)
  }
  if (dragDepth === 0) isDragging.value = false
}

function handleDrop(e: DragEvent): void {
  dragDepth = 0
  isDragging.value = false
  if (internalDrag || !hasFiles(e)) return
  e.preventDefault()
  void processDrop(e)
}

export function useFileDrop() {
  function init(): void {
    if (mounted) return
    mounted = true
    document.addEventListener('dragstart', handleDragStart)
    document.addEventListener('dragend', handleDragEnd)
    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('drop', handleDrop)
  }

  function dispose(): void {
    if (!mounted) return
    mounted = false
    document.removeEventListener('dragstart', handleDragStart)
    document.removeEventListener('dragend', handleDragEnd)
    document.removeEventListener('dragenter', handleDragEnter)
    document.removeEventListener('dragover', handleDragOver)
    document.removeEventListener('dragleave', handleDragLeave)
    document.removeEventListener('drop', handleDrop)
    dragDepth = 0
    internalDrag = false
    isDragging.value = false
  }

  return { isDragging, init, dispose }
}
