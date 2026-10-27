<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  IconChevronRight,
  IconCopy,
  IconFile,
  IconFolder,
  IconMessageChatbot,
  IconMinus,
  IconMoon,
  IconRefresh,
  IconSquare,
  IconSun,
  IconX
} from '@tabler/icons-vue'
import { useFileStore, type EditorMode } from '../../stores/file'
import { useThemeStore } from '../../stores/theme'
import { useUpdateStore } from '../../stores/update'
import { useAiStore } from '../../stores/ai'
import { buildBarItems } from '../../utils/tab-order'
import { useSyncStore } from '../../stores/sync'
import {
  useAppearanceStore,
  MIN_UI_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_LINE_HEIGHT,
  MAX_EDITOR_LINE_HEIGHT,
  EDITOR_FONT_FAMILY_PRESETS,
  EDITOR_MONO_FONT_FAMILY_PRESETS,
  CUSTOM_FONT_SENTINEL
} from '../../stores/appearance'
import { requestDialog } from '../../utils/dialog'
import { findCodeLanguage, languageDisplayName } from '../../utils/editor-language'
import SyncPanel from './SyncPanel.vue'
import QuickOpenPalette from '../common/QuickOpenPalette.vue'
import Tooltip from '../common/Tooltip.vue'

const fileStore = useFileStore()
const themeStore = useThemeStore()
const updateStore = useUpdateStore()
const aiStore = useAiStore()
const syncStore = useSyncStore()
const appearanceStore = useAppearanceStore()
const isMaximized = ref(false)
const quickOpenVisible = ref(false)

/** 快速打开文件（Ctrl+P）：未打开文件夹时给出提示 */
async function openQuickOpen(): Promise<void> {
  if (!fileStore.openedFolderPath) {
    await requestDialog({
      title: '快速打开文件',
      message: '请先打开文件夹后再搜索文件',
      buttons: [{ label: '确定', value: 0, primary: true }]
    })
    return
  }
  quickOpenVisible.value = true
}

function handleQuickOpenEvent(): void {
  void openQuickOpen()
}

// ===== 菜单状态 =====
interface MenuItem {
  kind: 'item' | 'divider' | 'submenu'
  label?: string
  action?: string
  shortcut?: string
  payload?: string
  checked?: boolean
  icon?: string
  disabled?: boolean
  children?: MenuItem[]
}

const activeMenu = ref<string | null>(null)
const menuPosition = ref({ left: 0, top: 0 })
const hoveredRecentPath = ref<string | null>(null)

function hoverRecentItem(item: MenuItem): void {
  hoveredRecentPath.value = item.payload ?? null
}

function clearHoveredRecentItem(): void {
  hoveredRecentPath.value = null
}

const fileMenu = computed<MenuItem[]>(() => {
  const recentItems: MenuItem[] = fileStore.recentFiles.map((item) => ({
    kind: 'item',
    label: item.path.split(/[/\\]/).pop() || item.path,
    action: item.type === 'folder' ? 'recent-folder' : 'recent-file',
    payload: item.path,
    icon: item.type === 'folder' ? 'folder' : 'file'
  }))

  const recentChildren: MenuItem[] =
    recentItems.length > 0
      ? [
          ...recentItems,
          { kind: 'divider' },
          { kind: 'item', label: '清空最近文件', action: 'clear-recent' }
        ]
      : [{ kind: 'item', label: '（无最近文件）', action: 'none' }]

  const recentMenu: MenuItem = { kind: 'submenu', label: '最近文件', children: recentChildren }

  /*
   * 聚合入口：新建 / 打开 / 导入 / 导出 各自收成一个二级菜单。
   * 父项负责「动作」，子项只写对象（文件、文件夹、思维导图…），
   * 既避免「新建 ▸ 新建文件」这种重复，也让文件菜单从 20 多项降到 10 项左右。
   */
  const newMenu: MenuItem = {
    kind: 'submenu',
    label: '新建',
    children: [
      { kind: 'item', label: '文件', action: 'new', shortcut: 'Ctrl+N' },
      { kind: 'item', label: '思维导图', action: 'new-mindmap', shortcut: 'Ctrl+Shift+N' },
      {
        kind: 'item',
        label: '由当前笔记生成',
        action: 'md-to-mindmap',
        disabled: !canConvertToMindMap.value
      }
    ]
  }

  const openMenu: MenuItem = {
    kind: 'submenu',
    label: '打开',
    children: [
      { kind: 'item', label: '文件', action: 'open', shortcut: 'Ctrl+O' },
      { kind: 'item', label: '文件夹', action: 'open-folder' },
      { kind: 'item', label: '快速打开', action: 'quick-open', shortcut: 'Ctrl+P' },
      ...(fileStore.openedFolderPath
        ? [{ kind: 'item', label: '关闭文件夹', action: 'close-folder' } as MenuItem]
        : [])
    ]
  }

  const importMenu: MenuItem = {
    kind: 'submenu',
    label: '导入',
    children: [
      { kind: 'item', label: 'Markdown', action: 'import-md' },
      { kind: 'item', label: 'Word 文档', action: 'import-docx' },
      // 导入 XMind 会落一个本地 `.inkmind`（重名不覆盖），与上面几种导入同一套行为
      { kind: 'item', label: 'XMind 文件', action: 'import-xmind' },
      { kind: 'item', label: '文件夹', action: 'import-folder' }
    ]
  }

  // 思维导图没有 Markdown 正文，导出 PDF/Markdown 对它无意义：保留在菜单里但置灰，
  // 比「菜单项凭空消失」更容易理解；大纲与图片导出则只有导图可用。
  const exportMenu: MenuItem = {
    kind: 'submenu',
    label: '导出',
    children: [
      { kind: 'item', label: 'Markdown', action: 'export-md', disabled: isMindMapActiveTab.value },
      {
        kind: 'item',
        label: 'XMind 文件',
        action: 'export-xmind',
        disabled: !isMindMapActiveTab.value
      },
      {
        kind: 'item',
        label: '思维导图大纲',
        action: 'export-mindmap-outline',
        disabled: !isMindMapActiveTab.value
      },
      { kind: 'divider' },
      {
        kind: 'item',
        label: 'PNG 图片',
        action: 'export-mindmap-png',
        disabled: !isMindMapActiveTab.value
      },
      {
        kind: 'item',
        label: 'SVG 矢量图',
        action: 'export-mindmap-svg',
        disabled: !isMindMapActiveTab.value
      },
      { kind: 'divider' },
      { kind: 'item', label: 'PDF', action: 'export-pdf', disabled: isMindMapActiveTab.value },
      {
        kind: 'item',
        label: '批量 PDF',
        action: 'export-batch-pdf',
        disabled: isMindMapActiveTab.value
      }
    ]
  }

  return [
    newMenu,
    openMenu,
    recentMenu,
    { kind: 'divider' },
    { kind: 'item', label: '保存', action: 'save', shortcut: 'Ctrl+S' },
    { kind: 'item', label: '另存为', action: 'save-as', shortcut: 'Ctrl+Shift+S' },
    { kind: 'divider' },
    importMenu,
    exportMenu,
    { kind: 'divider' },
    {
      kind: 'item',
      label: '同步',
      action: 'sync',
      checked: syncStore.panelOpen,
      disabled: !fileStore.openedFolderPath
    },
    { kind: 'divider' },
    { kind: 'item', label: '退出', action: 'exit' }
  ]
})

