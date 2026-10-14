/**
 * ProseMirror 键盘快捷键和命令
 */
import { Schema, NodeType, Node as ProseMirrorNode, ResolvedPos } from 'prosemirror-model'
import {
  TextSelection,
  Selection,
  NodeSelection,
  Command,
  Plugin,
  PluginKey,
  EditorState
} from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import {
  toggleMark,
  wrapIn,
  setBlockType,
  chainCommands,
  exitCode,
  joinDown,
  joinUp,
  lift,
  selectParentNode,
  deleteSelection,
  joinBackward,
  joinForward,
  selectNodeBackward,
  selectNodeForward
} from 'prosemirror-commands'
import {
  wrapInList,
  splitListItem,
  liftListItem,
  sinkListItem
} from 'prosemirror-schema-list'
import { undo, redo } from 'prosemirror-history'
import { isInTable, goToNextCell, nextCell, CellSelection } from 'prosemirror-tables'
import { markdownSchema } from './schema'
import { applyHeadingLevel } from './heading-markers'

/**
 * 切换标题级别的命令
 */
function toggleHeading(level: number): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    const node = $from.parent
    const isSame = node.type.name === 'heading' && node.attrs.level === level
    return applyHeadingLevel(isSame ? null : level)(state, dispatch)
  }
}

/**
 * 切换任务列表项的完成状态
 */
function toggleTaskChecked(): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    const node = $from.node($from.depth)

    if (node.type.name === 'task_item') {
      if (dispatch) {
        const tr = state.tr
        const checked = !node.attrs.checked
        tr.setNodeMarkup($from.before($from.depth), undefined, { ...node.attrs, checked })
        dispatch(tr)
      }
      return true
    }
    return false
  }
}

/**
 * 在光标处插入硬换行
 */
function insertHardBreak(): Command {
  return (state, dispatch) => {
    const br = state.schema.nodes.hard_break

    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(br.create()))
    }
    return true
  }
}

/**
 * 插入水平分割线
 */
function insertHorizontalRule(): Command {
  return (state, dispatch) => {
    const hr = state.schema.nodes.horizontal_rule

    if (dispatch) {
      const tr = state.tr.replaceSelectionWith(hr.create())
      dispatch(tr)
    }
    return true
  }
}

/**
 * 创建链接的命令。
 * 链接在文档中以字面文本 `[文字](url)` 形式存在（IR 折叠插件负责渲染/折叠），
 * 因此这里直接插入/包裹字面文本，并把光标选中文字部分便于编辑。
 */
function insertLink(href = '', title = ''): Command {
  const suffix = `(${href}${title ? ' "' + title + '"' : ''})`
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    const label = empty ? href || '链接' : state.doc.textBetween(from, to)
    const literal = `[${label}]${suffix}`
    if (dispatch) {
      const tr = state.tr.insertText(literal, from, empty ? from : to)
      tr.setSelection(TextSelection.create(tr.doc, from + 1, from + 1 + label.length))
      dispatch(tr)
    }
    return true
  }
}

/**
 * 插入图片
 */
function insertImage(src = '', alt = '', title = ''): Command {
  return (state, dispatch) => {
    const imageNode = state.schema.nodes.image.create({ src, alt, title })

    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(imageNode))
    }
    return true
  }
}

/**
 * 切换到行内代码
 */
function toggleCode(): Command {
  return toggleMark(markdownSchema.marks.code)
}

/**
 * 切换删除线
 */
function toggleStrikethrough(): Command {
  return toggleMark(markdownSchema.marks.strikethrough)
}

/**
 * 自定义列表分割逻辑
 * 处理任务列表和普通列表的分割
 * 在列表项末尾按回车时自动创建新列表项，空列表项时退出列表
 */
