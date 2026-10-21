/**
 * 链接语法解析
 *
 * 从 Markdown 文本中抽取：
 * - wikilink：`[[名称]]`、`[[名称|别名]]`、`[[名称#标题]]`、`[[名称#标题|别名]]`
 * - 嵌入：`![[图片.png]]`、`![[文件.pdf#page=3]]`
 * - Markdown 相对链接：`[文本](sub/其他.md)`（外链不产出 LinkRef）
 *
 * 设计约束（见设计文档 §5.2）：
 * - **围栏代码块与行内代码中的 `[[ ]]` 不识别为链接**——否则代码示例会产生大量断链噪声；
 * - 本模块为纯函数，不 import electron。
 */

import type { LinkRef } from '../../shared/knowledge/types'
import { columnOf, inlineCodeRanges, isInsideRanges, lineOf, scanVisibleLines } from './text-scan'

/** 解析出的 wikilink 明细（含字符区间，供引用重写使用） */
export interface WikiLinkToken {
  /** 原文，含 `!` 前缀与两层方括号 */
  raw: string
  /** 原文起始偏移（相对传入的 text） */
  start: number
  /** 原文结束偏移（不含） */
  end: number
  /** 书写时的目标文本 */
  target: string
  alias?: string
  anchor?: string
  embed: boolean
}

/** 拆解 `[[ ]]` 内部：`目标#锚点|别名` */
function splitInner(inner: string): { target: string; anchor?: string; alias?: string } {
  const pipeAt = inner.indexOf('|')
  const beforeAlias = pipeAt === -1 ? inner : inner.slice(0, pipeAt)
  const alias = pipeAt === -1 ? undefined : inner.slice(pipeAt + 1).trim()

  const hashAt = beforeAlias.indexOf('#')
  const target = (hashAt === -1 ? beforeAlias : beforeAlias.slice(0, hashAt)).trim()
  const anchor = hashAt === -1 ? undefined : beforeAlias.slice(hashAt + 1).trim()

  return {
    target,
    anchor: anchor === '' ? undefined : anchor,
    alias: alias === '' || alias === undefined ? undefined : alias
  }
}

/** 是否为库内相对目标（排除外链、协议、纯锚点、绝对路径） */
function isRelativeTarget(href: string): boolean {
  if (href === '') return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false // http: mailto: file: 等
  if (href.startsWith('//') || href.startsWith('#') || href.startsWith('/')) return false
  return true
}

/**
 * 抽取全部 wikilink（含嵌入），遵守代码区豁免
 *
 * 供引用重写复用：`start` / `end` 可直接用于原地替换。
 */
export function parseWikiLinks(text: string): WikiLinkToken[] {
  const tokens: WikiLinkToken[] = []

  for (const { content, start } of scanVisibleLines(text)) {
    const codeRanges = inlineCodeRanges(content)
    const pattern = /!?\[\[([^\]]+?)\]\]/g
    let match: RegExpExecArray | null

    while ((match = pattern.exec(content)) !== null) {
      if (isInsideRanges(match.index, codeRanges)) continue
      const raw = match[0]
      const { target, anchor, alias } = splitInner(match[1])
      tokens.push({
        raw,
        start: start + match.index,
        end: start + match.index + raw.length,
        target,
        alias,
        anchor,
        embed: raw.startsWith('!')
      })
    }
  }

  return tokens
}

/** 相对 Markdown 链接的一次匹配 */
export interface MarkdownLinkMatch {
  raw: string
  href: string
  start: number
  end: number
  line: number
  column: number
}

/**
 * 迭代全部「库内相对」Markdown 链接
 *
 * 外链（`http:` 等）、纯锚点（`#x`）与绝对路径不产出。
 */
export function* iterateMarkdownLinks(text: string): Generator<MarkdownLinkMatch> {
  for (const { line, content, start } of scanVisibleLines(text)) {
    const codeRanges = inlineCodeRanges(content)
    // 允许 `[文本](路径 "标题")` 这种带标题的写法
    const pattern = /\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g
    let match: RegExpExecArray | null

    while ((match = pattern.exec(content)) !== null) {
      if (isInsideRanges(match.index, codeRanges)) continue
      const href = match[2]
      if (!isRelativeTarget(href)) continue
      yield {
        raw: match[0],
        href,
        start: start + match.index,
        end: start + match.index + match[0].length,
        line,
        column: match.index + 1
      }
    }
  }
}

/** 抽取 Markdown 链接的字符区间（供标签/提及扫描排除链接内部） */
export function parseMarkdownLinkSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const link of iterateMarkdownLinks(text)) {
    spans.push([link.start, link.end])
  }
  return spans
}

/** 抽取全部链接（wikilink + 相对 Markdown 链接），按出现顺序返回 */
export function parseLinks(text: string, from: string): LinkRef[] {
  const refs: LinkRef[] = []

  for (const token of parseWikiLinks(text)) {
    refs.push({
      from,
      raw: token.raw,
      target: token.target,
      kind: token.embed ? 'embed' : 'link',
      anchor: token.anchor,
      line: lineOf(text, token.start),
      column: columnOf(text, token.start)
    })
  }

  for (const link of iterateMarkdownLinks(text)) {
    refs.push({
      from,
      raw: link.raw,
      target: link.href,
      kind: 'link',
      line: link.line,
      column: link.column
    })
  }

  refs.sort((a, b) => a.line - b.line || a.column - b.column)
  return refs
}