/**
 * 编辑菜单。
 * 思维导图没有「文本选区」概念：系统剪贴板的剪切/复制/粘贴由渲染库自己按节点处理
 * （Ctrl+C/V 在画布上直接生效），菜单栏这几项对它无效，因此置灰而不是点了没反应；
 * 撤销/重做接在渲染库的历史栈上，「查找」走组件自己的节点搜索（导图没有正文、
 * 也就没有替换，所以替换仍然置灰）。
 */
const editMenu = computed<MenuItem[]>(() => [
  { kind: 'item', label: '撤销', action: 'undo', shortcut: 'Ctrl+Z' },
  { kind: 'item', label: '重做', action: 'redo', shortcut: 'Ctrl+Y' },
  { kind: 'divider' },
  {
    kind: 'item',
    label: '剪切',
    action: 'cut',
    shortcut: 'Ctrl+X',
    disabled: isMindMapActiveTab.value
  },
  {
    kind: 'item',
    label: '复制',
    action: 'copy',
    shortcut: 'Ctrl+C',
    disabled: isMindMapActiveTab.value
  },
  {
    kind: 'item',
    label: '粘贴',
    action: 'paste',
    shortcut: 'Ctrl+V',
    disabled: isMindMapActiveTab.value
  },
  { kind: 'divider' },
  {
    kind: 'item',
    label: '查找',
    action: 'find',
    shortcut: 'Ctrl+F'
  },
  {
    kind: 'item',
    label: '替换',
    action: 'replace',
    shortcut: 'Ctrl+H',
    disabled: isMindMapActiveTab.value
  }
])

/** 当前生效的编辑模式：非 .md/.mdx 文件（如 .txt）实际按源码编辑显示 */
const effectiveMode = computed<EditorMode>(() => fileStore.effectiveEditorMode)

/** 当前标签是否为思维导图（无 Markdown 正文，部分菜单项对它不适用） */
const isMindMapActiveTab = computed(() => fileStore.activeTab?.fileInfo?.format === 'mindmap')

/**
 * 能否把当前笔记转成导图：需要有可编辑的文本内容。
 * 导图本身、PDF/图片这类标签没有 Markdown 层级，转换只会得到一张空图。
 */
const canConvertToMindMap = computed(
  () => !isMindMapActiveTab.value && (fileStore.activeTab?.content ?? '').trim().length > 0
)

/** 纯文本模式按后缀匹配到的语言展示名（如 Shell/INI），无匹配时回退“纯文本” */
const plainLanguageLabel = computed<string | null>(() => {
  const name = fileStore.activeTab?.fileInfo?.name
  if (!name) return null
  const desc = findCodeLanguage(name)
  return desc ? languageDisplayName(desc) : null
})

const viewMenu = computed<MenuItem[]>(() => [
  {
    kind: 'submenu',
    label: '编辑器模式',
    disabled: !fileStore.canSwitchEditorMode,
    children: [
      {
        kind: 'item',
        label: '即时渲染',
        action: 'mode-ir',
        checked: effectiveMode.value === 'ir',
        disabled: !fileStore.canSwitchEditorMode
      },
      {
        kind: 'item',
        label: '源码编辑',
        action: 'mode-source',
        checked: effectiveMode.value === 'source',
        disabled: !fileStore.canSwitchEditorMode
      },
      {
        kind: 'item',
        label: '分屏预览',
        action: 'mode-split',
        checked: effectiveMode.value === 'split',
        disabled: !fileStore.canSwitchEditorMode
      },
      ...(effectiveMode.value === 'plain'
        ? [
            {
              kind: 'item' as const,
              label: fileStore.isPdfActiveTab ? 'PDF 预览' : (plainLanguageLabel.value ?? '纯文本'),
              action: 'mode-plain',
              checked: true,
              disabled: true
            }
          ]
        : [])
    ]
  },
  {
    kind: 'submenu',
    label: '主题',
    children: [
      { kind: 'item', label: '浅色', action: 'theme-light', checked: themeStore.theme === 'light' },
      { kind: 'item', label: '深色', action: 'theme-dark', checked: themeStore.theme === 'dark' },
      {
        kind: 'item',
        label: '跟随系统',
        action: 'theme-system',
        checked: themeStore.theme === 'system'
      }
    ]
  },
  { kind: 'divider' },
  {
    kind: 'item',
    label: '显示侧边栏',
    action: 'toggle-sidebar',
    checked: !fileStore.sidebarCollapsed
  },
  { kind: 'item', label: 'AI 助手', action: 'open-ai', checked: aiStore.panelOpen },
  { kind: 'divider' },
  { kind: 'item', label: '设置', action: 'settings', shortcut: 'Ctrl+,' }
])

const insertMenu: MenuItem[] = [
  { kind: 'item', label: '插入图片', action: 'insert-image', shortcut: 'Ctrl+Shift+K' },
  { kind: 'item', label: '插入链接', action: 'insert-link', shortcut: 'Ctrl+K' },
  { kind: 'divider' },
  { kind: 'item', label: '插入表格', action: 'insert-table' },
  { kind: 'item', label: '插入代码块', action: 'insert-code' },
  { kind: 'item', label: '插入分割线', action: 'insert-hr' },
  { kind: 'divider' },
  { kind: 'item', label: '插入附件', action: 'insert-attachment' }
]

const helpMenu: MenuItem[] = [
  { kind: 'item', label: '检查更新', action: 'check-updates' },
  { kind: 'item', label: '快捷键速查', action: 'shortcuts' },
  { kind: 'item', label: '使用文档', action: 'docs' },
  { kind: 'divider' },
  { kind: 'item', label: '关于 Inkase', action: 'about' }
]

const shortcuts = [
  { keys: 'Ctrl+N', label: '新建文件' },
  { keys: 'Ctrl+Shift+N', label: '新建思维导图' },
  { keys: 'Ctrl+O', label: '打开文件' },
  { keys: 'Ctrl+P', label: '快速打开文件' },
  { keys: 'Ctrl+S', label: '保存文件' },
  { keys: 'Ctrl+Shift+S', label: '另存为' },
  { keys: 'Ctrl+Z', label: '撤销' },
  { keys: 'Ctrl+Y', label: '重做' },
  { keys: 'Ctrl+X', label: '剪切' },
  { keys: 'Ctrl+C', label: '复制' },
  { keys: 'Ctrl+V', label: '粘贴' },
  { keys: 'Ctrl+B', label: '粗体' },
  { keys: 'Ctrl+I', label: '斜体' },
  { keys: 'Ctrl+K', label: '插入链接' },
  { keys: 'Ctrl+Shift+K', label: '插入图片' },
  { keys: 'Ctrl+F', label: '查找' },
  { keys: 'Ctrl+H', label: '替换' },
  { keys: 'Shift+Alt+F', label: '格式化文档（代码/纯文本）' },
  { keys: 'Ctrl+/', label: '切换编辑模式' },
  { keys: 'Ctrl+←/→', label: '切换标签' },
  { keys: 'Ctrl+滚轮', label: '缩放编辑区字号' },
  { keys: 'Ctrl+,', label: '打开设置' }
]

