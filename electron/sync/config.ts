import * as fs from 'fs'
import * as path from 'path'
import type { SyncConfig } from './types'

export const SYNC_CONFIG_DIR = '.inkase'
export const SYNC_CONFIG_FILE = 'sync.json'

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  version: 1,
  provider: 'git',
  autoCommit: true,
  autoPull: true,
  autoPush: false
}

/** 同步配置文件绝对路径 */
export function syncConfigPath(workspacePath: string): string {
  return path.join(workspacePath, SYNC_CONFIG_DIR, SYNC_CONFIG_FILE)
}

/**
 * 读取同步配置。文件不存在返回 null；JSON 损坏时备份为 .sync.json.bak 并返回 null。
 */
export function loadSyncConfig(workspacePath: string): SyncConfig | null {
  const filePath = syncConfigPath(workspacePath)
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<SyncConfig>
    if (raw.version !== 1 || raw.provider !== 'git') return null
    return {
      version: 1,
      provider: 'git',
      autoCommit: typeof raw.autoCommit === 'boolean' ? raw.autoCommit : DEFAULT_SYNC_CONFIG.autoCommit,
      autoPull: typeof raw.autoPull === 'boolean' ? raw.autoPull : DEFAULT_SYNC_CONFIG.autoPull,
      autoPush: typeof raw.autoPush === 'boolean' ? raw.autoPush : DEFAULT_SYNC_CONFIG.autoPush
    }
  } catch {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`)
    } catch {
      /* 备份失败忽略 */
    }
    return null
  }
}

/** 写入同步配置（原子写：先写 .tmp 再 rename） */
export function saveSyncConfig(workspacePath: string, config: SyncConfig): void {
  const dirPath = path.join(workspacePath, SYNC_CONFIG_DIR)
  fs.mkdirSync(dirPath, { recursive: true })
  const filePath = syncConfigPath(workspacePath)
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

/**
 * 确保 <工作区>/.gitignore 包含 .inkase。
 * 无 .gitignore 则创建，有则检查追加，避免重复行。
 */
export function ensureInkaseIgnored(workspacePath: string): void {
  const gitignorePath = path.join(workspacePath, '.gitignore')
  const line = '.inkase'
  let content = ''
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8')
  }
  // 冲突标记保护：.gitignore 处于未解决的合并冲突时跳过追加，避免破坏冲突标记。
  // 正常情况下 enable 已通过 autoResolveGitignoreConflict 消化 .gitignore 冲突，此为双保险。
  if (/^<<<<<<</m.test(content)) return
  const lines = content.split(/\r?\n/)
  if (lines.some((l) => l.trim() === line)) return
  const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
  fs.writeFileSync(gitignorePath, `${content}${sep}${line}\n`, 'utf-8')
}
