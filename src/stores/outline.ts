import { ref } from 'vue'
import { defineStore } from 'pinia'

/** 大纲来源类型：Markdown 标题 / PDF 目录 */
export type OutlineKind = 'markdown' | 'pdf'

/** 大纲条目（仅用于展示；跳转由各查看器按索引自行定位）。 */
export interface OutlineEntry {
  /** 层级：Markdown 为 1..6；PDF 为 depth + 1 */
  level: number
  text: string
  /** PDF 目录项的跳转页码（从 1 开始）；Markdown 项无此字段 */
  page?: number | null
}

/**
 * 大纲状态：由当前激活的 Markdown 编辑器或 PDF 查看器发布，侧栏大纲面板读取展示。
 *
 * - headings：当前文件顶层标题（按文档顺序，索引即跳转索引）
 * - activeIndex：编辑区/查看区滚动时当前所在项的索引（-1 表示无）
 * - kind：当前大纲来源（用于面板区分空态与展示）
 * - loading：PDF 目录解析中（仅 PDF）
 *
 * 同一时刻只有一个发布者处于活动状态（Markdown 编辑器与 PDF 查看器互斥），
 * 因此无需处理多发布者的竞争。
 */
export const useOutlineStore = defineStore('outline', () => {
  const headings = ref<OutlineEntry[]>([])
  const activeIndex = ref(-1)
  const kind = ref<OutlineKind | null>(null)
  const loading = ref(false)

  function setHeadings(next: OutlineEntry[], nextKind: OutlineKind = 'markdown'): void {
    headings.value = next
    kind.value = nextKind
    loading.value = false
    if (activeIndex.value >= next.length) activeIndex.value = next.length > 0 ? 0 : -1
  }

  /** 标记某来源正在加载（会清空现有条目），用于 PDF 目录解析期间 */
  function setLoading(nextKind: OutlineKind): void {
    kind.value = nextKind
    loading.value = true
    headings.value = []
    activeIndex.value = -1
  }

  function setActiveIndex(index: number): void {
    activeIndex.value = index
  }

  function clear(): void {
    headings.value = []
    activeIndex.value = -1
    kind.value = null
    loading.value = false
  }

  return { headings, activeIndex, kind, loading, setHeadings, setLoading, setActiveIndex, clear }
})