const MENU_DEFS = [
  { name: 'file', label: '文件' },
  { name: 'edit', label: '编辑' },
  { name: 'view', label: '视图' },
  { name: 'insert', label: '插入' },
  { name: 'help', label: '帮助' }
]

const menus = computed<Record<string, MenuItem[]>>(() => ({
  file: fileMenu.value,
  edit: editMenu.value,
  view: viewMenu.value,
  insert: insertMenu,
  help: helpMenu
}))

const currentMenuItems = computed<MenuItem[]>(() => {
  if (!activeMenu.value) return []
  return menus.value[activeMenu.value] ?? []
})

const EDIT_ACTIONS = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'find', 'replace'])
const settingsOpen = ref(false)
const settingsCompressEnabled = ref(true)
const settingsCompressQuality = ref(85)
const settingsMaxTabs = ref(20)
const settingsUiFontSize = ref(appearanceStore.uiFontSize)
const settingsEditorFontSize = ref(appearanceStore.editorFontSize)
const settingsEditorFontFamily = ref('')
const settingsEditorMonoFontFamily = ref('')
const settingsEditorLineHeight = ref(appearanceStore.editorLineHeight)
// select 绑定值：预设 value，或「自定义…」哨兵
const editorFontFamilySelect = ref('')
const editorMonoFontFamilySelect = ref('')
const editorFontFamilyCustom = ref(false)
const editorMonoFontFamilyCustom = ref(false)

/** 将存储的字体值映射为 select 值：预设原样，未知值进入自定义模式 */
function toFontSelectValue(value: string): string {
  if (!value) return ''
  const isPreset =
    EDITOR_FONT_FAMILY_PRESETS.some((p) => p.value === value) ||
    EDITOR_MONO_FONT_FAMILY_PRESETS.some((p) => p.value === value)
  return isPreset ? value : CUSTOM_FONT_SENTINEL
}

function handleEditorFontFamilyChange(): void {
  if (editorFontFamilySelect.value === CUSTOM_FONT_SENTINEL) {
    editorFontFamilyCustom.value = true
  } else {
    editorFontFamilyCustom.value = false
    settingsEditorFontFamily.value = editorFontFamilySelect.value
  }
}

function handleEditorMonoFontFamilyChange(): void {
  if (editorMonoFontFamilySelect.value === CUSTOM_FONT_SENTINEL) {
    editorMonoFontFamilyCustom.value = true
  } else {
    editorMonoFontFamilyCustom.value = false
    settingsEditorMonoFontFamily.value = editorMonoFontFamilySelect.value
  }
}
const linkDialogOpen = ref(false)
const linkHref = ref('')
const linkTitle = ref('')
const imageDialogOpen = ref(false)
const imageSrc = ref('')
const imageAlt = ref('')
const shortcutsOpen = ref(false)
const aboutOpen = ref(false)
const appVersion = ref('开发版')

function closeMenu(): void {
  activeMenu.value = null
}

