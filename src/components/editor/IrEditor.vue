<script setup lang="ts">
import {
  ref,
  shallowRef,
  reactive,
  watch,
  onMounted,
  onUnmounted,
  nextTick,
} from 'vue'
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconCopy,
  IconTrash
} from '@tabler/icons-vue'
import { useFileStore } from '../../stores/file'
import { findHeadingForAnchor } from '../../utils/prosemirror/anchors'
import { useThemeStore } from '../../stores/theme'
import { storeToRefs } from 'pinia'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import { EditorState } from 'prosemirror-state'
import { Plugin as ProseMirrorPlugin, PluginKey } from 'prosemirror-state'
import {
  markdownSchema,
  parseMarkdown,
  serializeMarkdown,
  createPlugins,
  createDocumentChangePlugin,
  taskListClickPlugin,
  toggleHeading,
  insertLink,
  createIRPlugin,
  createPastePlugin,
  getListClipboard,
} from '../../utils/prosemirror'
import { findMatches, type SearchMatch } from '../../utils/prosemirror/search'
import { NodeSelection, Selection, TextSelection } from 'prosemirror-state'
import { wrapIn, setBlockType } from 'prosemirror-commands'
import { undo, redo } from 'prosemirror-history'
import { wrapInList } from 'prosemirror-schema-list'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import katex from 'katex'
import type { NodeView, ViewMutationRecord } from 'prosemirror-view'
import { getHighlighter, type Highlighter } from '../../utils/shiki'
import EditorContextMenu from '../common/EditorContextMenu.vue'
import Tooltip from '../common/Tooltip.vue'
import FindReplacePanel from './FindReplacePanel.vue'
import type { EditorContextMenuItem } from '../../types/editor-context-menu'
import {
  addColumnBefore,
  addColumnAfter,
  deleteColumn,
  addRowBefore,
  addRowAfter,
  deleteRow,
  deleteTable,
  isInTable,
  selectedRect,
  cellAround,
} from 'prosemirror-tables'

class MathInlineView implements NodeView {
  dom: HTMLSpanElement
  private node
  constructor(node: any) {
    this.node = node
    this.dom = document.createElement('span')
    this.dom.className = 'math-inline'
    this.dom.contentEditable = 'false'
    this.renderMath()
  }
  update(node: any) {
    if (node.type.name !== 'math_inline') return false
    this.node = node
    this.renderMath()
    return true
  }
  private renderMath() {
    try {
      this.dom.innerHTML = katex.renderToString(this.node.attrs.source || '', { displayMode: false, throwOnError: false })
    } catch {
      this.dom.textContent = '$' + (this.node.attrs.source || '') + '$'
    }
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode') }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode') }
  stopEvent(): boolean { return true }
  ignoreMutation(): boolean { return true }
  destroy() {}
}

class MathBlockView implements NodeView {
  dom: HTMLDivElement
  private node
  constructor(node: any) {
    this.node = node
    this.dom = document.createElement('div')
    this.dom.className = 'math-block'
    this.dom.setAttribute('data-type', 'math_block')
    this.dom.contentEditable = 'false'
    this.renderMath()
  }
  update(node: any) {
    if (node.type.name !== 'math_block') return false
    this.node = node
    this.renderMath()
    return true
  }
  private renderMath() {
    try {
      this.dom.innerHTML = katex.renderToString(this.node.attrs.source || '', { displayMode: true, throwOnError: false })
    } catch {
      this.dom.textContent = '$$\n' + (this.node.attrs.source || '') + '\n$$'
    }
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode') }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode') }
  stopEvent(): boolean { return true }
  ignoreMutation(): boolean { return true }
  destroy() {}
}

const fileStore = useFileStore()
const themeStore = useThemeStore()
const ctrlPressed = ref(false)
const clearCtrlPressedOnBlur = (): void => { ctrlPressed.value = false }
const { fileContent, activeTabId } = storeToRefs(fileStore)
const containerRef = ref<HTMLDivElement>()
const editorRef = ref<HTMLDivElement>()
const tableToolbarRef = ref<HTMLDivElement>()
const viewRef = shallowRef<EditorView | null>(null)
let editorTabId: string | null = null

// ====== 查找 / 替换状态 ======
const searchOpen = ref(false)
const searchReplaceMode = ref(false)
const searchMatches = ref<SearchMatch[]>([])
const currentMatchIndex = ref(-1)
const lastSearchQuery = ref('')
const lastCaseSensitive = ref(false)

const isDragging = ref(false)
const tableToolbar = reactive({
  visible: false,
  x: 0,
  y: 0,
  tablePos: -1,
  align: null as 'left' | 'center' | 'right' | null
})
const shikiHighlighter = shallowRef<Highlighter | null>(null)
let highlightRequest = 0

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'inkase:close-context-menus'

function focusEditor(): void {
  const view = viewRef.value
  if (!view || view.isDestroyed) return

  // 先让浏览器产生真实的 focus 事件，再让 ProseMirror 同步 selection。
  view.dom.focus({ preventScroll: true })
  view.focus()
}

const supportedCodeLanguages = [
  { value: '', label: '纯文本' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'scss', label: 'SCSS' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'xml', label: 'XML' },
  { value: 'sql', label: 'SQL' },
  { value: 'bash', label: 'Bash' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'vue', label: 'Vue' },
  { value: 'svelte', label: 'Svelte' },
  { value: 'lua', label: 'Lua' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'php', label: 'PHP' },
  { value: 'swift', label: 'Swift' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'text', label: '纯文本' }
]

function normalizeCodeLanguage(language: string): string {
  const aliases: Record<string, string> = {
    'c++': 'cpp',
    'c#': 'csharp',
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    sh: 'bash',
    shell: 'bash'
  }
  return aliases[language.toLowerCase()] || language.toLowerCase()
}

class CodeBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private select: HTMLSelectElement
  private view: EditorView
  private getPos: () => number

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number) {
    this.view = view
    this.getPos = getPos
    this.dom = document.createElement('pre')
    this.dom.className = 'ir-code-block'
    this.select = document.createElement('select')
    this.select.className = 'ir-code-language'
    this.select.title = '选择代码语言'
    for (const language of supportedCodeLanguages) {
      const option = document.createElement('option')
      option.value = language.value
      option.textContent = language.label
      this.select.appendChild(option)
    }
    this.select.value = normalizeCodeLanguage(node.attrs.language || '')
    this.select.addEventListener('mousedown', (event) => event.stopPropagation())
    this.select.addEventListener('change', this.handleLanguageChange)
    this.dom.appendChild(this.select)
    this.contentDOM = document.createElement('code')
    this.contentDOM.className = node.attrs.language ? `language-${node.attrs.language}` : ''
    this.dom.appendChild(this.contentDOM)
  }

  private handleLanguageChange = (): void => {
    const language = this.select.value
    this.view.dispatch(this.view.state.tr.setNodeMarkup(this.getPos(), undefined, { language }))
    this.view.focus()
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== 'code_block') return false
    this.select.value = normalizeCodeLanguage(node.attrs.language || '')
    this.contentDOM.className = node.attrs.language ? `language-${node.attrs.language}` : ''
    return true
  }

  stopEvent(event: Event): boolean {
    return event.target === this.select || this.select.contains(event.target as Node)
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    // contentDOM 内的文本变更必须交给 ProseMirror 处理，否则空代码块中
    // 输入回车、删除到空以及鼠标选区都无法同步到文档模型。
    if (mutation.type === 'selection') return false
    return !this.contentDOM.contains(mutation.target)
  }
}

const codeHighlightKey = new PluginKey<DecorationSet>('ir-code-highlight')

function createCodeHighlightPlugin(): ProseMirrorPlugin {
  return new ProseMirrorPlugin<DecorationSet>({
    key: codeHighlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, decorations) {
        const meta = tr.getMeta(codeHighlightKey)
        if (meta instanceof DecorationSet) return meta
        return decorations.map(tr.mapping, tr.doc)
      }
    },
    view(view) {
      let scheduled = false

      const schedule = (): void => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          void updateCodeHighlights(view)
        })
      }

      schedule()
      return {
        update(updatedView, previousState) {
          // 高亮结果本身通过 decoration 事务写回，不应再次触发高亮。
          if (!updatedView.state.doc.eq(previousState.doc)) schedule()
        }
      }
    },
    props: {
      decorations(state) {
        return codeHighlightKey.getState(state) || DecorationSet.empty
      }
    }
  })
}

