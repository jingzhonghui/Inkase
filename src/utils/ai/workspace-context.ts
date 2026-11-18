/**
 * 渲染进程 AI 工作区适配器。
 *
 * 把 Pinia 的 fileStore 与共享的 AI DTO 相互转换：
 * - createExecutionSnapshot：读取当前活动 tab 及其选区，产出 AiExecutionSnapshot。
 * - applyDocumentOperation：把已批准的文档操作应用到 fileStore（含 revision/hash 双重校验）。
 *
 * 工作区文件搜索不再依赖发送消息时的文件快照，而是由模型在主进程调用
 * search_workspace / read_workspace_file 等实时工具完成；快照只携带授权根目录。
 */
import type {
  AiDocumentSnapshot,
  AiExecutionSnapshot,
  AiSelectionSnapshot,
  ApprovedDocumentOperation,
  ToolExecutionResult
} from '../../../shared/ai/types'
import { hashDocumentContent } from './document-revision'
import { useFileStore } from '../../stores/file'

type FileStore = ReturnType<typeof useFileStore>

/** 编辑器里可以作为文本交给 AI 的格式；图片与 PDF 是只读二进制，正文不参与上下文。 */
const TEXT_DOCUMENT_FORMATS = new Set<AiDocumentSnapshot['format']>([
  'markdown',
  'mdx',
  'mindmap',
  'diagram'
])

/**
 * 文档真实格式 → AI 快照格式。
 *
 * 早先的实现把所有非 Markdown、非思维导图的文档都兜底成 `mdx`，
 * 图表（XML）与图片、PDF（二进制）于是被当成 Markdown 正文，模型据此做出的
 * 判断自然不对。这里逐一映射，未知格式退回 `mdx`（编辑器本身按 Markdown 处理）。
 */
function toSnapshotFormat(format: string | undefined): AiDocumentSnapshot['format'] {
  switch (format) {
    case 'markdown':
      return 'markdown'
    case 'mindmap':
      return 'mindmap'
    case 'diagram':
      return 'diagram'
    case 'image':
      return 'image'
    case 'pdf':
      return 'pdf'
    default:
      return 'mdx'
  }
}

/**
 * 把归一化的编辑器选区映射为 AI 选区 DTO。
 */
function toAiSelection(sel: { from: number; to: number; cursor: number; text: string }): AiSelectionSnapshot {
  return { text: sel.text, from: sel.from, to: sel.to, cursor: sel.cursor }
}

export function createExecutionSnapshot(fileStore: FileStore): AiExecutionSnapshot {
  const tab = fileStore.tabs.find((t) => t.id === fileStore.activeTabId) ?? null

  if (!tab) {
    return {
      conversationId: '',
      activeDocument: null,
      selection: null,
      cursor: null,
      workspaceRoot: fileStore.openedFolderPath ?? null
    }
  }

  const sel = fileStore.editorSelection
  const validSelection = sel !== null
    && sel.tabId === tab.id
    && Number.isInteger(sel.from)
    && Number.isInteger(sel.to)
    && Number.isInteger(sel.cursor)
    && sel.from >= 0
    && sel.from <= sel.to
    && sel.to <= tab.content.length
    && sel.cursor >= 0
    && sel.cursor <= tab.content.length
    && tab.content.slice(sel.from, sel.to) === sel.text

  const format = toSnapshotFormat(tab.fileInfo?.format)

  return {
    conversationId: '',
    activeDocument: {
      id: tab.id,
      title: tab.document?.metadata.title || tab.fileInfo?.name || '',
      path: tab.fileInfo?.path ?? null,
      format,
      // 二进制文档的 content 是 Data URL / base64，不该进入 AI 上下文
      content: TEXT_DOCUMENT_FORMATS.has(format) ? tab.content : '',
      revision: tab.revision,
      contentHash: hashDocumentContent(tab.content),
      modified: tab.fileInfo?.modified ?? false
    },
    selection: validSelection ? toAiSelection(sel) : null,
    cursor: validSelection ? sel.cursor : null,
    workspaceRoot: fileStore.openedFolderPath ?? null
  }
}

export async function applyDocumentOperation(
  fileStore: FileStore,
  operation: ApprovedDocumentOperation,
  revealDocument?: () => void
): Promise<ToolExecutionResult> {
  switch (operation.type) {
    case 'replace-document':
      return applyReplace(fileStore, operation)
    case 'insert-document':
      return applyInsert(fileStore, operation)
    case 'create-document':
      return applyCreate(fileStore, operation, revealDocument)
    case 'delete-workspace-file':
      return applyDeleteFile(fileStore, operation)
    case 'move-workspace-entry':
      return applyMoveEntry(fileStore, operation)
    case 'create-workspace-directory':
      return applyCreateDirectory(fileStore, operation)
    case 'write-workspace-file':
      return applyWriteFile(fileStore, operation)
  }
}

/**
 * 移动 / 改名。
 *
 * 先查受影响标签有没有未保存修改：文件被移走后标签会指向旧路径，
 * 带着未保存内容移动等于把改动挂到一个不存在的位置。
 */