function toggleMenu(name: string, event: MouseEvent): void {
  if (activeMenu.value === name) {
    closeMenu()
    return
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  activeMenu.value = name
  menuPosition.value = { left: rect.left, top: rect.bottom }
}

function onMenuHover(name: string, event: MouseEvent): void {
  if (!activeMenu.value || activeMenu.value === name) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  activeMenu.value = name
  menuPosition.value = { left: rect.left, top: rect.bottom }
}

function handleDocumentMousedown(event: MouseEvent): void {
  if (!activeMenu.value) return
  const target = event.target as HTMLElement
  const dropdown = document.querySelector('.menu-dropdown')
  if (dropdown && dropdown.contains(target)) return
  if (target.closest('.menu-bar')) return
  closeMenu()
}

// ===== 文件操作 =====

async function newFile(): Promise<void> {
  if (!(await fileStore.confirmSaveBeforeAction())) return
  await fileStore.newFile()
}

async function newMindMap(): Promise<void> {
  if (!(await fileStore.confirmSaveBeforeAction())) return
  await fileStore.newMindMap()
}

async function openFile(filePath?: string): Promise<void> {
  if (!(await fileStore.confirmSaveBeforeAction())) return
  await fileStore.openFile(filePath)
}

async function saveFile(): Promise<void> {
  await fileStore.saveFile()
}

async function saveAsFile(): Promise<void> {
  await fileStore.saveAsFile()
}

async function exportCurrentPdf(): Promise<void> {
  const tabId = fileStore.activeTabId
  if (!tabId) return
  await fileStore.exportTabToPdf(tabId)
}

async function exportBatchPdf(): Promise<void> {
  if (!fileStore.openedFolderPath) {
    const opened = await fileStore.openFolder()
    if (!opened || !fileStore.openedFolderPath) return
  }
  await fileStore.exportFolderToPdf(fileStore.openedFolderPath)
}

/**
 * 导出思维导图图片。
 *
 * 失败必须说出来：图片导出可能因「画布还没渲染完 / 内容为空 / PNG 编码失败」
 * 而中止，这些都不是用户点错了菜单，静默失败只会让人觉得功能不存在。
 */
async function exportMindMapImage(format: 'png' | 'svg'): Promise<void> {
  const ok = await fileStore.exportMindMapImage(format)
  if (!ok && fileStore.error) {
    await requestDialog({
      title: '导出失败',
      message: fileStore.error,
      buttons: [{ label: '确定', value: 0, primary: true }]
    })
  }
}

/** 从最近文件列表中移除单条记录 */
async function removeRecentItem(item: MenuItem): Promise<void> {
  if (!item.payload) return
  hoveredRecentPath.value = null
  await fileStore.removeRecent(item.payload)
}

async function clearRecentFiles(): Promise<void> {
  const choice = await requestDialog({
    title: '清空最近文件',
    message: '确定要清空所有最近打开的文件和文件夹记录吗？',
    buttons: [
      { label: '取消', value: 1 },
      { label: '清空', value: 0, primary: true }
    ]
  })
  if (choice === 0) {
    await fileStore.clearRecent()
  }
}

async function runMenuItem(item: MenuItem): Promise<void> {
  if (item.kind !== 'item' || !item.action || item.action === 'none' || item.disabled) return
  closeMenu()
  if (EDIT_ACTIONS.has(item.action)) {
    window.dispatchEvent(new CustomEvent(`editor:${item.action}`))
    return
  }
  if (item.action.startsWith('mode-')) {
    fileStore.setEditorMode(item.action.replace('mode-', '') as 'ir' | 'source' | 'split')
    return
  }
  if (item.action.startsWith('theme-')) {
    themeStore.setTheme(item.action.replace('theme-', '') as 'light' | 'dark' | 'system')
    return
  }
  switch (item.action) {
    case 'new':
      await newFile()
      break
    case 'new-mindmap':
      await newMindMap()
      break
    case 'open':
      await openFile()
      break
    case 'open-folder':
      await fileStore.openFolder()
      break
    case 'quick-open':
      await openQuickOpen()
      break
    case 'close-folder':
      await fileStore.closeFolder()
      break
    case 'save':
      await saveFile()
      break
    case 'save-as':
      await saveAsFile()
      break
    case 'import-md':
      await fileStore.importMarkdown()
      break
    case 'import-docx':
      await fileStore.importDocx()
      break
    case 'import-folder':
      await fileStore.importFolder()
      break
    case 'import-xmind':
      await fileStore.importXmind()
      break
    case 'md-to-mindmap': {
      // 转换只新建标签，原笔记保持原样；失败（内容为空/标签已满）静默无副作用
      const created = fileStore.convertActiveToMindMap()
      if (!created) {
        console.warn('[mindmap] 当前笔记无法转换为思维导图（内容为空或标签已满）')
      }
      break
    }
    case 'export-md':
      await fileStore.exportMarkdown()
      break
    case 'export-mindmap-outline':
      await fileStore.exportMindMapOutline()
      break
    case 'export-xmind':
      await fileStore.exportXmind()
      break
    case 'export-mindmap-png':
      await exportMindMapImage('png')
      break
    case 'export-mindmap-svg':
      await exportMindMapImage('svg')
      break
    case 'export-pdf':
      await exportCurrentPdf()
      break
    case 'export-batch-pdf':
      await exportBatchPdf()
      break
    case 'recent-file':
      await openFile(item.payload)
      break
    case 'recent-folder':
      if (item.payload) {
        await fileStore.openFolderPath(item.payload)
      }
      break
    case 'clear-recent':
      await clearRecentFiles()
      break
    case 'exit':
      window.electronAPI?.windowClose()
      break
    case 'toggle-sidebar':
      fileStore.toggleSidebar()
      break
    case 'open-ai':
      aiStore.openPanel()
      break
    case 'sync':
      syncStore.openPanel()
      break
    case 'settings':
      openSettings()
      break
    case 'insert-image':
      openImageDialog()
      break
    case 'insert-link':
      openLinkDialog()
      break
    case 'insert-table':
      window.dispatchEvent(new CustomEvent('editor:format', { detail: 'table' }))
      break
    case 'insert-code':
      window.dispatchEvent(new CustomEvent('editor:codeBlock', { detail: { language: '' } }))
      break
    case 'insert-hr':
      window.dispatchEvent(new CustomEvent('editor:format', { detail: 'horizontalRule' }))
      break
    case 'insert-attachment':
      await selectAttachmentFile()
      break
    case 'check-updates':
      {
        const result = await updateStore.check()
        if (result === 'not-available') {
          await window.electronAPI.showMessageBox({
            type: 'info',
            title: '检查更新',
            message: '当前已是最新版本'
          })
        } else if (result === 'error') {
          await window.electronAPI.showMessageBox({
            type: 'error',
            title: '检查更新失败',
            message: updateStore.errorMessage || '检查更新失败'
          })
        }
        // available 时由 UpdateDialog 自动弹出
      }
      break
    case 'shortcuts':
      shortcutsOpen.value = true
      break
    case 'docs':
      {
        try {
          const result = await window.electronAPI.getUserGuidePath()
          if (!result.success || !result.data) {
            await window.electronAPI.showMessageBox({
              type: 'error',
              title: '打开使用教程失败',
              message: result.error || '内置使用教程不存在。'
            })
            break
          }
          // 使用内置 PDF 查看器打开教程
          const opened = await fileStore.openFile(result.data, { addToRecent: false })
          if (!opened && fileStore.error) {
            await window.electronAPI.showMessageBox({
              type: 'error',
              title: '打开使用教程失败',
              message: fileStore.error
            })
          }
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error)
          await window.electronAPI.showMessageBox({
            type: 'error',
            title: '打开使用教程失败',
            message: `无法打开内置使用教程：${details}`
          })
        }
      }
      break
    case 'about':
      aboutOpen.value = true
      break
  }
}

function chooseFile(accept?: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

function openImageDialog(): void {
  imageSrc.value = ''
  imageAlt.value = ''
  imageDialogOpen.value = true
}

function openLinkDialog(): void {
  linkHref.value = ''
  linkTitle.value = ''
  linkDialogOpen.value = true
}

function confirmInsertLink(): void {
  const href = linkHref.value.trim()
  if (!href) return
  window.dispatchEvent(
    new CustomEvent('editor:link', {
      detail: { href, title: linkTitle.value.trim() }
    })
  )
  linkDialogOpen.value = false
}

function confirmInsertImage(): void {
  const src = imageSrc.value.trim()
  if (!src) return
  window.dispatchEvent(
    new CustomEvent('editor:image', {
      detail: { src, alt: imageAlt.value.trim() }
    })
  )
  imageDialogOpen.value = false
}

async function selectImageFile(): Promise<void> {
  const file = await chooseFile('image/*')
  if (!file) return
  const result = await fileStore.addImage(file)
  if (!result.success || !result.path) return
  window.dispatchEvent(
    new CustomEvent('editor:image', {
      detail: { src: result.path, alt: file.name }
    })
  )
  imageDialogOpen.value = false
}

async function selectAttachmentFile(): Promise<void> {
  const file = await chooseFile()
  if (!file) return
  const result = await fileStore.addAttachment(file)
  if (!result.success || !result.path) return
  window.dispatchEvent(
    new CustomEvent('editor:attachment', {
      detail: { path: result.path, name: file.name }
    })
  )
}

function openSettings(): void {
  settingsCompressEnabled.value = fileStore.imageCompressSettings.enabled
  settingsCompressQuality.value = fileStore.imageCompressSettings.quality
  settingsMaxTabs.value = fileStore.maxOpenTabs
  settingsUiFontSize.value = appearanceStore.uiFontSize
  settingsEditorFontSize.value = appearanceStore.editorFontSize
  settingsEditorFontFamily.value = appearanceStore.editorFontFamily
  settingsEditorMonoFontFamily.value = appearanceStore.editorMonoFontFamily
  settingsEditorLineHeight.value = appearanceStore.editorLineHeight
  editorFontFamilySelect.value = toFontSelectValue(settingsEditorFontFamily.value)
  editorFontFamilyCustom.value = editorFontFamilySelect.value === CUSTOM_FONT_SENTINEL
  editorMonoFontFamilySelect.value = toFontSelectValue(settingsEditorMonoFontFamily.value)
  editorMonoFontFamilyCustom.value = editorMonoFontFamilySelect.value === CUSTOM_FONT_SENTINEL
  settingsOpen.value = true
}

function saveSettings(): void {
  fileStore.setImageCompressSettings({
    enabled: settingsCompressEnabled.value,
    quality: settingsCompressQuality.value
  })
  fileStore.setMaxOpenTabs(settingsMaxTabs.value)
  appearanceStore.setUiFontSize(settingsUiFontSize.value)
  appearanceStore.setEditorFontSize(settingsEditorFontSize.value)
  appearanceStore.setEditorFontFamily(
    editorFontFamilyCustom.value ? settingsEditorFontFamily.value : editorFontFamilySelect.value
  )
  appearanceStore.setEditorMonoFontFamily(
    editorMonoFontFamilyCustom.value
      ? settingsEditorMonoFontFamily.value
      : editorMonoFontFamilySelect.value
  )
  appearanceStore.setEditorLineHeight(settingsEditorLineHeight.value)
  settingsOpen.value = false
}

function toggleTheme(): void {
  themeStore.toggleTheme()
}

function toggleAiPanel(): void {
  if (aiStore.panelOpen) {
    void aiStore.requestClosePanel()
  } else {
    aiStore.openPanel()
  }
}

const syncTooltip = computed(() => {
  const labels: Record<string, string> = {
    upToDate: '已同步',
    pendingCommit: '有未提交变更',
    pendingPush: '有本地提交待推送',
    pendingPull: '有远端更新待拉取',
    conflict: '存在冲突',
    error: '同步出错',
    syncing: '同步中',
    uninitialized: '同步未配置'
  }
  const action = syncStore.panelOpen ? '点击收起同步面板' : '点击打开同步面板'
  return `${labels[syncStore.status] ?? '同步'}（${action}）`
})

function handleMinimize(): void {
  window.electronAPI?.windowMinimize()
}

function handleMaximize(): void {
  window.electronAPI?.windowMaximize()
}

function handleClose(): void {
  window.electronAPI?.windowClose()
}

/**
 * 切换编辑模式（Ctrl+/）
 * 顺序：分屏预览 -> 源码编辑 -> 即时渲染 -> 分屏预览
 */
function handleToggleModeEvent(): void {
  if (!fileStore.canSwitchEditorMode) return
  const modes: Array<'split' | 'source' | 'ir'> = ['split', 'source', 'ir']
  const currentMode = fileStore.editorMode === 'plain' ? 'source' : fileStore.editorMode
  const currentIndex = modes.indexOf(currentMode)
  const nextIndex = (currentIndex + 1) % modes.length
  fileStore.setEditorMode(modes[nextIndex])
}

function isTextInputTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return element?.tagName === 'INPUT' || element?.tagName === 'TEXTAREA'
}

