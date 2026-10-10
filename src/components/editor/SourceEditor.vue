<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, shallowRef } from 'vue'
import { useFileStore } from '../../stores/file'
import { useThemeStore } from '../../stores/theme'
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, Decoration, type DecorationSet } from '@codemirror/view'
import { EditorState, Compartment, StateField, StateEffect, type Extension } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { defaultHighlightStyle, syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language'
import { tags as hlTags } from '@lezer/highlight'
import { history, defaultKeymap, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { highlightSelectionMatches } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, type Completion } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import { findCodeLanguage } from '../../utils/editor-language'
import EditorContextMenu from '../common/EditorContextMenu.vue'
import FindReplacePanel from './FindReplacePanel.vue'
import type { EditorContextMenuItem } from '../../types/editor-context-menu'

// Props
interface Props {
  class?: string
  plainText?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  plainText: false
})

// Emits
const emit = defineEmits<{
  (e: 'update:content', content: string): void
  (e: 'scroll', ratio: number): void
}>()

// Store
const fileStore = useFileStore()
const themeStore = useThemeStore()

// Refs
const editorRef = ref<HTMLDivElement>()
const editorView = shallowRef<EditorView | null>(null)

// 主题 compartment - 在 initEditor 中创建
let themeCompartment: Compartment | null = null

// 纯文本模式的语法高亮 compartment - 在 initEditor 中创建
let langCompartment: Compartment | null = null

/**
 * properties/ini 等 legacy 语言的 value 部分使用 tags.quote，
 * oneDark（暗色）与 defaultHighlightStyle（浅色）均未覆盖该 tag，
 * 在纯文本模式按主题补色（各取主题的 string 配色保持一致观感）。
 * 仅限纯文本分支使用：Markdown 引用块同样使用 tags.quote，全局追加会改变引用块配色。
 */
const plainTextValueHighlights: Extension[] = [
  syntaxHighlighting(HighlightStyle.define([{ tag: hlTags.quote, color: '#98c379' }], { themeType: 'dark' })),
  syntaxHighlighting(HighlightStyle.define([{ tag: hlTags.quote, color: '#a11' }], { themeType: 'light' }))
]

/**
 * 浅色主题的完整代码配色（替换 defaultHighlightStyle 使用）。
 * 起因：@codemirror/language 的 defaultHighlightStyle 里属性名只匹配
 * definition(propertyName)，不含普通 propertyName，也没有 name/punctuation/operator 等，
 * 导致浅色主题下 JSON 的键名、括号、冒号等无颜色（数字因 number⊂literal 才被着色）。
 * 这里给出一套接近 VSCode 浅色的完整配色；顶部保留 Markdown 结构规则以不改变 Markdown 源码观感。
 */
const codeHighlightLight = HighlightStyle.define(
  [
    // Markdown 结构（与 defaultHighlightStyle 一致）
    { tag: hlTags.link, textDecoration: 'underline' },
    { tag: hlTags.heading, textDecoration: 'underline', fontWeight: 'bold' },
    { tag: hlTags.emphasis, fontStyle: 'italic' },
    { tag: hlTags.strong, fontWeight: 'bold' },
    { tag: hlTags.strikethrough, textDecoration: 'line-through' },
    // 代码
    { tag: hlTags.comment, color: '#008000' },
    { tag: hlTags.keyword, color: '#af00db' },
    { tag: hlTags.string, color: '#a31515' },
    { tag: hlTags.number, color: '#098658' },
    { tag: [hlTags.bool, hlTags.null, hlTags.atom, hlTags.self, hlTags.url], color: '#0000ff' },
    { tag: [hlTags.regexp, hlTags.escape, hlTags.special(hlTags.string)], color: '#ee0000' },
    { tag: [hlTags.propertyName, hlTags.attributeName], color: '#0451a5' },
    { tag: hlTags.attributeValue, color: '#0000ff' },
    { tag: hlTags.variableName, color: '#001080' },
    {
      tag: [hlTags.definition(hlTags.variableName), hlTags.function(hlTags.variableName), hlTags.labelName],
      color: '#795e26'
    },
    { tag: [hlTags.typeName, hlTags.className, hlTags.namespace, hlTags.tagName], color: '#267f99' },
    { tag: hlTags.operator, color: '#000000' },
    { tag: hlTags.punctuation, color: '#6e7781' },
    { tag: hlTags.meta, color: '#404740' },
    { tag: hlTags.invalid, color: '#cd3131' }
  ],
  { themeType: 'light' }
)

// 查找替换面板状态
const searchOpen = ref(false)
const searchReplaceMode = ref(false)
const searchMatches = ref<Array<{ from: number; to: number }>>([])
const currentMatchIndex = ref(-1)
const lastSearchQuery = ref('')
const lastCaseSensitive = ref(false)
const sourceContextMenu = ref({ visible: false, x: 0, y: 0, items: [] as EditorContextMenuItem[] })

// 查找高亮（自定义 Decoration，不依赖 CodeMirror 原生搜索面板）
const searchDecoEffect = StateEffect.define<DecorationSet>()
const searchDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    let next = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(searchDecoEffect)) next = effect.value
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

// git 冲突标记行高亮（<<<<<<< / ======= / >>>>>>>）
const conflictMarkerRegex = /^(<<<<<<<|=======|>>>>>>>)/
const conflictDecoField = StateField.define<DecorationSet>({
  create: (state) => computeConflictDecos(state),
  update: (deco, tr) => (tr.docChanged ? computeConflictDecos(tr.state) : deco.map(tr.changes)),
  provide: (field) => EditorView.decorations.from(field)
})

function computeConflictDecos(state: EditorState): DecorationSet {
  const decos: Array<{ from: number }> = []
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    if (conflictMarkerRegex.test(line.text)) {
      decos.push({ from: line.from })
    }
  }
  return Decoration.set(decos.map((d) => Decoration.line({ class: 'cm-conflict-marker' }).range(d.from)))
}