async function updateCodeHighlights(view: EditorView): Promise<void> {
  const highlighter = shikiHighlighter.value
  if (!highlighter || view.isDestroyed) return

  const request = ++highlightRequest
  const theme = themeStore.isDark ? 'github-dark' : 'github-light'
  const codeBlocks: Array<{ node: typeof view.state.doc; pos: number }> = []

  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'code_block') codeBlocks.push({ node: node as typeof view.state.doc, pos })
  })

  const decorations: Decoration[] = []
  const BATCH_SIZE = 4

  for (let i = 0; i < codeBlocks.length; i += BATCH_SIZE) {
    if (request !== highlightRequest || view.isDestroyed) return
    const batch = codeBlocks.slice(i, i + BATCH_SIZE)

    for (const { node, pos } of batch) {
      const language = normalizeCodeLanguage(node.attrs.language || 'text')
      const code = node.textContent
      try {
        const tokenLines = await highlighter.codeToTokensBase(code, {
          lang: language as import('shiki').BundledLanguage,
          theme
        }) as Array<Array<{
          content: string
          color?: string
          fontStyle?: number
        }>>
        let offset = 0

        for (const line of tokenLines) {
          for (const token of line) {
            const length = token.content.length
            if (length > 0 && token.color) {
              const styles = [`color: ${token.color}`]
              if (token.fontStyle === 1 || token.fontStyle === 3) styles.push('font-style: italic')
              if (token.fontStyle === 2 || token.fontStyle === 3) styles.push('font-weight: 700')
              decorations.push(Decoration.inline(pos + 1 + offset, pos + 1 + offset + length, {
                style: styles.join('; ')
              }))
            }
            offset += length
          }
          offset += 1
        }
      } catch {
        // 未知语言保持编辑器默认文本颜色。
      }
    }

    // 批间让出事件循环，保持 UI 响应
    if (i + BATCH_SIZE < codeBlocks.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (request !== highlightRequest || view.isDestroyed) return
    }
  }

  if (request !== highlightRequest || view.isDestroyed) return
  view.dispatch(view.state.tr.setMeta(codeHighlightKey, DecorationSet.create(view.state.doc, decorations)))
}

async function initShiki(): Promise<void> {
  try {
    shikiHighlighter.value = await getHighlighter()
    if (viewRef.value) void updateCodeHighlights(viewRef.value)
  } catch (error) {
    console.error('IR 模式代码高亮初始化失败:', error)
  }
}

// 右键菜单状态
type ContextMenuItem = EditorContextMenuItem

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  items: ContextMenuItem[]
  type: 'table' | 'general' | null
  activeSubmenu: string | null
}

const contextMenu = reactive<ContextMenuState>({
  visible: false,
  x: 0,
  y: 0,
  items: [],
  type: null,
  activeSubmenu: null
})

// 标记是否正在从 store 同步内容到编辑器（避免 createDocumentChangePlugin 回写 store 造成循环）
let isUpdatingFromStore = false

// 关闭右键菜单
function closeContextMenu() {
  contextMenu.visible = false
  contextMenu.type = null
  contextMenu.activeSubmenu = null
}

function hideTableToolbar(): void {
  tableToolbar.visible = false
  tableToolbar.tablePos = -1
  tableToolbar.align = null
}

function getTableContext(view: EditorView): { pos: number; node: ProseMirrorNode } | null {
  const cell = cellAround(view.state.selection.$from)
  if (!cell) return null
  const table = cell.node(-1)
  return { pos: cell.start(-1) - 1, node: table }
}

function getTableAlign(table: ProseMirrorNode): 'left' | 'center' | 'right' | null {
  const firstRow = table.firstChild
  const firstCell = firstRow?.firstChild
  const align = firstCell?.attrs.align
  return align === 'left' || align === 'center' || align === 'right' ? align : null
}

function updateTableToolbar(view: EditorView): void {
  const context = getTableContext(view)
  if (!context || !containerRef.value || !editorRef.value) {
    hideTableToolbar()
    return
  }

  const tableElement = view.nodeDOM(context.pos) as HTMLElement | null
  if (!tableElement) {
    hideTableToolbar()
    return
  }

  const containerRect = containerRef.value.getBoundingClientRect()
  const tableRect = tableElement.getBoundingClientRect()
  const scrollTop = containerRef.value.scrollTop || 0
  const scrollLeft = containerRef.value.scrollLeft || 0
  const toolbarWidth = tableToolbarRef.value?.offsetWidth || 196
  const toolbarHeight = tableToolbarRef.value?.offsetHeight || 36
  const gap = 6
  const maxX = Math.max(8, containerRect.width - toolbarWidth - 8)
  const x = Math.min(Math.max(8, tableRect.left - containerRect.left + scrollLeft), maxX)
  const aboveY = tableRect.top - containerRect.top + scrollTop - toolbarHeight - gap
  const belowY = tableRect.bottom - containerRect.top + scrollTop + gap

  tableToolbar.visible = true
  tableToolbar.x = x
  tableToolbar.y = aboveY >= 8 ? aboveY : belowY
  tableToolbar.tablePos = context.pos
  tableToolbar.align = getTableAlign(context.node)
}

function handleTableToolbarLayout(): void {
  const view = viewRef.value
  if (view) updateTableToolbar(view)
}

function setTableAlign(view: EditorView, align: 'left' | 'center' | 'right'): void {
  const context = getTableContext(view)
  if (!context) return
  let tr = view.state.tr
  context.node.descendants((node, pos) => {
    if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
      tr = tr.setNodeMarkup(context.pos + 1 + pos, undefined, { ...node.attrs, align })
    }
    return true
  })
  view.dispatch(tr)
  view.focus()
  nextTick(() => updateTableToolbar(view))
}

function escapeHtmlForClipboard(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function tableToHtml(table: ProseMirrorNode): string {
  const rows: string[] = []
  table.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell) => {
      const tag = cell.type.name === 'table_header' ? 'th' : 'td'
      const align = cell.attrs.align as string | null
      const styleAttr = align ? ` style="text-align:${align}"` : ''
      cells.push(`<${tag}${styleAttr}>${escapeHtmlForClipboard(cell.textContent)}</${tag}>`)
    })
    rows.push(`<tr>${cells.join('')}</tr>`)
  })
  return `<table><tbody>${rows.join('')}</tbody></table>`
}

async function copyCurrentTable(view: EditorView): Promise<void> {
  const context = getTableContext(view)
  if (!context) return
  const markdown = serializeMarkdown(view.state.schema.node('doc', null, [context.node])).trim()
  const html = tableToHtml(context.node)
  await window.electronAPI?.clipboardWriteTable?.({ text: markdown, html })
  view.focus()
}

function deleteCurrentTable(view: EditorView): void {
  const context = getTableContext(view)
  if (!context) return
  const tableEnd = context.pos + context.node.nodeSize
  view.dispatch(view.state.tr.delete(context.pos, tableEnd))
  hideTableToolbar()
  view.focus()
}

// 计算菜单位置，确保在屏幕边界内
function calculateMenuPosition(x: number, y: number, menuHeight: number = 80, menuWidth: number = 170): { x: number; y: number } {
  // 视口尺寸
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  // 调整 X 坐标
  let adjustedX = x
  if (x + menuWidth > viewportWidth) {
    adjustedX = x - menuWidth
  }

  // 调整 Y 坐标
  let adjustedY = y
  if (y + menuHeight > viewportHeight) {
    adjustedY = Math.max(10, y - menuHeight)
  }

  return { x: adjustedX, y: adjustedY }
}

function buildHistoryMenuItems(view: EditorView): ContextMenuItem[] {
  return [
    { label: '撤销', action: () => { undo(view.state, view.dispatch); view.focus() } },
    { label: '重做', action: () => { redo(view.state, view.dispatch); view.focus() } },
    { label: '', action: () => {}, divider: true }
  ]
}

// 构建表格右键菜单项
function buildTableMenuItems(view: EditorView): ContextMenuItem[] {
  const { state } = view
  if (!isInTable(state)) return []

  const currentAlign = getCurrentColumnAlign(state)
  const check = (align: string) => (currentAlign === align ? '✓ ' : '')
  const alignItems: ContextMenuItem[] = [
    { label: check('left') + '左对齐', action: () => setColumnAlign(view, 'left') },
    { label: check('center') + '居中对齐', action: () => setColumnAlign(view, 'center') },
    { label: check('right') + '右对齐', action: () => setColumnAlign(view, 'right') },
  ]

  return [
    ...buildHistoryMenuItems(view),
    { label: '在左侧插入列', action: () => { addColumnBefore(state, view.dispatch); view.focus() } },
    { label: '在右侧插入列', action: () => { addColumnAfter(state, view.dispatch); view.focus() } },
    { label: '', action: () => {}, divider: true },
    { label: '在上方插入行', action: () => { addRowBefore(state, view.dispatch); view.focus() } },
    { label: '在下方插入行', action: () => { addRowAfter(state, view.dispatch); view.focus() } },
    { label: '', action: () => {}, divider: true },
    { label: '删除当前列', action: () => { deleteColumn(state, view.dispatch); view.focus() } },
    { label: '删除当前行', action: () => { deleteRow(state, view.dispatch); view.focus() } },
    { label: '', action: () => {}, divider: true },
    { label: '对齐', children: alignItems },
    { label: '', action: () => {}, divider: true },
    { label: '删除表格', action: () => { deleteTable(state, view.dispatch); view.focus() } },
  ]
}