function handleTabNavigationKeydown(event: KeyboardEvent): boolean {
  if (event.isComposing) return false
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return false

  // 只保留 Ctrl+←/→（Alt+←/→ 已移除）。Ctrl+←/→ 与编辑器内「按词移动光标」冲突，
  // 因此在捕获阶段先于编辑器处理并阻止其继续处理；输入框（查找/重命名/AI 输入等）
  // 仍保留原生行为，由 handleTabNavigationCapture 过滤
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false

  const items = buildBarItems(fileStore.tabs, aiStore.panelOpen, aiStore.tabIndex)
  if (items.length < 2) return false

  const currentIndex = aiStore.panelActive
    ? items.findIndex((item) => item.kind === 'ai')
    : items.findIndex((item) => item.kind === 'file' && item.tab.id === fileStore.activeTabId)
  const offset = event.key === 'ArrowRight' ? 1 : -1
  const nextIndex =
    ((currentIndex === -1 ? 0 : currentIndex) + offset + items.length) % items.length
  const next = items[nextIndex]
  event.preventDefault()
  if (next.kind === 'ai') {
    aiStore.activatePanel()
  } else {
    if (aiStore.panelActive) aiStore.deactivatePanel()
    void fileStore.setActiveTab(next.tab.id)
  }
  return true
}

/** 捕获阶段拦截：编辑器会消费 Ctrl+方向键，冒泡阶段已来不及 */
function handleTabNavigationCapture(event: KeyboardEvent): void {
  if (isTextInputTarget(event.target)) return
  if (handleTabNavigationKeydown(event)) event.stopPropagation()
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (
      settingsOpen.value ||
      linkDialogOpen.value ||
      imageDialogOpen.value ||
      shortcutsOpen.value ||
      aboutOpen.value
    ) {
      settingsOpen.value = false
      linkDialogOpen.value = false
      imageDialogOpen.value = false
      shortcutsOpen.value = false
      aboutOpen.value = false
      return
    }
    closeMenu()
    return
  }

  if (!event.ctrlKey) return

  if (event.key === 'n') {
    event.preventDefault()
    if (event.shiftKey) {
      newMindMap()
    } else {
      newFile()
    }
  } else if (event.key === 'o') {
    event.preventDefault()
    openFile()
  } else if (event.key === 'p') {
    event.preventDefault()
    void openQuickOpen()
  } else if (event.key === 's') {
    event.preventDefault()
    if (event.shiftKey) {
      saveAsFile()
    } else {
      saveFile()
    }
  } else if (event.key === ',') {
    event.preventDefault()
    openSettings()
  }
}

let removeMaximizedListener: (() => void) | null = null
let removeUnmaximizedListener: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  // 捕获阶段处理标签切换，保证编辑器聚焦时也能生效
  window.addEventListener('keydown', handleTabNavigationCapture, true)
  document.addEventListener('mousedown', handleDocumentMousedown)
  window.addEventListener('editor:toggleMode', handleToggleModeEvent)
  window.addEventListener('editor:showLinkDialog', openLinkDialog)
  window.addEventListener('editor:showImageDialog', openImageDialog)
  window.addEventListener('inkase:quick-open', handleQuickOpenEvent)

  const maximized = await window.electronAPI?.windowIsMaximized()
  isMaximized.value = maximized ?? false

  const version = await window.electronAPI?.getVersion()
  if (version) appVersion.value = version

  removeMaximizedListener =
    window.electronAPI?.onWindowMaximized(() => {
      isMaximized.value = true
    }) ?? null
  removeUnmaximizedListener =
    window.electronAPI?.onWindowUnmaximized(() => {
      isMaximized.value = false
    }) ?? null
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('keydown', handleTabNavigationCapture, true)
  document.removeEventListener('mousedown', handleDocumentMousedown)
  window.removeEventListener('editor:toggleMode', handleToggleModeEvent)
  window.removeEventListener('editor:showLinkDialog', openLinkDialog)
  window.removeEventListener('editor:showImageDialog', openImageDialog)
  window.removeEventListener('inkase:quick-open', handleQuickOpenEvent)
  removeMaximizedListener?.()
  removeUnmaximizedListener?.()
})
</script>