async function applyMoveEntry(
  fileStore: FileStore,
  operation: Extract<ApprovedDocumentOperation, { type: 'move-workspace-entry' }>
): Promise<ToolExecutionResult> {
  const root = fileStore.openedFolderPath
  if (!root) return { status: 'failed', message: '当前没有打开工作区' }
  if (!isInsideRoot(root, operation.fromAbsolute) || !isInsideRoot(root, operation.toAbsolute)) {
    return { status: 'failed', message: '目标路径不在当前工作区内' }
  }

  const affected = fileStore.tabs.filter(
    (tab) =>
      !!tab.fileInfo?.path &&
      (isSameFilePath(tab.fileInfo.path, operation.fromAbsolute) ||
        isInsideRoot(operation.fromAbsolute, tab.fileInfo.path))
  )
  if (affected.some((tab) => tab.fileInfo?.modified)) {
    return { status: 'conflict', message: '目标文件或目录内还有未保存的修改，请先保存' }
  }

  const from = splitDirAndName(operation.fromAbsolute)
  const to = splitDirAndName(operation.toAbsolute)
  const sameDirectory = isSameFilePath(from.dir, to.dir)

  if (sameDirectory) {
    const renamed = await fileStore.renameItem(operation.fromAbsolute, to.name)
    return renamed
      ? { status: 'applied' }
      : { status: 'failed', message: '重命名失败：目标可能已存在或文件被占用' }
  }

  const moved = await fileStore.moveItem(operation.fromAbsolute, to.dir)
  if (!moved) return { status: 'failed', message: '移动失败：目标可能已存在或文件被占用' }

  if (from.name !== to.name) {
    const renamed = await fileStore.renameItem(operation.toAbsolute, to.name)
    if (!renamed) {
      return { status: 'failed', message: '已移动但改名失败：目标位置可能已有同名文件' }
    }
  }
  return { status: 'applied' }
}

async function applyCreateDirectory(
  fileStore: FileStore,
  operation: Extract<ApprovedDocumentOperation, { type: 'create-workspace-directory' }>
): Promise<ToolExecutionResult> {
  const root = fileStore.openedFolderPath
  if (!root) return { status: 'failed', message: '当前没有打开工作区' }
  if (!isInsideRoot(root, operation.absolutePath)) {
    return { status: 'failed', message: '目标路径不在当前工作区内' }
  }

  const { dir, name } = splitDirAndName(operation.absolutePath)
  if (!dir || !name) return { status: 'failed', message: '目标路径不合法' }

  const created = await fileStore.createFolder(dir, name)
  return created
    ? { status: 'applied' }
    : { status: 'failed', message: '创建目录失败：同名目录可能已存在' }
}

/**
 * 按路径写文本。
 *
 * 只处理纯文本格式（主进程在造操作时已经挡掉容器与图表）。文件若在编辑器里
 * 打开着，必须先确认没有未保存修改，写完再把标签内容同步过去、清掉脏标记——
 * 否则会出现「磁盘是新的、编辑器还是旧的」。
 */
async function applyWriteFile(
  fileStore: FileStore,
  operation: Extract<ApprovedDocumentOperation, { type: 'write-workspace-file' }>
): Promise<ToolExecutionResult> {
  const root = fileStore.openedFolderPath
  if (!root) return { status: 'failed', message: '当前没有打开工作区' }
  if (!isInsideRoot(root, operation.absolutePath)) {
    return { status: 'failed', message: '目标路径不在当前工作区内' }
  }
  if (!window.electronAPI?.saveFile) return { status: 'failed', message: '文件写入接口不可用' }

  const tab = fileStore.tabs.find(
    (item) => !!item.fileInfo?.path && isSameFilePath(item.fileInfo.path, operation.absolutePath)
  )
  if (tab) {
    if (tab.fileInfo?.modified) {
      return { status: 'conflict', message: '该文件在编辑器中有未保存的修改，请先保存或撤销' }
    }
    if (operation.target) {
      const conflict = checkTargetFresh(tab, operation.target)
      if (conflict) return { status: 'conflict', message: conflict }
    }
  }

  const result = await window.electronAPI.saveFile(
    operation.content,
    undefined,
    operation.absolutePath,
    false
  )
  if (!result.success) {
    return { status: 'failed', message: result.error || '写入文件失败' }
  }

  if (tab) {
    // 磁盘与编辑器现在一致：内容同步过去，并清掉「未保存」标记
    fileStore.updateTabContent(tab.id, operation.content)
    if (tab.fileInfo) tab.fileInfo.modified = false
  } else {
    // 新文件或未打开的已有文件：刷新文件树并推动图谱索引
    await fileStore.readFolder(root)
  }
  return { status: 'applied' }
}

/**
 * 判断绝对路径是否落在工作区根内。
 *
 * Windows 上大小写不敏感、分隔符可能是 `\\` 也可能混用 `/`，比较前统一。
 */
