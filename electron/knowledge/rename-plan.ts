/**
 * 重命名 / 移动的影响范围计算
 *
 * 把一次「旧绝对路径 → 新绝对路径」换算成库内相对路径映射：
 * - 文件：单条映射
 * - 目录：展开为该目录下**所有文件**的映射（遍历规则与索引一致，跳过隐藏项与 `node_modules`）
 * - 任一路径不在已授权工作区内：返回 null，调用方据此跳过引用重写
 *
 * 必须在磁盘操作**之前**调用——移动之后就找不到旧目录了。
 */

import * as path from 'node:path'
import { isPathWithinRoot } from '../workspace/workspace-authorization'
import { walkVault } from './vault-walk'

/** 一条库内路径重命名 */
export interface PathRename {
  /** 旧的库内相对路径 */
  from: string
  /** 新的库内相对路径 */
  to: string
}

/** 绝对路径 → 库内相对路径（`/` 分隔） */
export function toRelPath(root: string, absPath: string): string {
  return path.relative(root, absPath).replace(/\\/g, '/')
}

/**
 * 计算重命名/移动影响的库内路径映射
 *
 * @returns 不在工作区内、或目录不可读时返回 null
 */
export function planRenames(
  root: string,
  oldAbs: string,
  newAbs: string,
  isDirectory: boolean
): PathRename[] | null {
  if (!isPathWithinRoot(root, oldAbs) || !isPathWithinRoot(root, newAbs)) return null

  if (!isDirectory) {
    return [{ from: toRelPath(root, oldAbs), to: toRelPath(root, newAbs) }]
  }

  try {
    return walkVault(oldAbs).map((file) => ({
      from: toRelPath(root, path.join(oldAbs, file.rel)),
      to: toRelPath(root, path.join(newAbs, file.rel))
    }))
  } catch {
    return null
  }
}