<template>
  <header class="app-header">
    <img src="../../assets/logo.svg" alt="M+" class="logo-icon" />

    <nav class="menu-bar">
      <div
        v-for="menu in MENU_DEFS"
        :key="menu.name"
        class="menu-item"
        :class="{ open: activeMenu === menu.name }"
        @click.stop="toggleMenu(menu.name, $event)"
        @mouseenter="onMenuHover(menu.name, $event)"
      >
        {{ menu.label }}
      </div>
    </nav>

    <div class="window-drag-region" />

    <div class="header-right">
      <Tooltip :content="syncTooltip">
        <button
          class="icon-btn sync-btn"
          :data-status="syncStore.status"
          :disabled="!fileStore.openedFolderPath"
          :aria-label="syncStore.panelOpen ? '收起同步面板' : '打开同步面板'"
          :class="{ active: syncStore.panelOpen }"
          @click="syncStore.togglePanel()"
        >
          <IconRefresh class="icon" :class="{ spinning: syncStore.syncing }" />
        </button>
      </Tooltip>

      <Tooltip :content="aiStore.panelOpen ? '关闭 AI 助手' : 'AI 助手'">
        <button
          class="icon-btn"
          :aria-label="aiStore.panelOpen ? '关闭 AI 助手' : 'AI 助手'"
          :class="{ active: aiStore.panelOpen }"
          @click="toggleAiPanel"
        >
          <IconMessageChatbot class="icon" />
        </button>
      </Tooltip>

      <Tooltip :content="themeStore.isDark ? '切换到浅色主题' : '切换到深色主题'">
        <button class="icon-btn" @click="toggleTheme">
          <IconSun v-if="themeStore.isDark" class="icon" />
          <IconMoon v-else class="icon" />
        </button>
      </Tooltip>

      <div class="window-controls">
        <Tooltip content="最小化">
          <button class="window-btn" @click="handleMinimize">
            <IconMinus :size="14" />
          </button>
        </Tooltip>
        <Tooltip :content="isMaximized ? '还原' : '最大化'">
          <button class="window-btn" @click="handleMaximize">
            <IconCopy v-if="isMaximized" :size="14" />
            <IconSquare v-else :size="14" />
          </button>
        </Tooltip>
        <Tooltip content="关闭">
          <button class="window-btn close" @click="handleClose">
            <IconX :size="14" />
          </button>
        </Tooltip>
      </div>
    </div>

    <teleport to="body">
      <div
        v-if="activeMenu"
        class="menu-dropdown"
        :style="{ left: menuPosition.left + 'px', top: menuPosition.top + 'px' }"
        @click.stop
      >
        <template v-for="(item, index) in currentMenuItems" :key="index">
          <div v-if="item.kind === 'divider'" class="menu-divider" />
          <div
            v-else-if="item.kind === 'submenu'"
            class="menu-entry has-sub"
            :class="{ disabled: item.disabled }"
          >
            <span>{{ item.label }}</span>
            <IconChevronRight class="sub-indicator" :size="12" />
            <div class="submenu">
              <template v-for="(sub, subIndex) in item.children" :key="subIndex">
                <div v-if="sub.kind === 'divider'" class="menu-divider" />
                <Tooltip v-else block :content="sub.payload || ''">
                  <div
                    class="menu-entry"
                    :class="{ disabled: sub.disabled || sub.action === 'none' }"
                    @mouseenter="hoverRecentItem(sub)"
                    @mouseleave="clearHoveredRecentItem"
                    @click="runMenuItem(sub)"
                  >
                    <span class="menu-entry-label">
                      <span v-if="sub.icon" class="menu-icon">
                        <IconFolder v-if="sub.icon === 'folder'" :size="14" />
                        <IconFile v-else-if="sub.icon === 'file'" :size="14" />
                      </span>
                      <span v-if="sub.checked !== undefined" class="menu-check">{{
                        sub.checked ? '✓' : ''
                      }}</span>
                      {{ sub.label }}
                    </span>
                    <!-- 二级菜单里的条目同样要显示快捷键，否则挪进子菜单的 Ctrl+N 会「消失」 -->
                    <span v-if="sub.shortcut" class="shortcut">{{ sub.shortcut }}</span>
                    <button
                      v-if="
                        (sub.action === 'recent-file' || sub.action === 'recent-folder') &&
                        hoveredRecentPath === sub.payload
                      "
                      class="recent-remove"
                      :aria-label="`从最近文件移除 ${sub.label}`"
                      @click.stop.prevent="removeRecentItem(sub)"
                    >
                      <IconX :size="12" />
                    </button>
                  </div>
                </Tooltip>
              </template>
            </div>
          </div>
          <div
            v-else
            class="menu-entry"
            :class="{ disabled: item.disabled || item.action === 'none' }"
            @click="runMenuItem(item)"
          >
            <span class="menu-entry-label">
              <span v-if="item.checked !== undefined" class="menu-check">{{
                item.checked ? '✓' : ''
              }}</span>
              {{ item.label }}
            </span>
            <span v-if="item.shortcut" class="shortcut">{{ item.shortcut }}</span>
          </div>
        </template>
      </div>

      <div v-if="settingsOpen" class="settings-overlay" @mousedown.self="settingsOpen = false">
        <section class="settings-dialog">
          <h2>设置</h2>

          <div class="settings-grid">
            <label class="settings-row settings-row-inline">
              <span>
                <strong>图片自动压缩</strong>
                <small>插入图片时自动压缩以减小文档体积</small>
              </span>
              <input v-model="settingsCompressEnabled" type="checkbox" />
            </label>

            <label class="settings-row">
              <span>
                <strong>压缩质量</strong>
                <small>数值越高画质越好、体积越大</small>
              </span>
              <span class="quality-control">
                <input
                  v-model.number="settingsCompressQuality"
                  type="range"
                  min="1"
                  max="100"
                  :disabled="!settingsCompressEnabled"
                />
                <output>{{ settingsCompressQuality }}</output>
              </span>
            </label>

            <label class="settings-row">
              <span>
                <strong>最大打开标签数</strong>
                <small>同时打开的标签数量上限，防止打开过多</small>
              </span>
              <input
                v-model.number="settingsMaxTabs"
                class="settings-number"
                type="number"
                min="1"
                max="100"
              />
            </label>

            <label class="settings-row">
              <span>
                <strong>编辑区域字体大小</strong>
                <small>源码、即时渲染、预览与工具栏的字号，编辑器内可 Ctrl+滚轮缩放</small>
              </span>
              <input
                v-model.number="settingsEditorFontSize"
                class="settings-number"
                type="number"
                :min="MIN_EDITOR_FONT_SIZE"
                :max="MAX_EDITOR_FONT_SIZE"
              />
            </label>

            <label class="settings-row">
              <span>
                <strong>编辑器正文字体</strong>
                <small>即时渲染编辑与预览的正文使用字体</small>
              </span>
              <span class="font-control">
                <select
                  v-model="editorFontFamilySelect"
                  class="settings-select"
                  @change="handleEditorFontFamilyChange"
                >
                  <option
                    v-for="preset in EDITOR_FONT_FAMILY_PRESETS"
                    :key="preset.value || 'system'"
                    :value="preset.value"
                  >
                    {{ preset.label }}
                  </option>
                </select>
                <input
                  v-if="editorFontFamilyCustom"
                  v-model="settingsEditorFontFamily"
                  class="settings-number font-custom-input"
                  type="text"
                  placeholder="如 '字体名', sans-serif"
                />
              </span>
            </label>

            <label class="settings-row">
              <span>
                <strong>编辑器代码字体</strong>
                <small>源码编辑模式与代码块使用的等宽字体</small>
              </span>
              <span class="font-control">
                <select
                  v-model="editorMonoFontFamilySelect"
                  class="settings-select"
                  @change="handleEditorMonoFontFamilyChange"
                >
                  <option
                    v-for="preset in EDITOR_MONO_FONT_FAMILY_PRESETS"
                    :key="preset.value || 'system'"
                    :value="preset.value"
                  >
                    {{ preset.label }}
                  </option>
                </select>
                <input
                  v-if="editorMonoFontFamilyCustom"
                  v-model="settingsEditorMonoFontFamily"
                  class="settings-number font-custom-input"
                  type="text"
                  placeholder="如 '字体名', monospace"
                />
              </span>
            </label>

            <label class="settings-row">
              <span>
                <strong>编辑器行高</strong>
                <small>数值越大行间距越宽松</small>
              </span>
              <span class="quality-control">
                <input
                  v-model.number="settingsEditorLineHeight"
                  type="range"
                  :min="MIN_EDITOR_LINE_HEIGHT"
                  :max="MAX_EDITOR_LINE_HEIGHT"
                  step="0.1"
                />
                <output>{{ settingsEditorLineHeight.toFixed(1) }}</output>
              </span>
            </label>

            <label class="settings-row">
              <span>
                <strong>主界面字体大小</strong>
                <small>菜单栏、标签页、侧边栏、状态栏等的字号</small>
              </span>
              <input
                v-model.number="settingsUiFontSize"
                class="settings-number"
                type="number"
                :min="MIN_UI_FONT_SIZE"
                :max="MAX_UI_FONT_SIZE"
              />
            </label>

            <div class="settings-theme">
              <strong>默认主题</strong>
              <div class="theme-options">
                <button
                  v-for="option in [
                    { value: 'light', label: '浅色' },
                    { value: 'dark', label: '深色' },
                    { value: 'system', label: '跟随系统' }
                  ]"
                  :key="option.value"
                  type="button"
                  :class="{ active: themeStore.theme === option.value }"
                  @click="themeStore.setTheme(option.value as 'light' | 'dark' | 'system')"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
          </div>

          <div class="settings-actions">
            <button type="button" class="secondary" @click="settingsOpen = false">取消</button>
            <button type="button" class="primary" @click="saveSettings">完成</button>
          </div>
        </section>
      </div>

      <div
        v-if="linkDialogOpen"
        class="insert-dialog-overlay"
        @mousedown.self="linkDialogOpen = false"
      >
        <section class="insert-dialog">
          <h2>插入链接</h2>
          <label>
            <span>链接地址</span>
            <input
              v-model="linkHref"
              type="url"
              placeholder="https://example.com"
              autofocus
              @keydown.enter="confirmInsertLink"
            />
          </label>
          <label>
            <span>显示文本</span>
            <input
              v-model="linkTitle"
              type="text"
              placeholder="可选，默认使用选中文本"
              @keydown.enter="confirmInsertLink"
            />
          </label>
          <div class="settings-actions">
            <button type="button" class="secondary" @click="linkDialogOpen = false">取消</button>
            <button
              type="button"
              class="primary"
              :disabled="!linkHref.trim()"
              @click="confirmInsertLink"
            >
              插入
            </button>
          </div>
        </section>
      </div>

      <div
        v-if="imageDialogOpen"
        class="insert-dialog-overlay"
        @mousedown.self="imageDialogOpen = false"
      >
        <section class="insert-dialog">
          <h2>插入图片</h2>
          <label>
            <span>图片地址</span>
            <input
              v-model="imageSrc"
              type="text"
              placeholder="URL 或相对路径"
              autofocus
              @keydown.enter="confirmInsertImage"
            />
          </label>
          <label>
            <span>替代文本</span>
            <input
              v-model="imageAlt"
              type="text"
              placeholder="可选"
              @keydown.enter="confirmInsertImage"
            />
          </label>
          <button type="button" class="local-file-button" @click="selectImageFile">
            选择本地图片
          </button>
          <div class="settings-actions">
            <button type="button" class="secondary" @click="imageDialogOpen = false">取消</button>
            <button
              type="button"
              class="primary"
              :disabled="!imageSrc.trim()"
              @click="confirmInsertImage"
            >
              插入
            </button>
          </div>
        </section>
      </div>

      <div v-if="shortcutsOpen" class="help-overlay" @mousedown.self="shortcutsOpen = false">
        <section class="help-dialog shortcuts-dialog">
          <h2>快捷键速查</h2>
          <div class="shortcuts-grid">
            <div v-for="shortcut in shortcuts" :key="shortcut.keys" class="shortcut-row">
              <kbd>{{ shortcut.keys }}</kbd>
              <span>{{ shortcut.label }}</span>
            </div>
          </div>
          <div class="settings-actions">
            <button type="button" class="primary" @click="shortcutsOpen = false">确定</button>
          </div>
        </section>
      </div>

      <div v-if="aboutOpen" class="help-overlay" @mousedown.self="aboutOpen = false">
        <section class="help-dialog about-dialog">
          <img src="../../assets/logo.svg" alt="Inkase" class="about-logo" />
          <h2>Inkase</h2>
          <p class="about-version">版本 {{ appVersion }}</p>
          <p>一款以自包含 .mdx 文件格式为核心的轻量级文档工作台。</p>
          <p class="about-copyright">Copyright © 2026 Inkase Team</p>
          <div class="settings-actions">
            <button type="button" class="primary" @click="aboutOpen = false">确定</button>
          </div>
        </section>
      </div>
    </teleport>

    <SyncPanel v-if="syncStore.panelOpen" />
    <QuickOpenPalette :visible="quickOpenVisible" @close="quickOpenVisible = false" />
  </header>