// 是否正在同步内容（防止循环更新）
let isSyncing = false

/**
 * 创建 CodeMirror 扩展配置
 */
function createExtensions(): Extension[] {
  // 创建主题 compartment
  themeCompartment = new Compartment()
  // 创建纯文本语言高亮 compartment
  langCompartment = new Compartment()

  const extensions: Extension[] = [
    // 基础编辑功能
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    closeBrackets(),
    // 光标所在括号与配对括号高亮（VSCode 式括号匹配）
    bracketMatching(),

    ...(props.plainText
      ? [
          EditorView.lineWrapping,
          // 语法高亮按文件后缀异步懒加载（loadPlainLanguage），初始为空
          langCompartment!.of([]),
          // legacy 语言 value 部分（tags.quote）的按主题补色
          ...plainTextValueHighlights
        ]
      : [
          // Markdown 语言支持（仅预载常用语法，减少初始化体积）
          markdown({
            base: markdownLanguage,
            codeLanguages: languages.filter(
              (d) =>
                ['javascript', 'typescript', 'python', 'go', 'rust', 'java',
                 'c', 'cpp', 'csharp', 'html', 'css', 'json', 'yaml', 'xml', 'sql',
                 'bash', 'powershell', 'ruby', 'php', 'swift', 'kotlin', 'markdown'].includes(d.name)
            )
          }),
          // 自动补全
          autocompletion({
            override: [markdownCompletions],
            closeOnBlur: true
          })
        ]),

    // 按键映射
    keymap.of([
      indentWithTab,
      ...closeBracketsKeymap,
      // 过滤掉 defaultKeymap 中的 Ctrl+/ 注释切换，避免与切换编辑模式快捷键冲突
      ...defaultKeymap.filter((binding) => binding.key !== 'Mod-/'),
      ...historyKeymap,
      ...completionKeymap,
      ...(props.plainText
        ? customKeymap.filter((binding) => ['Mod-f', 'Mod-h', 'Escape'].includes(binding.key))
        : customKeymap)
    ]),

    // 查找高亮（面板由 FindReplacePanel 统一提供）
    searchDecoField,

    // Markdown 模式高亮 Git 冲突标记；纯文本必须原样显示
    ...(props.plainText ? [] : [conflictDecoField]),

    // 主题（使用 compartment）
    themeCompartment.of(getThemeExtension()),

    // 自定义样式
    editorStyles,

    // 内容变化监听
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !isSyncing) {
        const content = update.state.doc.toString()
        fileStore.updateContent(content)
        emit('update:content', content)
      }
      if (update.selectionSet || update.docChanged) {
        updateCursorPosition(update.state)
        updateEditorSelectionSnapshot(update.state)
      }
    }),

    // 未选择内容时复制光标所在行
    EditorView.domEventHandlers({
      copy(event: ClipboardEvent, view: EditorView) {
        const { from, to } = view.state.selection.main
        if (from !== to) return false
        event.clipboardData?.setData('text/plain', view.state.doc.lineAt(from).text)
        event.preventDefault()
        return true
      }
    })
  ]

  return extensions
}

function closeSourceContextMenu(): void {
  sourceContextMenu.value.visible = false
}

function showSourceContextMenu(event: MouseEvent): void {
  event.preventDefault()
  const view = editorView.value
  if (!view) return
  sourceContextMenu.value = {
    visible: true,
    x: Math.min(event.clientX, window.innerWidth - 150),
    y: Math.min(event.clientY, window.innerHeight - 240),
    items: buildSourceContextMenuItems(view)
  }
}

function runHistoryCommand(command: (view: EditorView) => boolean): void {
  const view = editorView.value
  if (view) command(view)
  closeSourceContextMenu()
}

function buildSourceContextMenuItems(view: EditorView): EditorContextMenuItem[] {
  if (props.plainText) {
    return [
      { label: '撤销', action: () => runHistoryCommand(undo) },
      { label: '重做', action: () => runHistoryCommand(redo) }
    ]
  }

  return [
    { label: '撤销', action: () => runHistoryCommand(undo) },
    { label: '重做', action: () => runHistoryCommand(redo) },
    { label: '', divider: true },
    {
      label: '插入',
      children: [
        { label: '表格', action: () => insertTable(view) },
        { label: '代码块', action: () => view.dispatch({ changes: { from: view.state.selection.main.from, insert: '```\n\n```' } }) },
        { label: '图片', action: () => window.dispatchEvent(new CustomEvent('editor:showImageDialog')) },
        { label: '链接', action: () => window.dispatchEvent(new CustomEvent('editor:showLinkDialog')) },
        { label: '分割线', action: () => view.dispatch({ changes: { from: view.state.selection.main.from, insert: '\n---\n' } }) }
      ]
    },
    {
      label: '格式化',
      children: [
        { label: '标题 1', action: () => setHeadingLevel(view, 1) },
        { label: '标题 2', action: () => setHeadingLevel(view, 2) },
        { label: '标题 3', action: () => setHeadingLevel(view, 3) },
        { label: '引用块', action: () => prependLinePrefix(view, '> ') },
        { label: '无序列表', action: () => prependLinePrefix(view, '- ') },
        { label: '有序列表', action: () => prependLinePrefix(view, '1. ') }
      ]
    }
  ]
}

/**
 * Markdown 自动补全
 */
