import * as fs from 'fs'
import * as path from 'path'

/** 同步清单目录（与 sync.json 同处 .inkase，本机私有） */
export const SYNC_STATE_DIR = '.inkase'
export const SYNC_STATE_FILE = 'sync-state.json'

/** 单个文件的同步基准；key 为相对工作区、以 / 分隔的路径 */
export interface SyncStateEntry {
  /** 上次同步时远端的 ETag，缺失为 null */
  etag: string | null
  /** 上次同步时本地内容哈希 */
  hash: string
  /** 字节数 */
  size: number
  /** 本地 mtime（毫秒时间戳） */
  mtime: number
}

/** WebDAV 上次同步基准清单 */
export interface SyncState {
  version: 1
  provider: 'webdav'
  remoteRoot: string
  files: Record<string, SyncStateEntry>
}

/** 一侧文件的存在状态；null 表示该侧文件不存在 */
export type FileSide = { hash: string } | null

/** 三向比对后对单个文件应采取的动作 */
export type FileAction = 'upload' | 'download' | 'deleteRemote' | 'deleteLocal' | 'conflict' | 'none'

/**
 * 三向比对：把 (base, local, remote) 映射为单个文件的同步动作。
 * base 为上次同步基准；与某侧 hash 相等即视为「该侧未变」。纯函数，无 IO。
 */
export function compareFile(base: SyncStateEntry | null, local: FileSide, remote: FileSide): FileAction {
  // 无基准：本地/远端互为新增
  if (base === null) {
    if (local === null) return remote === null ? 'none' : 'download'
    if (remote === null) return 'upload'
    return local.hash === remote.hash ? 'none' : 'conflict'
  }

  // 有基准：删除靠 base 区分是谁删的
  if (local === null) {
    if (remote === null) return 'none'
    return remote.hash === base.hash ? 'deleteRemote' : 'conflict'
  }
  if (remote === null) return local.hash === base.hash ? 'deleteLocal' : 'conflict'

  const localChanged = local.hash !== base.hash
  const remoteChanged = remote.hash !== base.hash
  if (!localChanged && !remoteChanged) return 'none'
  if (localChanged && !remoteChanged) return 'upload'
  if (!localChanged && remoteChanged) return 'download'
  return 'conflict'
}

/** 远端为空而基准清单非空：疑似远端被清空/挂载失败，需护栏提示 */
export function isSuspiciousEmptyRemote(baseCount: number, remoteCount: number): boolean {
  return baseCount > 0 && remoteCount === 0
}

/** 同步清单文件绝对路径 */
export function syncStatePath(workspacePath: string): string {
  return path.join(workspacePath, SYNC_STATE_DIR, SYNC_STATE_FILE)
}

/** 构造一份空清单 */
export function emptySyncState(remoteRoot: string): SyncState {
  return { version: 1, provider: 'webdav', remoteRoot, files: {} }
}

/**
 * 读取同步清单。文件不存在返回 null；version !== 1、provider !== 'webdav'
 * 或结构不完整返回 null；JSON 损坏时备份为 .bak 并返回 null。
 */
export function loadSyncState(workspacePath: string): SyncState | null {
  const filePath = syncStatePath(workspacePath)
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<SyncState>
    if (raw.version !== 1 || raw.provider !== 'webdav') return null
    if (typeof raw.remoteRoot !== 'string') return null
    if (!raw.files || typeof raw.files !== 'object') return null
    return { version: 1, provider: 'webdav', remoteRoot: raw.remoteRoot, files: raw.files }
  } catch {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`)
    } catch {
      /* 备份失败忽略 */
    }
    return null
  }
}

/** 写入同步清单（原子写：先写 .tmp 再 rename） */
export function saveSyncState(workspacePath: string, state: SyncState): void {
  const dirPath = path.join(workspacePath, SYNC_STATE_DIR)
  fs.mkdirSync(dirPath, { recursive: true })
  const filePath = syncStatePath(workspacePath)
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
  fs.renameSync(tmpPath, filePath)
}
