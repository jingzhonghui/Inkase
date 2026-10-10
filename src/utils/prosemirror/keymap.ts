/**
 * ProseMirror 键盘快捷键和命令
 */
import { Schema, NodeType } from 'prosemirror-model'
import {
  TextSelection,
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
import { isInTable, goToNextCell } from 'prosemirror-tables'
import { markdownSchema } from './schema'

/**
 * 切换标题级别的命令
 */
function toggleHeading(level: number): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection
    const nodeType = state.schema.nodes.heading
    const paragraph = state.schema.nodes.paragraph

    // 检查当前选区是否已经是目标级别的标题
    let isCurrentHeading = false
    state.doc.nodesBetween($from.pos, $to.pos, (node) => {
      if (node.type === nodeType && node.attrs.level === level) {
        isCurrentHeading = true
      }
      return true
    })

    if (isCurrentHeading) {
      // 切换回段落
      return setBlockType(paragraph)(state, dispatch)
    } else {
      // 设置为目标级别标题
      return setBlockType(nodeType, { level })(state, dispatch)
    }
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
    'Mod-0': setBlockType(schema.nodes.paragraph),

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

    // 导航
    'Alt-ArrowUp': joinUp,
    'Alt-ArrowDown': joinDown,
    'Mod-BracketLeft': lift,
    'Escape': selectParentNode,

    // 回车
    'Enter': chainCommands(
      customSplitListItem(schema.nodes.list_item),
      customSplitListItem(schema.nodes.task_item),
      exitTableOnLastRow(schema),
      handleEnter(schema)
    ),

    // Backspace — 代码块为空时删除代码块，否则在句首时将代码块替换为段落
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
          if ($from.parentOffset === 0) {
            if (dispatch) {
              const start = $from.before($from.depth)
              const end = $from.after($from.depth)
              const tr = state.tr.replaceWith(start, end, schema.nodes.paragraph.create())
              tr.setSelection(TextSelection.create(tr.doc, start + 1))
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
  handleShiftTab
}