// 构建通用右键菜单项
function buildGeneralMenuItems(view: EditorView): ContextMenuItem[] {
  const { state } = view
  const { schema } = state
  const items: ContextMenuItem[] = [
    ...buildHistoryMenuItems(view),
    {
      label: '插入',
      children: [
        { label: '表格', action: () => { insertTableNode(); view.focus() } },
        { label: '代码块', action: () => {
          setBlockType(schema.nodes.code_block, { language: '' })(state, view.dispatch)
          view.focus()
        }},
        { label: '图片', action: () => {
          closeContextMenu()
          window.dispatchEvent(new CustomEvent('editor:showImageDialog'))
        }},
        { label: '链接', action: () => {
          closeContextMenu()
          window.dispatchEvent(new CustomEvent('editor:showLinkDialog'))
        }},
        { label: '分割线', action: () => {
          const hr = schema.nodes.horizontal_rule.create()
          view.dispatch(state.tr.replaceSelectionWith(hr))
          view.focus()
        }},
      ]
    },
    {
      label: '格式化',
      children: [
        { label: '标题 1', action: () => { toggleHeading(1)(state, view.dispatch); view.focus() } },
        { label: '标题 2', action: () => { toggleHeading(2)(state, view.dispatch); view.focus() } },
        { label: '标题 3', action: () => { toggleHeading(3)(state, view.dispatch); view.focus() } },
        { label: '引用块', action: () => { wrapIn(schema.nodes.blockquote)(state, view.dispatch); view.focus() } },
        { label: '无序列表', action: () => { wrapInList(schema.nodes.bullet_list)(state, view.dispatch); view.focus() } },
        { label: '有序列表', action: () => { wrapInList(schema.nodes.ordered_list)(state, view.dispatch); view.focus() } },
      ]
    },
  ]

  return items
}

function insertImageNode(view: EditorView, src: string, alt = '', title = ''): void {
  const image = view.state.schema.nodes.image.create({ src, alt, title })
  const tr = view.state.tr.replaceSelectionWith(image)
  if (tr.doc.resolve(tr.selection.from).parent.type.name === 'paragraph') {
    tr.split(tr.selection.from)
  }
  view.dispatch(tr)
  view.focus()
}

function deleteSelectedImage(view: EditorView): void {
  const selection = view.state.selection
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return
  const src = selection.node.attrs.src as string
  const asset = fileStore.imageAssets.find((item) => item.path === src)
  if (asset) {
    void fileStore.removeAsset(asset.id).then((result) => {
      if (!result.success || view.isDestroyed) return
      view.dispatch(view.state.tr.deleteSelection())
      view.focus()
    })
  } else {
    view.dispatch(view.state.tr.deleteSelection())
    view.focus()
  }
}

function moveSelectionToEnd(view: EditorView): void {
  view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)))
  view.focus()
}

function isOutsideProseMirror(event: Event): boolean {
  const view = viewRef.value
  return !!view && !view.dom.contains(event.target as Node)
}

function handleEditorBlankMouseDown(event: MouseEvent): void {
  if (event.button !== 0 || !isOutsideProseMirror(event)) return
  const view = viewRef.value
  if (!view) return
  event.preventDefault()
  moveSelectionToEnd(view)
}

function handleEditorBlankContextMenu(event: MouseEvent): void {
  if (!isOutsideProseMirror(event)) return
  const view = viewRef.value
  if (!view) return

  event.preventDefault()
  window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
  moveSelectionToEnd(view)
  contextMenu.items = buildGeneralMenuItems(view)
  contextMenu.type = 'general'
  const pos = calculateMenuPosition(event.clientX, event.clientY, 170)
  contextMenu.x = pos.x
  contextMenu.y = pos.y
  contextMenu.visible = true
}

function handleInternalAnchorClick(view: EditorView, event: MouseEvent): boolean {
  if ((!event.ctrlKey && !event.metaKey) || event.button !== 0) return false
  const target = event.target as HTMLElement
  const link = target.closest('a')
  if (!link) return false

  const href = link.getAttribute('href')
  if (!href) return false

  if (href.startsWith('#')) {
    const heading = findHeadingForAnchor(
      Array.from(view.dom.querySelectorAll<HTMLElement>('h1, h2, h3, h4')),
      href
    )
    if (!heading) return false

    event.preventDefault()
    heading.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return true
  }

  event.preventDefault()
  const currentFilePath = fileStore.currentFile?.path || undefined
  const openedFolderPath = fileStore.openedFolderPath || undefined

  window.electronAPI.openLink(href, currentFilePath, openedFolderPath).then(result => {
    if (result.success && result.data) {
      fileStore.openFile(result.data, { addToRecent: true })
    } else if (result.error && !result.data) {
      if (!href.startsWith('http://') && !href.startsWith('https://')) {
        import('../../utils/dialog').then(({ requestDialog }) => {
          requestDialog({
            title: '无法打开链接',
            message: result.error || '无法打开链接',
            buttons: [{ label: '确定', value: 0, primary: true }]
          })
        })
      }
    }
  })

  return true
}

function updateCtrlPressed(event: KeyboardEvent): void {
  if (event.key === 'Control' || event.key === 'Meta') ctrlPressed.value = true
}

function clearCtrlPressed(event: KeyboardEvent): void {
  if (event.key === 'Control' || event.key === 'Meta') ctrlPressed.value = false
}

// 复制/剪切有序列表时，将带序号的纯文本写入剪贴板
// 未选择内容时复制光标所在行的整行内容
function handleListCopy(view: EditorView, event: Event, isCut: boolean): boolean {
  const { from, to } = view.state.selection
  if (from === to) {
    const clipboardEvent = event as ClipboardEvent
    if (!clipboardEvent.clipboardData) return true
    const $pos = view.state.doc.resolve(from)
    const start = $pos.before($pos.depth)
    const end = $pos.after($pos.depth)
    clipboardEvent.clipboardData.setData('text/plain', view.state.doc.textBetween(start, end, '\n'))
    event.preventDefault()
    return true
  }

  // 如果选区在单个列表项内部（不跨越列表项边界），走默认复制行为
  const { $from, $to } = view.state.selection
  if ($from.sameParent($to)) return false

  const result = getListClipboard(view.state)
  if (!result) return false
  const clipboardEvent = event as ClipboardEvent
  if (!clipboardEvent.clipboardData) return false
  clipboardEvent.clipboardData.setData('text/plain', result.text)
  clipboardEvent.clipboardData.setData('text/html', result.html)
  clipboardEvent.preventDefault()
  if (isCut) {
    view.dispatch(view.state.tr.deleteSelection())
  }
  return true
}

function createListClipboardPlugin(): ProseMirrorPlugin {
  return new ProseMirrorPlugin({
    props: {
      handleDOMEvents: {
        copy: (view, event) => handleListCopy(view, event, false),
        cut: (view, event) => handleListCopy(view, event, true),
      },
    },
  })
}

// 右键菜单插件
function createContextMenuPlugin(): ProseMirrorPlugin {
  return new ProseMirrorPlugin({
    props: {
      handleDOMEvents: {
        mousedown: (view, event) => {
          const mouseEvent = event as MouseEvent
          if (mouseEvent.button !== 0) return false
          const target = event.target as HTMLElement

          if (handleInternalAnchorClick(view, mouseEvent)) return true

          // 点击图片：选中图片节点
          if (target.closest('img')) {
            const coords = view.posAtCoords({ left: mouseEvent.clientX, top: mouseEvent.clientY })
            if (!coords) return false
            const node = view.state.doc.nodeAt(coords.pos) || view.state.doc.nodeAt(coords.pos - 1)
            if (node?.type.name !== 'image') return false
            const imagePos = view.state.doc.nodeAt(coords.pos)?.type.name === 'image' ? coords.pos : coords.pos - 1
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, imagePos)))
            return true
          }

          return false
        },
        contextmenu: (view, event) => {
          const target = event.target as HTMLElement

          if (target.closest('img')) {
            event.preventDefault()
            window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
            const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
            if (coords) {
              const node = view.state.doc.nodeAt(coords.pos) || view.state.doc.nodeAt(coords.pos - 1)
              if (node?.type.name === 'image') {
                view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, coords.pos)))
              }
            }
            contextMenu.items = [
              ...buildHistoryMenuItems(view),
              { label: '删除图片', action: () => deleteSelectedImage(view) }
            ]
            contextMenu.type = 'general'
            const pos = calculateMenuPosition(event.clientX, event.clientY, 42)
            contextMenu.x = pos.x
            contextMenu.y = pos.y
            contextMenu.visible = true
            return true
          }

          // 检查是否在表格单元格内
          if (target.closest('td, th')) {
            event.preventDefault()
            window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))

            // 确保光标在点击的单元格中
            const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
            if (coords) {
              const pos = view.state.doc.resolve(coords.pos)
              const tr = view.state.tr.setSelection(new TextSelection(pos))
              view.dispatch(tr)
            }

            contextMenu.items = buildTableMenuItems(view)
            contextMenu.type = 'table'
            const pos = calculateMenuPosition(event.clientX, event.clientY, 240, 200)
            contextMenu.x = pos.x
            contextMenu.y = pos.y
            contextMenu.visible = true
            return true
          }

          // 编辑器内容区域保持原有光标定位逻辑。
          if (target.closest('.ProseMirror')) {
            event.preventDefault()
            window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))

            contextMenu.items = buildGeneralMenuItems(view)
            contextMenu.type = 'general'
            const pos = calculateMenuPosition(event.clientX, event.clientY, 170)
            contextMenu.x = pos.x
            contextMenu.y = pos.y
            contextMenu.visible = true
            return true
          }

          return false
        }
      }
    }
  })
}

// ────── 序列化节流（避免每次按键都全文档序列化） ──────
let serializeScheduled = false
let lastSerializeTs = 0

function scheduleSerialize(state: { doc: ProseMirrorNode }): void {
  if (isUpdatingFromStore) return
  const now = performance.now()
  if (serializeScheduled && now - lastSerializeTs < 50) return
  serializeScheduled = true
  lastSerializeTs = now
  requestAnimationFrame(() => {
    serializeScheduled = false
    const markdown = serializeMarkdown(state.doc)
    const currentContent = (fileStore.fileContent || '').replace(/\n+$/, '')
    const newMarkdown = markdown.replace(/\n+$/, '')
    if (currentContent !== newMarkdown) {
      fileStore.updateContent(markdown)
    }
  })
}

