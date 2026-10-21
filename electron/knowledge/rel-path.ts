/**
 * 库内相对路径校验
 *
 * 渲染进程只能提交库内相对路径，绝对路径、盘符相对路径与 `..` 一律拒绝。
 * 这是知识库 IPC 的安全边界：**绝不接受渲染进程传来的绝对路径**，
 * 工作区根目录只信任主进程的授权状态。
 */

import * as path from 'node:path'
import { isPathWithinRoot } from '../workspace/workspace-authorization'

/**
 * 校验并归一化库内相对路径
 *
 * @param root 已授权的工作区绝对路径
 * @param relPath 渲染进程提交的库内相对路径（允许 `\` 分隔）
 * @returns 归一化后的 POSIX 相对路径（`/` 分隔，无 `./` 与重复分隔符）
 * @throws 输入非法或解析后越出根目录
 */
export function resolveRelPath(root: string, relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('缺少文件路径')
  }

  const normalized = relPath.replace(/\\/g, '/')
  // 绝对路径、盘符相对路径（C:a.md）、根相对路径都拒绝
  if (path.isAbsolute(relPath) || /^[a-z]:/i.test(normalized) || normalized.startsWith('/')) {
    throw new Error('只接受库内相对路径')
  }
  if (normalized.split('/').includes('..')) {
    throw new Error('路径越权')
  }

  const posix = path.posix.normalize(normalized)
  const abs = path.resolve(root, posix)
  if (!isPathWithinRoot(root, abs)) {
    throw new Error('路径越权')
  }
  return posix
}
