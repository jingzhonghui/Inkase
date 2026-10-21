/**
 * 库内文件遍历
 *
 * 索引服务与引用重写共用同一套遍历规则，避免两处实现漂移：
 * - 跳过隐藏目录与隐藏文件（含 `.inkase`、`.git`）
 * - 跳过 `node_modules`
 * - 结果按库内相对路径排序，保证构建顺序稳定
 *
 * 根目录不可读时**抛出**（由调用方决定是否降级）；子目录不可读时跳过。
 */

import * as fs from 'fs'
import * as path from 'path'

/** 递归扫描时跳过的目录名（隐藏目录已由 `.` 前缀规则覆盖） */
const SKIP_DIRS = new Set(['node_modules'])

/** 遍历到的单个文件 */
export interface VaultFile {
  /** 库内相对路径，'/' 分隔 */
  rel: string
  /** 绝对路径 */
  abs: string
  /** 毫秒时间戳（取整，供增量判定） */
  mtime: number
  /** 字节数 */
  size: number
}

/**
 * 递归遍历库内文件
 *
 * @throws 当 `root` 不存在或不是目录时
 */
export function walkVault(root: string): VaultFile[] {
  const out: VaultFile[] = []

  const walk = (absDir: string, relDir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return // 子目录不可读：跳过，不影响整体
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue

      const abs = path.join(absDir, entry.name)
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`

      if (entry.isDirectory()) {
        walk(abs, rel)
        continue
      }
      if (!entry.isFile()) continue

      let stat: fs.Stats
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }

      out.push({ rel, abs, mtime: Math.floor(stat.mtimeMs), size: stat.size })
    }
  }

  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`不是目录：${root}`)
  }
  walk(root, '')

  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}
