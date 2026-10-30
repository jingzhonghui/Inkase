import { externalSchemeOf, stripHrefSuffix } from './link-resolve'
import type { RawLink } from './types'

/**
 * 从 Markdown 正文抽取文档间链接。
 *
 * 纯函数、逐行对齐设计文档 §5.3：先按「同长度空白替换」剥离代码块 / 行内代码 /
 * HTML 注释 / 图片，再在剥离后的副本上扫描。用同长度替换而不是删除，
 * 是为了让行号与列偏移完全不变——断链清单里的行号要能直接跳转。
 */

export const DEFAULT_MAX_LINKS_PER_FILE = 2000

export interface ExtractLinksResult {
  links: RawLink[]
  /** 是否因单文件链接数上限被截断 */
  truncated: boolean
}

/** 与源文本等长的空白遮盖：非换行字符一律换成空格 */
function maskRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end && i < chars.length; i++) {
    if (chars[i] !== '\n') chars[i] = ' '
  }
}

interface LineSpan {
  /** 行首偏移 */
  start: number
  /** 行尾偏移（不含换行符） */
  end: number
}

function splitLines(text: string): LineSpan[] {
  const spans: LineSpan[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      spans.push({ start, end: i })
      start = i + 1
    }
  }
  spans.push({ start, end: text.length })
  return spans
}

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/

/**
 * 尖括号自动链接可接受的形式（对齐 CommonMark 的 autolink）。
 *
 * 只有绝对 URI 与邮箱会让 markdown-it 渲染出可点击的 `<a>`；`<u>`、`<br>`、
 * `<b.md>`、`<T>` 要么是 HTML 标签、要么只是普通文本，既点不开也不该成边。
 * 早期实现只要求「非空且无空白」，把 Inkase 自己序列化出来的下划线
 * `<u>…</u>` 也当成了链接目标，图谱里因此凭空多出断链。
 */
const AUTOLINK_URI_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/
const AUTOLINK_EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/

/** 剥离围栏代码块（含未闭合的情况：一直吞到文末） */
function maskFencedCode(text: string, chars: string[], lines: LineSpan[]): void {
  let fenceChar: string | null = null
  let fenceLength = 0

  for (const line of lines) {
    const content = text.slice(line.start, line.end)

    if (fenceChar === null) {
      const match = FENCE_OPEN_RE.exec(content)
      if (match) {
        const run = match[1]
        fenceChar = run[0]
        fenceLength = run.length
        maskRange(chars, line.start, line.end)
      }
      continue
    }

    maskRange(chars, line.start, line.end)
    // 用字符串拼接而不是模板字符串：围栏字符本身可能就是反引号
    const marker = fenceChar === '`' ? '`' : '~'
    const closing = new RegExp('^[ \\t]{0,3}' + marker + '{' + fenceLength + ',}[ \\t]*$')
    if (closing.test(content)) {
      fenceChar = null
      fenceLength = 0
    }
  }
}

/** 剥离 HTML 注释 */
function maskHtmlComments(text: string, chars: string[]): void {
  let from = 0
  for (;;) {
    const start = text.indexOf('<!--', from)
    if (start === -1) return
    const close = text.indexOf('-->', start + 4)
    const end = close === -1 ? text.length : close + 3
    maskRange(chars, start, end)
    from = end
  }
}

/**
 * 剥离行内代码。
 *
 * 按 CommonMark：结束串必须与开启串长度相同。找不到同长度结束串时
 * 只遮掉那串反引号本身，避免「一个没闭合的反引号吞掉后面整篇文章」。
 */
function maskInlineCode(text: string, chars: string[]): void {
  let i = 0
  while (i < text.length) {
    if (text[i] !== '`') {
      i++
      continue
    }
    let runLength = 0
    while (i + runLength < text.length && text[i + runLength] === '`') runLength++

    let cursor = i + runLength
    let closed = -1
    while (cursor < text.length) {
      if (text[cursor] !== '`') {
        cursor++
        continue
      }
      let candidate = 0
      while (cursor + candidate < text.length && text[cursor + candidate] === '`') candidate++
      if (candidate === runLength) {
        closed = cursor
        break
      }
      cursor += candidate
    }

    if (closed === -1) {
      maskRange(chars, i, i + runLength)
      i += runLength
    } else {
      maskRange(chars, i, closed + runLength)
      i = closed + runLength
    }
  }
}

