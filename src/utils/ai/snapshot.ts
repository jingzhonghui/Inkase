import type { ApprovedDocumentOperation, ToolApprovalRequest } from '../../../shared/ai/types'
import type { SnapshotFileInput } from '../../../shared/ai/snapshots'
import { snapshotFileKey } from '../../../shared/ai/snapshots'
import { requestDialog } from '../dialog'
import { useFileStore } from '../../stores/file'

type FileStore = ReturnType<typeof useFileStore>

function snapshotFile(operation: ApprovedDocumentOperation): SnapshotFileInput | null {
  if (operation.type === 'create-document') return null
  if (operation.type !== 'replace-document' && operation.type !== 'insert-document') return null
  const target = operation.target
  return {
    path: target.path || null,
    documentId: target.id,
    title: target.title,
    content: target.content,
    scope: 'memory',
    existed: true
  }
}

/**
 * 在渲染进程真正修改文档前，把「修改前内容」交给主进程写入 run 快照。
 *
 * 没有工作区（无法落 `.inkase/snapshots`）或不是替换/插入类操作时返回 null；
 * 快照写入失败则抛出，调用方必须放弃本次修改（写前快照是硬前提）。
 */
export async function createSnapshotForApproval(
  approval: ToolApprovalRequest,
  conversationId: string
): Promise<string | null> {
  if (approval.execution.location !== 'renderer') return null
  const snapshot = snapshotFile(approval.execution.operation)
  const fileStore = useFileStore()
  if (!snapshot || !fileStore.openedFolderPath) return null

  const response = await window.electronAPI.createAiSnapshot({
    runId: approval.runId,
    conversationId,
    toolName: approval.toolName,
    files: [snapshot]
  })
  if (!response.success) throw new Error(response.error || '写入前快照失败，已取消本次修改')
  return approval.runId
}

function absolutePath(fileStore: FileStore, relativePath: string | null): string | null {
  if (!relativePath) return null
  const root = fileStore.openedFolderPath
  if (!root) return null
  return `${root.replace(/[\\/]+$/, '')}/${relativePath}`.replace(/\\/g, '/')
}

function findTab(fileStore: FileStore, documentId: string | undefined, absolute: string | null) {
  if (documentId) {
    const byId = fileStore.tabs.find((tab) => tab.id === documentId)
    if (byId) return byId
  }
  if (!absolute) return null
  const normalized = absolute.replace(/\\/g, '/')
  return fileStore.tabs.find((tab) => tab.fileInfo?.path?.replace(/\\/g, '/') === normalized) ?? null
}

/**
 * 一键回滚一次 AI 运行。
 *
 * - memory 快照：恢复仍打开标签的内容（AI 修改本来就没有落盘）
 * - disk 快照：主进程已把文件写回原内容，这里刷新打开的标签并重建索引
 *
 * 目标标签已有未保存改动时先询问；用户取消则跳过该文件。
 */
export async function rollbackAiSnapshot(runId: string): Promise<number> {
  const preview = await window.electronAPI.readAiSnapshot(runId)
  if (!preview.success || !preview.data) {
    throw new Error(preview.error || '回滚失败')
  }

  const fileStore = useFileStore()
  const keys: string[] = []
  for (const file of preview.data.files) {
    const absolute = absolutePath(fileStore, file.record.path)
    let tab = findTab(fileStore, file.record.documentId, absolute)
    if (!tab && absolute) {
      await fileStore.openFile(absolute, { addToRecent: false })
      tab = findTab(fileStore, file.record.documentId, absolute)
    }
    // 关掉的未保存文档没有可恢复的标签；磁盘文件则由主进程直接还原
    if (!tab) {
      if (file.record.scope === 'disk') keys.push(snapshotFileKey(file.record))
      continue
    }

    if (tab.fileInfo?.modified && tab.content !== file.content) {
      const choice = await requestDialog({
        title: '回滚 AI 修改',
        message: `「${tab.fileInfo.name}」有未保存改动，回滚会覆盖当前内容。`,
        detail: '继续回滚会把该标签恢复到 AI 修改前的状态，磁盘文件不会自动保存。',
        buttons: [
          { label: '取消', value: 1 },
          { label: '回滚', value: 0, primary: true }
        ]
      })
      if (choice !== 0) continue
    }
    keys.push(snapshotFileKey(file.record))
  }

  if (keys.length === 0) return 0

  const response = await window.electronAPI.rollbackAiSnapshot({ runId, keys })
  if (!response.success || !response.data) {
    throw new Error(response.error || '回滚失败')
  }

  for (const file of response.data.files) {
    const absolute = absolutePath(fileStore, file.record.path)
    const tab = findTab(fileStore, file.record.documentId, absolute)
    if (!tab) continue
    fileStore.updateTabContent(tab.id, file.content)
    if (file.record.scope === 'disk' && tab.fileInfo) tab.fileInfo.modified = false
  }

  if (response.data.restoredDisk.length > 0) {
    await window.electronAPI.rebuildKnowledgeIndex()
    const { useKnowledgeStore } = await import('../../stores/knowledge')
    await useKnowledgeStore().refreshAll()
  }

  return response.data.files.length
}