</template>

<style scoped>
.app-header {
  position: relative;
  display: flex;
  align-items: center;
  height: var(--header-height);
  padding: 0 var(--spacing-sm);
  background-color: var(--color-bg-primary);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.logo-icon {
  width: 20px;
  height: 20px;
  display: block;
  flex-shrink: 0;
  margin-right: 6px;
  -webkit-app-region: no-drag;
}

.menu-bar {
  display: flex;
  align-items: stretch;
  align-self: stretch;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

.menu-item {
  display: flex;
  align-items: center;
  padding: 0 10px;
  font-size: var(--ui-font-size);
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
  transition:
    background-color 0.2s,
    color 0.2s;
  white-space: nowrap;
}

.menu-item:hover,
.menu-item.open {
  background-color: var(--color-bg-secondary);
  color: var(--color-text);
}

.header-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

.header-right > :deep(.tooltip-trigger),
.window-controls > :deep(.tooltip-trigger) {
  flex: 0 0 auto;
}

.window-drag-region {
  align-self: stretch;
  flex: 1;
  min-width: 24px;
  -webkit-app-region: drag;
}

.header-right {
  gap: var(--spacing-sm);
}

.icon-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
}

.icon-btn:hover {
  background-color: var(--color-bg-secondary);
  color: var(--color-text);
}

.icon-btn.active {
  color: var(--color-primary);
  background-color: var(--color-primary-light);
}

.sync-btn:disabled {
  color: var(--color-text-tertiary);
  cursor: not-allowed;
  opacity: 0.5;
}

.sync-btn[data-status='conflict'],
.sync-btn[data-status='error'] {
  color: var(--color-danger, #ef4444);
}

.sync-btn[data-status='pendingPush'],
.sync-btn[data-status='pendingCommit'] {
  color: var(--color-warning);
}

.sync-btn[data-status='pendingPull'] {
  color: var(--color-accent);
}

.sync-btn[data-status='upToDate'] {
  color: var(--color-success);
}

.icon {
  width: 16px;
  height: 16px;
}

.icon.spinning {
  animation: sync-btn-spin 0.9s linear infinite;
}

@keyframes sync-btn-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .icon.spinning {
    animation: none;
  }
}

.window-controls {
  display: flex;
  align-items: center;
  margin-left: 4px;
}

.window-btn {
  width: 30px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.window-btn:hover {
  background-color: var(--color-bg-secondary);
  color: var(--color-text);
}

.window-btn svg {
  width: 14px;
  height: 14px;
}

.window-btn.close:hover {
  background-color: #e81123;
  color: white;
}
</style>

<style>
.menu-dropdown {
  position: fixed;
  z-index: 10002;
  min-width: 220px;
  padding: 5px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  user-select: none;
  /* 必须保持溢出可见，否则向右展开的二级菜单会被一级菜单裁剪 */
  overflow: visible;
}

.menu-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 7px 12px;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s;
}

.menu-entry:hover {
  background: var(--color-bg-secondary);
}

.menu-entry .shortcut {
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

.menu-entry .sub-indicator {
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-text-tertiary);
}

/* 最近文件项悬停时显示的移除按钮 */
.recent-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition:
    color 0.12s,
    background-color 0.12s;
}

