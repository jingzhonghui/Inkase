/**
 * IR 模式的滚动锚点：把 ProseMirror 文档位置映射到 Markdown 行号。
 *
 * IR 与源码/分屏的布局高度完全不同，比例换算会随换行宽度漂移，
 * 所以阅读位置以「Markdown 行号」为准：保存时把视口顶部落到某个块的行号，
 * 恢复时再按行号找回同一块。
 *
 * 做法依赖一个性质：把每个顶层块单独序列化后，结果能在整篇序列化文本里按顺序找到
 * （顶层块没有缩进，序列化结果一致）。任何一步对不上就返回 null，让调用方退回比例。
 */
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { markdownSchema } from './schema'
import { serializeMarkdown } from './markdown'
import { lineFromOffset } from '../editor-scroll'

export interface ScrollAnchorBlock {
  /** 块在 ProseMirror 文档中的起始位置 */
  pos: number
  /** 块首行的 Markdown 行号（1 基） */
  line: number
  /** 块末行之后的行号（1 基），用于判断行号落在哪个块 */
  endLine: number
}

export interface ScrollAnchorTable {
  /** 整篇 Markdown（序列化结果） */
  content: string
  blocks: ScrollAnchorBlock[]
}

/** 为文档建立「块 ↔ 行号」表；序列化对不上时返回 null。 */
export function buildScrollAnchorTable(doc: ProseMirrorNode): ScrollAnchorTable | null {
  let content: string
  try {
    content = serializeMarkdown(doc)
  } catch {
    return null
  }

  const blocks: ScrollAnchorBlock[] = []
  let cursor = 0
  let failed = false

  doc.forEach((node, pos) => {
    if (failed) return false
    let single: string
    try {
      single = serializeMarkdown(markdownSchema.node('doc', null, node))
    } catch {
      failed = true
      return false
    }
    const offset = content.indexOf(single, cursor)
    if (offset < 0) {
      failed = true
      return false
    }
    const line = lineFromOffset(content, offset)
    blocks.push({
      pos,
      line,
      endLine: line + Math.max(1, single.split('\n').length)
    })
    cursor = offset + single.length
    return true
  })

  if (failed || blocks.length === 0) return null
  return { content, blocks }
}

/** 文档位置 → 所在块（取起始位置不超过 pos 的最后一个块）。 */
export function blockAtPos(table: ScrollAnchorTable, pos: number): ScrollAnchorBlock | null {
  let found: ScrollAnchorBlock | null = null
  for (const block of table.blocks) {
    if (block.pos > pos) break
    found = block
  }
  return found
}

/** 行号 → 所在块（取起始行不超过 line 的最后一个块）。 */
export function blockAtLine(table: ScrollAnchorTable, line: number): ScrollAnchorBlock | null {
  let found: ScrollAnchorBlock | null = null
  for (const block of table.blocks) {
    if (block.line > line) break
    found = block
  }
  return found
}