function markdownCompletions(context: { matchBefore: (regexp: RegExp) => { from: number; to: number; text: string } | null; explicit: boolean }): { from: number; options: Completion[] } | null {
  const word = context.matchBefore(/^\s*[#\-* >[]?/)
  if (!word && !context.explicit) return null

  const completions: Completion[] = [
    // 标题
    { label: '# ', type: 'keyword', detail: 'H1 标题', info: '一级标题' },
    { label: '## ', type: 'keyword', detail: 'H2 标题', info: '二级标题' },
    { label: '### ', type: 'keyword', detail: 'H3 标题', info: '三级标题' },
    { label: '#### ', type: 'keyword', detail: 'H4 标题', info: '四级标题' },
    
    // 列表
    { label: '- ', type: 'keyword', detail: '无序列表', info: '创建无序列表项' },
    { label: '1. ', type: 'keyword', detail: '有序列表', info: '创建有序列表项' },
    { label: '- [ ] ', type: 'keyword', detail: '任务列表', info: '创建未完成任务' },
    { label: '- [x] ', type: 'keyword', detail: '任务列表', info: '创建已完成任务' },
    
    // 引用和代码
    { label: '> ', type: 'keyword', detail: '引用块', info: '创建引用块' },
    { label: '```', type: 'keyword', detail: '代码块', info: '创建 fenced 代码块' },
    { label: '```js', type: 'keyword', detail: 'JS代码块', info: '创建 JavaScript 代码块' },
    { label: '```ts', type: 'keyword', detail: 'TS代码块', info: '创建 TypeScript 代码块' },
    { label: '```python', type: 'keyword', detail: 'Python代码块', info: '创建 Python 代码块' },
    
    // 行内格式
    { label: '**粗体**', type: 'text', detail: '粗体', apply: '****', boost: -1 },
    { label: '*斜体*', type: 'text', detail: '斜体', apply: '**', boost: -1 },
    { label: '`代码`', type: 'text', detail: '行内代码', apply: '``', boost: -1 },
    { label: '[链接](url)', type: 'text', detail: '链接', apply: '[]()', boost: -1 },
    { label: '![图片](url)', type: 'text', detail: '图片', apply: '![]()', boost: -1 },
    
    // 水平线
    { label: '---', type: 'keyword', detail: '分割线' },
    
    // 表格
    { label: '| 表头 | 表头 |', type: 'text', detail: '表格', apply: '|  |  |\n|---|---|\n|  |  |' }
  ]

  return {
    from: word?.from ?? 0,
    options: completions
  }
}

/**
 * 自定义快捷键
 */
const customKeymap = [
  // Ctrl+B: 粗体
  {
    key: 'Mod-b',
    run: (view: EditorView) => {
      wrapSelection(view, '**', '**')
      return true
    },
    preventDefault: true
  },
  // Ctrl+I: 斜体
  {
    key: 'Mod-i',
    run: (view: EditorView) => {
      wrapSelection(view, '*', '*')
      return true
    },
    preventDefault: true
  },
  // Ctrl+K: 插入链接
  {
    key: 'Mod-k',
    run: (view: EditorView) => {
      insertLink(view)
      return true
    },
    preventDefault: true
  },
  // Ctrl+Shift+K: 插入图片
  {
    key: 'Mod-Shift-k',
    run: (view: EditorView) => {
      insertImage(view)
      return true
    },
    preventDefault: true
  },
  // Ctrl+F: 查找（统一查找面板）
  {
    key: 'Mod-f',
    run: () => {
      openSearch(false)
      return true
    },
    preventDefault: true
  },
  // Ctrl+H: 替换（统一查找面板）
  {
    key: 'Mod-h',
    run: () => {
      openSearch(true)
      return true
    },
    preventDefault: true
  },
  // 列表项回车自动续行
  {
    key: 'Enter',
    run: (view: EditorView) => {
      return continueList(view) || false
    }
  },
  // Tab: 增加缩进（列表嵌套）
  {
    key: 'Tab',
    run: (view: EditorView) => {
      return indentList(view, true)
    }
  },
  // Shift+Tab: 减少缩进
  {
    key: 'Shift-Tab',
    run: (view: EditorView) => {
      return indentList(view, false)
    }
  },
    // Esc: 关闭查找面板
  {
    key: 'Escape',
    run: () => {
      if (searchOpen.value) {
        closeSearch()
        return true
      }
      return false
    }
  }
]

/**
 * 包裹选中文本
 */
function wrapSelection(view: EditorView, before: string, after: string): void {
  const { from, to } = view.state.selection.main
  const text = view.state.doc.sliceString(from, to)
  
  view.dispatch({
    changes: { from, to, insert: before + text + after },
    selection: { anchor: from + before.length + text.length }
  })
  
  view.focus()
}

/**
 * 插入链接
 */
function insertLink(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const text = view.state.doc.sliceString(from, to)
  
  if (text) {
    // 有选中文本，包裹为链接
    view.dispatch({
      changes: { from, to, insert: `[${text}]()` },
      selection: { anchor: from + text.length + 3 }
    })
  } else {
    // 无选中文本，插入占位符
    view.dispatch({
      changes: { from, insert: '[链接文本]()' },
      selection: { anchor: from + 6 }
    })
  }
  
  view.focus()
}

/**
 * 插入图片
 */
function insertImage(view: EditorView): void {
  const { from } = view.state.selection.main
  
  view.dispatch({
    changes: { from, insert: '![图片描述]()' },
    selection: { anchor: from + 7 }
  })
  
  view.focus()
}

function setHeadingLevel(view: EditorView, level: number): void {
  const line = view.state.doc.lineAt(view.state.selection.main.from)
  const text = line.text.replace(/^#{1,4}\s+/, '')
  const heading = `${'#'.repeat(level)} ${text}`
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: heading },
    selection: { anchor: line.from + heading.length }
  })
  view.focus()
}

/**
 * 列表项回车自动续行
 */
