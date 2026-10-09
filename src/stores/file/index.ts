import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { isEditableMarkdownFormat } from '../../types/mdx'
import type { DocumentFormat, MdxDocument } from '../../types/mdx'
import { createMdxDocument } from '../../types/mdx'
import { loadSessionState, saveSessionState } from '../session'
import { useAiStore } from '../ai'
import { requestDialog } from '../../utils/dialog'
import type { FileInfo, EditorMode, EditorSelectionSnapshot, RecentItem, TabInfo } from './types'
import { createTabState, createTabOps } from './tabs'
import { useAssets } from './assets'
import { useFolder } from './folder'
import { useClipboard } from './clipboard'
import { usePdf } from './pdf'
import { createExternalWatch } from './external-watch'

/** Markdown 文件后缀白名单：仅这些文件走 Markdown 编辑模式（IR/源码/分屏），其余文本文件一律纯文本 */
const MARKDOWN_FILE_RE = /\.(md|mdx|markdown)$/i

/** HTML 文件后缀：走独立的「源码/预览」切换，不参与 Markdown 编辑模式 */
const HTML_FILE_RE = /\.html?$/i

/**
 * 文件状态管理 Store
 * 支持多标签页：tabs 数组管理所有打开的标签，activeTabId 指向当前激活标签
 * 保留 currentFile / document / fileContent 作为向后兼容的 computed 代理
 *
 * 职责：核心文件操作、内容编辑、会话持久化、崩溃恢复、最近文件、导入导出。
 * 其余能力（资源、文件夹、PDF、Tab 操作）拆分为独立模块，在下方组合。
 */
