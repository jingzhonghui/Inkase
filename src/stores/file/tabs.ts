import { computed, ref, type Ref } from 'vue'
import type { ComputedRef } from 'vue'
import type { MdxDocument } from '../../types/mdx'
import type { FileInfo, TabInfo } from './types'
import { requestDialog } from '../../utils/dialog'

export interface TabState {
  tabs: Ref<TabInfo[]>
  activeTabId: Ref<string | null>
  activeTab: ComputedRef<TabInfo | null>
  stateVersion: Ref<number>
  currentFile: ComputedRef<FileInfo | null>
  document: ComputedRef<MdxDocument | null>
  fileContent: ComputedRef<string>
  hasFile: ComputedRef<boolean>
  isModified: ComputedRef<boolean>
  isDirty: ComputedRef<boolean>
  fileName: ComputedRef<string>
  displayTitle: ComputedRef<string>
  imageAssets: ComputedRef<MdxDocument['assets']['images']>
  hasMultipleTabs: ComputedRef<boolean>
  createTab: () => TabInfo
  findTabByPath: (filePath: string) => TabInfo | undefined
  revealInExplorer: (filePath: string) => Promise<void>
}

/**
 * Tab 状态与 getters（纯状态，不依赖文件操作）
 */
export function createTabState(): TabState {
  const tabs = ref<TabInfo[]>([])
  const activeTabId = ref<string | null>(null)
  let tabIdCounter = 0

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null)
  const stateVersion = ref(0)

  // 向后兼容的代理 computed（从 activeTab 读取）
  // 注意：Vue computed 对对象引用做缓存，直接修改 tab 属性不会触发下游更新。
  // 使用 stateVersion 强制在属性变更时重新计算。
  const currentFile = computed<FileInfo | null>(() => {
    stateVersion.value
    return activeTab.value?.fileInfo ?? null
  })
  const document = computed<MdxDocument | null>(() => {
    stateVersion.value
    return activeTab.value?.document ?? null
  })
  const fileContent = computed<string>(() => {
    stateVersion.value
    return activeTab.value?.content ?? ''
  })

  const hasFile = computed(() => {
    stateVersion.value
    return activeTab.value !== null && activeTab.value.document !== null
  })
  const isModified = computed(() => {
    stateVersion.value
    return activeTab.value?.fileInfo?.modified ?? false
  })
  const isDirty = computed(() => {
    stateVersion.value
    if (!activeTab.value?.document) return false
    return (activeTab.value?.fileInfo?.modified ?? false) || !activeTab.value?.fileInfo?.path
  })
  const fileName = computed(() => {
    stateVersion.value
    const tab = activeTab.value
    if (!tab) return '未命名.mdx'
    return tab.fileInfo?.name ?? '未命名.mdx'
  })
  const displayTitle = computed(() => {
    stateVersion.value
    // 已知扩展名都剥掉，避免 `.inkmind` 之类的后缀出现在窗口标题里
    const name = fileName.value.replace(/\.(mdx|md|inkmind)$/i, '')
    return isModified.value ? `${name} *` : name
  })
  const imageAssets = computed(() => {
    stateVersion.value
    return activeTab.value?.document?.assets.images || []
  })
  const hasMultipleTabs = computed(() => tabs.value.length > 1)

  function createTabId(): string {
    return `tab_${++tabIdCounter}`
  }

  function createTab(): TabInfo {
    const id = createTabId()
    const tab: TabInfo = { id, fileInfo: null, document: null, content: '', revision: 0 }
    tabs.value.push(tab)
    return tab
  }

  function findTabByPath(filePath: string): TabInfo | undefined {
    return tabs.value.find((t) => t.fileInfo?.path === filePath)
  }

  async function revealInExplorer(filePath: string): Promise<void> {
    if (window.electronAPI?.revealInExplorer) {
      await window.electronAPI.revealInExplorer(filePath)
    }
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    stateVersion,
    currentFile,
    document,
    fileContent,
    hasFile,
    isModified,
    isDirty,
    fileName,
    displayTitle,
    imageAssets,
    hasMultipleTabs,
    createTab,
    findTabByPath,
    revealInExplorer
  }
}

export interface TabOpsDeps {
  saveFile: () => Promise<boolean>
  persistSession: () => void
  writeRecoverySnapshot: () => Promise<void>
  revealFileInTree: (filePath: string) => Promise<void>
  editorResetVersion: Ref<number>
}

export interface TabOps {
  setActiveTab: (tabId: string) => Promise<void>
  closeTab: (tabId: string) => Promise<boolean>
  closeOtherTabs: (keepTabId: string) => Promise<void>
  closeAllTabs: () => Promise<void>
  moveTab: (tabId: string, insertIndex: number) => void
  /** 按给定 id 顺序重排标签；未列出的标签按原顺序补在末尾，避免误删 */
  reorderTabs: (orderedIds: string[]) => void
  confirmSaveForTab: (tab: TabInfo) => Promise<'save' | 'discard' | 'cancel'>
  confirmSaveBeforeClose: () => Promise<boolean>
}

