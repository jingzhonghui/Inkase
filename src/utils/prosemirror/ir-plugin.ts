import { Plugin, PluginKey, EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { MarkType, Node as ProseMirrorNode, ResolvedPos } from 'prosemirror-model'

export const irPluginKey = new PluginKey('ir')

/**
 * 带源码标记的块级节点。
 * 只有光标/选区所在的块才展开 `#`、`>`、``` 等标记，避免整篇文档一起显示。
 */
const BLOCK_MARKER_TYPES = new Set(['heading', 'blockquote', 'code_block'])

/** 需要在 IR 模式展开源码标记的行内标记（与 schema 中的 data-mark 对应） */
const INLINE_MARKER_MARKS = new Set(['bold', 'italic', 'strikethrough', 'underline', 'code'])

/**
 * IR 模式插件：根据当前选区，仅对选区所在的块级节点与行内标记生成装饰，
 * 使源码标记「只在光标附近展开」。装饰集在每次 state 更新时自动重算。
 */
export function createIRPlugin(): Plugin {
  return new Plugin({
    key: irPluginKey,
    props: {
      decorations(state: EditorState) {
        const decorations: Decoration[] = []
        collectBlockDecorations(state, decorations)
        collectMarkDecorations(state, decorations)
        collectLinkDecorations(state, decorations)
        return decorations.length
          ? DecorationSet.create(state.doc, decorations)
          : DecorationSet.empty
      }
    }
  })
}

/** 为选区所在的 heading/blockquote/code_block 添加块级标记装饰 */
function collectBlockDecorations(state: EditorState, decorations: Decoration[]): void {
  const { from, to, empty } = state.selection

  if (empty) {
    const $from = state.doc.resolve(from)
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth)
      if (BLOCK_MARKER_TYPES.has(node.type.name)) {
        const start = $from.before(depth)
        decorations.push(
          Decoration.node(start, start + node.nodeSize, { class: 'ir-active-block' })
        )
        break
      }
    }
    return
  }

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (BLOCK_MARKER_TYPES.has(node.type.name)) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { class: 'ir-active-block' })
      )
      return false
    }
    return true
  })
}

/** 为选区相邻/覆盖的行内标记添加装饰（仅限需要展开标记的 mark 类型） */
function collectMarkDecorations(state: EditorState, decorations: Decoration[]): void {
  const { from, to, empty } = state.selection
  const seen = new Set<string>()

  const addAt = (pos: number): void => {
    if (pos < 0 || pos > state.doc.content.size) return
    const $pos = state.doc.resolve(pos)
    if (!$pos.parent.isTextblock) return

    for (const mark of $pos.marks()) {
      if (!INLINE_MARKER_MARKS.has(mark.type.name)) continue
      const range = getMarkRange($pos, mark.type)
      if (!range) continue
      const key = `${range.from}:${range.to}:${mark.type.name}`
      if (seen.has(key)) continue
      seen.add(key)
      decorations.push(
        Decoration.inline(range.from, range.to, { class: 'ir-active-mark' })
      )
    }
  }

  if (empty) {
    addAt(from)
    addAt(from - 1)
    addAt(from + 1)
    return
  }

  addAt(from)
  addAt(to)
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) addAt(pos + 1)
    return true
  })
}

/**
 * 链接字面语法 `[文字](url)`。链接在文档中以字面文本存储，本插件按选区
 * 决定「展开显示原文」还是「折叠只显示文字」，从而让光标能在链接内部
 * 任意位置移动、逐字编辑（含 URL）。\uFFFC 为非文本内联节点占位符，需排除。
 */