function continueList(view: EditorView): boolean {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const lineText = line.text
  
  // 匹配列表项
  const match = lineText.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
  if (match) {
    const [, indent, marker, content] = match
    
    // 如果列表项为空，取消列表
    if (!content.trim()) {
      view.dispatch({
        changes: { from: line.from, to: from, insert: '' }
      })
      return true
    }
    
    // 任务列表
    const taskMatch = marker.match(/^-\s*\[(.)\]$/)
    if (taskMatch) {
      view.dispatch({
        changes: { from, insert: `\n${indent}- [ ] ` }
      })
      return true
    }
    
    // 有序列表，递增数字
    if (/^\d+\./.test(marker)) {
      const num = parseInt(marker) + 1
      view.dispatch({
        changes: { from, insert: `\n${indent}${num}. ` }
      })
      return true
    }
    
    // 无序列表
    view.dispatch({
      changes: { from, insert: `\n${indent}${marker} ` }
    })
    return true
  }
  
  return false
}

/**
 * 列表缩进/反缩进
 */
function indentList(view: EditorView, increase: boolean): boolean {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const lineText = line.text
  
  // 检查是否是列表项
  if (/^\s*([-*]|\d+\.)\s/.test(lineText)) {
    if (increase) {
      view.dispatch({
        changes: { from: line.from, insert: '  ' }
      })
    } else if (lineText.startsWith('  ')) {
      view.dispatch({
        changes: { from: line.from, to: line.from + 2, insert: '' }
      })
    }
    view.focus()
    return true
  }
  
  return false
}

/**
 * 获取主题扩展
 */
function getThemeExtension(): Extension {
  const isDark = themeStore.isDark
  
  if (isDark) {
    // 深色主题：继承 oneDark 并增强选区样式
    return [
      oneDark,
      // 兜底着色器：oneDark 未覆盖的语言 tag（如 legacy 模式）使用默认配色；oneDark 作为主着色器优先生效
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.theme({
        '&': {
          backgroundColor: 'var(--color-bg-primary)'
        },
        '.cm-selectionBackground': {
          backgroundColor: 'rgba(96, 165, 250, 0.4) !important'
        },
        '.cm-selectionMatch': {
          backgroundColor: 'rgba(96, 165, 250, 0.3) !important'
        },
        '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
          backgroundColor: 'rgba(96, 165, 250, 0.5) !important'
        },
        '.cm-activeLine': {
          backgroundColor: 'rgba(96, 165, 250, 0.08)'
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'rgba(96, 165, 250, 0.08)'
        }
      })
    ]
  }
  
  // 浅色主题：使用完整的代码配色（替换 defaultHighlightStyle，补齐缺失 tag）
  return [
    syntaxHighlighting(codeHighlightLight),
    EditorView.theme({
    '&': {
      backgroundColor: 'var(--color-bg-primary)',
      color: 'var(--color-text)'
    },
    '.cm-content': {
      caretColor: 'var(--color-primary)'
    },
    '.cm-cursor': {
      borderLeftColor: 'var(--color-primary)'
    },
    '.cm-selectionBackground': {
      backgroundColor: 'rgba(59, 130, 246, 0.3) !important'
    },
    '.cm-selectionMatch': {
      backgroundColor: 'rgba(59, 130, 246, 0.2) !important'
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'rgba(59, 130, 246, 0.4) !important'
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(59, 130, 246, 0.05)'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(59, 130, 246, 0.05)'
    },
    '.cm-gutters': {
      backgroundColor: 'var(--color-bg-secondary)',
      borderRight: '1px solid var(--color-border)',
      color: 'var(--color-text-tertiary)'
    },
    '.cm-lineNumbers': {
      color: 'var(--color-text-tertiary)'
    }
    })
  ]
}

/**
 * 自定义编辑器样式
 */
const editorStyles = EditorView.theme({
  '&': {
    fontSize: 'calc(var(--editor-font-size, 16px) - 2px)',
    fontFamily: 'var(--font-mono)'
  },
  '.cm-content': {
    padding: '24px 32px',
    lineHeight: '1.6'
  },
  '.cm-line': {
    padding: '0 4px'
  },
  '.cm-gutters': {
    fontFamily: 'var(--font-mono)'
  },
  // Markdown 标记样式
  '.cm-heading': {
    fontWeight: 'bold',
    color: 'var(--color-primary)'
  },
  '.cm-link': {
    color: 'var(--color-primary)',
    textDecoration: 'underline'
  },
  '.cm-url': {
    color: 'var(--color-success)'
  },
  '.cm-emphasis': {
    fontStyle: 'italic'
  },
  '.cm-strong': {
    fontWeight: 'bold'
  },
  '.cm-strikethrough': {
    textDecoration: 'line-through'
  },
  '.cm-code': {
    fontFamily: 'var(--font-mono)',
    backgroundColor: 'var(--color-bg-secondary)',
    padding: '2px 4px',
    borderRadius: '3px'
  },
  '.cm-blockquote': {
    color: 'var(--color-text-secondary)',
    borderLeft: '3px solid var(--color-border)'
  },
  '.cm-list': {
    color: 'var(--color-text)'
  },
  '.cm-comment': {
    color: 'var(--color-text-tertiary)',
    fontStyle: 'italic'
  },
  '.cm-keyword': {
    color: 'var(--color-primary)',
    fontWeight: 'bold'
  },
  '.cm-string': {
    color: 'var(--color-success)'
  },
  '.cm-number': {
    color: 'var(--color-warning)'
  }
})

/**
 * 更新光标位置
 */
function updateCursorPosition(state: EditorState): void {
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  const lineNumber = line.number
  const column = pos - line.from + 1
  fileStore.setCursorPosition(lineNumber, column)
}

/**
 * 发布归一化的编辑器选区快照（CodeMirror 偏移即 Markdown 偏移）。
 * 无活动 tab 时发布 null。
 */