/** 从 `start` 处的开括号找到配对的闭括号（跳过转义、支持嵌套） */
function findClosing(text: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 剥离图片 `![alt](src)`。
 *
 * 图片是资源不是文档，而且 `src` 常是 `assets/images/...`；
 * 不先剥掉，`![a](b)` 会被后面的链接扫描当成 `[a](b)` 收进来。
 */
function maskImages(text: string, chars: string[]): void {
  let from = 0
  for (;;) {
    const bang = text.indexOf('![', from)
    if (bang === -1) return
    const closeBracket = findClosing(text, bang + 1, '[', ']')
    if (closeBracket === -1) {
      from = bang + 2
      continue
    }
    if (text[closeBracket + 1] !== '(') {
      from = closeBracket + 1
      continue
    }
    const closeParen = findClosing(text, closeBracket + 1, '(', ')')
    if (closeParen === -1) {
      from = closeBracket + 2
      continue
    }
    maskRange(chars, bang, closeParen + 1)
    from = closeParen + 1
  }
}

/** 解析 `[text](...)` 括号内部分的目的地，跳过可选的 `"title"` */
function parseDestination(inner: string): string | null {
  const text = inner.trim()
  if (!text) return null

  if (text.startsWith('<')) {
    const close = text.indexOf('>')
    if (close === -1) return null
    const target = text.slice(1, close).trim()
    return target || null
  }

  let depth = 0
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      out += text[i + 1]
      i++
      continue
    }
    if (ch === '(') {
      depth++
      out += ch
      continue
    }
    if (ch === ')') {
      if (depth === 0) break
      depth--
      out += ch
      continue
    }
    if (depth === 0 && /\s/.test(ch)) break
    out += ch
  }

  const target = out.trim()
  return target || null
}

const REF_DEFINITION_RE = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/

interface Candidate {
  href: string
  index: number
}

/** 扫描三种写法：行内链接、尖括号自动链接、引用定义 */
function scanCandidates(masked: string): Candidate[] {
  const candidates: Candidate[] = []

  // 行内链接
  let i = 0
  while (i < masked.length) {
    if (masked[i] !== '[') {
      i++
      continue
    }
    const closeBracket = findClosing(masked, i, '[', ']')
    if (closeBracket === -1) {
      // 后面再没有 `]` 了，继续扫也不会有结果
      break
    }
    if (masked[closeBracket + 1] !== '(') {
      i++
      continue
    }
    const closeParen = findClosing(masked, closeBracket + 1, '(', ')')
    if (closeParen === -1) {
      i = closeBracket + 1
      continue
    }
    const href = parseDestination(masked.slice(closeBracket + 2, closeParen))
    if (href) candidates.push({ href, index: i })
    i = closeParen + 1
  }

  // 尖括号自动链接：只认 CommonMark 的 autolink 语法（绝对 URI / 邮箱）。
  //
  // markdown-it 只会把这两类渲染成可点击的 `<a>`；`<u>`、`<br>`、`<b.md>`、`<T>`
  // 要么是 HTML 标签、要么只是普通文本，收进图谱就会造出「图上有边、点不开」
  // 的假边与假断链（Inkase 自己的下划线就是 `<u>…</u>`）。
  i = 0
  while (i < masked.length) {
    if (masked[i] !== '<') {
      i++
      continue
    }
    const close = masked.indexOf('>', i + 1)
    if (close === -1) break
    const inner = masked.slice(i + 1, close).trim()
    if (AUTOLINK_URI_RE.test(inner)) {
      candidates.push({ href: inner, index: i })
    } else if (AUTOLINK_EMAIL_RE.test(inner)) {
      // 邮箱统一拼成 `mailto:`，交给 externalSchemeOf 当外链丢掉
      candidates.push({ href: `mailto:${inner}`, index: i })
    }
    i = close + 1
  }

  // 引用定义：行首 `[id]: href`
  for (const line of splitLines(masked)) {
    const content = masked.slice(line.start, line.end)
    const match = REF_DEFINITION_RE.exec(content)
    if (!match) continue
    const href = (match[1] ?? match[2] ?? '').trim()
    if (href) candidates.push({ href, index: line.start })
  }

  candidates.sort((a, b) => a.index - b.index)
  return candidates
}

/** 是否为「不可能是文档链接」的目标（外链 / 纯锚点），抽取阶段就丢掉 */
function isObviouslyNonDocument(href: string): boolean {
  if (externalSchemeOf(href) !== null) return true
  const { path, fragmentOnly } = stripHrefSuffix(href)
  return fragmentOnly || path.trim().length === 0
}

function offsetToLine(lineStarts: readonly number[], index: number): number {
  let low = 0
  let high = lineStarts.length - 1
  let answer = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (lineStarts[mid] <= index) {
      answer = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return answer + 1
}

export function extractLinksDetailed(
  markdown: string,
  maxLinks: number = DEFAULT_MAX_LINKS_PER_FILE
): ExtractLinksResult {
  if (!markdown) return { links: [], truncated: false }

  const chars = markdown.split('')
  const masked = (() => {
    const lines = splitLines(markdown)
    maskFencedCode(markdown, chars, lines)
    maskHtmlComments(markdown, chars)
    maskInlineCode(markdown, chars)
    maskImages(markdown, chars)
    return chars.join('')
  })()

  const lineStarts = splitLines(markdown).map((line) => line.start)
  const links: RawLink[] = []
  let truncated = false

  for (const candidate of scanCandidates(masked)) {
    if (isObviouslyNonDocument(candidate.href)) continue
    if (links.length >= maxLinks) {
      truncated = true
      break
    }
    links.push({ href: candidate.href, line: offsetToLine(lineStarts, candidate.index) })
  }

  return { links, truncated }
}

/** 只要链接列表时的便捷入口 */
export function extractLinks(
  markdown: string,
  maxLinks: number = DEFAULT_MAX_LINKS_PER_FILE
): RawLink[] {
  return extractLinksDetailed(markdown, maxLinks).links
}
