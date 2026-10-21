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
import { parseWikiLinks, type WikiLinkToken } from './link-parser'
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
 * 在单份文本内改写引用
 *
 * @param map 书写时的目标文本 → 新目标文本（由调用方基于索引解析结果构造）
 * @returns 改写后的文本与改写次数；无改动时原样返回
 */
export function planRewrite(text: string, map: Map<string, string>): { text: string; changes: number } {
  if (map.size === 0 || text === '') return { text, changes: 0 }

  const tokens = parseWikiLinks(text)
  if (tokens.length === 0) return { text, changes: 0 }

  let result = ''
  let cursor = 0
  let changes = 0

  for (const token of tokens) {
    const replacement = map.get(token.target)
    if (replacement === undefined || replacement === token.target) continue

    result += text.slice(cursor, token.start) + renderWikiLink(token, replacement)
    cursor = token.end
    changes++
  }

  if (changes === 0) return { text, changes: 0 }
  result += text.slice(cursor)
  return { text: result, changes }
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
  if (map.size === 0) return plan

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
        const outcome = planRewrite(text, map)
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
