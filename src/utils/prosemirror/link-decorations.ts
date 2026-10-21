/**
 * `[[链接]]` 装饰区间（纯函数）
 *
 * 为 IR 与源码模式提供「哪些区间是 wiki 链接、解析状态如何」的统一答案：
 * 解析成功用正常色，`ambiguous` / `missing` 用警示色——断链必须可视化，
 * 否则库里的坏链接没人会发现（设计文档 §5.2）。
 *
 * 约束：**不涉及 ProseMirror schema**，`[[ ]]` 始终是纯文本，这里只算区间。
 */

import type { LinkResolution } from '../../../shared/knowledge/types'

/** 链接的解析状态，直接决定装饰样式 */
export type LinkDecorationKind = 'resolved' | 'ambiguous' | 'missing'

export interface LinkDecoration {
  /** 整个标记的起始偏移（`![[` 时含 `!`） */
  from: number
  /** 结束偏移（不含） */
  to: number
  kind: LinkDecorationKind
  /** 书写时的目标：已剥离别名与锚点 */
  target: string
  /** 是否为嵌入 `![[...]]` */
  embed: boolean
}

/** 由调用方注入的解析器（主进程解析结果的本地缓存） */
export type LinkResolver = (target: string) => LinkResolution

/** 围栏代码块起始/结束标记 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/**
 * 单行内的行内代码区间
 *
 * 反引号必须等长闭合；未闭合的反引号按普通文本处理。
 */
function inlineCodeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let i = 0

  while (i < line.length) {
    if (line[i] !== '`') {
      i++
      continue
    }
    let open = 0
    while (line[i + open] === '`') open++

    let cursor = i + open
    let closed = false
    while (cursor < line.length) {
      if (line[cursor] !== '`') {
        cursor++
        continue
      }
      let close = 0
      while (line[cursor + close] === '`') close++
      if (close === open) {
        ranges.push([i, cursor + open])
        i = cursor + open
        closed = true
        break
      }
      cursor += close
    }
    if (!closed) i += open
  }

  return ranges
}

function insideRanges(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end)
}

/**
 * 收集文本中全部 wiki 链接的装饰区间
 *
 * 忽略围栏代码块与行内代码中的 `[[...]]`；未闭合的 `[[` 之后不再解析。
 */
export function collectLinkDecorations(text: string, resolve: LinkResolver): LinkDecoration[] {
  const decorations: LinkDecoration[] = []
  let offset = 0
  let inFence: string | null = null

  for (const line of text.split('\n')) {
    const fenceMatch = FENCE.exec(line)
    if (inFence !== null) {
      // 闭合围栏：标记字符一致且长度不短于开启者
      if (fenceMatch !== null && fenceMatch[1][0] === inFence[0] && fenceMatch[1].length >= inFence.length) {
        inFence = null
      }
      offset += line.length + 1
      continue
    }
    if (fenceMatch !== null) {
      inFence = fenceMatch[1]
      offset += line.length + 1
      continue
    }

    const codeRanges = inlineCodeRanges(line)
    let i = 0
    while (i < line.length) {
      if (line[i] !== '[' || line[i + 1] !== '[' || insideRanges(codeRanges, i)) {
        i++
        continue
      }
      const close = line.indexOf(']]', i + 2)
      if (close === -1) break

      const embed = i > 0 && line[i - 1] === '!'
      const from = embed ? i - 1 : i
      const inner = line.slice(i + 2, close)
      const target = inner.split('|')[0].split('#')[0].trim()
      const resolution = target === '' ? { status: 'missing' as const } : resolve(target)

      decorations.push({
        from: offset + from,
        to: offset + close + 2,
        kind: resolution.status,
        target,
        embed
      })

      i = close + 2
    }

    offset += line.length + 1
  }

  return decorations
}
