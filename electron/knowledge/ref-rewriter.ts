/**
 * 引用重写
 *
 * 文件重命名 / 移动后，把库内所有指向它的引用就地改写（见设计文档 §5.6）。
 *
 * 设计约束：
 * - **只改 `[[ ]]` 的链接目标**，别名（`|别名`）、锚点（`#标题`）、嵌入前缀（`!`）原样保留；
 * - 代码块与行内代码中的 `[[ ]]` 不参与改写（复用 link-parser 的豁免规则）；
 * - **绝不静默猜测**：改写映射由调用方基于索引的解析结果构造，因此歧义链接
 *   （`status !== 'resolved'`）不会进入映射，也就不会被误改；
 * - 除目标文本外不触碰任何其它字节。
 *
 * `.mdx` 需要在 ZIP 内读写 `content.md`，故由调用方通过 `readText` / `writeText` 注入；
 * 默认实现只处理 `.md`。
 */

import * as fs from 'fs'
import * as path from 'path'
import type { LinkRef } from '../../shared/knowledge/types'
import { iterateMarkdownLinks, parseWikiLinks, type WikiLinkToken } from './link-parser'
import { normalizeName } from './link-resolver'
import { walkVault } from './vault-walk'

/** 单个文件的改写结果 */
export interface RewriteChange {
  /** 库内相对路径 */
  path: string
  /** 改写次数 */
  count: number
}

/** 单个文件的改写失败 */
export interface RewriteError {
  path: string
  message: string
}

/** 一次引用重写的计划与结果 */
export interface RewritePlan {
  /** 有改动的文件及次数 */
  changes: RewriteChange[]
  /** 改写后的完整文本（`dryRun` 时同样返回，便于预览） */
  edits: Array<{ path: string; text: string }>
  /** 读写失败的文件 */
  errors: RewriteError[]
}

/** 引用重写选项 */
export interface RewriteOptions {
  /** 只计算不落盘 */
  dryRun?: boolean
  /** 限定处理范围（库内相对路径）；默认遍历全库 `.md` */
  only?: string[]
  /**
   * 库内路径重映射（旧路径 → 新路径）
   *
   * 提供后会重算 Markdown 相对链接；目录重命名需展开为多条记录。
   */
  pathMap?: Map<string, string>
  /** 读取文本；返回 null 表示该文件不参与改写（例如无法解包的 `.mdx`） */
  readText?: (absPath: string, relPath: string) => Promise<string | null>
  /** 写入文本 */
  writeText?: (absPath: string, relPath: string, text: string) => Promise<void>
  onProgress?: (done: number, total: number) => void
}

/** 按 token 重新渲染 wikilink，保留嵌入前缀、锚点与别名 */
function renderWikiLink(token: WikiLinkToken, target: string): string {
  const prefix = token.embed ? '!' : ''
  const anchor = token.anchor === undefined ? '' : `#${token.anchor}`
  const alias = token.alias === undefined ? '' : `|${token.alias}`
  return `${prefix}[[${target}${anchor}${alias}]]`
}

/**
 * 单份文本的改写上下文
 *
 * Markdown 相对链接按**源文件所在目录**解析，同一段 href 在不同文件里指向不同目标，
 * 因此无法用全局文本映射表达，必须带上当前文件的库内路径逐文件重算。
 */
export interface RewriteContext {
  /** 当前文件的库内相对路径 */
  from?: string
  /** 库内路径重映射（按 normalizeName 比较）：旧路径 → 新路径 */
  pathMap?: Map<string, string>
}

/**
 * 在单份文本内改写引用
 *
 * @param map 书写时的目标文本 → 新目标文本（由调用方基于索引解析结果构造）
 * @param context 逐文件上下文；提供后才能重算 Markdown 相对链接
 * @returns 改写后的文本与改写次数；无改动时原样返回
 */
export function planRewrite(
  text: string,
  map: Map<string, string>,
  context: RewriteContext = {}
): { text: string; changes: number } {
  if (text === '') return { text, changes: 0 }

  const edits: Array<{ start: number; end: number; replacement: string }> = []

  if (map.size > 0) {
    for (const token of parseWikiLinks(text)) {
      const replacement = map.get(token.target)
      if (replacement === undefined || replacement === token.target) continue
      edits.push({ start: token.start, end: token.end, replacement: renderWikiLink(token, replacement) })
    }
  }

  const { from, pathMap } = context
  if (from !== undefined && pathMap !== undefined && pathMap.size > 0) {
    for (const link of iterateMarkdownLinks(text)) {
      const next = rewriteMarkdownHref(link.href, from, pathMap)
      if (next === null || next === link.href) continue
      // 只替换 href 本身，保留 `[文本](` 与可能存在的标题
      const hrefOffset = link.raw.indexOf('](')
      if (hrefOffset === -1) continue
      const start = link.start + hrefOffset + 2
      edits.push({ start, end: start + link.href.length, replacement: next })
    }
  }

  if (edits.length === 0) return { text, changes: 0 }

  edits.sort((a, b) => a.start - b.start)
  let result = ''
  let cursor = 0
  let changes = 0

  for (const edit of edits) {
    if (edit.start < cursor) continue // 防御：区间重叠时跳过后者
    result += text.slice(cursor, edit.start) + edit.replacement
    cursor = edit.end
    changes++
  }

  if (changes === 0) return { text, changes: 0 }
  result += text.slice(cursor)
  return { text: result, changes }
}

