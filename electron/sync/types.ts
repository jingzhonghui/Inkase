import type { ConflictChoice, SyncProviderKind, SyncResult, SyncStatus } from '../../shared/sync/types'

export type {
  ConflictChoice,
  EnableSyncOptions,
  SyncConfig,
  SyncProviderKind,
  SyncResult,
  SyncStatus,
  SyncStatusView
} from '../../shared/sync/types'

/** git 分支信息（git provider 特有） */
export interface BranchInfo {
  branch: string
  upstream: string | null
}

/**
 * 同步提供者抽象接口。
 * 后续新增同步盘/网盘方案时，只需实现该接口并在工厂注册一个分支。
 */
export interface SyncProvider {
  readonly kind: SyncProviderKind
  readonly workspacePath: string
  /** 探测当前同步状态 */
  status(): Promise<SyncStatus>
  /** 拉取远端到本地；成功时返回 changedFiles（本次实际变更的绝对路径） */
  pull(): Promise<SyncResult>
  /** 推送本地到远端 */
  push(): Promise<SyncResult>
  /** 提交本地变更（folder/webdav 等可空实现） */
  commit(message: string): Promise<void>
  /** 分支信息（可选能力，git 提供） */
  branchInfo?(): Promise<BranchInfo | null>
  /** 冲突状态下的冲突文件绝对路径列表（可选能力） */
  conflictedFiles?(): Promise<string[]>
  /** 是否处于 rebase 合并中间态（可选能力） */
  rebaseInProgress?(): Promise<boolean>
  /** 继续 rebase（解决冲突后；可选能力） */
  continueRebase?(): Promise<SyncResult>
  /** 中止 rebase（可选能力） */
  abortRebase?(): Promise<SyncResult>
  /** 冲突文件的人工裁决（可选能力，webdav 等无 rebase 的后端提供） */
  resolveConflicts?(choices: ConflictChoice[]): Promise<SyncResult>
  dispose(): void
}
