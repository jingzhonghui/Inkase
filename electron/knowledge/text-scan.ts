/**
 * 文本扫描底层工具
 *
 * 供链接解析（link-parser）与索引服务（index-service）共用：
 * 行偏移、行列号、围栏代码块与行内代码的豁免。
 *
 * 所有函数均为纯函数，不 import electron。
 */

/** 一行可见内容（不在围栏代码块内） */
export interface VisibleLine {
  /** 行号，1-based */
  line: number
  /** 行内容（已去掉行尾 `\r`） */
  content: string
  /** 行起始偏移 */
  start: number
}

/** 一段可见且不在行内代码中的文本 */
export interface VisibleSegment {
  /** 行号，1-based */
  line: number
  /** 段起始偏移（相对整段文本） */
  start: number
  /** 段内容 */
  text: string
}

/** 每行的起始偏移 */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 偏移 → 1-based 行号 */
export function lineOf(text: string, offset: number): number {
  let line = 1
  const limit = Math.min(offset, text.length)
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

/** 偏移 → 1-based 列号 */
export function columnOf(text: string, offset: number): number {
  let lastBreak = -1
  const limit = Math.min(offset, text.length)
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\n') lastBreak = i
  }
  return offset - lastBreak
}

/** 行内代码（反引号）占用的区间，用于豁免其中的链接/标签语法 */
export function inlineCodeRanges(line: string): Array<[number, number]> {
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

/** 偏移是否落在任一区间内 */
export function isInsideRanges(offset: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end)
}

/**
 * 按行扫描，剔除围栏代码块（``` 或 ~~~）内的整行
 *
 * 未闭合的围栏会一直延伸到文本结尾。
 */
export function scanVisibleLines(text: string): VisibleLine[] {
  const starts = lineStarts(text)
  const result: VisibleLine[] = []
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

/** 逐行切分出「非代码块、非行内代码」的片段，供标签与提及扫描使用 */
export function visibleSegments(text: string): VisibleSegment[] {
  const segments: VisibleSegment[] = []

  for (const { line, content, start } of scanVisibleLines(text)) {
    const codeRanges = inlineCodeRanges(content)
    if (codeRanges.length === 0) {
      segments.push({ line, start, text: content })
      continue
    }

    let cursor = 0
    for (const [from, to] of codeRanges) {
      if (from > cursor) {
        segments.push({ line, start: start + cursor, text: content.slice(cursor, from) })
      }
      cursor = Math.max(cursor, to)
    }
    if (cursor < content.length) {
      segments.push({ line, start: start + cursor, text: content.slice(cursor) })
    }
  }

  return segments
}
