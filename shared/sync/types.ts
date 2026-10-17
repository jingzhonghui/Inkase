/** 同步提供者类型（当前支持 git 与 webdav） */
export type SyncProviderKind = 'git' | 'webdav'

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

/** 单个冲突文件的人工裁决（主进程/渲染层共用） */
export interface ConflictChoice {
  path: string
  choice: 'local' | 'remote'
}

/** 同步配置（存于 <工作区>/.inkase/sync.json，本机私有；凭据不落盘） */
export interface SyncConfig {
  version: 1
  provider: SyncProviderKind
  autoCommit: boolean
  autoPull: boolean
  autoPush: boolean
  /** webdav 服务地址 */
  url?: string
  /** webdav 用户名（口令不入配置，单独安全存储） */
  username?: string
  /** webdav 远端根目录 */
  remoteRoot?: string
}

/** 启用同步的入参 */
export interface EnableSyncOptions {
  remoteUrl?: string
  autoCommit?: boolean
  autoPull?: boolean
  autoPush?: boolean
  /** 同步后端类型，缺省沿用 git */
  provider?: SyncProviderKind
  /** webdav 服务地址 */
  url?: string
  /** webdav 用户名 */
  username?: string
  /** webdav 口令（仅入参，不写入配置文件） */
  password?: string
  /** webdav 远端根目录 */
  remoteRoot?: string
}

/** 渲染进程可见的同步状态视图 */
export interface SyncStatusView {
  status: SyncStatus
  error: string | null
  configured: boolean
  isGitRepo: boolean
  branch: string | null
  upstream: string | null
  /** 当前同步后端类型 */
  provider: SyncProviderKind
  /** 冲突状态下的冲突文件绝对路径列表 */
  conflictedFiles?: string[]
  /** 是否处于 rebase 合并中间态（冲突引导使用） */
  inRebase?: boolean
}
