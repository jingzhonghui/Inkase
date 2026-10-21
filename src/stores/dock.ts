import { ref } from 'vue'
import { defineStore } from 'pinia'

/** 右侧停靠面板的页签 */
export type DockTab = 'backlinks' | 'graph' | 'ai'

/** 页签定义（顺序即展示顺序） */
export const DOCK_TABS: ReadonlyArray<{ id: DockTab; label: string }> = [
  { id: 'backlinks', label: '反链' },
  { id: 'graph', label: '图谱' },
  { id: 'ai', label: 'AI 助手' }
]

export const DOCK_MIN_WIDTH = 260
export const DOCK_MAX_WIDTH = 720
export const DOCK_DEFAULT_WIDTH = 340

const DOCK_STORAGE_KEY = 'inkase-dock'

/** 宽度夹取到合法区间（非法输入回落到默认宽度） */
export function clampDockWidth(value: number): number {
  if (!Number.isFinite(value)) return DOCK_DEFAULT_WIDTH
  return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(value)))
}

function isDockTab(value: unknown): value is DockTab {
  return value === 'backlinks' || value === 'graph' || value === 'ai'
}

/**
 * 右侧三合一停靠面板状态
 *
 * 反链 / 图谱 / AI 共用一个可调宽的面板；宽度与页签持久化到 localStorage
 * （独立 key，避免与 file store 的会话对象互相覆盖）。
 */
export const useDockStore = defineStore('dock', () => {
  const open = ref(false)
  const activeTab = ref<DockTab>('backlinks')
  const width = ref(DOCK_DEFAULT_WIDTH)

  function persist(): void {
    try {
      localStorage.setItem(
        DOCK_STORAGE_KEY,
        JSON.stringify({ open: open.value, activeTab: activeTab.value, width: width.value })
      )
    } catch {
      // 忽略存储错误
    }
  }

  /** 从 localStorage 恢复（应用启动时调用一次） */
  function restore(): void {
    try {
      const saved = localStorage.getItem(DOCK_STORAGE_KEY)
      if (saved === null) return
      const parsed: unknown = JSON.parse(saved)
      if (typeof parsed !== 'object' || parsed === null) return
      const state = parsed as { open?: unknown; activeTab?: unknown; width?: unknown }
      if (typeof state.open === 'boolean') open.value = state.open
      if (isDockTab(state.activeTab)) activeTab.value = state.activeTab
      if (typeof state.width === 'number') width.value = clampDockWidth(state.width)
    } catch {
      // 忽略解析错误
    }
  }

  /** 切换面板；给定页签时切到该页签，重复点击同一页签则收起 */
  function toggle(tab?: DockTab): void {
    if (tab !== undefined) {
      if (open.value && activeTab.value === tab) {
        open.value = false
      } else {
        open.value = true
        activeTab.value = tab
      }
    } else {
      open.value = !open.value
    }
    persist()
  }

  /** 展开并切到指定页签 */
  function show(tab: DockTab): void {
    open.value = true
    activeTab.value = tab
    persist()
  }

  function close(): void {
    open.value = false
    persist()
  }

  function setTab(tab: DockTab): void {
    activeTab.value = tab
    persist()
  }

  function setWidth(value: number): void {
    width.value = clampDockWidth(value)
    persist()
  }

  return { open, activeTab, width, restore, toggle, show, close, setTab, setWidth }
})
