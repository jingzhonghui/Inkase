/**
 * 从 CodeMirror 选区读出「光标处格式」，供编辑工具栏高亮。
 *
 * 用语法树而不是正则：`@codemirror/lang-markdown` 已经解析出
 * `ATXHeading2` / `StrongEmphasis` / `FencedCode` 这些节点，沿祖先链往上走
 * 一遍就能得到「我现在在一级标题里、里面还有加粗」这种事实。
 * 正则得逐字符数 `**` 的奇偶性，遇到 `***粗斜体***`、行内代码里的星号、
 * 跨行的标记全都会误判。语法树还顺带解决了「光标是否在围栏代码块内」——
 * 那个用正则得从文档开头数围栏，文档一大就是 O(n)。
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { EMPTY_EDITOR_FORMAT_STATE, type EditorFormatState } from '../types/editor-format-state'

/** ATX 标题 `#`–`######` 与 Setext 标题（`===` / `---` 下划线式，只有 1–2 级） */
const HEADING_NODE = /^(?:ATX|Setext)Heading([1-6])$/

/** 围栏代码块与缩进代码块：两者都算「在代码块里」 */
const CODE_BLOCK_NODES = new Set(['FencedCode', 'CodeBlock'])

export function readFormatStateFromCodeMirror(state: EditorState): EditorFormatState {
  const result: EditorFormatState = { ...EMPTY_EDITOR_FORMAT_STATE }
  const head = state.selection.main.head
  const node = syntaxTree(state).resolveInner(head, -1)

  // `typeof node` 省掉对 `@lezer/common` 的直接依赖：那边只为了一个类型名
  let current: typeof node | null = node
  while (current) {
    const heading = HEADING_NODE.exec(current.name)
    if (heading) {
      result.heading = Number(heading[1])
    } else if (CODE_BLOCK_NODES.has(current.name)) {
      result.codeBlock = true
    } else {
      switch (current.name) {
        case 'Blockquote':
          result.blockquote = true
          break
        case 'BulletList':
          result.bulletList = true
          break
        case 'OrderedList':
          result.orderedList = true
          break
        case 'StrongEmphasis':
          result.bold = true
          break
        case 'Emphasis':
          result.italic = true
          break
        case 'Strikethrough':
          result.strikethrough = true
          break
        case 'InlineCode':
          result.code = true
          break
      }
    }
    current = current.parent
  }

  return result
}