function updateEditorSelectionSnapshot(state: EditorState): void {
  const tabId = fileStore.activeTabId
  if (!tabId) {
    fileStore.updateEditorSelection(null)
    return
  }
  const { from, to, head } = state.selection.main
  const text = state.doc.sliceString(from, to)
  fileStore.updateEditorSelection({ tabId, from, to, cursor: head, text })
}

/**
 * 初始化编辑器
 */
function initEditor(): void {
  if (!editorRef.value) return

  const startState = EditorState.create({
    doc: fileStore.fileContent,
    extensions: createExtensions()
  })

  const view = new EditorView({
    state: startState,
    parent: editorRef.value
  })

  // 监听滚动事件
  const scroller = view.scrollDOM
  scroller.addEventListener('scroll', handleScroll)

  editorView.value = view
  updateCursorPosition(view.state)
  updateEditorSelectionSnapshot(view.state)

  if (props.plainText) loadPlainLanguage(view)
}

/**
 * 纯文本模式按文件后缀懒加载语法高亮（复用主题 compartment 模式）
 * 语言包加载失败时静默降级为无高亮纯文本
 */
function loadPlainLanguage(view: EditorView): void {
  if (!langCompartment) return
  const name = fileStore.activeTab?.fileInfo?.name ?? ''
  const desc = name ? findCodeLanguage(name) : null
  if (!desc) return
  void desc
    .load()
    .then((support) => {
      // 组件可能已被销毁或切换到其他 tab（:key 重建），仅作用于当前视图
      if (editorView.value !== view) return
      view.dispatch({ effects: langCompartment!.reconfigure(support) })
    })
    .catch((err: unknown) => {
      // 降级为无高亮纯文本，但保留诊断信息
      console.warn(`[SourceEditor] 语法高亮语言包加载失败: ${name}`, err)
    })
}

/**
 * 处理滚动事件
 */
function handleScroll(): void {
  if (isSyncing) return
  const view = editorView.value
  if (!view) return

  const scroller = view.scrollDOM
  const maxScroll = scroller.scrollHeight - scroller.clientHeight
  if (maxScroll > 0) {
    const ratio = scroller.scrollTop / maxScroll
    emit('scroll', ratio)
  }
}

/**
 * 销毁编辑器
 */
function destroyEditor(): void {
  const view = editorView.value
  if (view) {
    view.scrollDOM.removeEventListener('scroll', handleScroll)
    view.destroy()
  }
  editorView.value = null
}

/**
 * 处理拖放事件 - 图片拖放
 */
function handleDragOver(e: DragEvent): void {
  e.preventDefault()
}

async function handleDrop(e: DragEvent): Promise<void> {
  e.preventDefault()

  if (!e.dataTransfer) return

  const files = Array.from(e.dataTransfer.files)
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      await insertImageFromFile(file)
    }
  }
}

/**
 * 处理粘贴事件 - 图片粘贴
 */
async function handlePaste(e: ClipboardEvent): Promise<void> {
  if (!e.clipboardData) return

  // 优先处理图片文件
  const files = Array.from(e.clipboardData.files)
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      e.preventDefault()
      await insertImageFromFile(file)
      return
    }
  }
}

/**
 * 从文件插入图片
 */
async function insertImageFromFile(file: File): Promise<void> {
  const view = editorView.value
  if (!view) return

  const result = await fileStore.addImage(file)
  if (result.success && result.path) {
    const { from } = view.state.selection.main
    view.dispatch({
      changes: { from, insert: `![${file.name}](${result.path})` }
    })
    view.focus()
  }
}

/**
 * 更新编辑器主题
 */
function updateTheme(): void {
  const view = editorView.value
  if (!view || !themeCompartment) return
  
  view.dispatch({
    effects: themeCompartment.reconfigure(getThemeExtension())
  })
}

// ========== 工具栏事件处理 ==========

function handleFormatEvent(e: Event): void {
  if (props.plainText) return
  const view = editorView.value
  if (!view) return

  const format = (e as CustomEvent).detail as string
  switch (format) {
    case 'bold':
      wrapSelection(view, '**', '**')
      break
    case 'italic':
      wrapSelection(view, '*', '*')
      break
    case 'strikethrough':
      wrapSelection(view, '~~', '~~')
      break
    case 'unorderedList':
      prependLinePrefix(view, '- ')
      break
    case 'orderedList':
      prependLinePrefix(view, '1. ')
      break
    case 'blockquote':
      prependLinePrefix(view, '> ')
      break
    case 'table':
      insertTable(view)
      break
    case 'horizontalRule': {
      const { from } = view.state.selection.main
      view.dispatch({ changes: { from, insert: '\n---\n' }, selection: { anchor: from + 5 } })
      break
    }
  }
  view.focus()
}

function handleHeadingEvent(e: Event): void {
  if (props.plainText) return
  const view = editorView.value
  if (!view) return

  const level = (e as CustomEvent).detail as number
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)

  // 移除已有标题标记
  const existingMatch = line.text.match(/^(#{0,4})\s/)
  const currentLevel = existingMatch ? existingMatch[1].length : 0

  let newText: string
  if (level === 0) {
    newText = line.text.replace(/^#{1,4}\s+/, '')
  } else if (currentLevel > 0) {
    newText = line.text.replace(/^#{1,4}\s*/, '#'.repeat(level) + ' ')
  } else {
    newText = '#'.repeat(level) + ' ' + line.text
  }

  view.dispatch({ changes: { from: line.from, to: line.to, insert: newText } })
  view.focus()
}

function handleLinkEvent(e: Event): void {
  if (props.plainText) return
  const view = editorView.value
  if (!view) return

  const { href, title } = (e as CustomEvent).detail as { href: string; title: string }
  const { from, to } = view.state.selection.main
  const selectedText = view.state.doc.sliceString(from, to)
  const linkText = title || selectedText || '链接文本'
  const insert = `[${linkText}](${href})`

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + 1, head: from + 1 + linkText.length }
  })
  view.focus()
}

