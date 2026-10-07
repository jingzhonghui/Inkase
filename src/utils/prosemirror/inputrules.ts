/**
 * ProseMirror 输入规则（Markdown 语法自动转换）
 * 类似 Typora 的实时 Markdown 编辑体验
 */
import { Node as ProseMirrorNode, NodeType, Schema } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import {
  InputRule,
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule
} from 'prosemirror-inputrules'

/**
 * 创建标题输入规则 (# 标题)
 */
function headingRule(nodeType: NodeType, maxLevel: number): InputRule {
  return textblockTypeInputRule(
    new RegExp('^(#{1,' + maxLevel + '})\\s$'),
    nodeType,
    (match) => ({ level: match[1].length })
  )
}

/**
 * 创建代码块输入规则 (```)
 */
function codeBlockRule(nodeType: NodeType): InputRule {
  return textblockTypeInputRule(
    /^```([\w+#.-]+)?\s$/,
    nodeType,
    (match) => ({ language: (match[1] || '').toLowerCase() })
  )
}

/**
 * 创建引用块输入规则 (>)
 */
function blockquoteRule(nodeType: NodeType): InputRule {
  return wrappingInputRule(/^>\s$/, nodeType)
}

/**
 * 创建有序列表输入规则 (1.)
 */
function orderedListRule(nodeType: NodeType): InputRule {
  return wrappingInputRule(
    /^(\d+)\.\s$/,
    nodeType,
    (match) => ({ order: +match[1] }),
    (match, node) => node.childCount + node.attrs.order === +match[1]
  )
}

/**
 * 创建无序列表输入规则 (- 或 *)
 */
function bulletListRule(nodeType: NodeType): InputRule {
  return wrappingInputRule(/^\s*([-+*])\s$/, nodeType)
}

/**
 * 创建任务列表输入规则。
 *
 * 因为输入 `- ` 时 `bulletListRule` 会先把它转成普通无序列表，无法再匹配 `- [ ] `，
 * 所以这里改为匹配「列表项段落开头输入的 `[ ] ` / `[x] `」，并把所在的整个无序列表
 * 转换为任务列表（任务列表要求所有项都是 task_item）。
 */
function taskListRule(listType: NodeType, itemType: NodeType): InputRule {
  return new InputRule(
    /^\[( |x|X)\]\s$/,
    (state: EditorState, match: RegExpMatchArray, start: number, end: number) => {
      const { $from } = state.selection
      let listDepth = -1
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type === listType) {
          listDepth = d
          break
        }
      }
      if (listDepth === -1) return null

      const item = $from.node(listDepth + 1)
      const paragraph = $from.node(listDepth + 2)
      // 标记必须位于列表项首个段落的开头，避免误把正文中的 [ ] 转成任务项
      if (paragraph !== $from.parent || item.firstChild !== paragraph) return null

      const listStart = $from.before(listDepth)
      const currentIndex = $from.index(listDepth)
      const checked = match[1].toLowerCase() === 'x'

      const tr = state.tr.delete(start, end)
      const list = tr.doc.nodeAt(listStart)
      if (!list || list.type !== listType) return null

      const items: ProseMirrorNode[] = []
      list.forEach((child, _offset, index) => {
        items.push(itemType.create({ checked: index === currentIndex ? checked : false }, child.content))
      })
      const newList = listType.create(null, items)
      tr.replaceWith(listStart, listStart + list.nodeSize, newList)

      let pos = listStart + 1
      for (let i = 0; i < currentIndex; i++) pos += items[i].nodeSize
      pos += 2 // task_item_open + paragraph_open
      tr.setSelection(TextSelection.create(tr.doc, pos))
      return tr
    }
  )
}

/**
 * 创建水平分割线输入规则 (--- 或 *** 或 ___)
 */
function horizontalRuleRule(nodeType: NodeType): InputRule {
  return new InputRule(
    /^(?:---|___|\*\*\*)$/,
    (state, _match, start, end) => {
      const { tr } = state
      tr.replaceWith(start, end, nodeType.create())
      return tr
    }
  )
}

/**
 * 创建行内代码输入规则 (`code`)
 */
function inlineCodeRule(markType: any): InputRule {
  return new InputRule(
    /`([^`]+)`$/,
    (state, match, start, end) => {
      const { tr } = state
      const text = match[1]
      const from = start
      const to = end

      // 删除匹配文本并插入带标记的文本
      tr.delete(from, to)
      const mark = markType.create()
      tr.insertText(text, from)
      tr.addMark(from, from + text.length, mark)
      return tr
    }
  )
}

/**
 * 创建粗体输入规则 (**text**)
 */
function boldRule(markType: any): InputRule {
  return new InputRule(
    /\*\*([^*]+)\*\*$/,
    (state, match, start, end) => {
      const { tr } = state
      const text = match[1]

      tr.delete(start, end)
      const mark = markType.create()
      tr.insertText(text, start)
      tr.addMark(start, start + text.length, mark)
      return tr
    }
  )
}

/**
 * 创建斜体输入规则 (*text*)
 */
function italicRule(markType: any): InputRule {
  return new InputRule(
    /(?<!\*)\*([^*]+)\*(?!\*)$/,
    (state, match, start, end) => {
      const { tr } = state
      const text = match[1]

      tr.delete(start, end)
      const mark = markType.create()
      tr.insertText(text, start)
      tr.addMark(start, start + text.length, mark)
      return tr
    }
  )
}

/**
 * 创建删除线输入规则 (~~text~~)
 */
function strikethroughRule(markType: any): InputRule {
  return new InputRule(
    /~~([^~]+)~~$/,
    (state, match, start, end) => {
      const { tr } = state
      const text = match[1]

      tr.delete(start, end)
      const mark = markType.create()
      tr.insertText(text, start)
      tr.addMark(start, start + text.length, mark)
      return tr
    }
  )
}

/**
 * 创建下划线输入规则 (<u>text</u>)
 */
function underlineRule(markType: any): InputRule {
  return new InputRule(
    /<u>([^<]+)<\/u>$/,
    (state, match, start, end) => {
      const { tr } = state
      const text = match[1]

      tr.delete(start, end)
      const mark = markType.create()
      tr.insertText(text, start)
      tr.addMark(start, start + text.length, mark)
      return tr
    }
  )
}

/**
 * 创建链接输入规则 ([text](url))
 */
function linkRule(markType: any): InputRule {
  return new InputRule(
    /\[([^\]]+)\]\(([^)]+)\)$/,
    (state, match, start, end) => {
      const { tr } = state
      const text = match[1]
      const href = match[2]

      tr.delete(start, end)
      const mark = markType.create({ href })
      tr.insertText(text, start)
      tr.addMark(start, start + text.length, mark)
      return tr
    }
  )
}