function customSplitListItem(itemType: NodeType): Command {
  return (state, dispatch) => {
    const { $from } = state.selection

    // 查找列表项节点 - 需要向上遍历节点树
    let listItemDepth = -1
    for (let i = $from.depth; i > 0; i--) {
      const node = $from.node(i)
      if (node.type.name === 'list_item' || node.type.name === 'task_item') {
        listItemDepth = i
        break
      }
    }

    // 如果不在列表项中，返回 false 让其他命令处理
    if (listItemDepth === -1) {
      return false
    }

    const listItemNode = $from.node(listItemDepth)

    // 检查列表项是否为空（只有段落且内容为空）
    const isEmpty = listItemNode.childCount === 1 &&
      listItemNode.firstChild?.type.name === 'paragraph' &&
      listItemNode.firstChild?.content.size === 0

    if (isEmpty) {
      // 空列表项：退出列表（lift）
      if (dispatch) {
        // 获取列表在文档中的位置
        const listDepth = listItemDepth - 1
        const listNode = $from.node(listDepth)

        // 如果这是列表中的唯一一个项，直接转换为段落
        if (listNode.childCount === 1) {
          const tr = state.tr
          // 删除整个列表，插入段落
          const listStart = $from.before(listDepth)
          const listEnd = $from.after(listDepth)
          const paragraph = state.schema.nodes.paragraph.create()
          tr.replaceWith(listStart, listEnd, paragraph)
          tr.setSelection(TextSelection.create(tr.doc, listStart + 1))
          dispatch(tr)
        } else {
          // 多个列表项：将当前项提升为段落
          liftListItem(itemType)(state, dispatch)
        }
      }
      return true
    }

    // 非空列表项：使用默认分割创建新列表项
    return splitListItem(itemType)(state, dispatch)
  }
}

/**
 * 回车键处理
 * 在任务列表中点击复选框时切换状态
 */
function handleEnter(schema: Schema): Command {
  return chainCommands(
    convertBlockMarkerOnEnter(schema),
    (state, dispatch) => {
      if (state.selection.$from.parent.type.name === 'code_block') {
        if (dispatch) {
          dispatch(state.tr.insertText('\n'))
        }
        return true
      }

      return false
    },
    exitCode
  )
}

/**
 * 表格最后一行按回车时，跳出表格并在下方创建新段落
 */
function exitTableOnLastRow(schema: Schema): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false
    const { $from } = state.selection

    // 向上找到 table_row
    let rowDepth = -1
    for (let i = $from.depth; i > 0; i--) {
      if ($from.node(i).type.name === 'table_row') {
        rowDepth = i
        break
      }
    }
    if (rowDepth === -1) return false

    const tableDepth = rowDepth - 1
    const tableNode = $from.node(tableDepth)
    const rowIndex = $from.index(tableDepth)

    // 只在表格最后一行生效
    if (rowIndex < tableNode.childCount - 1) return false

    if (dispatch) {
      const tableEnd = $from.after(tableDepth)
      const tr = state.tr
      // 表格后已有可继续输入的段落（parseMarkdown 会为表格/代码块补齐尾部空段），
      // 此时只需把光标移出表格，而不是再插入一个重复的空段。
      const next = state.doc.nodeAt(tableEnd)
      if (next && next.type === schema.nodes.paragraph) {
        tr.setSelection(TextSelection.create(tr.doc, tableEnd))
      } else {
        tr.insert(tableEnd, schema.nodes.paragraph.create())
        tr.setSelection(TextSelection.create(tr.doc, tableEnd + 1))
      }
      dispatch(tr)
    }
    return true
  }
}

/** 能直接承载光标的块：文本块，或可下钻到段落的容器（引用/列表）。 */
function isCaretBlock(node: ProseMirrorNode | null | undefined): boolean {
  if (!node) return false
  return (
    node.isTextblock ||
    node.type.name === 'blockquote' ||
    node.type.name === 'bullet_list' ||
    node.type.name === 'ordered_list' ||
    node.type.name === 'task_list'
  )
}

/** 找到 $pos 所在的最外层表格，返回表格在文档中的起始位置（位置在表格之前）。 */
function tableStartAt($pos: ResolvedPos): number | null {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.spec.tableRole === 'table') return $pos.before(d)
  }
  return null
}