function handleImageEvent(e: Event): void {
  if (props.plainText) return
  const view = editorView.value
  if (!view) return

  const { src, alt } = (e as CustomEvent).detail as { src: string; alt: string }
  const { from } = view.state.selection.main
  const altText = alt || '图片'
  const insert = `![${altText}](${src})`

  view.dispatch({
    changes: { from, insert },
    selection: { anchor: from + 2, head: from + 2 + altText.length }
  })
  view.focus()
}

function handleCodeBlockEvent(e: Event): void {
  if (props.plainText) return
  const view = editorView.value
  if (!view) return

  const { language } = (e as CustomEvent).detail as { language?: string }
  const { from } = view.state.selection.main
  const lang = language || ''
  const insert = `\n\`\`\`${lang}\n\n\`\`\`\n`

  view.dispatch({
    changes: { from, insert },
    selection: { anchor: from + 4 + lang.length + 1 }
  })
  view.focus()
}

function handleUndoEvent(): void {
  const view = editorView.value
  if (!view) return
  undo(view)
  view.focus()
}

function handleRedoEvent(): void {
  const view = editorView.value
  if (!view) return
  redo(view)
  view.focus()
}

async function handleCopyEvent(): Promise<void> {
  const view = editorView.value
  if (!view) return
  const { from, to } = view.state.selection.main
  if (from !== to) {
    await window.electronAPI?.clipboardWriteText(view.state.doc.sliceString(from, to))
  } else {
    const line = view.state.doc.lineAt(from)
    await window.electronAPI?.clipboardWriteText(line.text)
  }
  view.focus()
}

function handleAttachmentEvent(e: Event): void {
  if (props.plainText) return
  const view = editorView.value
  if (!view) return
  const { path, name } = (e as CustomEvent).detail as { path: string; name: string }
  const { from, to } = view.state.selection.main
  const insert = `[${name}](${path})`
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
  view.focus()
}

async function handleCutEvent(): Promise<void> {
  const view = editorView.value
  if (!view) return
  const { from, to } = view.state.selection.main
  if (from === to) return
  await window.electronAPI?.clipboardWriteText(view.state.doc.sliceString(from, to))
  view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } })
  view.focus()
}

async function handlePasteEvent(): Promise<void> {
  const view = editorView.value
  if (!view) return
  const text = await window.electronAPI?.clipboardReadText()
  if (!text) return
  const { from, to } = view.state.selection.main
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length }
  })
  view.focus()
}

function handleSearchEvent(): void {
  openSearch(false)
}

function handleReplaceEvent(): void {
  openSearch(true)
}

function handleModeToggleKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === '/') {
    event.preventDefault()
    event.stopPropagation()
    window.dispatchEvent(new CustomEvent('editor:toggleMode'))
  }
}

function openSearch(replaceMode = false): void {
  searchReplaceMode.value = replaceMode
  searchOpen.value = true
}

function closeSearch(): void {
  searchOpen.value = false
  searchMatches.value = []
  currentMatchIndex.value = -1
  const view = editorView.value
  if (view) {
    view.dispatch({ effects: searchDecoEffect.of(Decoration.none) })
  }
  editorView.value?.focus()
}

function computeMatches(text: string, query: string, caseSensitive: boolean): Array<{ from: number; to: number }> {
  const matches: Array<{ from: number; to: number }> = []
  if (!query) return matches
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  let idx = hay.indexOf(needle)
  while (idx !== -1) {
    matches.push({ from: idx, to: idx + query.length })
    idx = hay.indexOf(needle, idx + query.length)
  }
  return matches
}

function applySearchState(view: EditorView): void {
  const decos = searchMatches.value.map((m, i) =>
    Decoration.mark({
      class: i === currentMatchIndex.value ? 'cm-searchMatch cm-searchMatch-selected' : 'cm-searchMatch'
    }).range(m.from, m.to)
  )
  const m = searchMatches.value[currentMatchIndex.value]
  if (m) {
    view.dispatch({
      effects: searchDecoEffect.of(Decoration.set(decos)),
      selection: { anchor: m.from, head: m.to },
      scrollIntoView: true
    })
  } else {
    view.dispatch({ effects: searchDecoEffect.of(Decoration.set(decos)) })
  }
}

function handleSearch(query: string, caseSensitive: boolean): void {
  const view = editorView.value
  if (!view) return
  lastSearchQuery.value = query
  lastCaseSensitive.value = caseSensitive
  searchMatches.value = computeMatches(view.state.doc.toString(), query, caseSensitive)
  if (searchMatches.value.length === 0) {
    currentMatchIndex.value = -1
  } else if (currentMatchIndex.value < 0 || currentMatchIndex.value >= searchMatches.value.length) {
    currentMatchIndex.value = 0
  }
  applySearchState(view)
}

function nextMatch(): void {
  const view = editorView.value
  if (!view || searchMatches.value.length === 0) return
  currentMatchIndex.value = (currentMatchIndex.value + 1) % searchMatches.value.length
  applySearchState(view)
  view.focus()
}

function prevMatch(): void {
  const view = editorView.value
  if (!view || searchMatches.value.length === 0) return
  currentMatchIndex.value = (currentMatchIndex.value - 1 + searchMatches.value.length) % searchMatches.value.length
  applySearchState(view)
  view.focus()
}

function handleReplace(query: string, replaceText: string, caseSensitive: boolean): void {
  const view = editorView.value
  const m = searchMatches.value[currentMatchIndex.value]
  if (!view || !m) return
  view.dispatch({ changes: { from: m.from, to: m.to, insert: replaceText } })
  handleSearch(query, caseSensitive)
}