// ====== 查找 / 替换 ======
const searchPluginKey = new PluginKey<DecorationSet>('irSearch')

const irSearchPlugin = new ProseMirrorPlugin<DecorationSet>({
  key: searchPluginKey,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, old) => {
      const meta = tr.getMeta(searchPluginKey)
      if (meta) return meta as DecorationSet
      return old.map(tr.mapping, tr.doc)
    }
  },
  props: {
    decorations(state) {
      return searchPluginKey.getState(state) ?? DecorationSet.empty
    },
    handleKeyDown: (_view, event) => {
      if (event.key === 'Escape' && searchOpen.value) {
        closeSearch()
        return true
      }
      return false
    }
  }
})

function recomputeMatches(query: string, caseSensitive: boolean): void {
  const view = viewRef.value
  if (!view) return
  lastSearchQuery.value = query
  lastCaseSensitive.value = caseSensitive
  searchMatches.value = findMatches(view.state.doc, query, caseSensitive)
  if (searchMatches.value.length === 0) {
    currentMatchIndex.value = -1
  } else if (currentMatchIndex.value < 0 || currentMatchIndex.value >= searchMatches.value.length) {
    currentMatchIndex.value = 0
  }
  updateSearchDecorations()
}

function updateSearchDecorations(): void {
  const view = viewRef.value
  if (!view) return
  const decos = searchMatches.value.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === currentMatchIndex.value ? 'ir-search-match-current' : 'ir-search-match'
    })
  )
  const set = DecorationSet.create(view.state.doc, decos)
  view.dispatch(view.state.tr.setMeta(searchPluginKey, set))
}

function jumpToMatch(index: number): void {
  const view = viewRef.value
  const match = searchMatches.value[index]
  if (!view || !match) return
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.between(view.state.doc.resolve(match.from), view.state.doc.resolve(match.to))
    )
  )
  currentMatchIndex.value = index
  updateSearchDecorations()
  view.focus()
}

function nextMatch(): void {
  if (searchMatches.value.length === 0) return
  jumpToMatch((currentMatchIndex.value + 1) % searchMatches.value.length)
}

function prevMatch(): void {
  if (searchMatches.value.length === 0) return
  jumpToMatch((currentMatchIndex.value - 1 + searchMatches.value.length) % searchMatches.value.length)
}

function replaceCurrent(query: string, replaceText: string, caseSensitive: boolean): void {
  const view = viewRef.value
  const match = searchMatches.value[currentMatchIndex.value]
  if (!view || !match) return
  view.dispatch(view.state.tr.replaceWith(match.from, match.to, view.state.schema.text(replaceText)))
  recomputeMatches(query, caseSensitive)
}

function replaceAll(query: string, replaceText: string, caseSensitive: boolean): void {
  const view = viewRef.value
  if (!view || searchMatches.value.length === 0) return
  let tr = view.state.tr
  for (let i = searchMatches.value.length - 1; i >= 0; i--) {
    const m = searchMatches.value[i]
    tr = tr.replaceWith(m.from, m.to, view.state.schema.text(replaceText))
  }
  view.dispatch(tr)
  recomputeMatches(query, caseSensitive)
}

function openSearch(replaceMode = false): void {
  searchReplaceMode.value = replaceMode
  searchOpen.value = true
}

function closeSearch(): void {
  searchOpen.value = false
  const view = viewRef.value
  if (view) {
    view.dispatch(view.state.tr.setMeta(searchPluginKey, DecorationSet.empty))
  }
  viewRef.value?.focus()
}

function createEditorState(content: string): EditorState {
  const doc = parseMarkdown(content || '')
  const plugins = [
    ...createPlugins(markdownSchema),
    taskListClickPlugin,
    createPastePlugin((view, file) => {
      // 异步处理图片插入，使用最新的 view 状态
      handlePasteImage(view, file)
    }),
    createDocumentChangePlugin((state) => {
      scheduleSerialize(state)
    }),
    createIRPlugin(),
    createCodeHighlightPlugin(),
    createContextMenuPlugin(),
    createListClipboardPlugin(),
    irSearchPlugin,
  ]
  return EditorState.create({ doc, plugins })
}

async function handlePasteImage(view: EditorView, file: File): Promise<void> {
  const result = await fileStore.addImage(file)
  if (result.success && result.path) {
    // 使用 view.state 和 view.dispatch 来确保状态一致性
    insertImageNode(view, result.path, file.name)
    // 加载并渲染图片
    await nextTick(() => loadEditorImages())
  }
}

/**
 * 把 ProseMirror 选区映射为 Markdown 偏移，校验通过后发布归一化选区快照。
 *
 * 映射策略：分别序列化「选区前的文档前缀」与「选中的切片」为 Markdown，
 * 前缀长度即为候选 from 偏移，加上选中切片长度得到 to 偏移；
 * 随后校验 fileContent.slice(from, to) === text。任何一步不匹配（例如
 * 节点选区、序列化与文档正文不一致）都 fail-closed 发布 null。
 * 绝不把 ProseMirror 位置直接当作 Markdown 偏移。
 */
function publishSelectionFromProseMirror(): void {
  const view = viewRef.value
  if (!view) return
  const tabId = activeTabId.value
  if (!tabId) {
    fileStore.updateEditorSelection(null)
    return
  }
  const { selection, doc } = view.state
  if (!(selection instanceof TextSelection)) {
    fileStore.updateEditorSelection(null)
    return
  }
  const { from, to } = selection
  const content = fileStore.fileContent

  // collapsed 光标：slice(from, from) === '' 恒真，前缀序列化又可能丢失块间分隔符，
  // 因此改用「完整序列化 - 后缀序列化」反推光标 offset，并在不一致时 fail-closed。
  if (from === to) {
    let fullMarkdown: string
    let suffixMarkdown: string
    try {
      fullMarkdown = serializeMarkdown(doc)
      suffixMarkdown = serializeMarkdown(doc.cut(from, doc.content.size))
    } catch {
      fileStore.updateEditorSelection(null)
      return
    }
    if (fullMarkdown !== content) {
      fileStore.updateEditorSelection(null)
      return
    }
    const cursorOffset = fullMarkdown.length - suffixMarkdown.length
    if (fullMarkdown.slice(cursorOffset) !== suffixMarkdown) {
      fileStore.updateEditorSelection(null)
      return
    }
    fileStore.updateEditorSelection({
      tabId,
      from: cursorOffset,
      to: cursorOffset,
      cursor: cursorOffset,
      text: ''
    })
    return
  }

  let prefixMarkdown: string
  let selectedMarkdown: string
  try {
    prefixMarkdown = serializeMarkdown(doc.cut(0, from))
    selectedMarkdown = serializeMarkdown(doc.cut(from, to))
  } catch {
    fileStore.updateEditorSelection(null)
    return
  }
  const fromOffset = prefixMarkdown.length
  const toOffset = fromOffset + selectedMarkdown.length
  if (content.slice(fromOffset, toOffset) !== selectedMarkdown) {
    fileStore.updateEditorSelection(null)
    return
  }
  fileStore.updateEditorSelection({
    tabId,
    from: fromOffset,
    to: toOffset,
    cursor: toOffset,
    text: selectedMarkdown
  })
}

/** 将 ProseMirror 光标位置换算为 Markdown 行列，供状态栏显示。 */
function updateCursorPositionFromProseMirror(): void {
  const view = viewRef.value
  if (!view) return
  const cursor = view.state.selection.head
  let offset = 0
  try {
    const fullMarkdown = serializeMarkdown(view.state.doc)
    const suffixMarkdown = serializeMarkdown(view.state.doc.cut(cursor, view.state.doc.content.size))
    if (fullMarkdown.endsWith(suffixMarkdown)) {
      offset = fullMarkdown.length - suffixMarkdown.length
    } else {
      offset = serializeMarkdown(view.state.doc.cut(0, cursor)).length
    }
  } catch {
    return
  }
  const prefix = fileStore.fileContent.slice(0, offset)
  const lastNewline = prefix.lastIndexOf('\n')
  fileStore.setCursorPosition(
    prefix.split('\n').length,
    offset - lastNewline
  )
}

function initEditor(): void {
  if (!editorRef.value) {
    console.warn('[IrEditor] init skipped: editorRef is null')
    return
  }
  editorTabId = activeTabId.value
  const content = fileStore.fileContent
  const state = createEditorState(content)
  viewRef.value = new EditorView(editorRef.value, {
    state,
    dispatchTransaction(tr) {
      const view = viewRef.value
      if (!view) return
      const selectionChanged = tr.selectionSet
      view.updateState(view.state.apply(tr))
      updateSavedPosition()
      updateCursorPositionFromProseMirror()
      if (selectionChanged) publishSelectionFromProseMirror()
      nextTick(() => updateTableToolbar(view))
      if (!view.hasFocus() && !searchOpen.value) view.focus()
      if (tr.docChanged && searchOpen.value) {
        recomputeMatches(lastSearchQuery.value, lastCaseSensitive.value)
      }
    },
    attributes: {
      class: 'ir-editor',
      spellcheck: 'false'
    },
    nodeViews: {
      math_inline: (node) => new MathInlineView(node),
      math_block: (node) => new MathBlockView(node),
      code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos as () => number),
    },
  })
  restoreEditorPosition()
}