const LINK_PATTERN = /\[([^\]\n\uFFFC]*)\]\(([^()\n\uFFFC]+)(?:\s+"[^"]*")?\)/g
/** 裸 URL（http/https/www），始终按链接样式渲染（无折叠语法）。
 * 排除括号/方括号等，避免匹配跨越 `[...](...)` 链接语法。 */
const BARE_URL_PATTERN = /(?:\bhttps?:\/\/|\bwww\.)[^\s<>"'`()[\]{}）】\uFFFC]+/g

/**
 * 收集文本块内链接（含裸 URL）的装饰：
 * - 光标（或选区）落在某个链接区间内 → 该链接展开：`[`、`](url)` 以浅色显示
 * - 否则折叠：`[`、`](url)` 用 display:none 隐藏，只显示链接文字
 * - 链接文字与裸 URL 始终套用链接样式
 */
function collectLinkDecorations(state: EditorState, decorations: Decoration[]): void {
  const { from: selFrom, to: selTo } = state.selection

  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true

    const { text, posMap } = flattenInline(node, pos + 1)
    if (!text) return false

    const linkRanges: Array<[number, number]> = []
    LINK_PATTERN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LINK_PATTERN.exec(text)) !== null) {
      const s = m.index
      const e = s + m[0].length
      const openFrom = posMap[s]
      const textFrom = posMap[s + 1]
      const textTo = posMap[s + 1 + m[1].length]
      const suffixFrom = textTo
      const suffixTo = posMap[e]
      linkRanges.push([openFrom, suffixTo])

      const active = selFrom < suffixTo && selTo > openFrom
      const syntaxClass = active ? 'md-link-mark' : 'md-link-hidden'
      decorations.push(Decoration.inline(openFrom, textFrom, { class: syntaxClass }))
      if (suffixTo > suffixFrom) {
        decorations.push(Decoration.inline(suffixFrom, suffixTo, { class: syntaxClass }))
      }
      if (textTo > textFrom) {
        decorations.push(Decoration.inline(textFrom, textTo, { class: 'md-link-text' }))
      }
    }

    BARE_URL_PATTERN.lastIndex = 0
    while ((m = BARE_URL_PATTERN.exec(text)) !== null) {
      const uFrom = posMap[m.index]
      const uTo = posMap[m.index + m[0].length]
      if (linkRanges.some(([a, b]) => uFrom >= a && uTo <= b)) continue
      decorations.push(Decoration.inline(uFrom, uTo, { class: 'md-link-text' }))
    }

    return false
  })
}

/**
 * 把一个文本块的 inline 内容摊平成字符串，并记录每个字符对应的文档位置。
 * posMap 长度为 text.length + 1，末位为块内容末尾的位置。
 */
function flattenInline(
  block: ProseMirrorNode,
  blockStart: number
): { text: string; posMap: number[] } {
  const chars: string[] = []
  const posMap: number[] = []
  let p = blockStart
  block.forEach((child) => {
    if (child.isText) {
      const t = child.text || ''
      for (let i = 0; i < t.length; i++) {
        chars.push(t[i])
        posMap.push(p + i)
      }
      p += t.length
    } else {
      // 非文本内联节点（图片/公式/硬换行）用占位符打断链接匹配
      chars.push('\uFFFC')
      posMap.push(p)
      p += child.nodeSize
    }
  })
  posMap.push(p)
  return { text: chars.join(''), posMap }
}

/** 链接信息（用于 Ctrl+点击打开、编辑等）。 */
export interface LinkInfo {
  href: string
  text: string
  from: number
  to: number
}

/**
 * 查找文档位置 pos 所在的链接（`[文字](url)` 或裸 URL）。
 * 命中返回链接信息，否则返回 null。
 */
export function findLinkAt(state: EditorState, pos: number): LinkInfo | null {
  const $pos = state.doc.resolve(pos)
  let block: ProseMirrorNode | null = null
  let depth = $pos.depth
  while (depth > 0) {
    const n = $pos.node(depth)
    if (n.isTextblock) {
      block = n
      break
    }
    depth--
  }
  if (!block) return null

  const { text, posMap } = flattenInline(block, $pos.before(depth) + 1)

  LINK_PATTERN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINK_PATTERN.exec(text)) !== null) {
    const from = posMap[m.index]
    const to = posMap[m.index + m[0].length]
    if (pos >= from && pos <= to) {
      return { href: m[2], text: m[1], from, to }
    }
  }

  BARE_URL_PATTERN.lastIndex = 0
  while ((m = BARE_URL_PATTERN.exec(text)) !== null) {
    const from = posMap[m.index]
    const to = posMap[m.index + m[0].length]
    if (pos >= from && pos <= to) {
      return { href: m[0], text: m[0], from, to }
    }
  }

  return null
}

/**
 * 求某个 mark 在当前文本块内的完整区间 [from, to)。
 * 与 tiptap 的 getMarkRange 等价：同一 mark 跨多个文本节点时也能得到完整范围。
 */
function getMarkRange($pos: ResolvedPos, type: MarkType): { from: number; to: number } | null {
  const start = $pos.parent.childAfter($pos.parentOffset)
  if (!start.node) return null

  const mark = start.node.marks.find((m) => m.type === type)
  if (!mark) return null

  let startIndex = $pos.index()
  let startPos = $pos.start() + start.offset
  let endIndex = startIndex + 1
  let endPos = startPos + start.node.nodeSize

  while (startIndex > 0 && mark.isInSet($pos.parent.child(startIndex - 1).marks)) {
    startIndex--
    startPos -= $pos.parent.child(startIndex).nodeSize
  }
  while (endIndex < $pos.parent.childCount && mark.isInSet($pos.parent.child(endIndex).marks)) {
    endPos += $pos.parent.child(endIndex).nodeSize
    endIndex++
  }

  return endPos > startPos ? { from: startPos, to: endPos } : null
}