function handleReplaceAll(query: string, replaceText: string, caseSensitive: boolean): void {
  const view = editorView.value
  if (!view || searchMatches.value.length === 0) return
  const changes = searchMatches.value.map((m) => ({ from: m.from, to: m.to, insert: replaceText }))
  view.dispatch({ changes })
  handleSearch(query, caseSensitive)
}

/** 在当前行首插入前缀 */
function prependLinePrefix(view: EditorView, prefix: string): void {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)

  // 如果已有相同前缀则移除
  if (line.text.startsWith(prefix)) {
    const newText = line.text.slice(prefix.length)
    view.dispatch({ changes: { from: line.from, to: line.to, insert: newText } })
  } else {
    // 移除其他列表前缀
    const cleaned = line.text.replace(/^[-*]\s|\d+\.\s|>\s/, '')
    view.dispatch({ changes: { from: line.from, to: line.to, insert: prefix + cleaned } })
  }
}

/** 插入表格 */
function insertTable(view: EditorView): void {
  const { from } = view.state.selection.main
  const table = [
    '| 列1 | 列2 | 列3 |',
    '| --- | --- | --- |',
    '| 内容 | 内容 | 内容 |'
  ].join('\n')

  view.dispatch({
    changes: { from, insert: '\n' + table + '\n' },
    selection: { anchor: from + 3 }
  })
}

// Lifecycle
onMounted(() => {
  initEditor()

  // 添加拖放和粘贴事件监听
  const editorEl = editorRef.value
  if (editorEl) {
    editorEl.addEventListener('dragover', handleDragOver)
    editorEl.addEventListener('drop', handleDrop)
    editorEl.addEventListener('paste', handlePaste)
    editorEl.addEventListener('keydown', handleModeToggleKeydown)
  }

  // 工具栏事件监听
  window.addEventListener('editor:format', handleFormatEvent)
  window.addEventListener('editor:heading', handleHeadingEvent)
  window.addEventListener('editor:link', handleLinkEvent)
  window.addEventListener('editor:image', handleImageEvent)
  window.addEventListener('editor:attachment', handleAttachmentEvent)
  window.addEventListener('editor:codeBlock', handleCodeBlockEvent)
  window.addEventListener('editor:undo', handleUndoEvent)
  window.addEventListener('editor:redo', handleRedoEvent)
  window.addEventListener('editor:cut', handleCutEvent)
  window.addEventListener('editor:copy', handleCopyEvent)
  window.addEventListener('editor:paste', handlePasteEvent)
  window.addEventListener('editor:find', handleSearchEvent)
  window.addEventListener('editor:replace', handleReplaceEvent)
  document.addEventListener('click', closeSourceContextMenu)
})

onUnmounted(() => {
  // 移除事件监听
  const editorEl = editorRef.value
  if (editorEl) {
    editorEl.removeEventListener('dragover', handleDragOver)
    editorEl.removeEventListener('drop', handleDrop)
    editorEl.removeEventListener('paste', handlePaste)
    editorEl.removeEventListener('keydown', handleModeToggleKeydown)
  }

  window.removeEventListener('editor:format', handleFormatEvent)
  window.removeEventListener('editor:heading', handleHeadingEvent)
  window.removeEventListener('editor:link', handleLinkEvent)
  window.removeEventListener('editor:image', handleImageEvent)
  window.removeEventListener('editor:attachment', handleAttachmentEvent)
  window.removeEventListener('editor:codeBlock', handleCodeBlockEvent)
  window.removeEventListener('editor:undo', handleUndoEvent)
  window.removeEventListener('editor:redo', handleRedoEvent)
  window.removeEventListener('editor:cut', handleCutEvent)
  window.removeEventListener('editor:copy', handleCopyEvent)
  window.removeEventListener('editor:paste', handlePasteEvent)
  window.removeEventListener('editor:find', handleSearchEvent)
  window.removeEventListener('editor:replace', handleReplaceEvent)
  document.removeEventListener('click', closeSourceContextMenu)

  destroyEditor()
})

// Watch for content changes from store (incremental diff sync)
watch(() => [fileStore.activeTabId, fileStore.fileContent] as const, ([newTabId, newContent], [oldTabId]) => {
  const view = editorView.value
  if (!view) return

  const currentContent = view.state.doc.toString()
  const tabChanged = newTabId !== oldTabId
  if (currentContent === newContent) {
    if (tabChanged) view.dispatch({ selection: { anchor: 0 } })
    updateCursorPosition(view.state)
    updateEditorSelectionSnapshot(view.state)
    return
  }

  isSyncing = true

  let prefixLen = 0
  const minLen = Math.min(currentContent.length, newContent.length)
  while (prefixLen < minLen && currentContent[prefixLen] === newContent[prefixLen]) prefixLen++
  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen &&
    currentContent[currentContent.length - 1 - suffixLen] === newContent[newContent.length - 1 - suffixLen]
  ) suffixLen++

  view.dispatch({
    changes: {
      from: prefixLen,
      to: currentContent.length - suffixLen,
      insert: newContent.slice(prefixLen, newContent.length - suffixLen)
    },
    selection: tabChanged ? { anchor: 0 } : undefined
  })
  isSyncing = false
  updateCursorPosition(view.state)
  updateEditorSelectionSnapshot(view.state)
})

// Watch for theme changes
watch(() => themeStore.currentTheme, updateTheme)
watch(() => themeStore.systemPreference, updateTheme)

// Expose methods for parent component
defineExpose({
  focus: () => editorView.value?.focus(),
  getView: () => editorView.value,
  scrollTo: (ratio: number) => {
    const view = editorView.value
    if (!view) return
    const scroller = view.scrollDOM
    const maxScroll = scroller.scrollHeight - scroller.clientHeight
    if (maxScroll > 0) {
      scroller.scrollTop = ratio * maxScroll
    }
  }
})
</script>