/**
 * 切回该标签页时，恢复上次阅读位置（滚动 + 光标）。
 * EditorPanel 以 activeTabId 作为 :key 重建 IrEditor，若不恢复，
 * 切换标签后再切回来文档会回到开头。
 */
function restoreEditorPosition(): void {
  const view = viewRef.value
  const container = containerRef.value
  if (!view || !container || !editorTabId) return
  const saved = fileStore.tabs.find((t) => t.id === editorTabId)?.savedEditorPosition
  if (!saved) return

  // 光标恢复：使用 updateState 直接替换 state，绕过 dispatchTransaction，
  // 避免恢复动作触发 focus / 选区发布等副作用干扰滚动位置。
  const docSize = view.state.doc.content.size
  const from = Math.max(0, Math.min(Math.floor(saved.from), docSize))
  const to = Math.max(from, Math.min(Math.floor(saved.to), docSize))
  try {
    const sel = TextSelection.between(view.state.doc.resolve(from), view.state.doc.resolve(to))
    view.updateState(view.state.apply(view.state.tr.setSelection(sel)))
  } catch {
    // 位置非法时仅恢复滚动
  }
  applySavedScroll(saved.scrollTop)
}

/**
 * 把容器滚动到上次位置。
 * 组件刚重建时布局可能尚未就绪（scrollHeight/clientHeight 为 0），
 * 一次设置会被 clamp 到顶部，因此重试直至滚动真正生效。
 */
function applySavedScroll(savedScrollTop: number, attempt = 0): void {
  const container = containerRef.value
  const view = viewRef.value
  if (!container || view?.isDestroyed) return
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
  const target = Math.min(Math.max(0, savedScrollTop), maxScroll)
  container.scrollTop = target

  const settled = maxScroll > 0 && Math.abs(container.scrollTop - target) < 1
  if (settled || attempt >= 40) return
  setTimeout(() => applySavedScroll(savedScrollTop, attempt + 1), 50)
}

/** 实时把当前阅读位置写回标签（滚动/选区变化时调用） */
function updateSavedPosition(): void {
  const view = viewRef.value
  if (!view || !editorTabId) return
  const tab = fileStore.tabs.find((t) => t.id === editorTabId)
  if (!tab) return
  tab.savedEditorPosition = {
    scrollTop: containerRef.value?.scrollTop ?? tab.savedEditorPosition?.scrollTop ?? 0,
    from: view.state.selection.from,
    to: view.state.selection.to
  }
}

let scrollSaveRaf = 0
function handlePositionScroll(): void {
  if (scrollSaveRaf) return
  scrollSaveRaf = requestAnimationFrame(() => {
    scrollSaveRaf = 0
    updateSavedPosition()
  })
}

/**
 * 卸载兜底：把当前阅读位置写回标签。
 * 卸载瞬间容器可能已被 DOM 移除（scrollTop 读到 0），
 * 若之前已记录过非零滚动位置则保留旧值，避免误把位置重置到顶部。
 */
function saveEditorPosition(): void {
  const view = viewRef.value
  if (!view || !editorTabId) return
  const tab = fileStore.tabs.find((t) => t.id === editorTabId)
  if (!tab) return
  const scrollTop = containerRef.value?.scrollTop ?? 0
  const prev = tab.savedEditorPosition
  tab.savedEditorPosition = {
    scrollTop: scrollTop > 0 ? scrollTop : (prev?.scrollTop ?? 0),
    from: view.state.selection.from,
    to: view.state.selection.to
  }
}

function setBlockTypeCommand(type: string, attrs?: Record<string, unknown>): void {
  const view = viewRef.value
  if (!view) return
  const { state, dispatch } = view
  const nodeType = state.schema.nodes[type]
  if (type === 'paragraph') setBlockType(nodeType)(state, dispatch)
  else if (type === 'heading') setBlockType(nodeType, attrs)(state, dispatch)
  else if (type === 'code_block') setBlockType(nodeType, attrs)(state, dispatch)
  else if (type === 'blockquote') wrapIn(nodeType)(state, dispatch)
  else if (type === 'bullet_list') wrapInList(nodeType)(state, dispatch)
  else if (type === 'ordered_list') wrapInList(nodeType, attrs)(state, dispatch)
  view.focus()
}

function toggleHeadingLevel(level: number): void {
  const view = viewRef.value
  if (!view) return
  const { state, dispatch } = view
  toggleHeading(level)(state, dispatch)
  view.focus()
}

function handleDragOver(e: DragEvent): void {
  e.preventDefault()
  isDragging.value = true
}
function handleDragLeave(e: DragEvent): void {
  e.preventDefault()
  isDragging.value = false
}
async function handleDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  isDragging.value = false
  if (!e.dataTransfer) return
  for (const file of Array.from(e.dataTransfer.files)) {
    if (file.type.startsWith('image/')) await insertImageFromFile(file)
  }
  const url = e.dataTransfer.getData('text/uri-list')
  if (url && isImageUrl(url) && viewRef.value) insertImageNode(viewRef.value, url)
}
// 注意：粘贴图片处理已移至 ProseMirror 插件 createPastePlugin
// 保留此函数是为了防止其他组件依赖，但实际处理在插件中完成
async function handlePaste(_e: ClipboardEvent): Promise<void> {
  // ProseMirror 插件会处理图片粘贴，这里不再重复处理
  // 这样可以避免事务冲突
}
async function insertImageFromFile(file: File): Promise<void> {
  const result = await fileStore.addImage(file)
  if (result.success && result.path) {
    const view = viewRef.value
    if (!view) return
    // 使用 view.state 创建事务，确保状态一致性
    insertImageNode(view, result.path, file.name)
  }
}
function isImageUrl(url: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i.test(url)
}

async function loadEditorImages(): Promise<void> {
  if (!editorRef.value) return

  const filePath = fileStore.currentFile?.path || undefined
  const pending: Promise<void>[] = []

  for (const img of editorRef.value.querySelectorAll('img')) {
    const src = img.getAttribute('src')
    if (!src || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) continue

    const cacheKey = `${filePath ?? ''}:${src}`
    const cached = fileStore.getCachedImage(cacheKey)
    if (cached) {
      img.src = cached
      continue
    }
    pending.push((async () => {
      try {
        const result = await fileStore.getImage(src, filePath)
        if ((fileStore.currentFile?.path || undefined) !== filePath) return
        if (result.success && result.data) {
          fileStore.setCachedImage(cacheKey, result.data)
          img.src = result.data
        }
      } catch { /* ignore */ }
    })())
  }

  await Promise.all(pending)
}

watch([activeTabId, fileContent], ([newTabId, newContent], [oldTabId]) => {
  const view = viewRef.value
  if (!view) return

  const currentMarkdown = serializeMarkdown(view.state.doc).replace(/\n+$/, '')
  const normalizedNewContent = (newContent || '').replace(/\n+$/, '')
  const tabChanged = newTabId !== oldTabId
  if (!tabChanged && currentMarkdown === normalizedNewContent) return

  // 从 store 同步内容到编辑器：直接用 updateState 替换整个 state
  // 避免 dispatch transaction 时和当前 state 不匹配，同时阻止
  // createDocumentChangePlugin 回写 store 造成双向循环
  isUpdatingFromStore = true
  const newState = EditorState.create({
    doc: parseMarkdown(newContent || ''),
    plugins: view.state.plugins
  })
  view.updateState(newState)
  isUpdatingFromStore = false
  // 切换 tab 后编辑器选区被重置为文档开头，重新发布快照避免残留旧 tab 的选区。
  if (tabChanged) publishSelectionFromProseMirror()
  nextTick(() => loadEditorImages())
})

watch(() => themeStore.currentTheme, () => {
  nextTick(() => {
    if (viewRef.value) void updateCodeHighlights(viewRef.value)
  })
})

watch(() => fileStore.currentFile?.path, (newPath, oldPath) => {
  if (newPath !== oldPath) { fileStore.clearImageCache(); nextTick(() => loadEditorImages()) }
})

// ========== 工具栏事件处理 ==========

/** 手动 toggle mark，有选区时直接 addMark，无选区时 addStoredMark */
function toggleMarkInView(view: EditorView, markType: import('prosemirror-model').MarkType): void {
  const { from, to } = view.state.selection
  if (from === to) {
    const tr = view.state.tr.addStoredMark(markType.create())
    view.updateState(view.state.apply(tr))
  } else {
    const text = view.state.doc.textBetween(from, to)
    const mark = markType.create()
    const markedText = view.state.schema.text(text, [mark])
    const tr = view.state.tr.replaceWith(from, to, markedText)
    view.updateState(view.state.apply(tr))
  }
  view.focus()
}

function applyAndSync(view: EditorView, tr: any): void {
  view.updateState(view.state.apply(tr))
}

/**
 * 获取光标所在列的对齐方式（用于右键菜单勾选显示）
 */
function getCurrentColumnAlign(state: EditorState): 'left' | 'center' | 'right' | null {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  const cells = rect.map.cellsInRect({ left: rect.left, top: 0, right: rect.left + 1, bottom: rect.map.height })
  if (cells.length === 0) return null
  const node = state.doc.nodeAt(rect.tableStart + cells[0])
  return (node?.attrs.align as 'left' | 'center' | 'right') || null
}

/**
 * 设置光标所在列（或选中的多列）的对齐方式
 */
