/**
 * AI 写入前快照的共享类型。
 *
 * 快照按 run 聚合：一次 AI 运行里对同一文档的多次修改只保留最早的那份内容，
 * 回滚时一次还原到运行开始前。
 */
export type SnapshotScope = 'memory' | 'disk'

export interface SnapshotFileInput {
  /** 工作区相对路径；未保存的新文档为 null */
  path: string | null
  /** 渲染进程标签 id，用于回滚时定位仍打开的标签 */
  documentId?: string
  title: string
  content: string
  scope: SnapshotScope
  /** disk 快照：文件原本是否存在；memory 快照忽略 */
  existed?: boolean
}

export interface SnapshotCreateInput {
  runId: string
  conversationId: string
  toolName: string
  files: SnapshotFileInput[]
}

export interface SnapshotFileRecord extends Omit<SnapshotFileInput, 'content'> {
  storageName: string
  contentHash: string
  size: number
}

export interface SnapshotManifest {
  version: 1
  runId: string
  conversationId: string
  toolName: string
  createdAt: number
  files: SnapshotFileRecord[]
  /** 已执行过回滚的时间；重复回滚仍允许 */
  rolledBackAt?: number
}

export interface SnapshotSummary {
  runId: string
  conversationId: string
  toolName: string
  createdAt: number
  fileCount: number
  totalBytes: number
  paths: Array<string | null>
  scopes: SnapshotScope[]
  rolledBackAt?: number
}

export interface SnapshotBundleFile {
  record: SnapshotFileRecord
  content: string
}

export interface SnapshotRestoreResult {
  manifest: SnapshotManifest
  /** 所有快照内容；memory 项由渲染进程恢复标签，disk 项主进程已写回磁盘 */
  files: SnapshotBundleFile[]
  restoredDisk: string[]
  skippedDisk: string[]
}

export interface SnapshotRollbackInput {
  runId: string
  /** 只回滚用户确认过的文件；缺省表示全部 */
  keys?: string[]
}

export function snapshotFileKey(file: {
  path: string | null
  documentId?: string
  storageName?: string
}): string {
  if (file.path) return `path:${file.path}`
  if (file.documentId) return `id:${file.documentId}`
  return `storage:${file.storageName ?? ''}`
}