/** 重算一条 Markdown 相对链接；无需改写时返回 null */
function rewriteMarkdownHref(href: string, from: string, pathMap: Map<string, string>): string | null {
  const hashAt = href.indexOf('#')
  const core = hashAt === -1 ? href : href.slice(0, hashAt)
  if (core === '') return null

  const fromDir = path.posix.dirname(from)
  const resolved = path.posix.normalize(path.posix.join(fromDir, core))
  const next = pathMap.get(normalizeName(resolved))
  if (next === undefined) return null

  const relative = path.posix.relative(fromDir, next)
  if (relative === '') return null
  return hashAt === -1 ? relative : `${relative}${href.slice(hashAt)}`
}

/** 取扩展名（含点）；无扩展名返回空串 */
function extensionOf(filePath: string): string {
  const match = /\.[^./\\]+$/.exec(filePath)
  return match === null ? '' : match[0]
}

/** 取最后一级路径段 */
function basenameOf(filePath: string): string {
  const at = filePath.replace(/\\/g, '/').lastIndexOf('/')
  return at === -1 ? filePath : filePath.slice(at + 1)
}

/** 去掉最后一级扩展名 */
function stripExtension(filePath: string): string {
  return filePath.replace(/\.[^./\\]+$/, '')
}

/**
 * 把一条链接的书写形态换算为重命名后的书写形态
 *
 * - 路径形态（含 `/`）：整体指向新路径，保留「写没写扩展名」的习惯
 * - 纯名称形态：与旧 basename（带或不带扩展名）一致时替换为新 basename
 * - 别名或其它形态：重命名不影响其解析，返回 null（**绝不猜测**）
 */
function rewriteTarget(
  target: string,
  ctx: { oldBase: string; newBase: string; oldExt: string; newExt: string; toRel: string }
): string | null {
  const normalized = target.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')

  if (lastSlash !== -1) {
    const written = normalized.slice(lastSlash + 1)
    if (normalizeName(stripExtension(written)) !== normalizeName(ctx.oldBase)) return null
    return extensionOf(written) === '' ? stripExtension(ctx.toRel) : ctx.toRel
  }

  const name = normalizeName(normalized)
  if (name === normalizeName(ctx.oldBase)) return ctx.newBase
  if (name === normalizeName(`${ctx.oldBase}${ctx.oldExt}`)) return `${ctx.newBase}${ctx.newExt}`
  return null
}

/**
 * 由索引生成 wikilink 改写映射
 *
 * 只有**已解析**且指向被重命名文件的引用才进入映射；歧义/断链不会误改。
 */
export function buildRenameMap(
  fromRel: string,
  toRel: string,
  outgoing: Record<string, LinkRef[]>
): Map<string, string> {
  const map = new Map<string, string>()
  const ctx = {
    oldBase: basenameOf(stripExtension(fromRel)),
    newBase: basenameOf(stripExtension(toRel)),
    oldExt: extensionOf(fromRel),
    newExt: extensionOf(toRel),
    toRel
  }

  for (const refs of Object.values(outgoing)) {
    for (const ref of refs) {
      if (ref.status !== 'resolved' || ref.to !== fromRel) continue
      const target = ref.target
      if (target === undefined || target === '') continue
      const replacement = rewriteTarget(target, ctx)
      if (replacement !== null) map.set(target, replacement)
    }
  }

  return map
}

/**
 * 由重命名清单生成路径映射，用于重算 Markdown 相对链接
 *
 * 目录重命名时调用方应把该目录下所有文件展开为多条记录。
 */
export function buildPathMap(renames: Array<{ from: string; to: string }>): Map<string, string> {
  const map = new Map<string, string>()
  for (const { from, to } of renames) {
    map.set(normalizeName(from), to)
    map.set(normalizeName(stripExtension(from)), to)
  }
  return map
}

/** 默认读取：只处理 `.md`，其余交给调用方注入 */
async function defaultReadText(absPath: string, relPath: string): Promise<string | null> {
  if (path.extname(relPath).toLowerCase() !== '.md') return null
  return fs.promises.readFile(absPath, 'utf-8')
}

/** 默认写入 */
async function defaultWriteText(absPath: string, _relPath: string, text: string): Promise<void> {
  await fs.promises.writeFile(absPath, text, 'utf-8')
}

/**
 * 遍历库内文件并改写引用
 *
 * 单个文件失败只记入 `errors` 并继续——重命名不应该因为一个坏文件而整体失败。
 */
export async function rewriteVault(
  root: string,
  map: Map<string, string>,
  options: RewriteOptions = {}
): Promise<RewritePlan> {
  const plan: RewritePlan = { changes: [], edits: [], errors: [] }
  if (map.size === 0 && (options.pathMap?.size ?? 0) === 0) return plan

  const readText = options.readText ?? defaultReadText
  const writeText = options.writeText ?? defaultWriteText

  let targets: string[]
  if (options.only !== undefined) {
    targets = [...options.only]
  } else {
    try {
      const all = walkVault(root)
      // 注入自定义读写适配器时，由适配器决定哪些文件可处理（返回 null 即跳过）；
      // 否则默认只处理可直接读写的 `.md`
      targets = (
        options.readText === undefined
          ? all.filter((file) => path.extname(file.rel).toLowerCase() === '.md')
          : all
      ).map((file) => file.rel)
    } catch (error) {
      plan.errors.push({ path: root, message: describeError(error) })
      return plan
    }
  }

  let done = 0
  for (const rel of targets) {
    const absPath = path.join(root, rel)
    try {
      const text = await readText(absPath, rel)
      if (text !== null) {
        const outcome = planRewrite(text, map, { from: rel, pathMap: options.pathMap })
        if (outcome.changes > 0) {
          plan.edits.push({ path: rel, text: outcome.text })
          plan.changes.push({ path: rel, count: outcome.changes })
          if (options.dryRun !== true) await writeText(absPath, rel, outcome.text)
        }
      }
    } catch (error) {
      plan.errors.push({ path: rel, message: describeError(error) })
    }

    done++
    options.onProgress?.(done, targets.length)
  }

  return plan
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