function setColumnAlign(view: EditorView, align: 'left' | 'center' | 'right'): void {
  const { state } = view
  if (!isInTable(state)) return
  const rect = selectedRect(state)
  const { map, tableStart } = rect
  const { doc } = state
  let tr = state.tr
  const seen = new Set<number>()
  for (let col = rect.left; col < rect.right; col++) {
    const cells = map.cellsInRect({ left: col, top: 0, right: col + 1, bottom: map.height })
    for (const tablePos of cells) {
      const pos = tableStart + tablePos
      if (seen.has(pos)) continue
      seen.add(pos)
      const node = doc.nodeAt(pos)
      if (!node) continue
      tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, align })
    }
  }
  view.dispatch(tr)
  view.focus()
}

function insertTableNode(): void {
  const view = viewRef.value
  if (!view) return
  const { schema } = view.state
  const createCell = (isHeader: boolean, text: string) => {
    const type = isHeader ? schema.nodes.table_header : schema.nodes.table_cell
    return type.create({}, schema.text(text))
  }
  const headerRow = schema.nodes.table_row.create(null, [
    createCell(true, '列1'), createCell(true, '列2'), createCell(true, '列3'),
  ])
  const dataRow = schema.nodes.table_row.create(null, [
    createCell(false, '内容'), createCell(false, '内容'), createCell(false, '内容'),
  ])
  const tableNode = schema.nodes.table.create(null, [headerRow, dataRow, dataRow])
  const tr = view.state.tr.replaceSelectionWith(tableNode)
  applyAndSync(view, tr)
  view.focus()
}

function handleFormatEvent(e: Event): void {
  const view = viewRef.value
  if (!view) return
  const { marks, nodes } = view.state.schema
const format = (e as CustomEvent).detail as string
  switch (format) {
    case 'bold':
      toggleMarkInView(view, marks.bold)
      return
    case 'italic':
      toggleMarkInView(view, marks.italic)
      return
    case 'strikethrough':
      toggleMarkInView(view, marks.strikethrough)
      return
    case 'underline':
      toggleMarkInView(view, marks.underline)
      return
    case 'unorderedList':
      wrapInList(nodes.bullet_list)(view.state, (tr) => applyAndSync(view, tr))
      break
    case 'orderedList':
      wrapInList(nodes.ordered_list)(view.state, (tr) => applyAndSync(view, tr))
      break
    case 'blockquote':
      wrapIn(nodes.blockquote)(view.state, (tr) => applyAndSync(view, tr))
      break
    case 'table':
      insertTableNode()
      return
    case 'horizontalRule': {
      const rule = nodes.horizontal_rule.create()
      view.dispatch(view.state.tr.replaceSelectionWith(rule))
      break
    }
  }
  view.focus()
}

function handleHeadingEvent(e: Event): void {
  const view = viewRef.value
  if (!view) return
  const level = (e as CustomEvent).detail as number
  if (level === 0) {
    setBlockType(view.state.schema.nodes.paragraph)(view.state, (tr) => applyAndSync(view, tr))
  } else {
    toggleHeading(level)(view.state, (tr) => applyAndSync(view, tr))
  }
  view.focus()
}

function handleLinkEvent(e: Event): void {
  const view = viewRef.value
  if (!view) return
  const { href, title } = (e as CustomEvent).detail as { href: string; title: string }
  insertLink(href, title)(view.state, (tr) => applyAndSync(view, tr))
  view.focus()
}

function handleImageEvent(e: Event): void {
  const view = viewRef.value
  if (!view) return
  const { src, alt } = (e as CustomEvent).detail as { src: string; alt: string }
  insertImageNode(view, src, alt)
}

function handleAttachmentEvent(e: Event): void {
  const view = viewRef.value
  if (!view) return
  const { path, name } = (e as CustomEvent).detail as { path: string; name: string }
  const link = view.state.schema.marks.link.create({ href: path, title: name })
  const text = view.state.schema.text(name, [link])
  // 不能用 replaceSelectionWith：它会按插入点上下文的 marks 规范化节点，
  // 导致新文本的 link mark 被剥掉（插入为纯文本）
  const { from } = view.state.selection
  const tr = view.state.tr.insert(from, text)
  tr.setSelection(TextSelection.create(tr.doc, from + text.nodeSize))
  view.dispatch(tr)
  view.focus()
}

function handleCodeBlockEvent(e: Event): void {
  const view = viewRef.value
  if (!view) return
  const { language } = (e as CustomEvent).detail as { language?: string }
  setBlockType(view.state.schema.nodes.code_block, { language: language || '' })(view.state, (tr) => applyAndSync(view, tr))
  view.focus()
}

function handleUndoEvent(): void {
  const view = viewRef.value
  if (!view) return
  undo(view.state, (tr) => applyAndSync(view, tr))
  view.focus()
}

function handleEditorFind(): void {
  openSearch(false)
}

function handleEditorReplace(): void {
  openSearch(true)
}

function handleRedoEvent(): void {
  const view = viewRef.value
  if (!view) return
  redo(view.state, (tr) => applyAndSync(view, tr))
  view.focus()
}

async function handleCopyEvent(): Promise<void> {
  const view = viewRef.value
  if (!view) return
  const { from, to } = view.state.selection
  if (from !== to) {
    const text = view.state.doc.textBetween(from, to, '\n')
    await window.electronAPI?.clipboardWriteText(text)
  } else {
    const $pos = view.state.doc.resolve(from)
    const start = $pos.before($pos.depth)
    const end = $pos.after($pos.depth)
    const text = view.state.doc.textBetween(start, end, '\n')
    await window.electronAPI?.clipboardWriteText(text)
  }
  view.focus()
}

async function handleCutEvent(): Promise<void> {
  const view = viewRef.value
  if (!view) return
  const { from, to } = view.state.selection
  if (from === to) return
  const text = view.state.doc.textBetween(from, to, '\n')
  await window.electronAPI?.clipboardWriteText(text)
  view.dispatch(view.state.tr.deleteSelection())
  view.focus()
}

async function handlePasteEvent(): Promise<void> {
  const view = viewRef.value
  if (!view) return
  const text = await window.electronAPI?.clipboardReadText()
  if (!text) return
  view.dispatch(view.state.tr.insertText(text))
  view.focus()
}

onMounted(() => {
  window.addEventListener('keydown', updateCtrlPressed)
  window.addEventListener('keyup', clearCtrlPressed)
  window.addEventListener('blur', clearCtrlPressedOnBlur)
  initEditor()
  void initShiki()
  const el = editorRef.value
  if (el) {
    el.addEventListener('dragover', handleDragOver)
    el.addEventListener('dragleave', handleDragLeave)
    el.addEventListener('drop', handleDrop)
    el.addEventListener('paste', handlePaste)
  }
  const container = containerRef.value
  if (container) {
    container.addEventListener('mousedown', handleEditorBlankMouseDown)
    container.addEventListener('contextmenu', handleEditorBlankContextMenu)
    container.addEventListener('scroll', handleTableToolbarLayout, { passive: true })
    container.addEventListener('scroll', handlePositionScroll, { passive: true })
  }
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
  window.addEventListener('editor:find', handleEditorFind)
  window.addEventListener('editor:replace', handleEditorReplace)
  document.addEventListener('click', closeContextMenu)
  document.addEventListener('contextmenu', closeContextMenu, true)
  window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeContextMenu)
  window.addEventListener('blur', closeContextMenu)
  const view = viewRef.value
  if (view) {
    // 删除文件后组件虽然重新挂载，窗口焦点仍可能停留在删除按钮上；
    // 点击编辑器正文时强制恢复真正的输入焦点。
    view.dom.addEventListener('mousedown', focusEditor)
  }
  window.addEventListener('focus', focusEditor)
  window.addEventListener('resize', handleTableToolbarLayout)
  nextTick(() => {
    loadEditorImages()
    focusEditor()
    if (viewRef.value) updateTableToolbar(viewRef.value)
  })
})

onUnmounted(() => {
  saveEditorPosition()
  // 组件卸载前强制同步内容到 store，防止切换模式时内容丢失
  const view = viewRef.value
  if (view && editorTabId === activeTabId.value) {
    const markdown = serializeMarkdown(view.state.doc)
    fileStore.setContent(markdown)
  }

  const el = editorRef.value
  if (el) {
    el.removeEventListener('dragover', handleDragOver)
    el.removeEventListener('dragleave', handleDragLeave)
    el.removeEventListener('drop', handleDrop)
    el.removeEventListener('paste', handlePaste)
  }
  const container = containerRef.value
  if (container) {
    container.removeEventListener('mousedown', handleEditorBlankMouseDown)
    container.removeEventListener('contextmenu', handleEditorBlankContextMenu)
    container.removeEventListener('scroll', handleTableToolbarLayout)
    container.removeEventListener('scroll', handlePositionScroll)
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
  window.removeEventListener('editor:find', handleEditorFind)
  window.removeEventListener('editor:replace', handleEditorReplace)
  window.removeEventListener('keydown', updateCtrlPressed)
  window.removeEventListener('keyup', clearCtrlPressed)
  window.removeEventListener('blur', clearCtrlPressedOnBlur)
  document.removeEventListener('click', closeContextMenu)
  document.removeEventListener('contextmenu', closeContextMenu, true)
  window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeContextMenu)
  window.removeEventListener('blur', closeContextMenu)
  window.removeEventListener('focus', focusEditor)
  window.removeEventListener('resize', handleTableToolbarLayout)
  view?.dom.removeEventListener('mousedown', focusEditor)
  view?.destroy()
  viewRef.value = null
})

