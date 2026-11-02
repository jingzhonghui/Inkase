<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watchEffect } from 'vue'
import {
  IconChevronRight,
  IconCopy,
  IconFile,
  IconFolder,
  IconMinus,
  IconMoon,
  IconRefresh,
  IconSquare,
  IconSun,
  IconWorld,
  IconX
} from '@tabler/icons-vue'
import { useFileStore, type EditorMode } from '../../stores/file'
import { useThemeStore } from '../../stores/theme'
import { useUpdateStore } from '../../stores/update'
import { useWorkspaceStore } from '../../stores/workspace'
import { buildBarItems } from '../../utils/tab-order'
import { useSyncStore } from '../../stores/sync'
import { detectPlatform } from '../../shortcuts/binding'
import { isForwardedCommand, pushShortcutsToMain } from '../../shortcuts/main-sync'
import { matchCommand } from '../../shortcuts/match'
import {
  formatShortcut,
  type CommandId
} from '../../shortcuts/registry'
import { requestDialog } from '../../utils/dialog'
import { findCodeLanguage, languageDisplayName } from '../../utils/editor-language'
import SyncPanel from './SyncPanel.vue'
import SettingsDialog from '../settings/SettingsDialog.vue'
import QuickOpenPalette from '../common/QuickOpenPalette.vue'
import Tooltip from '../common/Tooltip.vue'

const fileStore = useFileStore()
const themeStore = useThemeStore()
const updateStore = useUpdateStore()
const workspaceStore = useWorkspaceStore()
const syncStore = useSyncStore()
const isMaximized = ref(false)
const quickOpenVisible = ref(false)

/**
 * 当前平台。
 *
 * 只影响快捷键的**显示文本**（`Ctrl+` 还是 `⌘`）与 `Mod` 的落地键；
 * 不传 `getPlatform` IPC，因为主进程那边没有对应 handler，调用必 reject。
 * 同一进程内平台不会变，取一次即可。
 */
const platform = detectPlatform()

/**
 * 把主进程要拦截的键位同步过去。
 *
 * `watchEffect` 里读的是 `bindingOf`（覆盖值 ?? 默认值），因此启动时推一次，
 * 用户之后每改一次快捷键都会自动重推。不做这一步的话，图表画布里的
 * 保存快捷键会一直按**旧键位**拦截——新键没反应、旧键还在存盘。
 */
watchEffect(pushShortcutsToMain)

/** 官网地址（README 与安装包里对外的那个入口） */
const OFFICIAL_SITE_URL = 'https://jingzhonghui.github.io/Inkase/'

/**
 * 用系统浏览器打开官网。
 *
 * 不用 `target="_blank"`：Electron 的窗口没有标签页，那样只会在应用内开一个
 * 新窗口。统一走主进程的 openLink → shell.openExternal，交给默认浏览器。
 * 没有 electronAPI 时（浏览器里调试）退回 window.open。
 */
function openOfficialSite(): void {
  if (window.electronAPI?.openLink) {
    void window.electronAPI.openLink(OFFICIAL_SITE_URL)
    return
  }
  window.open(OFFICIAL_SITE_URL, '_blank')
}

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
  /**
   * 快捷键的两条来源：
   * - `shortcutId`：命令 id，显示文本由注册表按平台生成（首选）；
   * - `shortcut`：字面量，只给「不是命令」的展示用（目前没有）。
   */
  shortcutId?: CommandId
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
      { kind: 'item', label: '文件', action: 'new', shortcutId: 'file.new' },
      { kind: 'item', label: '思维导图', action: 'new-mindmap', shortcutId: 'file.new-mindmap' },
      { kind: 'item', label: '图表', action: 'new-diagram', shortcutId: 'file.new-diagram' },
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
      { kind: 'item', label: '文件', action: 'open', shortcutId: 'file.open' },
      { kind: 'item', label: '文件夹', action: 'open-folder' },
      { kind: 'item', label: '快速打开', action: 'quick-open', shortcutId: 'file.quick-open' },
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
      { kind: 'item', label: 'Markdown', action: 'export-md', disabled: isCanvasDocumentActiveTab.value },
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
      { kind: 'item', label: 'PDF', action: 'export-pdf', disabled: isCanvasDocumentActiveTab.value },
      {
        kind: 'item',
        label: '批量 PDF',
        action: 'export-batch-pdf',
        disabled: isCanvasDocumentActiveTab.value
      }
    ]
  }

  return [
    newMenu,
    openMenu,
    recentMenu,
    { kind: 'divider' },
    { kind: 'item', label: '保存', action: 'save', shortcutId: 'file.save' },
    { kind: 'item', label: '另存为', action: 'save-as', shortcutId: 'file.save-as' },
    // 与保存同组：关标签页是收尾动作，不需要单独一段
    { kind: 'item', label: '关闭标签页', action: 'close-tab', shortcutId: 'file.close-tab' },
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
  { kind: 'item', label: '撤销', action: 'undo', shortcutId: 'edit.undo' },
  { kind: 'item', label: '重做', action: 'redo', shortcutId: 'edit.redo' },
  { kind: 'divider' },
  {
    kind: 'item',
    label: '剪切',
    action: 'cut',
    shortcutId: 'edit.cut',
    disabled: isCanvasDocumentActiveTab.value
  },
  {
    kind: 'item',
    label: '复制',
    action: 'copy',
    shortcutId: 'edit.copy',
    disabled: isCanvasDocumentActiveTab.value
  },
  {
    kind: 'item',
    label: '粘贴',
    action: 'paste',
    shortcutId: 'edit.paste',
    disabled: isCanvasDocumentActiveTab.value
  },
  { kind: 'divider' },
  {
    kind: 'item',
    label: '查找',
    action: 'find',
    shortcutId: 'edit.find'
  },
  {
    kind: 'item',
    label: '替换',
    action: 'replace',
    shortcutId: 'edit.replace',
    disabled: isCanvasDocumentActiveTab.value
  }
])