.recent-remove:hover {
  color: var(--color-danger);
  background-color: var(--color-bg-tertiary);
}

.menu-entry-label {
  display: inline-flex;
  align-items: center;
}

.menu-check {
  width: 18px;
  color: var(--color-primary);
  font-weight: 600;
  text-align: left;
}

.menu-icon {
  display: inline-flex;
  align-items: center;
  width: 18px;
  margin-right: 4px;
  color: var(--color-text-tertiary);
}

.menu-icon svg {
  width: 14px;
  height: 14px;
}

.menu-entry.disabled {
  color: var(--color-text-tertiary);
  cursor: default;
  pointer-events: none;
  opacity: 0.7;
}

.menu-entry.disabled .menu-check,
.menu-entry.disabled .shortcut {
  color: inherit;
}

.menu-divider {
  height: 1px;
  margin: 5px 8px;
  background: var(--color-border);
}

.menu-entry.has-sub {
  position: relative;
}

.submenu {
  position: absolute;
  left: calc(100% - 4px);
  top: -6px;
  min-width: 180px;
  padding: 5px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  display: none;
  z-index: 10003;
  /* 子项较多（如最近文件）时允许在菜单内部滚动，避免超出窗口不可见 */
  max-height: min(480px, calc(100vh - 120px));
  overflow-y: auto;
}

.menu-entry.has-sub:hover > .submenu {
  display: block;
}

.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 10010;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.insert-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 10010;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.help-overlay {
  position: fixed;
  inset: 0;
  z-index: 10010;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.settings-dialog {
  width: 720px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  padding: 24px;
  overflow-y: auto;
  color: var(--color-text);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.24);
}

.insert-dialog {
  width: 390px;
  max-width: calc(100vw - 32px);
  padding: 22px;
  color: var(--color-text);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.24);
}

.help-dialog {
  width: 480px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 48px);
  padding: 24px;
  overflow-y: auto;
  color: var(--color-text);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.24);
}

.help-dialog h2 {
  margin: 0 0 18px;
  font-size: calc(var(--ui-font-size) + 4px);
}

.shortcuts-dialog {
  width: 560px;
}

.shortcuts-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 24px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 7px 0;
  color: var(--color-text-secondary);
  font-size: var(--ui-font-size);
}

.shortcut-row kbd {
  flex-shrink: 0;
  padding: 3px 8px;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-bottom-width: 2px;
  border-radius: 5px;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 2px);
}

.about-dialog p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--ui-font-size);
  line-height: 1.7;
}

.about-dialog {
  width: 390px;
  text-align: center;
}

.about-dialog h2 {
  margin-bottom: 4px;
  font-size: calc(var(--ui-font-size) + 6px);
}

.about-logo {
  width: 64px;
  height: 64px;
  margin-bottom: 10px;
  border-radius: 12px;
}

.about-version {
  margin-bottom: 14px !important;
  color: var(--color-text-tertiary) !important;
}

.about-copyright {
  margin-top: 16px !important;
  color: var(--color-text-tertiary) !important;
  font-size: calc(var(--ui-font-size) - 1px) !important;
}

.insert-dialog h2 {
  margin: 0 0 18px;
  font-size: calc(var(--ui-font-size) + 4px);
}

.insert-dialog label {
  display: block;
  margin-bottom: 13px;
}

.insert-dialog label > span {
  display: block;
  margin-bottom: 6px;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.insert-dialog input {
  width: 100%;
  padding: 8px 10px;
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
}

.insert-dialog input:focus {
  border-color: var(--color-primary);
}

.local-file-button {
  width: 100%;
  padding: 9px;
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px dashed var(--color-border-hover);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.local-file-button:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
}

.settings-dialog h2 {
  margin: 0 0 12px;
  font-size: calc(var(--ui-font-size) + 4px);
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 32px;
}

.settings-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  min-width: 0;
  padding: 10px 0;
  border-bottom: 1px solid var(--color-border);
}

/* 复选框等简单开关：标签与控件保持同行 */
.settings-row-inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.settings-row strong,
.settings-theme > strong {
  display: block;
  font-size: var(--ui-font-size);
  font-weight: 600;
}

.settings-row small {
  display: block;
  margin-top: 3px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.quality-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quality-control input {
  width: 120px;
}

.quality-control output {
  width: 24px;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
  text-align: right;
}

.settings-number {
  width: 72px;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-primary);
  color: var(--color-text);
  font-size: var(--ui-font-size);
}

.font-control {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.font-custom-input {
  flex: 1;
  width: auto;
  min-width: 0;
}

.settings-select {
  max-width: 180px;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-primary);
  color: var(--color-text);
  font-size: var(--ui-font-size);
  cursor: pointer;
}

.settings-theme {
  grid-column: 1 / -1;
  padding-top: 14px;
}

/* 窄窗口回退：网格塌缩为单列，避免控件挤压 */
@media (max-width: 680px) {
  .settings-dialog {
    width: 420px;
  }

  .settings-grid {
    grid-template-columns: 1fr;
  }
}

.theme-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 220px));
  gap: 8px;
  margin-top: 10px;
}

.theme-options button,
.settings-actions button {
  padding: 7px 12px;
  color: var(--color-text);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.theme-options button:hover,
.theme-options button.active {
  color: var(--color-primary);
  background: var(--color-primary-light);
  border-color: var(--color-primary);
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 22px;
}

.settings-actions button.primary {
  color: white;
  background: var(--color-primary);
  border-color: var(--color-primary);
}

.settings-actions button:hover {
  filter: brightness(1.05);
}

.settings-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
  filter: none;
}
</style>
