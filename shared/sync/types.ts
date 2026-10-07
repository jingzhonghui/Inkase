/** 同步提供者类型（第一版仅 git；folder/webdav 等后续扩展） */
export type SyncProviderKind = 'git'

/** 同步状态 */
export type SyncStatus =
  | 'uninitialized'
  | 'syncing'
  | 'upToDate'
  | 'pendingCommit'
  | 'pendingPush'
  | 'pendingPull'
  | 'conflict'
  | 'error'

/** 同步操作结果 */
export interface SyncResult {
  success: boolean
  changedFiles?: string[]
  error?: string
}

/** 同步配置（存于 <工作区>/.inkase/sync.json，本机私有） */
export interface SyncConfig {
  version: 1
  provider: SyncProviderKind
  autoCommit: boolean
  autoPull: boolean
  autoPush: boolean
}

/** 启用同步的入参 */
export interface EnableSyncOptions {
  remoteUrl?: string
  autoCommit?: boolean
  autoPull?: boolean
  autoPush?: boolean
}

/** 渲染进程可见的同步状态视图 */
export interface SyncStatusView {
  status: SyncStatus
  error: string | null
  configured: boolean
  isGitRepo: boolean
  branch: string | null
  upstream: string | null
  /** 冲突状态下的冲突文件绝对路径列表 */
  conflictedFiles?: string[]
  /** 是否处于 rebase 合并中间态（冲突引导使用） */
  inRebase?: boolean
}