/** 当前生效的编辑模式：非 .md/.mdx 文件（如 .txt）实际按源码编辑显示 */
const effectiveMode = computed<EditorMode>(() => fileStore.effectiveEditorMode)

/** 当前标签是否为思维导图（无 Markdown 正文，部分菜单项对它不适用） */
const isMindMapActiveTab = computed(() => fileStore.activeTab?.fileInfo?.format === 'mindmap')

/** 当前标签是否为图表（画布在 iframe 里，Markdown 的文本菜单同样不适用） */
const isDiagramActiveTab = computed(() => fileStore.activeTab?.fileInfo?.format === 'diagram')

/** 画布类文档（导图 / 图表）：没有 Markdown 文本选区，文本编辑菜单一律置灰 */
const isCanvasDocumentActiveTab = computed(
  () => isMindMapActiveTab.value || isDiagramActiveTab.value
)

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
  { kind: 'item', label: 'AI 助手', action: 'open-ai', checked: workspaceStore.isAi },
  { kind: 'divider' },
  { kind: 'item', label: '设置', action: 'settings', shortcutId: 'app.settings' }
])

const insertMenu: MenuItem[] = [
  { kind: 'item', label: '插入图片', action: 'insert-image', shortcutId: 'insert.image' },
  { kind: 'item', label: '插入链接', action: 'insert-link', shortcutId: 'insert.link' },
  { kind: 'divider' },
  { kind: 'item', label: '插入表格', action: 'insert-table' },
  { kind: 'item', label: '插入代码块', action: 'insert-code' },
  { kind: 'item', label: '插入分割线', action: 'insert-hr' },
  { kind: 'divider' },
  { kind: 'item', label: '插入附件', action: 'insert-attachment' }
]

const helpMenu: MenuItem[] = [
  { kind: 'item', label: '检查更新', action: 'check-updates' },
  { kind: 'item', label: '使用文档', action: 'docs' },
  { kind: 'divider' },
  { kind: 'item', label: '关于 Inkase', action: 'about' }
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

/** 菜单行右侧的快捷键文本：命令走注册表（按平台生成），无绑定则整列不占位 */
function menuShortcut(item: MenuItem): string {
  if (item.shortcutId) return formatShortcut(item.shortcutId, platform)
  return item.shortcut ?? ''
}

const EDIT_ACTIONS = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'find', 'replace'])
const settingsOpen = ref(false)
const linkDialogOpen = ref(false)
const linkHref = ref('')
const linkTitle = ref('')
const imageDialogOpen = ref(false)
const imageSrc = ref('')
const imageAlt = ref('')
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

/**
 * 关闭当前标签页（Ctrl+W）。
 *
 * 走 store 的 closeTab 而不是直接移除：它自带「未保存先问」的确认流程，
 * 与点标签上的 × 是同一条路径。没有活动标签时什么都不做——工作台本身就是
 * 那个「没有文档也还在」的家，不需要被关掉。
 */