/**
 * 构建所有输入规则
 */
export function buildInputRules(schema: Schema) {
  const rules: InputRule[] = [
    // 标题 # （支持 h1-h6）
    headingRule(schema.nodes.heading, 6),

    // 引用块 >
    blockquoteRule(schema.nodes.blockquote),

    // 有序列表 1.
    orderedListRule(schema.nodes.ordered_list),

    // 任务列表：在无序列表项开头输入 [ ] / [x]
    taskListRule(schema.nodes.bullet_list, schema.nodes.task_item),

    // 无序列表 - / * / +
    bulletListRule(schema.nodes.bullet_list),

    // 行内代码 `code`
    inlineCodeRule(schema.marks.code),

    // 粗体 **text**
    boldRule(schema.marks.bold),

    // 斜体 *text*
    italicRule(schema.marks.italic),

    // 删除线 ~~text~~
    strikethroughRule(schema.marks.strikethrough),

    // 下划线 <u>text</u>
    underlineRule(schema.marks.underline),

    // 链接 [text](url)
    linkRule(schema.marks.link)
  ]

  return inputRules({ rules })
}

/**
 * 导出单个规则函数
 */
export {
  headingRule,
  codeBlockRule,
  blockquoteRule,
  orderedListRule,
  bulletListRule,
  taskListRule,
  horizontalRuleRule
}
