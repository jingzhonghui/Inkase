import type { TabInfo } from '../stores/file/types'

/** AI 标签在统一标签序列里的占位 key */
export const AI_TAB_KEY = '__ai_tab__'

export interface FileBarItem {
  key: string
  kind: 'file'
  tab: TabInfo
}

export interface AiBarItem {
  key: string
  kind: 'ai'
}

export type BarItem = FileBarItem | AiBarItem

/**
 * 文件标签 + AI 标签的统一顺序：AI 标签插入到 aiTabIndex 处（null 表示排在最后）。
 * 标签栏渲染、拖拽排序与 Ctrl+←/→ 切换共用这一顺序，保证键盘与视觉一致。
 */
export function buildBarItems(tabs: readonly TabInfo[], aiOpen: boolean, aiTabIndex: number | null): BarItem[] {
  const items: BarItem[] = tabs.map((tab) => ({ key: tab.id, kind: 'file', tab }))
  if (!aiOpen) return items
  const index = aiTabIndex === null ? items.length : Math.max(0, Math.min(aiTabIndex, items.length))
  items.splice(index, 0, { key: AI_TAB_KEY, kind: 'ai' })
  return items
}
