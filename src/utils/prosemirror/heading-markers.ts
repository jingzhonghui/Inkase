import { Fragment, Node as ProseMirrorNode, Schema, Slice } from 'prosemirror-model'
import { Command, Plugin, PluginKey } from 'prosemirror-state'

/** 标题标记：行首 1~6 个 #，后跟一个空格。 */
export const HEADING_MARKER_RE = /^(#{1,6}) /

/** 从文本解析标题级别；无合法标记返回 null。 */
export function parseHeadingLevel(text: string): number | null {
  const m = HEADING_MARKER_RE.exec(text)
  return m ? m[1].length : null
}

/** 返回 heading 的行首标记长度（含尾部空格）；无标记返回 0。 */
export function getHeadingMarkerLength(node: ProseMirrorNode): number {
  const m = HEADING_MARKER_RE.exec(node.textContent)
  return m ? m[1].length + 1 : 0
}

/**
 * 递归为每个 heading 的内容前注入 `'#'×level + ' '` 标记文本。
 * 若内容已以该标记开头则跳过（幂等）。
 */
export function injectHeadingMarkers(doc: ProseMirrorNode, schema: Schema): ProseMirrorNode {
  if (doc.isLeaf) return doc

  let changed = false
  const children: ProseMirrorNode[] = []
  doc.forEach((child) => {
    const updated = injectHeadingMarkers(child, schema)
    if (updated !== child) changed = true
    children.push(updated)
  })

  let result = changed ? doc.copy(Fragment.fromArray(children)) : doc
  if (result.type.name === 'heading') {
    const marker = '#'.repeat(result.attrs.level as number) + ' '
    if (!result.textContent.startsWith(marker)) {
      result = result.copy(Fragment.from(schema.text(marker)).append(result.content))
    }
  }
  return result
}

/** 递归给片段中的 heading 注入标记（用于粘贴/拖入的富文本标题，避免被同步插件误降级）。 */
export function injectHeadingMarkersIntoFragment(fragment: Fragment, schema: Schema): Fragment {
  const children: ProseMirrorNode[] = []
  let changed = false
  fragment.forEach((child) => {
    const updated = injectHeadingMarkers(child, schema)
    if (updated !== child) changed = true
    children.push(updated)
  })
  return changed ? Fragment.fromArray(children) : fragment
}

/**
 * 将选区覆盖的每个文本块设为目标标题级别（1..6），level 为 null 表示正文。
 * 同步增删行首标记文本；对代码块跳过。
 */
export function applyHeadingLevel(level: number | null): Command {
  return (state, dispatch) => {
    const { schema, selection } = state
    const headingType = schema.nodes.heading
    const paragraphType = schema.nodes.paragraph

    const ranges: Array<{ from: number; to: number }> = []
    if (selection.empty) {
      const $from = selection.$from
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d)
        if (node.isTextblock && node.type.name !== 'code_block') {
          ranges.push({ from: $from.before(d), to: $from.after(d) })
          break
        }
      }
    } else {
      state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
        if (node.isTextblock && node.type.name !== 'code_block') {
          ranges.push({ from: pos, to: pos + node.nodeSize })
          return false
        }
        return true
      })
    }
    if (ranges.length === 0) return false

    if (!dispatch) return true

    let tr = state.tr
    // 从后往前处理，保证未处理块的原始位置仍有效
    for (let i = ranges.length - 1; i >= 0; i--) {
      const { from, to } = ranges[i]
      const node = state.doc.nodeAt(from)
      if (!node || !node.isTextblock) continue
      const existingLen = getHeadingMarkerLength(node)
      const desiredMarker = level === null ? '' : '#'.repeat(level) + ' '
      const delta = desiredMarker.length - existingLen
      const contentStart = from + 1
      if (existingLen > 0) {
        if (desiredMarker.length > 0) {
          tr = tr.replaceWith(contentStart, contentStart + existingLen, schema.text(desiredMarker))
        } else {
          tr = tr.delete(contentStart, contentStart + existingLen)
        }
      } else if (desiredMarker.length > 0) {
        tr = tr.insert(contentStart, schema.text(desiredMarker))
      }
      if (level === null) {
        tr = tr.setBlockType(from, to + delta, paragraphType)
      } else {
        tr = tr.setBlockType(from, to + delta, headingType, { level })
      }
    }
    dispatch(tr)
    return true
  }
}

export const headingMarkerPluginKey = new PluginKey('headingMarker')

/**
 * 依据标题文本行首的 `#` 数量同步 `attrs.level`；标记被删除时降级为段落。
 * 仅在文档发生变更时运行，且结果幂等（第二遍扫描无可改，避免无限追加事务）。
 */
export function headingMarkerPlugin(): Plugin {
  return new Plugin({
    key: headingMarkerPluginKey,
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null
      const { schema } = newState
      const headingType = schema.nodes.heading
      const paragraphType = schema.nodes.paragraph

      const fixes: Array<{ pos: number; size: number; level: number | null }> = []
      newState.doc.descendants((node, pos) => {
        if (node.type.name !== 'heading') return true
        const level = parseHeadingLevel(node.textContent)
        if (level === null) {
          fixes.push({ pos, size: node.nodeSize, level: null })
        } else if (level !== node.attrs.level) {
          fixes.push({ pos, size: node.nodeSize, level })
        }
        return false
      })
      if (fixes.length === 0) return null

      let tr = newState.tr
      for (const fix of fixes) {
        if (fix.level === null) {
          tr = tr.setBlockType(fix.pos, fix.pos + fix.size, paragraphType)
        } else {
          const node = tr.doc.nodeAt(fix.pos)
          if (!node) continue
          tr = tr.setNodeMarkup(fix.pos, headingType, { ...node.attrs, level: fix.level })
        }
      }
      return tr.setMeta('addToHistory', false)
    },
    props: {
      transformPasted(slice, view) {
        const content = injectHeadingMarkersIntoFragment(slice.content, view.state.schema)
        return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd)
      }
    }
  })
}