/**
 * Tab 操作（依赖文件保存、会话持久化与文件树定位）
 */
export function createTabOps(state: TabState, deps: TabOpsDeps): TabOps {
  const { tabs, activeTabId, stateVersion } = state

  async function setActiveTab(tabId: string): Promise<void> {
    activeTabId.value = tabId
    const filePath = tabs.value.find((tab) => tab.id === tabId)?.fileInfo?.path
    if (filePath) await deps.revealFileInTree(filePath)
    deps.persistSession()
  }

  async function confirmSaveForTab(tab: TabInfo): Promise<'save' | 'discard' | 'cancel'> {
    const isTabDirty = tab.document && ((tab.fileInfo?.modified ?? false) || !tab.fileInfo?.path)
    if (!isTabDirty) return 'discard'

    const title = tab.document?.metadata.title || '未命名文档'

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

  async function closeTab(tabId: string): Promise<boolean> {
    const index = tabs.value.findIndex((t) => t.id === tabId)
    if (index === -1) return true
    const tab = tabs.value[index]

    const isTabDirty = tab.document && ((tab.fileInfo?.modified ?? false) || !tab.fileInfo?.path)
    if (isTabDirty) {
      const choice = await confirmSaveForTab(tab)
      if (choice === 'cancel') return false
      if (choice === 'save') {
        activeTabId.value = tabId
        const saved = await deps.saveFile()
        if (!saved) return false
      }
    }

    tabs.value.splice(index, 1)
    deps.persistSession()
    await deps.writeRecoverySnapshot()

    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        const nextIndex = Math.min(index, tabs.value.length - 1)
        activeTabId.value = tabs.value[nextIndex].id
      } else {
        activeTabId.value = null
      }
      stateVersion.value++
      deps.editorResetVersion.value++
    }

    return true
  }

  async function closeOtherTabs(keepTabId: string): Promise<void> {
    const otherTabs = tabs.value.filter((t) => t.id !== keepTabId)
    for (const tab of otherTabs) {
      const result = await closeTab(tab.id)
      if (!result) return
    }
  }

  async function closeAllTabs(): Promise<void> {
    while (tabs.value.length > 0) {
      const result = await closeTab(tabs.value[0].id)
      if (!result) return
    }
  }

  /**
   * 拖动排序：把 tabId 对应的标签移动到 insertIndex 之前（insertIndex 针对原数组，范围 [0, length]）。
   * 位置不变时为无操作；不改变激活标签。
   */
  function moveTab(tabId: string, insertIndex: number): void {
    const from = tabs.value.findIndex((tab) => tab.id === tabId)
    if (from === -1) return
    let to = Math.max(0, Math.min(insertIndex, tabs.value.length))
    if (from < to) to -= 1
    if (to === from) return
    const [moved] = tabs.value.splice(from, 1)
    tabs.value.splice(to, 0, moved)
    deps.persistSession()
  }

  /**
   * 标签栏统一排序（文件标签与 AI 标签混排）：按 orderedIds 重排文件标签。
   * 传入的 id 中不存在的会被忽略；未传入的标签保持原相对顺序补在末尾。
   */
  function reorderTabs(orderedIds: string[]): void {
    if (tabs.value.length === 0 || orderedIds.length === 0) return
    const remaining = new Map(tabs.value.map((tab) => [tab.id, tab]))
    const ordered: TabInfo[] = []
    for (const id of orderedIds) {
      const tab = remaining.get(id)
      if (!tab) continue
      ordered.push(tab)
      remaining.delete(id)
    }
    if (ordered.length === 0) return
    if (remaining.size > 0) {
      for (const tab of tabs.value) {
        if (remaining.has(tab.id)) ordered.push(tab)
      }
    }
    if (ordered.length !== tabs.value.length) return
    const changed = ordered.some((tab, index) => tabs.value[index] !== tab)
    if (!changed) return
    tabs.value.splice(0, tabs.value.length, ...ordered)
    deps.persistSession()
  }

  async function confirmSaveBeforeClose(): Promise<boolean> {
    for (const tab of tabs.value) {
      const isTabDirty = tab.document && ((tab.fileInfo?.modified ?? false) || !tab.fileInfo?.path)
      if (!isTabDirty) continue

      const choice = await confirmSaveForTab(tab)
      if (choice === 'cancel') return false
      if (choice === 'save') {
        activeTabId.value = tab.id
        const saved = await deps.saveFile()
        if (!saved) return false
      }
    }
    return true
  }

  return {
    setActiveTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    moveTab,
    reorderTabs,
    confirmSaveForTab,
    confirmSaveBeforeClose
  }
}