<template>
  <div class="source-container">
    <div
      ref="editorRef"
      class="codemirror-wrapper"
      @contextmenu="showSourceContextMenu"
    />
    <FindReplacePanel
      :open="searchOpen"
      :replace-mode="searchReplaceMode"
      :match-count="searchMatches.length"
      :current-index="currentMatchIndex"
      @close="closeSearch"
      @search="handleSearch"
      @next="nextMatch"
      @prev="prevMatch"
      @replace="handleReplace"
      @replace-all="handleReplaceAll"
    />
    <EditorContextMenu
      :visible="sourceContextMenu.visible"
      :x="sourceContextMenu.x"
      :y="sourceContextMenu.y"
      :items="sourceContextMenu.items"
      @close="closeSourceContextMenu"
    />
  </div>
</template>

<style scoped>
.source-container {
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  background-color: var(--color-bg-primary);
}

.codemirror-wrapper {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.codemirror-wrapper :deep(.cm-editor) {
  height: 100%;
}

.codemirror-wrapper :deep(.cm-scroller) {
  font-family: var(--font-mono);
  overflow: auto;
}

/* 自动补全面板样式 */
.codemirror-wrapper :deep(.cm-tooltip) {
  background-color: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.codemirror-wrapper :deep(.cm-tooltip-section) {
  padding: 4px 0;
}

.codemirror-wrapper :deep(.cm-completionLabel) {
  color: var(--color-text);
  font-family: var(--font-mono);
}

.codemirror-wrapper :deep(.cm-completionDetail) {
  color: var(--color-text-secondary);
  font-size: 12px;
  margin-left: 8px;
}

.codemirror-wrapper :deep(.cm-completionInfo) {
  color: var(--color-text-tertiary);
  font-size: 12px;
  padding: 4px 8px;
}

.codemirror-wrapper :deep(.cm-completionMatchedText) {
  color: var(--color-primary);
  font-weight: bold;
  text-decoration: none;
}

.codemirror-wrapper :deep(.cm-tooltip-autocomplete) ul li[aria-selected] {
  background-color: var(--color-bg-secondary);
}

.codemirror-wrapper :deep(.cm-completionIcon) {
  width: 16px;
  height: 16px;
  margin-right: 8px;
}

.codemirror-wrapper :deep(.cm-completionIcon-keyword) {
  color: var(--color-primary);
}

.codemirror-wrapper :deep(.cm-completionIcon-text) {
  color: var(--color-text-secondary);
}

/* 查找替换面板样式 */
.codemirror-wrapper :deep(.cm-panel) {
  background-color: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  padding: 8px 16px;
}

.codemirror-wrapper :deep(.cm-panel label) {
  color: var(--color-text);
  font-size: 12px;
  margin-right: 8px;
}

.codemirror-wrapper :deep(.cm-panel input) {
  background-color: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  color: var(--color-text);
  font-size: 13px;
  margin-right: 8px;
}

.codemirror-wrapper :deep(.cm-panel input:focus) {
  outline: none;
  border-color: var(--color-primary);
}

.codemirror-wrapper :deep(.cm-panel button) {
  background-color: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 4px 12px;
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  margin-right: 4px;
}

.codemirror-wrapper :deep(.cm-panel button:hover) {
  background-color: var(--color-border);
}

.codemirror-wrapper :deep(.cm-panel button[name="close"]) {
  position: absolute;
  right: 8px;
  top: 8px;
  background: transparent;
  border: none;
  font-size: 16px;
  padding: 4px 8px;
}

.codemirror-wrapper :deep(.cm-searchMatch) {
  background-color: var(--color-warning);
  color: var(--color-text);
}

.codemirror-wrapper :deep(.cm-searchMatch-selected) {
  background-color: var(--color-primary);
  color: white;
}

/* git 冲突标记行高亮 */
.codemirror-wrapper :deep(.cm-line.cm-conflict-marker) {
  background-color: rgba(239, 68, 68, 0.16);
}

[data-theme='dark'] .codemirror-wrapper :deep(.cm-line.cm-conflict-marker) {
  background-color: rgba(239, 68, 68, 0.25);
}

/* 选区样式 - 确保选中效果更明显 */
.codemirror-wrapper :deep(.cm-selectionBackground) {
  background-color: rgba(59, 130, 246, 0.3) !important;
}

.codemirror-wrapper :deep(.cm-selectionMatch) {
  background-color: rgba(59, 130, 246, 0.2) !important;
}

.codemirror-wrapper :deep(.cm-focused) .cm-selectionBackground {
  background-color: rgba(59, 130, 246, 0.4) !important;
}

/* 深色主题选区样式 */
[data-theme='dark'] .codemirror-wrapper :deep(.cm-selectionBackground) {
  background-color: rgba(96, 165, 250, 0.4) !important;
}

[data-theme='dark'] .codemirror-wrapper :deep(.cm-selectionMatch) {
  background-color: rgba(96, 165, 250, 0.3) !important;
}

[data-theme='dark'] .codemirror-wrapper :deep(.cm-focused) .cm-selectionBackground {
  background-color: rgba(96, 165, 250, 0.5) !important;
}

/* 当前行背景 - 降低透明度让选区更明显 */
.codemirror-wrapper :deep(.cm-activeLine) {
  background-color: rgba(59, 130, 246, 0.05) !important;
}

.codemirror-wrapper :deep(.cm-activeLineGutter) {
  background-color: rgba(59, 130, 246, 0.05) !important;
}

[data-theme='dark'] .codemirror-wrapper :deep(.cm-activeLine) {
  background-color: rgba(96, 165, 250, 0.08) !important;
}

[data-theme='dark'] .codemirror-wrapper :deep(.cm-activeLineGutter) {
  background-color: rgba(96, 165, 250, 0.08) !important;
}
</style>
