import * as fs from 'node:fs'
import { buildRelatedBullet, planRelatedLinkInsertion } from '../../shared/graph/link-insert'
import { extractLinks } from '../../shared/graph/link-extract'
import { buildBasenameIndex, encodeLinkTarget, resolveLink } from '../../shared/graph/link-resolve'
import { baseLabelOf, graphFormatForPath, normalizeGraphId } from '../../shared/graph/types'
import { cleanupTempDir, openMdx } from '../mdx/reader'
import { prepareAssetsData, saveMdx } from '../mdx/writer'
import { isCaseInsensitiveFileSystem } from './service'
import { resolveWithinRoot } from './scanner'

/**
 * 往文档末尾的 `## 相关笔记` 小节追加一条链接。
 *
 * 两条防线决定了这里能不能让人放心点：
 * - **幂等**：小节里已经有指向同一目标的条目就直接返回，重复点「链接到…」不会堆出一串重复行；
 * - **mtime 冲突检测**：读完之后文件被别人改过就放弃写入并报错，
 *   宁可让用户重试，也不能把人家刚保存的内容覆盖掉。
 *
 * 已经打开在标签页里的文件**不会**走到这里：渲染层只改缓冲区，由用户自己保存。
 * 插入位置的算法在 `shared/graph/link-insert.ts`，两条路径共用同一份。
 */

export interface AppendLinkInput {
  /** 工作区根绝对路径 */
  root: string
  /** 源文件工作区相对路径（POSIX） */
  from: string
  /** 目标文件工作区相对路径（POSIX） */
  to: string
  /** 链接文字，缺省用目标文件名去扩展名 */
  title?: string
}

export interface AppendLinkResult {
  /** 链接所在行号（1 起）；已存在时为那条已有链接的行号 */
  line: number
  /** 已存在同目标链接，未写入任何内容 */
  skipped: boolean
}

export class LinkWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LinkWriteError'
  }
}

function atomicWriteText(targetPath: string, content: string): void {
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(tempPath, content, 'utf8')
    fs.renameSync(tempPath, targetPath)
  } catch (error) {
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // 临时文件可能压根没建起来
    }
    throw error
  }
}

/** 找出已存在的同目标链接行号；没有则返回 null */
function findExistingLink(
  content: string,
  from: string,
  to: string,
  caseInsensitive: boolean
): number | null {
  const targetId = normalizeGraphId(to, caseInsensitive)
  const ctx = {
    fromId: normalizeGraphId(from, caseInsensitive),
    fromPath: from,
    indexed: new Set([targetId]),
    basenames: buildBasenameIndex([{ id: targetId, path: to }]),
    caseInsensitive
  }

  for (const link of extractLinks(content)) {
    const resolution = resolveLink(link.href, ctx)
    if (resolution.kind === 'edge' && resolution.targetId === targetId) return link.line
  }
  return null
}

export async function appendLinkToFile(input: AppendLinkInput): Promise<AppendLinkResult> {
  if (!graphFormatForPath(input.to)) throw new LinkWriteError('目标文件格式不支持建立链接')

  const sourceAbs = resolveWithinRoot(input.root, input.from)
  const targetAbs = resolveWithinRoot(input.root, input.to)
  if (!sourceAbs) throw new LinkWriteError('源文件不在工作区内')
  if (!targetAbs) throw new LinkWriteError('目标文件不在工作区内')

  let sourceStat: fs.Stats
  try {
    sourceStat = fs.statSync(sourceAbs)
  } catch {
    throw new LinkWriteError('源文件不存在')
  }
  if (!fs.existsSync(targetAbs)) throw new LinkWriteError('目标文件不存在')

  const caseInsensitive = isCaseInsensitiveFileSystem()
  const bullet = buildRelatedBullet(
    input.title ?? baseLabelOf(input.to),
    encodeLinkTarget(input.from, input.to)
  )

  // ===== .mdx：解包 → 改正文 → 重新打包 =====
  if (graphFormatForPath(input.from) === 'mdx') {
    const opened = openMdx(sourceAbs)
    if (!opened.success || !opened.data) {
      throw new LinkWriteError(opened.error || '打开源文件失败')
    }
    const { document, tempDir } = opened.data
    try {
      const existing = findExistingLink(document.content, input.from, input.to, caseInsensitive)
      if (existing !== null) return { line: existing, skipped: true }

      const plan = planRelatedLinkInsertion(document.content, bullet)
      assertUnchanged(sourceAbs, sourceStat)

      document.content = plan.content
      const assets = prepareAssetsData(tempDir, document)
      const saved = await saveMdx(sourceAbs, document, assets)
      if (!saved.success) throw new LinkWriteError(saved.error || '保存文件失败')
      return { line: plan.line, skipped: false }
    } finally {
      cleanupTempDir(tempDir)
    }
  }

  // ===== 纯文本（.md / .markdown）：原子写 =====
  if (graphFormatForPath(input.from) !== 'markdown') {
    throw new LinkWriteError('源文件格式不支持写入链接')
  }

  const content = fs.readFileSync(sourceAbs, 'utf8')
  const existing = findExistingLink(content, input.from, input.to, caseInsensitive)
  if (existing !== null) return { line: existing, skipped: true }

  const plan = planRelatedLinkInsertion(content, bullet)
  assertUnchanged(sourceAbs, sourceStat)
  atomicWriteText(sourceAbs, plan.content)
  return { line: plan.line, skipped: false }
}

/** 读取之后文件被别的程序改过就放弃，避免覆盖用户刚保存的内容 */
function assertUnchanged(absolutePath: string, snapshot: fs.Stats): void {
  let current: fs.Stats
  try {
    current = fs.statSync(absolutePath)
  } catch {
    throw new LinkWriteError('源文件已被删除')
  }
  if (current.mtimeMs !== snapshot.mtimeMs || current.size !== snapshot.size) {
    throw new LinkWriteError('文件已被其他程序修改，请重新加载后再试')
  }
}
