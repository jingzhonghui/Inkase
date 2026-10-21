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

/** 计算每行的起始偏移 */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 行内代码（反引号）占用的区间，用于豁免其中的链接语法 */
function inlineCodeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      i++
      continue
    }
    let ticks = 0
    while (line[i + ticks] === '`') ticks++
    const closer = line.indexOf('`'.repeat(ticks), i + ticks)
    if (closer === -1) break // 未闭合：其后内容按普通文本处理
    ranges.push([i, closer + ticks])
    i = closer + ticks
  }
  return ranges
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

interface ScannedLine {
  /** 行号，1-based */
  line: number
  /** 行内可见内容（已去掉行尾 \r） */
  content: string
  /** 行起始偏移 */
  start: number
}

/** 按行扫描，剔除围栏代码块内的行 */
function visibleLines(text: string): ScannedLine[] {
  const starts = lineStarts(text)
  const result: ScannedLine[] = []
  let fence: string | null = null

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    const rawEnd = i + 1 < starts.length ? starts[i + 1] - 1 : text.length
    let content = text.slice(start, rawEnd)
    if (content.endsWith('\r')) content = content.slice(0, -1)

    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(content)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0]) fence = null
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      continue
    }

    result.push({ line: i + 1, content, start })
  }

  return result
}

/**
 * 抽取全部 wikilink（含嵌入），遵守代码区豁免
 *
 * 供引用重写复用：`start` / `end` 可直接用于原地替换。
 */
export function parseWikiLinks(text: string): WikiLinkToken[] {
  const tokens: WikiLinkToken[] = []

  for (const { line, content, start } of visibleLines(text)) {
    const codeRanges = inlineCodeRanges(content)
    const inCode = (index: number): boolean => codeRanges.some(([a, b]) => index >= a && index < b)

    const pattern = /!?\[\[([^\]]+?)\]\]/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      if (inCode(match.index)) continue
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

  for (const { line, content, start } of visibleLines(text)) {
    const codeRanges = inlineCodeRanges(content)
    const inCode = (index: number): boolean => codeRanges.some(([a, b]) => index >= a && index < b)

    // 允许 `[文本](路径 "标题")` 这种带标题的写法
    const pattern = /\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      if (inCode(match.index)) continue
      const href = match[2]
      if (!isRelativeTarget(href)) continue
      refs.push({
        from,
        raw: match[0],
        target: href,
        kind: 'link',
        line,
        column: match.index + 1
      })
    }
  }

  refs.sort((a, b) => a.line - b.line || a.column - b.column)
  return refs
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

function columnOf(text: string, offset: number): number {
  let lastBreak = -1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') lastBreak = i
  }
  return offset - lastBreak
}