defineExpose({
  setBlockTypeCommand,
  toggleHeadingLevel,
  insertImage: (src: string, alt?: string, title?: string) => {
    const view = viewRef.value
    if (!view) return
    insertImageNode(view, src, alt, title)
  },
  getView: () => viewRef.value,
  focus: () => viewRef.value?.focus(),
})
</script>

<template>
  <div
    ref="containerRef"
    class="ir-container"
    :class="{ dragging: isDragging, 'ir-ctrl-pressed': ctrlPressed }"
  >
    <div
      v-if="tableToolbar.visible"
      ref="tableToolbarRef"
      class="table-toolbar"
      :style="{ left: `${tableToolbar.x}px`, top: `${tableToolbar.y}px` }"
      @mousedown.stop.prevent
    >
      <Tooltip content="整张表格左对齐">
        <button
          class="table-toolbar-btn"
          :class="{ active: tableToolbar.align === 'left' }"
          aria-label="整张表格左对齐"
          @click="viewRef && setTableAlign(viewRef, 'left')"
        >
          <IconAlignLeft />
        </button>
      </Tooltip>
      <Tooltip content="整张表格居中对齐">
        <button
          class="table-toolbar-btn"
          :class="{ active: tableToolbar.align === 'center' }"
          aria-label="整张表格居中对齐"
          @click="viewRef && setTableAlign(viewRef, 'center')"
        >
          <IconAlignCenter />
        </button>
      </Tooltip>
      <Tooltip content="整张表格右对齐">
        <button
          class="table-toolbar-btn"
          :class="{ active: tableToolbar.align === 'right' }"
          aria-label="整张表格右对齐"
          @click="viewRef && setTableAlign(viewRef, 'right')"
        >
          <IconAlignRight />
        </button>
      </Tooltip>
      <span class="table-toolbar-divider" />
      <Tooltip content="复制整张表格">
        <button
          class="table-toolbar-btn"
          aria-label="复制整张表格"
          @click="viewRef && void copyCurrentTable(viewRef)"
        >
          <IconCopy />
        </button>
      </Tooltip>
      <Tooltip content="删除整张表格">
        <button
          class="table-toolbar-btn danger"
          aria-label="删除整张表格"
          @click="viewRef && deleteCurrentTable(viewRef)"
        >
          <IconTrash />
        </button>
      </Tooltip>
    </div>
    <FindReplacePanel
      :open="searchOpen"
      :replace-mode="searchReplaceMode"
      :match-count="searchMatches.length"
      :current-index="currentMatchIndex"
      @close="closeSearch"
      @search="recomputeMatches"
      @next="nextMatch"
      @prev="prevMatch"
      @replace="replaceCurrent"
      @replace-all="replaceAll"
    />
    <div
      ref="editorRef"
      class="ir-editor-wrapper"
    />
  </div>

  <EditorContextMenu
    :visible="contextMenu.visible"
    :x="contextMenu.x"
    :y="contextMenu.y"
    :items="contextMenu.items"
    @close="closeContextMenu"
  />
</template>

<style scoped>
.ir-container {
  flex: 1;
  overflow-y: auto;
  background-color: var(--color-bg-primary);
  position: relative;
}
.ir-container.dragging .ir-editor-wrapper {
  background-color: var(--color-primary-light);
  border: 2px dashed var(--color-primary);
}
.ir-editor-wrapper :deep(.ir-search-match) {
  background: rgb(255 200 0 / 0.3);
  border-radius: 2px;
}
.ir-editor-wrapper :deep(.ir-search-match-current) {
  background: rgb(255 165 0 / 0.5);
  border-radius: 2px;
}

.table-toolbar {
  position: absolute;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 36px;
  padding: 4px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 14px rgb(0 0 0 / 14%);
}
.table-toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.table-toolbar-btn:hover,
.table-toolbar-btn.active {
  color: var(--color-primary);
  background: var(--color-primary-light);
}
.table-toolbar-btn.danger:hover {
  color: var(--color-error);
  background: color-mix(in srgb, var(--color-error) 12%, transparent);
}
.table-toolbar-btn svg {
  width: 16px;
  height: 16px;
}
.table-toolbar-divider {
  width: 1px;
  height: 20px;
  margin: 0 3px;
  background: var(--color-border);
}
.ir-editor-wrapper {
  min-height: 100%;
  padding: 24px 32px;
}
.ir-editor-wrapper :deep(.ProseMirror) {
  outline: none;
  min-height: 100%;
  white-space: pre-wrap;
  caret-color: var(--color-primary);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.8;
  color: var(--color-text);
}
.ir-editor-wrapper :deep(.ProseMirror p) { margin: 0.5em 0; }
.ir-editor-wrapper :deep(.ProseMirror h1) {
  font-size: 2em; border-bottom: 2px solid var(--color-border);
  padding-bottom: 0.3em; margin: 0.67em 0; font-weight: 700;
}
.ir-editor-wrapper :deep(.ProseMirror h2) {
  font-size: 1.5em; border-bottom: 1px solid var(--color-border);
  padding-bottom: 0.3em; margin: 0.75em 0; font-weight: 600;
}
.ir-editor-wrapper :deep(.ProseMirror h3) {
  font-size: 1.25em; margin: 0.83em 0; font-weight: 600;
}
.ir-editor-wrapper :deep(.ProseMirror h4) {
  font-size: 1.1em; margin: 1em 0; font-weight: 600;
}
.ir-editor-wrapper :deep(.ProseMirror h5) {
  font-size: 1em; margin: 1em 0; font-weight: 600;
}
.ir-editor-wrapper :deep(.ProseMirror h6) {
  font-size: 0.95em; margin: 1em 0; font-weight: 600;
  color: var(--color-text-secondary);
}
.ir-editor-wrapper :deep(.ProseMirror ul),
.ir-editor-wrapper :deep(.ProseMirror ol) {
  margin: 0.5em 0; padding-left: 1.5em;
}
.ir-editor-wrapper :deep(.ProseMirror li) { margin: 0.25em 0; }
/* IR 模式：列表标记（无序用标准圆点，有序用计数器显示源码序号） */
.ir-editor-wrapper :deep(.ProseMirror ul) { list-style-type: disc; }
.ir-editor-wrapper :deep(.ProseMirror ol) { counter-reset: ir-ordered; list-style: none; }
.ir-editor-wrapper :deep(.ProseMirror ol > li) { counter-increment: ir-ordered; position: relative; }
.ir-editor-wrapper :deep(.ProseMirror ol > li::before) {
  content: counter(ir-ordered) '. ';
  position: absolute; left: -2em;
  opacity: 0.4; font-family: var(--font-mono); font-size: 0.85em;
  user-select: none; pointer-events: none;
}
.ir-editor-wrapper :deep(.ProseMirror li[data-type="task_item"][data-checked="true"]::before) {
  content: '- [x] ';
}
.ir-editor-wrapper :deep(.ProseMirror li[data-type="task_item"][data-checked="false"]::before) {
  content: '- [ ] ';
}
.ir-editor-wrapper :deep(.ProseMirror li[data-type="task_item"] input[type="checkbox"]) {
  display: none;
}
.ir-editor-wrapper :deep(.ProseMirror blockquote) {
  border-left: 4px solid var(--color-primary);
  padding: 8px 16px; margin: 0.5em 0;
  background: var(--color-primary-light);
  border-radius: 0 4px 4px 0;
}
/* IR 模式：块级源码标记（仅光标附近显示，与内联标记一致；隐藏时不占位） */
.ir-editor-wrapper :deep(.ProseMirror h1::before),
.ir-editor-wrapper :deep(.ProseMirror h2::before),
.ir-editor-wrapper :deep(.ProseMirror h3::before),
.ir-editor-wrapper :deep(.ProseMirror h4::before),
.ir-editor-wrapper :deep(.ProseMirror h5::before),
.ir-editor-wrapper :deep(.ProseMirror h6::before),
.ir-editor-wrapper :deep(.ProseMirror blockquote::before) {
  content: '';
  font-family: var(--font-mono);
  font-size: 0.85em;
  font-weight: 400;
  opacity: 0.4;
  user-select: none;
  pointer-events: none;
}
.ir-editor-wrapper :deep(.ProseMirror h1.ir-active-block::before) { content: '# '; }
.ir-editor-wrapper :deep(.ProseMirror h2.ir-active-block::before) { content: '## '; }
.ir-editor-wrapper :deep(.ProseMirror h3.ir-active-block::before) { content: '### '; }
.ir-editor-wrapper :deep(.ProseMirror h4.ir-active-block::before) { content: '#### '; }
.ir-editor-wrapper :deep(.ProseMirror h5.ir-active-block::before) { content: '##### '; }
.ir-editor-wrapper :deep(.ProseMirror h6.ir-active-block::before) { content: '###### '; }
.ir-editor-wrapper :deep(.ProseMirror blockquote.ir-active-block::before) { content: '> '; display: inline; }
/* 标题标记与标题文本之间的间距 */
.ir-editor-wrapper :deep(.ProseMirror h1) { padding-left: 0.2em; }
.ir-editor-wrapper :deep(.ProseMirror h2) { padding-left: 0.4em; }
.ir-editor-wrapper :deep(.ProseMirror h3) { padding-left: 0.6em; }
.ir-editor-wrapper :deep(.ProseMirror h4) { padding-left: 0.8em; }
.ir-editor-wrapper :deep(.ProseMirror h5) { padding-left: 1em; }
.ir-editor-wrapper :deep(.ProseMirror h6) { padding-left: 1.2em; }