function isInsideRoot(root: string, target: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const normalizedRoot = normalize(root)
  const normalizedTarget = normalize(target)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

/** 同一个文件的两个路径写法（分隔符、盘符大小写可能不同）。 */
function isSameFilePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
  return normalize(left) === normalize(right)
}

/**
 * 渲染层没有 node:path，这里只需要「取目录 / 取文件名」两件小事。
 * 同时兼容 `\\` 与 `/`，因为主进程 realpath 出来的路径与 store 里存的可能不同。
 */
function splitDirAndName(value: string): { dir: string; name: string } {
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (index < 0) return { dir: '', name: value }
  return { dir: value.slice(0, index), name: value.slice(index + 1) }
}

/**
 * 删除工作区文件。
 *
 * 三个前置条件，任何一条不满足都不动手：
 * 1. 有打开的工作区，且目标确实在它里面（主进程已经校验过，这里再校验一次）；
 * 2. 目标没有未保存的修改——删掉就等于丢数据；
 * 3. 走 fileStore.deleteItem，让文件树、已打开的标签与图谱索引一起更新。
 */
async function applyDeleteFile(
  fileStore: FileStore,
  operation: Extract<ApprovedDocumentOperation, { type: 'delete-workspace-file' }>
): Promise<ToolExecutionResult> {
  const root = fileStore.openedFolderPath
  if (!root) return { status: 'failed', message: '当前没有打开工作区' }
  if (!isInsideRoot(root, operation.absolutePath)) {
    return { status: 'failed', message: '目标文件不在当前工作区内' }
  }

  // 主进程给的绝对路径经 realpath 归一，盘符大小写可能与标签里存的不一致
  const tab = fileStore.tabs.find(
    (t) => !!t.fileInfo?.path && isSameFilePath(t.fileInfo.path, operation.absolutePath)
  )
  if (tab?.fileInfo?.modified) {
    return { status: 'failed', message: '该文件有未保存的修改，请先保存或手动关闭标签后再删除' }
  }

  const deleted = await fileStore.deleteItem(operation.absolutePath)
  return deleted
    ? { status: 'applied' }
    : { status: 'failed', message: '删除失败：文件可能已被移动、占用或权限不足' }
}

function findTargetTab(fileStore: FileStore, targetId: string) {
  return fileStore.tabs.find((t) => t.id === targetId) ?? null
}

/**
 * 变更前重新校验目标存在性、revision 与内容哈希。
 * 任一不匹配则视为冲突（文档已被用户改动）。
 */
function checkTargetFresh(
  tab: { revision: number; content: string },
  target: { revision: number; contentHash: string }
): string | null {
  if (tab.revision !== target.revision) return '文档已被修改'
  if (hashDocumentContent(tab.content) !== target.contentHash) return '文档已被修改'
  return null
}

function applyReplace(
  fileStore: FileStore,
  operation: Extract<ApprovedDocumentOperation, { type: 'replace-document' }>
): ToolExecutionResult {
  const tab = findTargetTab(fileStore, operation.target.id)
  if (!tab) {
    return { status: 'conflict', message: '目标文档不存在' }
  }
  const conflict = checkTargetFresh(tab, operation.target)
  if (conflict) {
    return { status: 'conflict', message: conflict }
  }
  fileStore.updateTabContent(tab.id, operation.content)
  return { status: 'applied' }
}

function applyInsert(
  fileStore: FileStore,
  operation: Extract<ApprovedDocumentOperation, { type: 'insert-document' }>
): ToolExecutionResult {
  const tab = findTargetTab(fileStore, operation.target.id)
  if (!tab) {
    return { status: 'conflict', message: '目标文档不存在' }
  }
  const conflict = checkTargetFresh(tab, operation.target)
  if (conflict) {
    return { status: 'conflict', message: conflict }
  }

  const base = tab.content
  let next: string

  switch (operation.position) {
    case 'start':
      next = operation.content + base
      break
    case 'end':
      next = base + operation.content
      break
    case 'selection': {
      const selection = operation.selection
      if (!selection) {
        return { status: 'conflict', message: '选区不可用' }
      }
      next = base.slice(0, selection.from) + operation.content + base.slice(selection.to)
      break
    }
    case 'cursor': {
      const cursor = operation.cursor
      if (cursor === null || cursor === undefined) {
        return { status: 'conflict', message: '光标不可用' }
      }
      next = base.slice(0, cursor) + operation.content + base.slice(cursor)
      break
    }
  }

  fileStore.updateTabContent(tab.id, next)
  return { status: 'applied' }
}

function applyCreate(
  fileStore: FileStore,
  operation: Extract<ApprovedDocumentOperation, { type: 'create-document' }>,
  revealDocument?: () => void
): ToolExecutionResult {
  const tab = fileStore.createGeneratedDocument(operation.title, operation.content, operation.format)
  if (!tab) {
    return { status: 'failed', message: '已达到最大打开标签数上限，请先关闭一些标签' }
  }
  revealDocument?.()
  return { status: 'applied', data: { tabId: tab.id } }
}
