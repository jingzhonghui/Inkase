import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { app } from 'electron'

export interface RecoveryTab {
  id: string
  filePath: string | null
  fileName: string
  /** 恢复的标签页格式；思维导图直接存文本，因此与 markdown/mdx 同样按文本恢复 */
  format: 'mdx' | 'markdown' | 'mindmap'
  content: string
  document: unknown
  modifiedAt: string
  assetData?: Record<string, string>
}

export interface RecoverySnapshot {
  version: 1
  createdAt: string
  activeTabId: string | null
  tabs: RecoveryTab[]
}

const SNAPSHOT_PREFIX = 'snapshot-'
const MARKER_PREFIX = 'running-'

/**
 * 当前进程的实例 ID，用于隔离多实例的恢复快照与运行标记，
 * 避免多实例共享 userData 时互相覆盖对方的未保存草稿。
 */
const INSTANCE_ID = `${process.pid}_${randomBytes(4).toString('hex')}`

function recoveryDir(): string {
  const dir = path.join(app.getPath('userData'), 'recovery')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function snapshotName(): string {
  return `${SNAPSHOT_PREFIX}${INSTANCE_ID}.json`
}

function markerName(): string {
  return `${MARKER_PREFIX}${INSTANCE_ID}`
}

function snapshotPath(): string {
  return path.join(recoveryDir(), snapshotName())
}

function markerPath(): string {
  return path.join(recoveryDir(), markerName())
}

export function markAppRunning(): void {
  const marker = markerPath()
  if (fs.existsSync(marker)) {
    return
  }
  fs.writeFileSync(marker, new Date().toISOString(), 'utf8')
}

/**
 * 是否存在上次异常退出的会话：任一运行标记都有对应的快照文件
 */
export function hadAbnormalExit(): boolean {
  const dir = recoveryDir()
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return false
  }
  return entries.some((name) => {
    if (!name.startsWith(MARKER_PREFIX)) return false
    const snapshot = path.join(dir, `${SNAPSHOT_PREFIX}${name.slice(MARKER_PREFIX.length)}.json`)
    return fs.existsSync(snapshot)
  })
}

export function writeRecoverySnapshot(snapshot: RecoverySnapshot): void {
  const target = snapshotPath()
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(snapshot), 'utf8')
  fs.renameSync(temporary, target)
}

/**
 * 读取所有异常退出快照中最新的那一份
 */
export function readRecoverySnapshot(): RecoverySnapshot | null {
  const dir = recoveryDir()
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith('.json'))
  } catch {
    return null
  }
  let latest: RecoverySnapshot | null = null
  for (const name of names) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as RecoverySnapshot
      if (value.version !== 1 || !Array.isArray(value.tabs)) continue
      if (!latest || (value.createdAt ?? '') > (latest.createdAt ?? '')) {
        latest = value
      }
    } catch {
      // 损坏文件跳过
    }
  }
  return latest
}

/**
 * 清理本实例的会话数据（正常退出时调用），不影响其他实例
 */
export function clearRecoveryData(): void {
  const dir = recoveryDir()
  fs.rmSync(path.join(dir, snapshotName()), { force: true })
  fs.rmSync(path.join(dir, `${snapshotName()}.tmp`), { force: true })
  fs.rmSync(path.join(dir, markerName()), { force: true })
}

/**
 * 清除所有异常退出快照（保留运行标记），用于放弃/完成恢复后避免反复提示
 */
export function clearRecoverySnapshot(): void {
  const dir = recoveryDir()
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith(SNAPSHOT_PREFIX)) {
      fs.rmSync(path.join(dir, name), { force: true })
    }
  }
}