/**
 * 把光标移出某个块节点（表格/代码块/分割线/公式块）：
 * - 相邻块能承载光标 → 进入相邻块；
 * - 否则（分割线/公式块/表格/无相邻块）→ 在来源块与邻居之间插入空段落并落入。
 * dir: -1 向上/左，1 向下/右。
 */
function moveOutOfBlock(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  dir: 1 | -1,
  blockPos: number,
  blockNode: ProseMirrorNode
): boolean {
  const boundary = dir < 0 ? blockPos : blockPos + blockNode.nodeSize
  const $pos = state.doc.resolve(boundary)
  const sibling = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter
  if (isCaretBlock(sibling)) {
    const target = Selection.near($pos, dir)
    if (target.eq(state.selection)) return false
    if (dispatch) dispatch(state.tr.setSelection(target).scrollIntoView())
    return true
  }
  if (!dispatch) return true
  const tr = state.tr.insert(boundary, state.schema.nodes.paragraph.create())
  tr.setSelection(TextSelection.create(tr.doc, boundary + 1))
  dispatch(tr.scrollIntoView())
  return true
}

/**
 * 表格单元格方向键导航。
 *
 * 本 schema 的单元格内容是 `inline*`（光标直接位于 table_cell/table_header 内）。
 * prosemirror-tables 内置的方向键导航依赖 atEndOfCell，而它从 `$head.depth - 1`
 * 往上寻找单元格，恰好跳过光标所在的单元格本身，因此在本 schema 下完全失效：
 * 方向键退回浏览器默认行为，越过单元格边界时会出现多余光标 / 幻影单元格。
 *
 * 这里补齐等价逻辑：光标位于单元格内容首/尾时移动到相邻单元格；
 * 抵达表格边界则移出表格——相邻块不能承载光标时补一个空段落。
 */
function tableArrowKey(axis: 'horiz' | 'vert', dir: 1 | -1): Command {
  return (state, dispatch, view) => {
    if (!view) return false
    const { selection } = state
    if (selection instanceof CellSelection) return false
    if (axis === 'vert' && !selection.empty) return false

    const $head = selection.$head
    const cell = $head.parent
    const role = cell.type.spec.tableRole
    if (role !== 'cell' && role !== 'header_cell') return false

    let atBoundary: boolean
    if (axis === 'vert') {
      // 垂直：仅在单元格首行（Up）/ 末行（Down）时跨单元格；
      // 多行单元格（硬换行）内部的上下移动交还浏览器默认行为。
      let onFirstLine = true
      let onLastLine = true
      for (let i = 0, offset = 0; i < cell.childCount; i++) {
        const child = cell.child(i)
        if (child.type.name === 'hard_break') {
          if (offset < $head.parentOffset) onFirstLine = false
          else onLastLine = false
        }
        offset += child.nodeSize
      }
      atBoundary = dir < 0 ? onFirstLine : onLastLine
    } else {
      // 水平：仅在单元格内容首/尾时跨单元格。
      atBoundary =
        dir < 0 ? $head.parentOffset === 0 : $head.parentOffset === cell.content.size
    }
    if (!atBoundary) return false

    const $cell = state.doc.resolve($head.before($head.depth))
    const tableStart = tableStartAt($cell) as number
    const tableNode = state.doc.nodeAt(tableStart) as ProseMirrorNode

    if (axis === 'vert') {
      const $next = nextCell($cell, axis, dir)
      if ($next) {
        if (dispatch) dispatch(state.tr.setSelection(Selection.near($next, 1)).scrollIntoView())
        return true
      }
    } else {
      // 水平用线性流进入相邻单元格（Selection.near 会跨行、跨单元格）；
      // 目标仍在同一张表 → 只是单元格间移动；否则视为移出表格。
      const target = Selection.near(state.doc.resolve(selection.head + dir), dir)
      if (tableStartAt(target.$from) === tableStart) {
        if (dispatch) dispatch(state.tr.setSelection(target).scrollIntoView())
        return true
      }
    }

    return moveOutOfBlock(state, dispatch, dir, tableStart, tableNode)
  }
}

