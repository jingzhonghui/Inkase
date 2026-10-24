/**
 * AI 批量写入的工作区文件 I/O。
 *
 * 与只读工具共用同一套边界：
 * - 只接受库内相对路径（`resolveRelPath`）；
 * - 对已存在的文件校验 `realpath` 仍在授权根内；
 * - 对不存在的文件校验最近的已存在祖先目录仍在根内；
 * - 拒绝符号链接。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveRelPath } from '../../knowledge/rel-path'
import { readVaultText, writeVaultText } from '../../knowledge/vault-text'
import { isPathWithinRoot } from '../../workspace/workspace-authorization'

export interface VaultTarget {
  rel: string
  abs: string
  exists: boolean
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 找到最近的已存在目录，并确认它不是符号链接且位于根内 */
async function resolveExistingParent(root: string, abs: string): Promise<string> {
  let current = path.dirname(abs)
  for (;;) {
    try {
      const info = await fs.promises.lstat(current)
      if (info.isSymbolicLink()) throw new Error('不允许通过符号链接写入')
      if (!info.isDirectory()) throw new Error('目标路径的父级不是目录')
      const real = await fs.promises.realpath(current)
      if (!isPathWithinRoot(root, real)) throw new Error('路径越权')
      return real
    } catch (error) {
      if (!isEnoent(error)) throw error
      const parent = path.dirname(current)
      if (parent === current) throw new Error('路径越权')
      current = parent
    }
  }
}

/**
 * 解析一个库内目标。
 *
 * `allowMissing` 为 true 时允许文件尚不存在（用于新建 MOC），
 * 但仍会校验父目录边界；为 false 时缺失会抛出。
 */
export async function resolveVaultTarget(
  root: string,
  inputPath: string,
  allowMissing = false
): Promise<VaultTarget> {
  const rel = resolveRelPath(root, inputPath)
  const abs = path.resolve(root, rel)

  let info: fs.Stats | null = null
  try {
    info = await fs.promises.lstat(abs)
  } catch (error) {
    if (!isEnoent(error)) throw new Error(`无法访问文件：${rel}`)
  }

  if (info !== null) {
    if (info.isSymbolicLink()) throw new Error('不允许读取或写入符号链接')
    if (!info.isFile()) throw new Error('目标不是文件')
    const real = await fs.promises.realpath(abs)
    if (!isPathWithinRoot(root, real)) throw new Error('路径越权')
    return { rel, abs: real, exists: true }
  }

  if (!allowMissing) throw new Error(`文件不存在：${rel}`)
  await resolveExistingParent(root, abs)
  return { rel, abs, exists: false }
}

/** 读取可编辑的 Markdown / MDX；文件不存在返回 null，其它类型抛错 */
export async function readVaultMarkdown(root: string, relPath: string): Promise<string | null> {
  const target = await resolveVaultTarget(root, relPath, true)
  if (!target.exists) return null
  const text = await readVaultText(target.abs, target.rel)
  if (text === null) throw new Error(`只支持编辑 Markdown / MDX：${target.rel}`)
  return text
}

/** 写回已存在的 Markdown / MDX */
export async function writeVaultMarkdown(root: string, relPath: string, text: string): Promise<void> {
  const target = await resolveVaultTarget(root, relPath, false)
  await writeVaultText(target.abs, target.rel, text)
}

/** 新建文件（父目录不存在时创建），原子写回 */
export async function createVaultMarkdown(root: string, relPath: string, text: string): Promise<void> {
  const target = await resolveVaultTarget(root, relPath, true)
  if (target.exists) throw new Error(`文件已存在：${target.rel}`)
  if (path.extname(target.rel).toLowerCase() !== '.md') {
    throw new Error('新建索引页只支持 .md 文件')
  }

  const directory = path.dirname(target.abs)
  await fs.promises.mkdir(directory, { recursive: true })
  const real = await fs.promises.realpath(directory)
  if (!isPathWithinRoot(root, real)) throw new Error('路径越权')

  const temporary = `${target.abs}.tmp`
  try {
    await fs.promises.writeFile(temporary, text, 'utf8')
    await fs.promises.rename(temporary, target.abs)
  } finally {
    await fs.promises.rm(temporary, { force: true })
  }
}

/** 删除一个刚由本工具创建的文件（失败补偿用） */
export async function removeCreatedVaultFile(root: string, relPath: string): Promise<void> {
  const target = await resolveVaultTarget(root, relPath, true)
  if (!target.exists) return
  await fs.promises.unlink(target.abs)
}