async function closeActiveTab(): Promise<void> {
  const tabId = fileStore.activeTabId
  if (!tabId) return
  await fileStore.closeTab(tabId)
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
    case 'new-diagram':
      await fileStore.newDiagram()
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
    case 'close-tab':
      await closeActiveTab()
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
      openAiPanel()
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

/**
 * 打开设置中心。
 *
 * 草稿的读取、主题预览与提交都在 `SettingsDialog` 里，这里只负责把面板打开。
 * 入口只有菜单和快捷键两处，落在「外观」节（`SettingsDialog` 的默认节）。
 */
function openSettings(): void {
  settingsOpen.value = true
}

function toggleTheme(): void {
  themeStore.toggleTheme()
}

/**
 * 打开 AI 助手。
 *
 * AI 已经不是独立标签，而是工作台的一段；「打开 AI」翻译成「打开工作台并切到
 * AI 段」。菜单、工具栏、快捷键三个入口都走这里，落点只有一处。
 */
function openAiPanel(): void {
  workspaceStore.open('ai')
}

/**
 * 跳到工作台的图谱段（Ctrl+Shift+G）。
 *
 * 已经建过索引就只切段，不重建——用户从图谱跳去改文档再回来，
 * 不该再等一次全库扫描。
 */
function openGraphPanel(): void {
  workspaceStore.open('graph')
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

  // 「上一个/下一个标签」在注册表里标了 priority: 'capture'：
  // Ctrl+←/→ 与编辑器内「按词移动光标」冲突，必须在捕获阶段先于编辑器处理。
  // 修饰键的严格程度（不许带 Alt/Shift/⌘）由注册表的绑定本身决定——
  // 这正是把「按词移动」与「切换标签」分开的那条线。
  const command = matchCommand(event, platform, {
    priority: 'capture',
    // 对话框与输入框的前置条件在这里不适用：切换标签与焦点无关，
    // 只由 handleTabNavigationCapture 单独过滤输入框（保留原生按词移动）。
    hasDialogOpen: false,
    isTextInput: false
  })
  if (!command || (command.id !== 'tab.prev' && command.id !== 'tab.next')) return false

  // 标签栏的序列是「工作台」+「文件标签」：工作台固定在第 0 位，
  // 因此键盘切换用同一份序列，否则会「跳到看不见的项」
  const fileItems = buildBarItems(fileStore.tabs, false, null)
  const total = fileItems.length + 1
  if (total < 2) return false

  const currentIndex = workspaceStore.active
    ? 0
    : 1 +
      fileItems.findIndex(
        (item) => item.kind === 'file' && item.tab.id === fileStore.activeTabId
      )
  const offset = command.id === 'tab.next' ? 1 : -1
  const nextIndex = ((currentIndex < 0 ? 0 : currentIndex) + offset + total) % total
  event.preventDefault()

  if (nextIndex === 0) {
    workspaceStore.activate()
    return true
  }

  const next = fileItems[nextIndex - 1]
  if (next?.kind === 'file') {
    workspaceStore.close()
    void fileStore.setActiveTab(next.tab.id)
  }
  return true
}

/** 捕获阶段拦截：编辑器会消费 Ctrl+方向键，冒泡阶段已来不及 */
function handleTabNavigationCapture(event: KeyboardEvent): void {
  if (isTextInputTarget(event.target)) return
  // 对话框开着时不该在背后换标签：用户以为焦点在面板里，切走了却看不出来
  if (isAnyDialogOpen()) return
  if (handleTabNavigationKeydown(event)) event.stopPropagation()
}

/** 是否有任一对话框开着（Escape 与 Ctrl+W 都要看这个） */
function isAnyDialogOpen(): boolean {
  return (
    settingsOpen.value ||
    linkDialogOpen.value ||
    imageDialogOpen.value ||
    aboutOpen.value
  )
}

/**
 * 执行一个应用级命令。
 *
 * 派发只负责「命令 → 动作」的映射，键位判断全在注册表与 `matchCommand` 里。
 * 这样将来加录制界面时，改的是绑定数据，不是这张表。
 */
function runCommand(id: CommandId): void {
  switch (id) {
    case 'file.new':
      void newFile()
      break
    case 'file.new-mindmap':
      void newMindMap()
      break
    case 'file.new-diagram':
      void fileStore.newDiagram()
      break
    case 'file.open':
      void openFile()
      break
    case 'file.quick-open':
      void openQuickOpen()
      break
    case 'file.save':
      void saveFile()
      break
    case 'file.save-as':
      void saveAsFile()
      break
    case 'file.close-tab':
      // 有对话框开着时不关标签：那时用户想关的多半是对话框，误关文档代价太大。
      // 守卫放在派发器里（而不是按键监听里）：主进程会先一步拦下 Ctrl+W 再转
      // IPC 回来，如果只守 keydown 那条路，生产环境里这个保护等于不存在。
      if (isAnyDialogOpen()) return
      void closeActiveTab()
      break
    case 'app.settings':
      openSettings()
      break
    case 'view.graph':
      openGraphPanel()
      break
    default:
      // tab.prev / tab.next 在捕获阶段处理；editor / native 类的命令不归这里
      break
  }
}

function handleKeydown(event: KeyboardEvent): void {
  // 输入法组合期间按键属于候选词选择（含 Escape），不能当成应用快捷键
  if (event.isComposing) return

  if (event.key === 'Escape') {
    if (isAnyDialogOpen()) {
      // 设置中心自己监听 Esc：它要先回滚主题预览，将来还要先退出快捷键录制态，
      // 这里替它关会把这些步骤整个跳过。
      if (settingsOpen.value) return
      linkDialogOpen.value = false
      imageDialogOpen.value = false
      aboutOpen.value = false
      return
    }
    closeMenu()
    return
  }

  // 其余按键一律交给注册表匹配：键位、平台差异（Ctrl / ⌘）、
  // 「对话框开着时哪些命令不响应」都收在 matchCommand 里，
  // 这里不再逐个 if (key === 'x')。
  const command = matchCommand(event, platform, {
    priority: 'bubble',
    hasDialogOpen: isAnyDialogOpen(),
    isTextInput: isTextInputTarget(event.target)
  })
  if (!command) return

  event.preventDefault()
  runCommand(command.id)
}

let removeMaximizedListener: (() => void) | null = null
let removeUnmaximizedListener: (() => void) | null = null
let removeShortcutListener: (() => void) | null = null

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

  // 保存/关闭标签页由主进程统一拦截后转发：图表画布在跨域 iframe 里，
  // 那里的 keydown 到不了页面，只有这条通道能让 Ctrl+S / Ctrl+W 仍然有效。
  // 载荷就是命令 id，直接走同一个派发器；再校验一次是因为 IPC 属于跨进程边界。
  // 用 `?.` 保护方法本身：单测与旧版 preload 上没有 onAppShortcut，
  // 只判 electronAPI 是否存在会让这里直接抛 TypeError。
  removeShortcutListener =
    window.electronAPI?.onAppShortcut?.((commandId) => {
      if (isForwardedCommand(commandId)) runCommand(commandId)
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
  removeShortcutListener?.()
})
</script>

<template>
  <header class="app-header">
    <img
      src="../../assets/logo.svg"
      alt="M+"
      class="logo-icon"
    >

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
          <IconRefresh
            class="icon"
            :class="{ spinning: syncStore.syncing }"
          />
        </button>
      </Tooltip>

      <Tooltip :content="themeStore.isDark ? '切换到浅色主题' : '切换到深色主题'">
        <button
          class="icon-btn"
          @click="toggleTheme"
        >
          <IconSun
            v-if="themeStore.isDark"
            class="icon"
          />
          <IconMoon
            v-else
            class="icon"
          />
        </button>
      </Tooltip>

      <div class="window-controls">
        <Tooltip content="最小化">
          <button
            class="window-btn"
            @click="handleMinimize"
          >
            <IconMinus :size="14" />
          </button>
        </Tooltip>
        <Tooltip :content="isMaximized ? '还原' : '最大化'">
          <button
            class="window-btn"
            @click="handleMaximize"
          >
            <IconCopy
              v-if="isMaximized"
              :size="14"
            />
            <IconSquare
              v-else
              :size="14"
            />
          </button>
        </Tooltip>
        <Tooltip content="关闭">
          <button
            class="window-btn close"
            @click="handleClose"
          >
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
        <template
          v-for="(item, index) in currentMenuItems"
          :key="index"
        >
          <div
            v-if="item.kind === 'divider'"
            class="menu-divider"
          />
          <div
            v-else-if="item.kind === 'submenu'"
            class="menu-entry has-sub"
            :class="{ disabled: item.disabled }"
          >
            <span>{{ item.label }}</span>
            <IconChevronRight
              class="sub-indicator"
              :size="12"
            />
            <div class="submenu">
              <template
                v-for="(sub, subIndex) in item.children"
                :key="subIndex"
              >
                <div
                  v-if="sub.kind === 'divider'"
                  class="menu-divider"
                />
                <Tooltip
                  v-else
                  block
                  :content="sub.payload || ''"
                >
                  <div
                    class="menu-entry"
                    :class="{ disabled: sub.disabled || sub.action === 'none' }"
                    @mouseenter="hoverRecentItem(sub)"
                    @mouseleave="clearHoveredRecentItem"
                    @click="runMenuItem(sub)"
                  >
                    <span class="menu-entry-label">
                      <span
                        v-if="sub.icon"
                        class="menu-icon"
                      >
                        <IconFolder
                          v-if="sub.icon === 'folder'"
                          :size="14"
                        />
                        <IconFile
                          v-else-if="sub.icon === 'file'"
                          :size="14"
                        />
                      </span>
                      <span
                        v-if="sub.checked !== undefined"
                        class="menu-check"
                      >{{
                        sub.checked ? '✓' : ''
                      }}</span>
                      {{ sub.label }}
                    </span>
                    <!-- 二级菜单里的条目同样要显示快捷键，否则挪进子菜单的 Ctrl+N 会「消失」。
                         这里必须和顶层一样走 menuShortcut（= 注册表 + 用户覆盖值），
                         不能读 sub.shortcut 字面量——那种写法在改键后就不跟手了 -->
                    <span
                      v-if="menuShortcut(sub)"
                      class="shortcut"
                    >{{ menuShortcut(sub) }}</span>
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
              <span
                v-if="item.checked !== undefined"
                class="menu-check"
              >{{
                item.checked ? '✓' : ''
              }}</span>
              {{ item.label }}
            </span>
            <span
              v-if="menuShortcut(item)"
              class="shortcut"
            >{{ menuShortcut(item) }}</span>
          </div>
        </template>
      </div>

      <!-- 设置中心：左栏分组 + 右栏内容，草稿与主题预览由它自己管 -->
      <SettingsDialog
        v-if="settingsOpen"
        @close="settingsOpen = false"
      />

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
            >
          </label>
          <label>
            <span>显示文本</span>
            <input
              v-model="linkTitle"
              type="text"
              placeholder="可选，默认使用选中文本"
              @keydown.enter="confirmInsertLink"
            >
          </label>
          <div class="settings-actions">
            <button
              type="button"
              class="secondary"
              @click="linkDialogOpen = false"
            >
              取消
            </button>
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
            >
          </label>
          <label>
            <span>替代文本</span>
            <input
              v-model="imageAlt"
              type="text"
              placeholder="可选"
              @keydown.enter="confirmInsertImage"
            >
          </label>
          <button
            type="button"
            class="local-file-button"
            @click="selectImageFile"
          >
            选择本地图片
          </button>
          <div class="settings-actions">
            <button
              type="button"
              class="secondary"
              @click="imageDialogOpen = false"
            >
              取消
            </button>
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

      <div
        v-if="aboutOpen"
        class="help-overlay"
        @mousedown.self="aboutOpen = false"
      >
        <section class="help-dialog about-dialog">
          <img
            src="../../assets/logo.svg"
            alt="Inkase"
            class="about-logo"
          >
          <h2>Inkase</h2>
          <p class="about-version">
            版本 {{ appVersion }}
          </p>
          <p>一款以自包含 .mdx 文件格式为核心的轻量级文档工作台。</p>
          <p class="about-links">
            <a
              :href="OFFICIAL_SITE_URL"
              class="about-site-link"
              @click.prevent="openOfficialSite"
            >
              <IconWorld
                :size="14"
                stroke="1.8"
              />
              <span>官网</span>
              <span class="about-site-url">jingzhonghui.github.io/Inkase</span>
            </a>
          </p>
          <p class="about-copyright">
            Copyright © 2026 Inkase Team
          </p>
          <div class="settings-actions">
            <button
              type="button"
              class="primary"
              @click="aboutOpen = false"
            >
              确定
            </button>
          </div>
        </section>
      </div>
    </teleport>

    <SyncPanel v-if="syncStore.panelOpen" />
    <QuickOpenPalette
      :visible="quickOpenVisible"
      @close="quickOpenVisible = false"
    />
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

/* 官网入口：一行胶囊，悬停才浮起来，避免和版权行抢视线 */
.about-links {
  margin-top: 12px !important;
}

.about-site-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-secondary) !important;
  font-size: calc(var(--ui-font-size) - 1px);
  text-decoration: none;
  transition: color 0.15s, border-color 0.15s, background-color 0.15s;
}

.about-site-link:hover {
  border-color: var(--color-primary);
  background-color: var(--color-bg-hover);
  color: var(--color-primary) !important;
}

.about-site-url {
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 2px);
}

.about-site-link:hover .about-site-url {
  color: var(--color-primary);
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

.settings-actions button {
  padding: 7px 12px;
  color: var(--color-text);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
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