/**
 * 代码块边界方向键：光标在代码块首/末行（上下）或文本首/尾（左右）时移出代码块；
 * 相邻块不能承载光标时补一个空段落，块内移动交还浏览器默认行为。
 */
function codeBlockArrowKey(axis: 'horiz' | 'vert', dir: 1 | -1): Command {
  return (state, dispatch, view) => {
    if (!view) return false
    const { selection } = state
    if (!(selection instanceof TextSelection) || !selection.empty) return false

    const $head = selection.$head
    const block = $head.parent
    if (block.type.name !== 'code_block') return false

    const offset = $head.parentOffset
    let atBoundary: boolean
    if (axis === 'horiz') {
      atBoundary = dir < 0 ? offset === 0 : offset === block.content.size
    } else {
      const text = block.textContent
      atBoundary =
        dir < 0 ? !text.slice(0, offset).includes('\n') : !text.slice(offset).includes('\n')
    }
    if (!atBoundary) return false

    return moveOutOfBlock(state, dispatch, dir, $head.before($head.depth), block)
  }
}

/** 特殊块：需要专门处理方向键进出、光标无法"自然"落进去的块。 */
function isSpecialBlock(node: ProseMirrorNode | null | undefined): boolean {
  if (!node) return false
  return (
    node.type.name === 'table' ||
    node.type.name === 'horizontal_rule' ||
    node.type.name === 'math_block' ||
    node.type.name === 'code_block'
  )
}

/**
 * 普通文本块 → 相邻特殊块的反向方向键导航。
 *
 * 光标在文本块首/末行（上下）或首/尾（左右）时，若该方向相邻的是特殊块
 * （表格/分割线/公式块/代码块），则把光标移入相邻块（表格落到最末/最前单元格，
 * 原子块返回其 NodeSelection，代码块落到文本末尾/开头）。
 *
 * 若当前文本块为空且可安全删除，则一并删除它（撤销此前为退出特殊块补出的占位空行）。
 * "不可删"仅指：该空段是文档最后一个块、且其前一个块是表格/代码块——此时删除会被
 * createPlugins 的 appendTransaction 立即补回，故保留占位。
 */
function textBlockArrowKey(axis: 'horiz' | 'vert', dir: 1 | -1): Command {
  return (state, dispatch, view) => {
    if (!view) return false
    const { selection } = state
    if (!(selection instanceof TextSelection) || !selection.empty) return false

    const $head = selection.$head
    const parent = $head.parent
    if (!parent.isTextblock || parent.type.name === 'code_block') return false

    let atBoundary: boolean
    if (axis === 'horiz') {
      atBoundary = dir < 0 ? $head.parentOffset === 0 : $head.parentOffset === parent.content.size
    } else {
      let onFirstLine = true
      let onLastLine = true
      for (let i = 0, offset = 0; i < parent.childCount; i++) {
        const child = parent.child(i)
        if (child.type.name === 'hard_break') {
          if (offset < $head.parentOffset) onFirstLine = false
          else onLastLine = false
        }
        offset += child.nodeSize
      }
      atBoundary = dir < 0 ? onFirstLine : onLastLine
    }
    if (!atBoundary) return false

    // 文档顺序上的相邻块：沿祖先链上溯，跨出列表项/引用等容器。
    // 只看直接兄弟会漏掉"列表项末尾的段落 → 该列表之后的表格"这类结构，
    // 从而退回浏览器默认行为（出现 gap cursor / 幻影单元格）。
    const doc = state.doc
    let boundary = -1
    let sibling: ProseMirrorNode | null = null
    for (let d = $head.depth; d >= 1; d--) {
      const b = dir < 0 ? $head.before(d) : $head.after(d)
      const $b = doc.resolve(b)
      const node = dir < 0 ? $b.nodeBefore : $b.nodeAfter
      if (node) {
        boundary = b
        sibling = node
        break
      }
    }
    if (!isSpecialBlock(sibling)) return false

    // 只有顶层空段落才是可安全删除的"占位空行"（嵌套空段落不在此列）。
    const blockStart = $head.before($head.depth)
    const blockEnd = $head.after($head.depth)
    const prev = doc.resolve(blockStart).nodeBefore
    const deletable =
      $head.depth === 1 &&
      parent.content.size === 0 &&
      !(
        blockEnd === doc.content.size &&
        prev !== null &&
        (prev.type.name === 'table' || prev.type.name === 'code_block')
      )

    if (!dispatch) return true

    const tr = state.tr
    if (deletable) tr.delete(blockStart, blockEnd)
    const target = Selection.near(tr.doc.resolve(deletable ? blockStart : boundary), dir)
    tr.setSelection(target)
    dispatch(tr.scrollIntoView())
    return true
  }
}

