import type { TabInfo } from '../stores/file/types'

/** AI 标签在统一标签序列里的占位 key */
export const AI_TAB_KEY = '__ai_tab__'

/** 知识图谱标签的占位 key */
export const GRAPH_TAB_KEY = '__graph_tab__'

export interface FileBarItem {
  key: string
  kind: 'file'
  tab: TabInfo
}

export interface AiBarItem {
  key: string
  kind: 'ai'
}

export interface GraphBarItem {
  key: string
  kind: 'graph'
}

export type BarItem = FileBarItem | AiBarItem | GraphBarItem

/**
 * 文件标签 + AI 标签 + 图谱标签的统一顺序。
 *
 * AI 标签插入到 aiTabIndex 处（null 表示排在最后）；`extra` 里的合成标签
 * （目前只有知识图谱）**固定追加在末尾**——它不可拖动、不参与文件排序，
 * 放在最后才不会因为文件增删而乱跳。
 *
 * 标签栏渲染、拖拽排序与 Ctrl+←/→ 切换共用这一顺序，保证键盘与视觉一致。
 */
export function buildBarItems(
  tabs: readonly TabInfo[],
  aiOpen: boolean,
  aiTabIndex: number | null,
  extra: readonly BarItem[] = []
): BarItem[] {
  const items: BarItem[] = tabs.map((tab) => ({ key: tab.id, kind: 'file', tab }))
  if (aiOpen) {
    const index = aiTabIndex === null ? items.length : Math.max(0, Math.min(aiTabIndex, items.length))
    items.splice(index, 0, { key: AI_TAB_KEY, kind: 'ai' })
  }
  if (extra.length > 0) items.push(...extra)
  return items
}