.ir-editor-wrapper :deep(.ProseMirror pre) {
  background: var(--color-bg-secondary);
  padding: 2em 16px 1.5em;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 0.9em; overflow-x: auto; margin: 0.5em 0;
  position: relative;
}
.ir-editor-wrapper :deep(.ProseMirror pre.ir-code-block) {
  padding-top: 2.2em;
}
.ir-editor-wrapper :deep(.ProseMirror .ir-code-language) {
  position: absolute;
  top: 6px;
  left: 10px;
  z-index: 1;
  max-width: 180px;
  padding: 2px 24px 2px 8px;
  color: var(--color-text-secondary);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font: 12px var(--font-sans);
  cursor: pointer;
}
.ir-editor-wrapper :deep(.ProseMirror .ir-code-language:focus) {
  color: var(--color-text);
  border-color: var(--color-primary);
  outline: none;
}
.ir-editor-wrapper :deep(.ProseMirror pre.ir-code-block::before) {
  display: none;
}
.ir-editor-wrapper :deep(.ProseMirror pre::before) {
  content: '';
  display: block;
  position: absolute;
  top: 0; left: 0; right: 0;
  padding: 2px 12px;
  font-size: 0.8em;
  opacity: 0.4;
  user-select: none;
  pointer-events: none;
  white-space: pre;
}
.ir-editor-wrapper :deep(.ProseMirror pre::after) {
  content: '';
  display: block;
  position: absolute;
  bottom: 0; left: 0; right: 0;
  padding: 2px 12px;
  font-size: 0.8em;
  opacity: 0.4;
  user-select: none;
  pointer-events: none;
}
.ir-editor-wrapper :deep(.ProseMirror pre.ir-active-block::before) {
  content: '```' attr(data-lang);
}
.ir-editor-wrapper :deep(.ProseMirror pre.ir-active-block::after) {
  content: '```';
}
.ir-editor-wrapper :deep(.ProseMirror code) {
  background: var(--color-bg-secondary);
  padding: 2px 6px; border-radius: 3px;
  font-size: 0.9em; font-family: var(--font-mono);
}
.ir-editor-wrapper :deep(.ProseMirror pre code) {
  background: none;
  padding: 0;
  display: block;
  min-height: 1.2em;
  white-space: pre-wrap;
}
.ir-editor-wrapper :deep(.ProseMirror img) {
  max-width: 100%; height: auto; border-radius: 4px; cursor: pointer;
}
.ir-editor-wrapper :deep(.ProseMirror img.ProseMirror-selectednode) {
  outline: 2px solid var(--color-primary);
  outline-offset: 3px;
  box-shadow: 0 0 0 4px var(--color-primary-light);
}
.ir-editor-wrapper :deep(.ProseMirror a) {
  color: var(--color-primary); text-decoration: underline;
}
.ir-container.ir-ctrl-pressed .ir-editor-wrapper :deep(.ProseMirror a) {
  cursor: pointer;
}
.ir-editor-wrapper :deep(.ProseMirror hr) {
  border: none;
  border-top: 2px solid var(--color-border);
  margin: 1.5em 0;
}
.ir-editor-wrapper :deep(.ProseMirror table) { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
.ir-editor-wrapper :deep(.ProseMirror th),
.ir-editor-wrapper :deep(.ProseMirror td) {
  border: 1px solid var(--color-border); padding: 8px 12px; min-width: 60px;
}
.ir-editor-wrapper :deep(.ProseMirror th) {
  background: var(--color-bg-secondary); font-weight: 600;
}
.ir-editor-wrapper :deep(.ProseMirror ul[data-type="task_list"]) { list-style: none; padding-left: 0; }
.ir-editor-wrapper :deep(.ProseMirror li[data-type="task_item"]) {
  display: flex; align-items: flex-start; gap: 8px;
}
.ir-editor-wrapper :deep(.ProseMirror li[data-type="task_item"] input[type="checkbox"]) {
  margin-top: 0.3em; cursor: pointer;
}
.ir-editor-wrapper :deep(.ProseMirror ::selection) { background: var(--color-primary-light); }
.ir-editor-wrapper :deep(.ProseMirror p.is-editor-empty:first-child::before) {
  content: '在此输入内容，支持 Markdown 语法...';
  color: var(--color-text-tertiary); float: left; height: 0; pointer-events: none;
}
/* 内联标记（默认隐藏且不占位，选区附近展开）
 * 由 IR 插件在光标附近的行内标记上生成 .ir-active-mark 装饰（mark 元素内的 span），
 * 因此以 [data-mark]:has(.ir-active-mark) 门控，只展开光标所在标记，而非全文。
 * 隐藏时 content 置空，避免透明标记仍占据布局宽度造成行首空白。 */
.ir-editor-wrapper :deep([data-mark]::before),
.ir-editor-wrapper :deep([data-mark]::after) {
  content: '';
  opacity: 0;
  transition: opacity 0.15s ease;
  user-select: none;
  pointer-events: none;
}
.ir-editor-wrapper :deep([data-mark]:has(.ir-active-mark)::before),
.ir-editor-wrapper :deep([data-mark]:has(.ir-active-mark)::after) {
  opacity: 0.4;
}
.ir-editor-wrapper :deep([data-mark="bold"]:has(.ir-active-mark)::before) { content: '**'; }
.ir-editor-wrapper :deep([data-mark="bold"]:has(.ir-active-mark)::after) { content: '**'; }
.ir-editor-wrapper :deep([data-mark="italic"]:has(.ir-active-mark)::before) { content: '*'; }
.ir-editor-wrapper :deep([data-mark="italic"]:has(.ir-active-mark)::after) { content: '*'; }
.ir-editor-wrapper :deep([data-mark="strikethrough"]:has(.ir-active-mark)::before) { content: '~~'; }
.ir-editor-wrapper :deep([data-mark="strikethrough"]:has(.ir-active-mark)::after) { content: '~~'; }
.ir-editor-wrapper :deep([data-mark="underline"]:has(.ir-active-mark)::before) { content: '<u>'; }
.ir-editor-wrapper :deep([data-mark="underline"]:has(.ir-active-mark)::after) { content: '</u>'; }
.ir-editor-wrapper :deep([data-mark="code"]:has(.ir-active-mark)::before) { content: '`'; }
.ir-editor-wrapper :deep([data-mark="code"]:has(.ir-active-mark)::after) { content: '`'; }
.ir-editor-wrapper :deep([data-mark="link"]:has(.ir-active-mark)::before) { content: '['; }
.ir-editor-wrapper :deep([data-mark="link"]:has(.ir-active-mark)::after) { content: '](' attr(href) ')'; }

.ir-editor-wrapper :deep(.ProseMirror .ProseMirror-cursor) {
  border-left: 2px solid var(--color-primary);
}
.ir-editor-wrapper :deep(.ProseMirror-gapcursor) { display: none; pointer-events: none; position: absolute; }

/* prosemirror-tables 样式 */
.ir-editor-wrapper :deep(.ProseMirror .tableWrapper) { overflow-x: auto; margin: 0.5em 0; }
.ir-editor-wrapper :deep(.ProseMirror table) {
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
  overflow: hidden;
}
.ir-editor-wrapper :deep(.ProseMirror td),
.ir-editor-wrapper :deep(.ProseMirror th) {
  vertical-align: top;
  box-sizing: border-box;
  position: relative;
  min-width: 1em;
  border: 1px solid var(--color-border);
  padding: 8px 12px;
  height: auto;
  line-height: 1.5;
}
.ir-editor-wrapper :deep(.ProseMirror th) {
  background: var(--color-bg-secondary);
  font-weight: 600;
}
/* 表格列对齐 */
.ir-editor-wrapper :deep(.ProseMirror td[align="left"]),
.ir-editor-wrapper :deep(.ProseMirror th[align="left"]) { text-align: left; }
.ir-editor-wrapper :deep(.ProseMirror td[align="center"]),
.ir-editor-wrapper :deep(.ProseMirror th[align="center"]) { text-align: center; }
.ir-editor-wrapper :deep(.ProseMirror td[align="right"]),
.ir-editor-wrapper :deep(.ProseMirror th[align="right"]) { text-align: right; }
/* 移除了 columnResizing 插件，不再显示 resize handle */
.ir-editor-wrapper :deep(.ProseMirror .selectedCell):after {
  z-index: 2;
  position: absolute;
  content: '';
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  background: var(--color-primary-light);
  pointer-events: none;
  opacity: 0.3;
}
.ir-editor-wrapper :deep(.ProseMirror-protectednode) { white-space: pre-wrap; }
.ir-editor-wrapper :deep(.ProseMirror-focused .ProseMirror-gapcursor) { display: block; }
.ir-editor-wrapper :deep(.ProseMirror-gapcursor:after) {
  content: ''; display: block; position: absolute; top: -2px; width: 20px;
  border-top: 1px solid var(--color-text);
  animation: ProseMirror-cursor-blink 1.1s steps(2, start) infinite;
}
@keyframes ProseMirror-cursor-blink { to { visibility: hidden; } }

</style>