/**
 * 选中块级节点（NodeSelection，如分割线/公式块）时，方向键把光标移出节点：
 * 相邻块能承载光标则进入，否则补一个空段落。
 * 行内节点（图片/行内公式）相邻必为文本，直接落到相邻文本位置。
 */
function arrowFromNodeSelection(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const { selection } = state
    if (!(selection instanceof NodeSelection)) return false
    const node = selection.node
    if (node.isBlock) {
      return moveOutOfBlock(state, dispatch, dir, selection.from, node)
    }
    const $pos = state.doc.resolve(dir < 0 ? selection.from : selection.to)
    const target = Selection.near($pos, dir)
    if (target.eq(state.selection)) return false
    if (dispatch) dispatch(state.tr.setSelection(target).scrollIntoView())
    return true
  }
}

/** 按回车时，将完整的块级 Markdown 标记转换为对应节点。 */
function convertBlockMarkerOnEnter(schema: Schema): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    const paragraph = $from.parent
    if (paragraph.type !== schema.nodes.paragraph || $from.parentOffset !== paragraph.content.size) {
      return false
    }

    const text = paragraph.textContent
    const codeMatch = text.match(/^```([\w+#.-]+)?$/)
    const isHorizontalRule = /^(---|___|\*\*\*)$/.test(text)
    if (!codeMatch && !isHorizontalRule) return false

    if (dispatch) {
      const start = $from.before($from.depth)
      const tr = state.tr
      if (codeMatch) {
        const language = codeMatch[1]?.toLowerCase() || ''
        const aliases: Record<string, string> = {
          'c++': 'cpp',
          'c#': 'csharp',
          js: 'javascript',
          ts: 'typescript',
          py: 'python',
          sh: 'bash',
          shell: 'bash'
        }
        const normalizedLanguage = aliases[language] || language
        const codeBlock = schema.nodes.code_block.create({ language: normalizedLanguage })
        tr.replaceWith(start, start + paragraph.nodeSize, codeBlock)
        tr.setSelection(TextSelection.create(tr.doc, start + 1))
      } else {
        const rule = schema.nodes.horizontal_rule.create()
        const emptyParagraph = schema.nodes.paragraph.create()
        tr.replaceWith(start, start + paragraph.nodeSize, [rule, emptyParagraph])
        tr.setSelection(TextSelection.create(tr.doc, start + rule.nodeSize + 1))
      }
      dispatch(tr)
    }
    return true
  }
}

/**
 * Tab 缩进单位（与列表缩进保持一致：2 个空格）
 */
const TAB_INDENT = '  '

/**
 * Tab 焦点逃逸模式。
 * 开启后编辑器不再拦截 Tab，允许键盘把焦点移出编辑器；通过 Ctrl+M 切换。
 * 存储于编辑器状态而非模块变量，保证多标签/多编辑器互不干扰且可测试。
 */
export const tabFocusModeKey = new PluginKey<boolean>('tabFocusMode')

export const tabFocusModePlugin = new Plugin<boolean>({
  key: tabFocusModeKey,
  state: {
    init: () => false,
    apply(tr, value) {
      const meta = tr.getMeta(tabFocusModeKey)
      return meta === undefined ? value : Boolean(meta)
    }
  }
})

interface CodeLine {
  start: number
  end: number
}

/** 光标所在代码块的内容信息（内容起始位置 + 文本 + 按 \n 切分的行范围） */
function getCodeBlockInfo(
  state: EditorState
): { contentStart: number; text: string; lines: CodeLine[] } | null {
  const { $from } = state.selection
  if ($from.parent.type.name !== 'code_block') return null
  const contentStart = $from.start()
  const text = $from.parent.textContent
  const lines: CodeLine[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push({ start, end: i })
      start = i + 1
    }
  }
  lines.push({ start, end: text.length })
  return { contentStart, text, lines }
}

function leadingSpaces(text: string): number {
  return text.match(/^ */)?.[0].length ?? 0
}

/**
 * 代码块缩进 / 反缩进。
 * - 空选区：Tab 在光标处插入缩进；Shift-Tab 删除当前行行首的缩进。
 * - 非空选区：对选区覆盖的每一行行首增 / 删缩进。
 */
function changeCodeBlockIndent(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  outdent: boolean
): boolean {
  const info = getCodeBlockInfo(state)
  if (!info) return false
  const { from, to } = state.selection
  const { contentStart, text, lines } = info

  // 空选区
  if (from === to) {
    if (!outdent) {
      if (dispatch) dispatch(state.tr.insertText(TAB_INDENT, from))
      return true
    }
    const target = lines.find(
      (line) => from >= contentStart + line.start && from <= contentStart + line.end
    ) ?? lines[0]
    const absStart = contentStart + target.start
    const remove = Math.min(TAB_INDENT.length, leadingSpaces(text.slice(target.start, target.end)))
    if (remove > 0 && dispatch) {
      dispatch(state.tr.delete(absStart, absStart + remove))
    }
    return true
  }

  // 非空选区：从后往前处理，避免位置偏移
  const targets = lines.filter(
    (line) => contentStart + line.end >= from && contentStart + line.start <= to
  )
  if (dispatch) {
    const tr = state.tr
    for (let i = targets.length - 1; i >= 0; i--) {
      const line = targets[i]
      const absStart = contentStart + line.start
      if (outdent) {
        const remove = Math.min(TAB_INDENT.length, leadingSpaces(text.slice(line.start, line.end)))
        if (remove > 0) tr.delete(absStart, absStart + remove)
      } else {
        tr.insertText(TAB_INDENT, absStart)
      }
    }
    dispatch(tr)
  }
  return true
}

/**
 * Tab 键处理。
 * 分派顺序：表格导航 → 列表缩进 → 代码块缩进 → 其它文本块（消费按键，避免焦点跳走）。
 * 焦点逃逸模式开启时直接放行，让浏览器执行默认的焦点切换。
 */
function handleTab(schema: Schema): Command {
  return (state, dispatch) => {
    if (tabFocusModeKey.getState(state)) return false
    if (isInTable(state)) {
      goToNextCell(1)(state, dispatch)
      return true
    }
    const { $from } = state.selection
    const parent = $from.node($from.depth)

    if (parent.type.name === 'list_item' || parent.type.name === 'task_item') {
      sinkListItem(schema.nodes.list_item)(state, dispatch)
      return true
    }
    if (parent.type.name === 'code_block') {
      return changeCodeBlockIndent(state, dispatch, false)
    }
    return true
  }
}

/**
 * Shift-Tab 键处理（与 handleTab 对称）。
 */
function handleShiftTab(schema: Schema): Command {
  return (state, dispatch) => {
    if (tabFocusModeKey.getState(state)) return false
    if (isInTable(state)) {
      goToNextCell(-1)(state, dispatch)
      return true
    }
    const { $from } = state.selection
    const parent = $from.node($from.depth)

    if (parent.type.name === 'list_item' || parent.type.name === 'task_item') {
      liftListItem(schema.nodes.list_item)(state, dispatch)
      return true
    }
    if (parent.type.name === 'code_block') {
      return changeCodeBlockIndent(state, dispatch, true)
    }
    return true
  }
}

/**
 * 切换注释：对选区文本包裹 HTML 注释，再次触发可取消
 */
function toggleCommentCommand(): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection
    const text = state.doc.textBetween(from, to)

    if (from === to) {
      // 空选区：插入占位注释，光标居中
      if (dispatch) {
        const marker = '<!--  -->'
        const tr = state.tr.insertText(marker, from)
        dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 5)))
      }
      return true
    }

    const isCommented = text.startsWith('<!--') && text.endsWith('-->')
    if (isCommented) {
      if (dispatch) dispatch(state.tr.insertText(text.slice(4, -3).trim(), from, to))
    } else {
      const openIdx = text.indexOf('<!--')
      const closeIdx = text.lastIndexOf('-->')
      if (openIdx !== -1 && closeIdx !== -1 && openIdx < closeIdx) {
        // 选区包含完整注释：移除注释标记
        const inner = text.slice(openIdx + 4, closeIdx).trim()
        if (dispatch) dispatch(state.tr.insertText(inner, from, to))
      } else {
        if (dispatch) dispatch(state.tr.insertText(`<!-- ${text} -->`, from, to))
      }
    }
    return true
  }
}

/**
 * 键盘快捷键映射表
 */
export function buildKeymap(schema: Schema): Record<string, Command> {
  const keymap: Record<string, Command> = {
    // 撤销/重做
    'Mod-z': undo,
    'Mod-Shift-z': redo,
    'Mod-y': redo,

    // 基本格式
    'Mod-b': (state, dispatch) => {
      return toggleMark(schema.marks.bold)(state, dispatch)
    },
    'Mod-i': (state, dispatch) => {
      return toggleMark(schema.marks.italic)(state, dispatch)
    },
    'Mod-`': (state, dispatch) => {
      return toggleCode()(state, dispatch)
    },
    'Mod-Shift-x': (state, dispatch) => {
      return toggleStrikethrough()(state, dispatch)
    },
    'Mod-u': (state, dispatch) => {
      return toggleMark(schema.marks.underline)(state, dispatch)
    },

    // 标题 (Ctrl+1 ~ Ctrl+6)
    'Mod-1': toggleHeading(1),
    'Mod-2': toggleHeading(2),
    'Mod-3': toggleHeading(3),
    'Mod-4': toggleHeading(4),
    'Mod-5': toggleHeading(5),
    'Mod-6': toggleHeading(6),
    'Mod-0': applyHeadingLevel(null),

    // 列表
    'Shift-Ctrl-8': wrapInList(schema.nodes.bullet_list),
    'Shift-Ctrl-9': wrapInList(schema.nodes.ordered_list),
    'Shift-Ctrl-[': liftListItem(schema.nodes.list_item),
    'Shift-Ctrl-]': sinkListItem(schema.nodes.list_item),

    // 引用块
    'Shift-Ctrl->': wrapIn(schema.nodes.blockquote),

    // 代码块
    'Shift-Ctrl-\\': setBlockType(schema.nodes.code_block),

    // 链接和图片
    'Mod-k': insertLink(),
    'Mod-Shift-k': insertImage(),

    // 查找 / 替换 / 切换编辑模式
    'Mod-f': (_state, _dispatch) => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('editor:find'))
      }
      return true
    },
    'Mod-h': (_state, _dispatch) => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('editor:replace'))
      }
      return true
    },
    'Mod-/': (_state, _dispatch) => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('editor:toggleMode'))
      }
      return true
    },

    // 水平分割线
    'Mod-Shift--': insertHorizontalRule(),

    // 导航（ArrowUp 的「跳出代码块 / 表格」逻辑在 plugins.ts 中以独立插件注册，
    // 需先于 tableEditing 生效，故不放在此 keymap 中）
    'Alt-ArrowUp': joinUp,
    'Alt-ArrowDown': joinDown,
    'Mod-BracketLeft': lift,
    'Escape': selectParentNode,

    // 方向键：依次处理
    // 1) 表格单元格导航（inline 单元格 schema 下 prosemirror-tables 内置逻辑失效）
    // 2) 代码块边界移出
    // 3) 文本块 → 相邻特殊块的反向导航（必要时补/删占位空段）
    // 4) 节点被选中（如分割线）时把光标移出
    'ArrowLeft': chainCommands(
      tableArrowKey('horiz', -1),
      codeBlockArrowKey('horiz', -1),
      textBlockArrowKey('horiz', -1),
      arrowFromNodeSelection(-1)
    ),
    'ArrowRight': chainCommands(
      tableArrowKey('horiz', 1),
      codeBlockArrowKey('horiz', 1),
      textBlockArrowKey('horiz', 1),
      arrowFromNodeSelection(1)
    ),
    'ArrowUp': chainCommands(
      tableArrowKey('vert', -1),
      codeBlockArrowKey('vert', -1),
      textBlockArrowKey('vert', -1),
      arrowFromNodeSelection(-1)
    ),
    'ArrowDown': chainCommands(
      tableArrowKey('vert', 1),
      codeBlockArrowKey('vert', 1),
      textBlockArrowKey('vert', 1),
      arrowFromNodeSelection(1)
    ),

    // 回车
    'Enter': chainCommands(
      customSplitListItem(schema.nodes.list_item),
      customSplitListItem(schema.nodes.task_item),
      exitTableOnLastRow(schema),
      handleEnter(schema)
    ),

    // Backspace — 代码块为空时删除整个代码块；光标在空的首行行首时仅删除该空行；
    // 其余情况保留内容，交给后续默认处理
    'Backspace': chainCommands(
      deleteSelection,
      (state, dispatch) => {
        const { $from } = state.selection
        if ($from.parent.type.name === 'code_block') {
          if ($from.parent.content.size === 0) {
            if (dispatch) {
              const start = $from.before($from.depth)
              const end = $from.after($from.depth)
              const tr = state.tr.delete(start, end)
              tr.setSelection(TextSelection.create(tr.doc, Math.max(0, start - 1)))
              dispatch(tr)
            }
            return true
          }
          if ($from.parentOffset === 0 && $from.parent.textContent.startsWith('\n')) {
            // 非空代码块、光标位于空的首行行首：只删除该空行（去掉第一个换行符），
            // 保留代码块其余内容。
            if (dispatch) {
              const contentStart = $from.start()
              const tr = state.tr.delete(contentStart, contentStart + 1)
              tr.setSelection(TextSelection.create(tr.doc, contentStart))
              dispatch(tr)
            }
            return true
          }
        }
        return false
      },
      joinBackward,
      selectNodeBackward
    ),

    // Delete — 代码块末尾删除时替换为段落
    'Delete': chainCommands(
      deleteSelection,
      (state, dispatch) => {
        const { $from } = state.selection
        if ($from.parent.type.name === 'code_block' && $from.parentOffset === $from.parent.content.size) {
          if (dispatch) {
            const start = $from.before($from.depth)
            const end = $from.after($from.depth)
            const tr = state.tr.replaceWith(start, end, schema.nodes.paragraph.create())
            tr.setSelection(TextSelection.create(tr.doc, start + 1))
            dispatch(tr)
          }
          return true
        }
        return false
      },
      joinForward,
      selectNodeForward
    ),

    // Tab 缩进
    'Tab': handleTab(schema),
    'Shift-Tab': handleShiftTab(schema),

    // Ctrl+M：切换 Tab 焦点逃逸模式（开启后 Tab 可移动焦点离开编辑器）
    'Ctrl-m': (state, dispatch) => {
      if (dispatch) {
        dispatch(state.tr.setMeta(tabFocusModeKey, !tabFocusModeKey.getState(state)))
      }
      return true
    },

    // 硬换行 (Shift+Enter)
    'Shift-Enter': insertHardBreak()
  }

  // Mac 兼容
  if (typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)) {
    keymap['Ctrl-h'] = toggleMark(schema.marks.strikethrough)
  }

  return keymap
}

/**
 * 导出命令函数
 */
export {
  toggleHeading,
  toggleTaskChecked,
  insertHardBreak,
  insertHorizontalRule,
  insertLink,
  insertImage,
  toggleCode,
  toggleStrikethrough,
  toggleCommentCommand,
  customSplitListItem,
  handleTab,
  handleShiftTab,
  tableArrowKey,
  codeBlockArrowKey,
  textBlockArrowKey,
  arrowFromNodeSelection
}
