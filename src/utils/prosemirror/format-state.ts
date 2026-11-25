/**
 * 从 ProseMirror 选区读出「光标处格式」。
 *
 * 两个细节决定这里不能只看 `$from.marks()`：
 * 1. **空选区**时（光标停在未标记的文字处），接着要输入的标记落在
 *    `state.storedMarks` 上而不是 `$from.marks()`。点一下「加粗」再把光标
 *    放到空段落里，按钮该保持亮着——`storedMarks` 优先。
 * 2. **非空选区**时按「整段都带这个标记」判断，否则选中一段半粗半细的文字
 *    会错误地显示为加粗。
 */
import type { EditorState } from 'prosemirror-state'
import type { MarkType, Node as ProseMirrorNode } from 'prosemirror-model'
import { EMPTY_EDITOR_FORMAT_STATE, type EditorFormatState } from '../../types/editor-format-state'

export function readFormatStateFromProseMirror(state: EditorState): EditorFormatState {
  const { selection, schema } = state
  const { $from, from, to } = selection

  const marks = state.storedMarks ?? $from.marks()
  const hasMark = (markType?: MarkType): boolean => {
    if (!markType) return false
    if (from !== to) return state.doc.rangeHasMark(from, to, markType)
    return marks.some((mark) => mark.type === markType)
  }

  let heading = 0
  let blockquote = false
  let bulletList = false
  let orderedList = false
  let codeBlock = false

  const parent = $from.parent
  if (parent.type.name === 'heading') heading = Number(parent.attrs.level) || 0
  if (parent.type.name === 'code_block') codeBlock = true

  // 引用与列表都是祖先节点（列表项里套段落），必须一路向上看
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node: ProseMirrorNode = $from.node(depth)
    switch (node.type.name) {
      case 'blockquote':
        blockquote = true
        break
      case 'bullet_list':
        bulletList = true
        break
      case 'ordered_list':
        orderedList = true
        break
      case 'code_block':
        codeBlock = true
        break
    }
  }

  return {
    ...EMPTY_EDITOR_FORMAT_STATE,
    bold: hasMark(schema.marks.bold),
    italic: hasMark(schema.marks.italic),
    strikethrough: hasMark(schema.marks.strikethrough),
    code: hasMark(schema.marks.code),
    heading,
    blockquote,
    bulletList,
    orderedList,
    codeBlock
  }
}