export const useFileStore = defineStore('file', () => {
  // ====== 编辑器状态 ======
  const DEFAULT_SIDEBAR_WIDTH = 220
  const MIN_SIDEBAR_WIDTH = 180
  const MAX_SIDEBAR_WIDTH = 420
  const clampSidebarWidth = (width: number): number => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))

  // ====== 最大打开标签数（默认 20，可在设置中修改，持久化到会话） ======
  const DEFAULT_MAX_OPEN_TABS = 20
  const MIN_MAX_OPEN_TABS = 1
  const MAX_MAX_OPEN_TABS = 100
  const sessionMaxOpenTabs = loadSessionState()?.maxOpenTabs
  const maxOpenTabs = ref<number>(
    typeof sessionMaxOpenTabs === 'number' && Number.isFinite(sessionMaxOpenTabs)
      ? Math.min(MAX_MAX_OPEN_TABS, Math.max(MIN_MAX_OPEN_TABS, Math.floor(sessionMaxOpenTabs)))
      : DEFAULT_MAX_OPEN_TABS
  )

  function setMaxOpenTabs(n: number): void {
    const clamped = Number.isFinite(n)
      ? Math.min(MAX_MAX_OPEN_TABS, Math.max(MIN_MAX_OPEN_TABS, Math.floor(n)))
      : DEFAULT_MAX_OPEN_TABS
    maxOpenTabs.value = clamped
    persistSession()
  }

  const editorMode = ref<EditorMode>('ir')
  const sessionEditorMode = loadSessionState()?.editorMode
  if (sessionEditorMode === 'ir' || sessionEditorMode === 'source' || sessionEditorMode === 'split') {
    editorMode.value = sessionEditorMode
  }
  const sidebarCollapsed = ref(false)
  const savedSidebarWidth = loadSessionState()?.sidebarWidth
  const sidebarWidth = ref(
    typeof savedSidebarWidth === 'number' && Number.isFinite(savedSidebarWidth)
      ? clampSidebarWidth(savedSidebarWidth)
      : DEFAULT_SIDEBAR_WIDTH
  )
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const recentFiles = ref<RecentItem[]>([])
  const wordCount = ref(0)
  const cursorLine = ref(1)
  const cursorColumn = ref(1)
  const editorResetVersion = ref(0)
  // 归一化的编辑器选区快照（供 AI 运行读取当前选区/光标）
  const editorSelection = ref<EditorSelectionSnapshot | null>(null)

  let recoveryWriteTimer: ReturnType<typeof setTimeout> | null = null
  let recoveryWriteInProgress = false
  let recoveryWritePending = false

  // ====== Tab 状态（纯状态 + getters） ======
  const tabState = createTabState()
  const { tabs, activeTabId, activeTab, stateVersion, fileContent } = tabState

  // 标签切换时同步状态栏统计，避免继续显示上一个文档的数据。
  watch(activeTabId, () => {
    updateWordCount()
    setCursorPosition(1, 1)
  })

  /** 当前激活标签是否为 HTML 文件（.html/.htm）：提供独立的浏览器式预览切换 */
  const isHtmlFile = computed(() => HTML_FILE_RE.test(activeTab.value?.fileInfo?.name ?? ''))

  /** HTML 预览开关（独立于 Markdown 编辑模式体系，仅 isHtmlFile 时生效） */
  const htmlPreviewActive = ref(false)

  function toggleHtmlPreview(): void {
    if (!isHtmlFile.value) return
    htmlPreviewActive.value = !htmlPreviewActive.value
  }

  /**
   * 将当前激活的预览标签转正（双击预览标签时调用）。
   * 无激活标签或激活标签不是预览标签时为无操作。
   */
  function pinActivePreviewTab(): void {
    const tab = activeTab.value
    if (!tab?.isPreview) return
    tab.isPreview = false
    persistSession()
  }

  /** 是否可切换编辑模式：仅 Markdown 文件支持（图片、代码/纯文本等不可切换） */
  const canSwitchEditorMode = computed(() => {
    const name = activeTab.value?.fileInfo?.name
    return !name || MARKDOWN_FILE_RE.test(name)
  })

  /** 非 Markdown 文本文件（.sh/.conf/.txt 等）一律纯文本模式，不参与 Markdown 编辑模式切换 */
  const effectiveEditorMode = computed<EditorMode>(() => {
    const name = activeTab.value?.fileInfo?.name
    return !name || MARKDOWN_FILE_RE.test(name) ? editorMode.value : 'plain'
  })

  /** 当前激活标签是否为 PDF 预览（PDF 为查看模式，不属于任何编辑模式） */
  const isPdfActiveTab = computed(() => activeTab.value?.fileInfo?.format === 'pdf')

  // ====== 字数统计 ======
  function updateWordCount(): void {
    const text = fileContent.value
    wordCount.value = text.replace(/\s/g, '').length
  }

  // ====== 崩溃恢复快照 ======
  async function writeRecoverySnapshot(): Promise<void> {
    if (!window.electronAPI) return
    if (recoveryWriteInProgress) {
      recoveryWritePending = true
      return
    }
    recoveryWriteInProgress = true
    const dirtyTabs = tabs.value.filter((tab) => tab.document && ((tab.fileInfo?.modified ?? false) || !tab.fileInfo?.path))
    try {
      if (dirtyTabs.length === 0) {
        const result = await window.electronAPI.clearRecovery()
        if (!result.success) throw new Error(result.error || '清理恢复快照失败')
      } else {
        const result = await window.electronAPI.writeRecovery({
          version: 1,
          createdAt: new Date().toISOString(),
          activeTabId: activeTabId.value,
          tabs: dirtyTabs.map((tab) => ({
            id: tab.id,
            filePath: tab.fileInfo?.path || null,
            fileName: tab.fileInfo?.name || '未命名.mdx',
            format: tab.fileInfo?.format || 'mdx',
            content: tab.content,
            document: tab.document,
            modifiedAt: new Date().toISOString()
          }))
        })
        if (!result.success) throw new Error(result.error || '写入恢复快照失败')
      }
    } finally {
      recoveryWriteInProgress = false
      if (recoveryWritePending) {
        recoveryWritePending = false
        void writeRecoverySnapshot().catch((err) => {
          error.value = err instanceof Error ? err.message : '写入恢复快照失败'
        })
      }
    }
  }

  function scheduleRecoverySnapshot(): void {
    if (recoveryWriteTimer) clearTimeout(recoveryWriteTimer)
    recoveryWriteTimer = setTimeout(() => {
      recoveryWriteTimer = null
      void writeRecoverySnapshot().catch((err) => {
        error.value = err instanceof Error ? err.message : '写入恢复快照失败'
      })
    }, 1000)
  }

  function cleanupTimers(): void {
    if (recoveryWriteTimer) clearTimeout(recoveryWriteTimer)
    recoveryWriteTimer = null
  }

  // ====== 会话持久化（后绑定，依赖 folder.openedFolderPath） ======
  let persistSession: () => void = () => {}

  // ====== 向后兼容的写入操作（代理到 activeTab） ======
  function setFile(file: FileInfo | null): void {
    const tab = activeTab.value
    if (!tab) return
    tab.fileInfo = file
    if (!file) tab.content = ''
    stateVersion.value++
    error.value = null
  }

  function setDocument(doc: MdxDocument | null, path?: string): void {
    const tab = activeTab.value
    if (!tab) return
    tab.document = doc
    if (doc) {
      tab.content = doc.content
      if (path) {
        tab.fileInfo = {
          path,
          name: path.split(/[/\\]/).pop() || '未命名.mdx',
          modified: false,
          format: path.toLowerCase().endsWith('.md') ? 'markdown' : 'mdx'
        }
      }
      stateVersion.value++
      updateWordCount()
    } else {
      tab.content = ''
      tab.fileInfo = null
      stateVersion.value++
    }
  }

  function setContent(content: string): void {
    const tab = activeTab.value
    if (!tab) return
    tab.content = content
    if (tab.document) {
      tab.document.content = content
    }
    stateVersion.value++
    updateWordCount()
    scheduleRecoverySnapshot()
  }

  function updateContent(content: string): void {
    const tab = activeTab.value
    if (!tab) return
    tab.content = content
    tab.revision++
    if (tab.document) {
      tab.document.content = content
    }
    if (tab.fileInfo) {
      tab.fileInfo.modified = true
      tab.isPreview = false
    }
    stateVersion.value++
    updateWordCount()
    scheduleRecoverySnapshot()
  }

  /**
   * 定向变更指定 tab 的内容（不假设目标 tab 是当前激活 tab）。
   * 供 AI 已批准文档操作调用：只修改 target tab，标记已修改并递增其 revision。
   */
  function updateTabContent(tabId: string, content: string): void {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (!tab) return
    tab.content = content
    if (tab.document) {
      tab.document.content = content
    }
    if (tab.fileInfo) {
      tab.fileInfo.modified = true
      tab.isPreview = false
    }
    tab.revision++
    stateVersion.value++
    updateWordCount()
    scheduleRecoverySnapshot()
  }

  /**
   * 发布归一化的编辑器选区快照（含所属 tabId）。
   * 传入 null 表示当前没有可用选区（例如没有活动 tab，或 IR 映射校验失败）。
   */
  function updateEditorSelection(sel: EditorSelectionSnapshot | null): void {
    editorSelection.value = sel
  }

  /**
   * 创建一篇由 AI 生成的新文档（未保存的新 tab），并激活它。
   */
  function createGeneratedDocument(
    title: string,
    content: string,
    format: 'markdown' | 'mdx'
  ): TabInfo | null {
    if (tabs.value.length >= maxOpenTabs.value) return null
    const tab = tabState.createTab()
    tab.document = createMdxDocument(title, content)
    tab.content = content
    tab.fileInfo = {
      path: '',
      name: format === 'markdown' ? `${title}.md` : `${title}.mdx`,
      modified: true,
      format
    }
    activeTabId.value = tab.id
    stateVersion.value++
    updateWordCount()
    return tab
  }

  function markSaved(): void {
    const tab = activeTab.value
    if (tab?.fileInfo) {
      tab.fileInfo.modified = false
    }
    stateVersion.value++
    scheduleRecoverySnapshot()
  }

  /**
   * 从磁盘重新加载指定文件的 tab 内容（用于同步拉取后被外部覆盖）。
   * 只更新已打开的 tab；未打开的返回 false。加载成功会清空 modified 标志。
   */
  async function reloadFile(filePath: string): Promise<boolean> {
    const tab = tabState.findTabByPath(filePath)
    if (!tab) return false
    if (!window.electronAPI) return false
    const result = await window.electronAPI.openFile(filePath, false)
    if (result.success && result.data) {
      const doc = result.data.document as MdxDocument
      tab.document = doc
      tab.content = doc.content
      if (tab.fileInfo) {
        tab.fileInfo.modified = false
        if (result.data.format) {
          tab.fileInfo.format = result.data.format as DocumentFormat
        }
      }
      stateVersion.value++
      updateWordCount()
      externalWatch.markExternalHandled(filePath)
      return true
    }
    return false
  }

  // ====== 最近文件 ======
  async function loadRecentFiles(): Promise<void> {
    try {
      if (window.electronAPI?.getRecentFiles) {
        const result = await window.electronAPI.getRecentFiles()
        if (result.success && result.data) {
          recentFiles.value = result.data
        }
      }
    } catch {
      recentFiles.value = []
    }
  }

  async function removeRecent(filePath: string): Promise<void> {
    recentFiles.value = recentFiles.value.filter((p) => p.path !== filePath)
    if (window.electronAPI?.removeRecentFile) {
      await window.electronAPI.removeRecentFile(filePath)
    }
  }

  async function clearRecent(): Promise<void> {
    recentFiles.value = []
    if (window.electronAPI?.clearRecentFiles) {
      await window.electronAPI.clearRecentFiles()
    }
  }

  // ====== 新建 / 打开 / 保存 / 关闭 ======
  async function newFile(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      if (tabs.value.length >= maxOpenTabs.value) {
        await requestDialog({
          title: '已达标签上限',
          message: `最多同时打开 ${maxOpenTabs.value} 个标签，请先关闭一些标签。`,
          buttons: [{ label: '知道了', value: 0, primary: true }]
        })
        return false
      }
      const tab = tabState.createTab()
      tab.excludeFromRecent = true

      if (window.electronAPI) {
        const result = await window.electronAPI.newFile()
        if (result.success && result.data) {
          const doc = result.data.document as MdxDocument
          tab.document = doc
          tab.content = doc.content
          tab.fileInfo = {
            path: '',
            name: '未命名.mdx',
            modified: false,
            format: 'mdx'
          }
          activeTabId.value = tab.id
          useAiStore().deactivatePanel()
          return true
        }
      }

      // Fallback: 本地创建
      const { createMdxDocument } = await import('../../types/mdx')
      tab.document = createMdxDocument('未命名文档', '')
      tab.content = tab.document.content
      tab.fileInfo = {
        path: '',
        name: '未命名.mdx',
        modified: false,
        format: 'mdx'
      }
      activeTabId.value = tab.id
      useAiStore().deactivatePanel()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '新建文件失败'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function openFile(
    filePath?: string,
    options?: { addToRecent?: boolean; silentLimit?: boolean; preview?: boolean; excludeFromRecent?: boolean }
  ): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      if (!window.electronAPI) {
        error.value = 'Electron API 不可用'
        return false
      }

      // 如果指定了路径，检查是否已在某 tab 中打开
      if (filePath) {
        const existing = tabState.findTabByPath(filePath)
        if (existing) {
          if (options?.preview === false) existing.isPreview = false
          activeTabId.value = existing.id
          useAiStore().deactivatePanel()
          await folder.revealFileInTree(filePath)
          return true
        }
      }

      const result = await window.electronAPI.openFile(filePath, options?.addToRecent)

      if (result.success && result.data) {
        const doc = result.data.document as MdxDocument
        const fPath = result.data.filePath as string

        // 再次检查（IPC 可能解析了路径）
        const existing = tabState.findTabByPath(fPath)
        if (existing) {
          if (options?.preview === false) existing.isPreview = false
          activeTabId.value = existing.id
          useAiStore().deactivatePanel()
          await folder.revealFileInTree(fPath)
          return true
        }

        if (result.data.largeFileWarning) {
          const choice = await requestDialog({
            title: '大文件警告',
            message: '此文件超过 50 MB，打开和编辑可能会变慢。',
            detail: '建议在外部编辑器中处理大文件。',
            buttons: [
              { label: '取消', value: 1 },
              { label: '仍然打开', value: 0, primary: true }
            ]
          })
          if (choice !== 0) {
            isLoading.value = false
            return false
          }
        }

        // 创建新 tab 前检查标签上限
        const previewTab = options?.preview === true ? tabs.value.find((tab) => tab.isPreview) : undefined
        if (tabs.value.length >= maxOpenTabs.value && !previewTab) {
          if (!options?.silentLimit) {
            await requestDialog({
              title: '已达标签上限',
              message: `最多同时打开 ${maxOpenTabs.value} 个标签，请先关闭一些标签。`,
              buttons: [{ label: '知道了', value: 0, primary: true }]
            })
          }
          isLoading.value = false
          return false
        }

        // 创建新 tab
        const tab = tabState.createTab()
        const format = (result.data.format as DocumentFormat) || (fPath.toLowerCase().endsWith('.md') ? 'markdown' : 'mdx')
        const isReadOnlyMedia = !isEditableMarkdownFormat(format)
        tab.document = doc
        tab.content = isReadOnlyMedia ? '' : doc.content
        if (format === 'image') tab.imageDataUrl = result.data.imageDataUrl
        if (format === 'pdf') tab.pdfBase64 = result.data.pdfBase64
        tab.fileInfo = {
          path: fPath,
          name: fPath.split(/[/\\]/).pop() || '未命名.mdx',
          modified: false,
          format
        }
        tab.excludeFromRecent = options?.excludeFromRecent === true
        tab.isPreview = options?.preview === true
        if (previewTab) {
          const previewIndex = tabs.value.indexOf(previewTab)
          tabs.value.splice(tabs.value.indexOf(tab), 1)
          tabs.value.splice(previewIndex, 1, tab)
        }
        activeTabId.value = tab.id
        useAiStore().deactivatePanel()
        await folder.revealFileInTree(fPath)

        await loadRecentFiles()
        persistSession()
        return true
      } else if (result.error === '用户取消') {
        return false
      } else {
        error.value = result.error || '打开文件失败'
        return false
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '打开文件失败'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveFile(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      if (!window.electronAPI) {
        error.value = 'Electron API 不可用'
        return false
      }

      const tab = activeTab.value
      if (!tab || !tab.document) {
        error.value = '没有打开的文档'
        return false
      }
      if (!isEditableMarkdownFormat(tab.fileInfo?.format)) {
        error.value = '该文件类型不支持编辑或保存'
        return false
      }

      const savedContent = tab.content
      const filePath = tab.fileInfo?.path
      const isInWorkspace = !!(filePath && folder.openedFolderPath.value && filePath.startsWith(folder.openedFolderPath.value))
      const result = await window.electronAPI.saveFile(
        savedContent,
        tab.document.metadata.title,
        filePath || undefined,
        !(tab.excludeFromRecent === true || isInWorkspace)
      )

      if (result.success) {
        // 自身写入触发的外部变更事件无需重载/提示
        if (filePath) externalWatch.markExternalHandled(filePath)
        if (tab.content === savedContent && tab.fileInfo) {
          tab.fileInfo.modified = false
          stateVersion.value++
          await writeRecoverySnapshot()
        }
        return true
      } else if (result.error === 'NEW_FILE') {
        return await saveAsFile()
      } else {
        error.value = result.error || '保存文件失败'
        return false
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '保存文件失败'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveAsFile(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      if (!window.electronAPI) {
        error.value = 'Electron API 不可用'
        return false
      }

      const tab = activeTab.value
      if (!tab || !tab.document) {
        error.value = '没有打开的文档'
        return false
      }
      if (!isEditableMarkdownFormat(tab.fileInfo?.format)) {
        error.value = '该文件类型不支持编辑或保存'
        return false
      }

      const savedContent = tab.content
      const result = await window.electronAPI.saveAsFile(
        savedContent,
        tab.document.metadata.title,
        tab.fileInfo?.path || undefined,
        tab.excludeFromRecent !== true
      )

      if (result.success && result.data) {
        const savePath = result.data as string
        externalWatch.markExternalHandled(savePath)
        if (tab.fileInfo) {
          tab.fileInfo.path = savePath
          tab.fileInfo.name = savePath.split(/[/\\]/).pop() || '未命名.mdx'
          tab.fileInfo.modified = tab.content !== savedContent
          tab.fileInfo.format = savePath.toLowerCase().endsWith('.md') ? 'markdown' : 'mdx'
        } else {
          tab.fileInfo = {
            path: savePath,
            name: savePath.split(/[/\\]/).pop() || '未命名.mdx',
            modified: tab.content !== savedContent,
            format: savePath.toLowerCase().endsWith('.md') ? 'markdown' : 'mdx'
          }
        }
        await loadRecentFiles()
        await writeRecoverySnapshot()
        return true
      } else if (result.error === '用户取消') {
        return false
      } else {
        error.value = result.error || '保存文件失败'
        return false
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '保存文件失败'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function closeFile(): Promise<boolean> {
    if (!activeTabId.value) return true
    const filePath = activeTab.value?.fileInfo?.path
    if (filePath) {
      try {
        await window.electronAPI?.closeFile(filePath)
      } catch {
        /* ignore */
      }
    }
    return tabOps.closeTab(activeTabId.value)
  }

  async function confirmSaveDialog(): Promise<'save' | 'discard' | 'cancel'> {
    const tab = activeTab.value
    const title = tab?.document?.metadata.title || '未命名文档'

    const choice = await requestDialog({
      title: '保存更改',
      message: `是否将更改保存到"${title}"？`,
      detail: '如果不保存，你的更改将会丢失。',
      buttons: [
        { label: '取消', value: 2 },
        { label: '不保存', value: 1 },
        { label: '保存', value: 0, primary: true }
      ]
    })
    return choice === 0 ? 'save' : choice === 1 ? 'discard' : 'cancel'
  }

  async function confirmSaveBeforeAction(): Promise<boolean> {
    if (!tabState.isDirty.value) return true

    const choice = await confirmSaveDialog()

    if (choice === 'cancel') return false
    if (choice === 'save') {
      const saved = await saveFile()
      if (!saved) return false
    }
    return true
  }

  // ====== 文件夹浏览 ======
  let closeFolderTab: (tabId: string) => Promise<boolean> = async () => true
  const folder = useFolder({
    tabs,
    activeTabId,
    stateVersion,
    editorResetVersion,
    error,
    isLoading,
    openFile,
    loadRecentFiles,
    persistSession: () => persistSession(),
    closeTab: (tabId) => closeFolderTab(tabId)
  })

  // ====== 会话持久化实现（依赖 folder.openedFolderPath） ======
  persistSession = () => {
    saveSessionState({
      openedFolderPath: folder.openedFolderPath.value,
      openFilePaths: tabs.value.map((t) => t.fileInfo?.path).filter((p): p is string => !!p),
      activeFilePath: activeTab.value?.fileInfo?.path ?? null,
      sidebarCollapsed: sidebarCollapsed.value,
      sidebarWidth: sidebarWidth.value,
      editorMode: editorMode.value,
      aiPanelOpen: useAiStore().panelOpen,
      aiPanelActive: useAiStore().panelActive,
      aiActiveConversationId: useAiStore().activeConversationId,
      maxOpenTabs: maxOpenTabs.value
    })
  }

  // ====== Tab 操作 ======
  const tabOps = createTabOps(tabState, {
    saveFile,
    persistSession: () => persistSession(),
    writeRecoverySnapshot,
    revealFileInTree: folder.revealFileInTree,
    editorResetVersion
  })
  closeFolderTab = tabOps.closeTab

  // ====== 剪贴板（复制/剪切/粘贴） ======
  const clipboard = useClipboard({
    tabs,
    selectedPaths: folder.selectedPaths,
    openedFolderPath: folder.openedFolderPath,
    fileTree: folder.fileTree,
    error,
    stateVersion,
    readFolder: folder.readFolder,
    persistSession: () => persistSession()
  })

  // ====== 资源管理 ======
  const assets = useAssets({ activeTab, stateVersion, scheduleRecoverySnapshot })

  // ====== PDF 导出 ======
  const pdf = usePdf({ tabs, error })

  // ====== 外部变更监视（磁盘新增/修改自动刷新文件树与已打开标签） ======
  const externalWatch = createExternalWatch({
    tabs,
    openedFolderPath: folder.openedFolderPath,
    readFolder: folder.readFolder,
    reloadFile,
    isTabDirty: (tab) => !!tab.document && ((tab.fileInfo?.modified ?? false) || !tab.fileInfo?.path)
  })
  externalWatch.setup()

  // ====== 编辑器操作 ======
  function setEditorMode(mode: EditorMode): void {
    editorMode.value = mode
    persistSession()
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
    persistSession()
  }

  function setSidebarWidth(width: number, persist = true): void {
    if (!Number.isFinite(width)) return
    sidebarWidth.value = clampSidebarWidth(width)
    if (persist) persistSession()
  }

  function setCursorPosition(line: number, column: number): void {
    cursorLine.value = line
    cursorColumn.value = column
  }

  // ====== 会话恢复 ======
  async function restoreSession(): Promise<void> {
    const state = loadSessionState()
    if (!state) {
      await useAiStore().loadConversations(null)
      return
    }

    if (state.editorMode === 'ir' || state.editorMode === 'source' || state.editorMode === 'split') {
      editorMode.value = state.editorMode
    }
    sidebarCollapsed.value = state.sidebarCollapsed === true
    if (typeof state.sidebarWidth === 'number' && Number.isFinite(state.sidebarWidth)) {
      sidebarWidth.value = clampSidebarWidth(state.sidebarWidth)
    }

    if (state.openedFolderPath) {
      const success = await folder.readFolder(state.openedFolderPath)
      if (success) {
        const folderName = state.openedFolderPath.split(/[/\\]/).pop() || state.openedFolderPath
        folder.fileTree.value = [
          {
            name: folderName,
            path: state.openedFolderPath,
            isDirectory: true,
            isExpanded: true,
            isLoading: false,
            children: folder.folderItems.value.map((item) => ({
              name: item.name,
              path: item.path,
              isDirectory: item.isDirectory,
              isExpanded: false,
              isLoading: false,
              children: []
            }))
          }
        ]
        await useAiStore().loadConversations(state.openedFolderPath)
      }
    }

    for (const filePath of state.openFilePaths ?? []) {
      const ok = await openFile(filePath, { addToRecent: false, silentLimit: true })
      if (!ok) break
    }

    if (state.activeFilePath) {
      const tab = tabState.findTabByPath(state.activeFilePath)
      if (tab) {
        activeTabId.value = tab.id
        await folder.revealFileInTree(state.activeFilePath)
      }
    }

    if (state.aiPanelOpen) {
      useAiStore().openPanel()
      if (state.aiPanelActive === false) {
        useAiStore().deactivatePanel()
      }
    }

    if (!state.openedFolderPath) {
      await useAiStore().loadConversations(null)
    }
  }

  async function restoreRecovery(): Promise<void> {
    if (!window.electronAPI) return
    const status = await window.electronAPI.recoveryStatus()
    if (!status.success || !status.data?.available) return
    const result = await window.electronAPI.readRecovery()
    const snapshot = result.data as
      | {
          activeTabId: string | null
          tabs: Array<{
            id: string
            filePath: string | null
            content: string
            document: MdxDocument
            fileName: string
            format: DocumentFormat
            assetData?: Record<string, string>
          }>
        }
      | undefined
    if (!snapshot?.tabs?.length) {
      await window.electronAPI.clearRecovery()
      return
    }

    const choice = await requestDialog({
      title: '恢复未保存内容',
      message: `检测到上次异常退出时有 ${snapshot.tabs.length} 个文档未保存。是否恢复？`,
      buttons: [
        { label: '放弃', value: 1 },
        { label: '恢复', value: 0, primary: true }
      ]
    })
    if (choice !== 0) {
      await window.electronAPI.clearRecovery()
      return
    }

    let recoveredActiveTabId: string | null = null
    for (const recovered of snapshot.tabs) {
      const existing = recovered.filePath ? tabState.findTabByPath(recovered.filePath) : undefined
      if (existing) {
        existing.content = recovered.content
        existing.document = recovered.document
        existing.document.content = recovered.content
        if (existing.fileInfo) existing.fileInfo.modified = true
        if (recovered.assetData && recovered.filePath) {
          const restoreResult = await window.electronAPI.restoreRecoveryAssets(recovered.filePath, recovered.document, recovered.assetData)
          if (!restoreResult.success) error.value = restoreResult.error || '恢复资源失败'
        }
        if (recovered.id === snapshot.activeTabId) recoveredActiveTabId = existing.id
        continue
      }
      const tab = tabState.createTab()
      tab.document = recovered.document
      tab.content = recovered.content
      tab.fileInfo = {
        path: '',
        name: `恢复-${recovered.fileName}`,
        modified: true,
        format: recovered.format
      }
      if (recovered.id === snapshot.activeTabId) recoveredActiveTabId = tab.id
    }
    if (recoveredActiveTabId) activeTabId.value = recoveredActiveTabId
    else if (!activeTabId.value && tabs.value.length > 0) activeTabId.value = tabs.value[tabs.value.length - 1].id
    stateVersion.value++
    updateWordCount()
    await window.electronAPI.clearRecovery()
  }

  async function init(): Promise<void> {
    await loadRecentFiles()
    await restoreSession()
    await restoreRecovery()
  }

  // ====== 导入 / 导出 ======
  async function importDocx(targetFolderOverride?: string): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      if (!window.electronAPI) {
        error.value = 'Electron API 不可用'
        return false
      }

      const targetFolder = targetFolderOverride || folder.openedFolderPath.value || undefined
      const result = await window.electronAPI.importDocx(undefined, targetFolder)

      if (result.success && result.data) {
        const doc = result.data.document as MdxDocument
        const fPath = result.data.filePath as string

        const existing = tabState.findTabByPath(fPath)
        if (existing) {
          activeTabId.value = existing.id
          useAiStore().deactivatePanel()
          return true
        }

        if (tabs.value.length >= maxOpenTabs.value) {
          await requestDialog({
            title: '已达标签上限',
            message: `最多同时打开 ${maxOpenTabs.value} 个标签，请先关闭一些标签。`,
            buttons: [{ label: '知道了', value: 0, primary: true }]
          })
          return false
        }

        const tab = tabState.createTab()
        tab.document = doc
        tab.content = doc.content
        tab.fileInfo = {
          path: fPath,
          name: fPath.split(/[/\\]/).pop() || '未命名.mdx',
          modified: false,
          format: 'mdx'
        }
        activeTabId.value = tab.id
        useAiStore().deactivatePanel()

        await loadRecentFiles()

        if (folder.openedFolderPath.value) {
          await folder.readFolder(folder.openedFolderPath.value)
        }

        return true
      } else if (result.error === '用户取消') {
        return false
      } else {
        error.value = result.error || '导入 Word 文档失败'
        return false
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '导入 Word 文档失败'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function importMarkdown(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      if (!window.electronAPI) {
        error.value = 'Electron API 不可用'
        return false
      }

      const targetFolder = folder.openedFolderPath.value || undefined
      const result = await window.electronAPI.importMd(undefined, targetFolder)

      if (result.success && result.data) {
        const doc = result.data.document as MdxDocument
        const fPath = result.data.filePath as string

        const existing = tabState.findTabByPath(fPath)
        if (existing) {
          activeTabId.value = existing.id
          useAiStore().deactivatePanel()
          return true
        }

        if (tabs.value.length >= maxOpenTabs.value) {
          await requestDialog({
            title: '已达标签上限',
            message: `最多同时打开 ${maxOpenTabs.value} 个标签，请先关闭一些标签。`,
            buttons: [{ label: '知道了', value: 0, primary: true }]
          })
          return false
        }

        const tab = tabState.createTab()
        tab.document = doc
        tab.content = doc.content
        tab.fileInfo = {
          path: fPath,
          name: fPath.split(/[/\\]/).pop() || '未命名.mdx',
          modified: false,
          format: result.data.format || (fPath.toLowerCase().endsWith('.md') ? 'markdown' : 'mdx')
        }
        activeTabId.value = tab.id
        useAiStore().deactivatePanel()

        await loadRecentFiles()

        if (folder.openedFolderPath.value) {
          await folder.readFolder(folder.openedFolderPath.value)
        }

        return true
      } else if (result.error === '用户取消') {
        return false
      } else {
        error.value = result.error || '导入失败'
        return false
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '导入失败'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function importFolder(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      if (!window.electronAPI) {
        error.value = 'Electron API 不可用'
        return false
      }

      const targetFolder = folder.openedFolderPath.value || undefined
      const result = await window.electronAPI.importFolder(undefined, targetFolder)

      if (result.success && result.data) {
        const data = result.data as {
          imported: Array<{ source: string; target: string }>
          failed: Array<{ source: string; error: string }>
          sourceDir: string
          targetDir: string
        }

        if (folder.openedFolderPath.value && folder.openedFolderPath.value === data.targetDir) {
          await folder.readFolder(folder.openedFolderPath.value)
        } else if (data.targetDir) {
          const success = await folder.readFolder(data.targetDir)
          if (success) {
            const folderName = data.targetDir.split(/[/\\]/).pop() || data.targetDir
            folder.fileTree.value = [
              {
                name: folderName,
                path: data.targetDir,
                isDirectory: true,
                isExpanded: true,
                isLoading: false,
                children: folder.folderItems.value.map((item) => ({
                  name: item.name,
                  path: item.path,
                  isDirectory: item.isDirectory,
                  isExpanded: false,
                  isLoading: false,
                  children: []
                }))
              }
            ]
            persistSession()
          }
        }

        const importedCount = data.imported.length
        const failedCount = data.failed.length
        if (failedCount > 0) {
          error.value = `导入完成：成功 ${importedCount} 个，失败 ${failedCount} 个`
        } else {
          console.log(`批量导入完成：${importedCount} 个文件`)
        }

        return true
      } else if (result.error === '用户取消') {
        return false
      } else {
        error.value = result.error || '批量导入失败'
        return false
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '批量导入失败'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function exportMarkdown(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      if (!window.electronAPI) {
        error.value = 'Electron API 不可用'
        return false
      }

      const tab = activeTab.value
      if (!tab?.fileInfo?.path) {
        error.value = '请先保存文件'
        return false
      }

      const result = await window.electronAPI.exportMd(tab.fileInfo.path)

      if (result.success) {
        return true
      } else {
        error.value = result.error || '导出失败'
        return false
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '导出失败'
      return false
    } finally {
      isLoading.value = false
    }
  }

  // ====== 暴露的接口 ======
  return {
    // Tab 状态
    tabs,
    activeTabId,
    activeTab: tabState.activeTab,
    canSwitchEditorMode,
    effectiveEditorMode,

    // 向后兼容的状态（computed proxy）
    currentFile: tabState.currentFile,
    document: tabState.document,
    fileContent: tabState.fileContent,

    // 编辑器状态
    editorMode,
    sidebarCollapsed,
    sidebarWidth,
    isLoading,
    error,
    recentFiles,
    wordCount,
    cursorLine,
    cursorColumn,
    editorResetVersion,
    editorSelection,
    pdfBatchProgress: pdf.pdfBatchProgress,

    // 文件夹浏览
    openedFolderPath: folder.openedFolderPath,
    folderItems: folder.folderItems,
    fileTree: folder.fileTree,

    // Getters
    hasFile: tabState.hasFile,
    isModified: tabState.isModified,
    isDirty: tabState.isDirty,
    fileName: tabState.fileName,
    displayTitle: tabState.displayTitle,
    imageAssets: tabState.imageAssets,
    imageCompressSettings: assets.imageCompressSettings,
    hasMultipleTabs: tabState.hasMultipleTabs,
    isPdfActiveTab,
    isHtmlFile,
    htmlPreviewActive,
    toggleHtmlPreview,
    pinActivePreviewTab,

    // 设置
    maxOpenTabs,
    setMaxOpenTabs,

    // Tab 操作
    setActiveTab: tabOps.setActiveTab,
    closeTab: tabOps.closeTab,
    closeOtherTabs: tabOps.closeOtherTabs,
    closeAllTabs: tabOps.closeAllTabs,
    confirmSaveForTab: tabOps.confirmSaveForTab,
    confirmSaveBeforeClose: tabOps.confirmSaveBeforeClose,
    revealInExplorer: tabState.revealInExplorer,

    // 向后兼容的写入操作
    setFile,
    setDocument,
    setContent,
    updateContent,
    markSaved,
    reloadFile,
    markExternalHandled: externalWatch.markExternalHandled,
    writeRecoverySnapshot,
    cleanupTimers,

    // AI 桥接：定向变更、选区快照、生成文档
    updateTabContent,
    updateEditorSelection,
    createGeneratedDocument,

    // 会话持久化
    persistSession,
    restoreSession,

    // 编辑器操作
    setEditorMode,
    toggleSidebar,
    setSidebarWidth,
    setCursorPosition,
    setImageCompressSettings: assets.setImageCompressSettings,

    // 文件操作
    init,
    newFile,
    openFile,
    saveFile,
    saveAsFile,
    closeFile,
    confirmSaveDialog,
    confirmSaveBeforeAction,
    importMarkdown,
    importDocx,
    importFolder,
    exportMarkdown,
    exportTabToPdf: pdf.exportTabToPdf,
    exportFileToPdf: pdf.exportFileToPdf,
    exportFolderToPdf: pdf.exportFolderToPdf,
    closePdfBatchProgress: pdf.closePdfBatchProgress,

    // 资源管理
    addImage: assets.addImage,
    getImage: assets.getImage,
    removeAsset: assets.removeAsset,
    refreshAssets: assets.refreshAssets,
    addAttachment: assets.addAttachment,
    detectOrphanAssets: assets.detectOrphanAssets,
    cleanupOrphanAssets: assets.cleanupOrphanAssets,
    renameImage: assets.renameImage,
    getCachedImage: assets.getCachedImage,
    setCachedImage: assets.setCachedImage,
    clearImageCache: assets.clearImageCache,

    // 最近文件
    removeRecent,
    clearRecent,

    // 文件夹操作
    openFolder: folder.openFolder,
    openFolderPath: folder.openFolderPath,
    readFolder: folder.readFolder,
    closeFolder: folder.closeFolder,
    navigateToFolder: folder.navigateToFolder,
    navigateUp: folder.navigateUp,
    expandNode: folder.expandNode,
    collapseNode: folder.collapseNode,
    toggleNode: folder.toggleNode,
    loadChildren: folder.loadChildren,

    // 选择模型
    selectedPaths: folder.selectedPaths,
    isSelected: folder.isSelected,
    selectOnly: folder.selectOnly,
    toggleSelected: folder.toggleSelected,
    selectRange: folder.selectRange,
    selectAllVisible: folder.selectAllVisible,
    clearSelection: folder.clearSelection,

    // 上下文菜单操作
    createFile: folder.createFile,
    createFolder: folder.createFolder,
    renameItem: folder.renameItem,
    moveItem: folder.moveItem,
    moveItems: folder.moveItems,
    deleteItem: folder.deleteItem,
    copyPath: folder.copyPath,
    importFilesInto: folder.importFilesInto,
    importDirectoryInto: folder.importDirectoryInto,

    // 剪贴板
    clipboardFiles: clipboard.clipboardFiles,
    hasSystemClipboardFiles: clipboard.hasSystemClipboardFiles,
    copySelection: clipboard.copySelection,
    pasteIntoSelection: clipboard.pasteIntoSelection,
    pasteInto: clipboard.pasteInto,
    resolvePasteTargetDir: clipboard.resolvePasteTargetDir,
    refreshClipboardState: clipboard.refreshClipboardState
  }
})

export type { EditorMode, FileInfo, FolderItem, FileTreeNode, RecentItem, TabInfo } from './types'
