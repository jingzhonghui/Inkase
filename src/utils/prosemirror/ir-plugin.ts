import { Plugin, PluginKey, EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { MarkType, ResolvedPos } from 'prosemirror-model'

export const irPluginKey = new PluginKey('ir')

/**
 * 带源码标记的块级节点。
 * 只有光标/选区所在的块才展开 `#`、`>`、``` 等标记，避免整篇文档一起显示。
 */
const BLOCK_MARKER_TYPES = new Set(['heading', 'blockquote', 'code_block'])

/** 需要在 IR 模式展开源码标记的行内标记（与 schema 中的 data-mark 对应） */
const INLINE_MARKER_MARKS = new Set(['bold', 'italic', 'strikethrough', 'underline', 'code', 'link'])

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
