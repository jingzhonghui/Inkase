import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  DEFAULT_LAYERS,
  defaultGraphFilters,
  emptyGraph,
  type Graph,
  type GraphFilters,
  type GraphLayer
} from '../../shared/knowledge/graph'
import type {
  BacklinkItem,
  IndexStatus,
  KnowledgeQuery,
  LinkRef,
  LinkResolution,
  MentionConversion,
  MentionConversionResult,
  NoteEntry,
  SearchHit,
  TagNote,
  TagSummary
} from '../../shared/knowledge/types'
import { toAbsolutePath, toVaultRelativePath } from '../utils/knowledge-path'
import { useFileStore } from './file'

/** 标签及使用计数（含来源细分），供面板直接渲染 */
export type TagCount = TagSummary

/** 空闲状态常量（避免多处字面量漂移） */
function idleStatus(): IndexStatus {
  return { state: 'idle', progress: { phase: 'idle', done: 0, total: 0 }, fileCount: 0 }
}

/**
 * 知识库索引 Store
 *
 * 负责：随工作区打开/关闭初始化索引、转发构建进度、按当前笔记拉取反链与标签、
 * 维护断链清单。**所有对外路径都是库内相对路径**，组件需要绝对路径时用 `resolveAbsolute`。
 */
export const useKnowledgeStore = defineStore('knowledge', () => {
  const status = ref<IndexStatus>(idleStatus())
  const backlinks = ref<BacklinkItem[]>([])
  const backlinksPath = ref<string | null>(null)
  const tags = ref<TagCount[]>([])
  const unresolved = ref<LinkRef[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 进度事件退订函数 */
  let stopProgress: (() => void) | null = null

  /** 索引构建中 */
  const building = computed(() => status.value.state === 'building')
  /** 索引不可用（构建失败），此时 UI 必须降级而不是报错阻塞 */
  const degraded = computed(() => status.value.state === 'degraded')
  /** 断链数量 */
  const brokenCount = computed(() => unresolved.value.length)
  /** 工作区根目录 */
  const root = computed(() => useFileStore().openedFolderPath ?? null)

  /** 当前激活文件的库内相对路径；不在库内为 null */
  const activeRelPath = computed<string | null>(() => {
    const fileStore = useFileStore()
    const absPath = fileStore.activeTab?.fileInfo?.path
    if (!absPath || !fileStore.openedFolderPath) return null
    return toVaultRelativePath(fileStore.openedFolderPath, absPath)
  })

  /** 库内相对路径 → 绝对路径（供打开文件/跳转使用） */
  function resolveAbsolute(relPath: string): string | null {
    const base = root.value
    if (base === null) return null
    return toAbsolutePath(base, relPath)
  }

  /**
   * 知识库 API 句柄
   *
   * 该能力由 preload 暴露；缺失时（旧版本 preload、测试环境）整体降级为空态，
   * 而不是抛错拖垮应用外壳。
   */
  function api(): typeof window.electronAPI | null {
    return typeof window.electronAPI?.onKnowledgeProgress === 'function' ? window.electronAPI : null
  }

  async function refreshStatus(): Promise<void> {
    const bridge = api()
    if (bridge === null) return
    const res = await bridge.knowledgeStatus()
    if (res.success && res.data) status.value = res.data
  }

  /** 载入已有索引；缺失或过期时构建 */
  async function ensureIndex(): Promise<void> {
    const bridge = api()
    if (bridge === null) return
    loading.value = true
    error.value = null
    try {
      const res = await bridge.ensureKnowledgeIndex()
      if (res.success && res.data) status.value = res.data
      else error.value = res.error ?? '索引不可用'
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '索引不可用'
    } finally {
      loading.value = false
    }
  }

  /** 强制全量重建 */
  async function rebuildIndex(): Promise<void> {
    const bridge = api()
    if (bridge === null) return
    loading.value = true
    error.value = null
    try {
      const res = await bridge.rebuildKnowledgeIndex()
      if (res.success && res.data) status.value = res.data
      else error.value = res.error ?? '索引重建失败'
      await Promise.all([loadTags(), loadUnresolved()])
      if (backlinksPath.value !== null) await loadBacklinks(backlinksPath.value)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '索引重建失败'
    } finally {
      loading.value = false
    }
  }

  /** 拉取指定文件的反链（含未链接提及） */
  async function loadBacklinks(relPath: string): Promise<void> {
    backlinksPath.value = relPath
    const bridge = api()
    if (bridge === null) {
      backlinks.value = []
      return
    }
    const res = await bridge.getBacklinks(relPath)
    backlinks.value = res.success && res.data ? res.data : []
  }

  /** 拉取全部标签 */
  async function loadTags(): Promise<void> {
    const bridge = api()
    if (bridge === null) {
      tags.value = []
      return
    }
    const res = await bridge.getKnowledgeTags()
    tags.value = res.success && res.data ? res.data : []
  }

  /** 拉取断链清单 */
  async function loadUnresolved(): Promise<void> {
    const bridge = api()
    if (bridge === null) {
      unresolved.value = []
      return
    }
    const res = await bridge.getUnresolvedLinks()
    unresolved.value = res.success && res.data ? res.data : []
  }

  /** 某个标签下的笔记（含各自来源） */
  async function loadNotesByTag(tag: string): Promise<TagNote[]> {
    const bridge = api()
    if (bridge === null) return []
    const res = await bridge.getNotesByTag(tag)
    return res.success && res.data ? res.data : []
  }

  /**
   * 结构化查询
   *
   * 查询语义在主进程解释；渲染层只组装条件。索引未就绪时文本搜索仍可用。
   */
  async function search(query: KnowledgeQuery): Promise<SearchHit[]> {
    const bridge = api()
    if (bridge === null) return []
    const res = await bridge.searchKnowledge(query)
    if (!res.success) {
      error.value = res.error ?? '搜索失败'
      return []
    }
    error.value = null
    return res.data ?? []
  }

  /**
   * 把一条未链接提及改写为链接
   *
   * 改写成功后索引已在主进程重建，这里刷新反链让提及从「未链接」组消失。
   */
  async function convertMention(request: MentionConversion): Promise<MentionConversionResult> {
    const bridge = api()
    if (bridge === null) return { changed: false, reason: '知识库 API 不可用' }

    const res = await bridge.convertMention(request)
    if (!res.success || !res.data) {
      const reason = res.error ?? '改写失败'
      error.value = reason
      return { changed: false, reason }
    }
    if (res.data.changed) await refreshAll()
    return res.data
  }

  /** 库内笔记清单（`[[` 自动补全的候选） */
  const notes = ref<NoteEntry[]>([])

  /** 拉取笔记清单 */
  async function loadNotes(): Promise<void> {
    const bridge = api()
    if (bridge === null) return
    const res = await bridge.listKnowledgeNotes()
    notes.value = res.success && res.data ? res.data : []
  }

  /** 批量解析链接目标（供 `[[ ]]` 装饰上色） */
  async function resolveTargets(
    targets: string[],
    from?: string
  ): Promise<Record<string, LinkResolution>> {
    const bridge = api()
    if (bridge === null) return {}
    if (targets.length === 0) return {}
    const res = await bridge.resolveLinks(targets, from)
    return res.success && res.data ? res.data : {}
  }

  /**
   * 图谱
   *
   * 主进程已跑过规模护栏，渲染层拿到的是「可以直接画」的图。
   * 懒加载：只有用户真的打开图谱页签才拉，避免每次索引刷新都白算一次。
   */
  const graph = ref<Graph>(emptyGraph())
  const graphLoading = ref(false)
  /** 是否曾经请求过图谱（用于索引刷新后决定要不要顺带刷新） */
  const graphLoaded = ref(false)
  /** 图谱数据版本：全局视图据此判断「该不该重跑布局」，避免无谓重排 */
  const graphVersion = ref(0)

  /**
   * 全局图谱页签
   *
   * 与 AI 助手页签同一套伪页签语义：`graphTabOpen` 控制页签是否在标签栏里，
   * `graphTabActive` 控制它是否占据内容区。两者分开是因为关闭面板不应丢失
   * 用户的缩放/选中状态——重新点开应当回到原样。
   */
  const graphTabOpen = ref(false)
  const graphTabActive = ref(false)

  function openGraphTab(): void {
    graphTabOpen.value = true
    graphTabActive.value = true
  }

  function activateGraphTab(): void {
    if (!graphTabOpen.value) return
    graphTabActive.value = true
  }

  /** 切到文件页签时调用：保留页签，只让出内容区 */
  function deactivateGraphTab(): void {
    graphTabActive.value = false
  }

  function closeGraphTab(): void {
    graphTabOpen.value = false
    graphTabActive.value = false
  }

  /** 视图过滤器（纯视图状态，不动索引） */
  const graphFilters = ref<GraphFilters>(defaultGraphFilters())
  /** 当前图上请求过的层：目录边要按需生成，刷新时得沿用 */
  const graphLayers = ref<readonly GraphLayer[]>(DEFAULT_LAYERS)
  /** 是否已手动解除规模护栏（显示全部节点） */
  const graphExpanded = ref(false)

  function updateGraphFilters(patch: Partial<GraphFilters>): void {
    graphFilters.value = { ...graphFilters.value, ...patch }
  }

  function resetGraphFilters(): void {
    graphFilters.value = defaultGraphFilters()
  }

  /**
   * 切换某一层边
   *
   * L1–L5 由渲染层直接扣边，不需要往返主进程；目录边（L6）是主进程按需生成的，
   * 开关它必须重新拉一次图。这是设计上刻意的取舍：默认关闭的层不该为所有人付成本。
   */
  async function toggleGraphLayer(layer: GraphLayer): Promise<void> {
    const current = graphFilters.value.layers
    const next = current.includes(layer)
      ? current.filter((item) => item !== layer)
      : [...current, layer]
    graphFilters.value = { ...graphFilters.value, layers: next }
    if (layer === 'folder') await loadGraph(next)
  }

  async function loadGraph(
    layers?: readonly GraphLayer[],
    options?: { aggregated?: boolean }
  ): Promise<void> {
    const bridge = api()
    if (bridge === null) return
    const requested = layers ?? graphLayers.value
    graphLoading.value = true
    try {
      const res = await bridge.getKnowledgeGraph(requested, {
        aggregated: options?.aggregated ?? !graphExpanded.value
      })
      graph.value = res.success && res.data ? res.data : emptyGraph()
      graphLayers.value = requested
      graphLoaded.value = true
      graphVersion.value += 1
    } finally {
      graphLoading.value = false
    }
  }

  /** 手动解除规模护栏：重新拉未聚合的整图（>1500 节点时由调用方确认） */
  async function expandGraph(): Promise<void> {
    if (graphExpanded.value) return
    graphExpanded.value = true
    await loadGraph(graphLayers.value)
  }

  /** 恢复自动聚合 */
  async function collapseGraph(): Promise<void> {
    if (!graphExpanded.value) return
    graphExpanded.value = false
    await loadGraph(graphLayers.value)
  }

  /** 库内容发生变化（重命名/移动/外部修改）后刷新全部派生数据 */
  async function refreshAll(): Promise<void> {
    await refreshStatus()
    await Promise.all([loadTags(), loadUnresolved(), loadNotes()])
    if (backlinksPath.value !== null) await loadBacklinks(backlinksPath.value)
    // 图谱按需刷新：没打开过图谱页签就不必算
    if (graphLoaded.value) await loadGraph()
  }

  function clear(): void {
    status.value = idleStatus()
    backlinks.value = []
    backlinksPath.value = null
    tags.value = []
    unresolved.value = []
    notes.value = []
    graph.value = emptyGraph()
    graphLoaded.value = false
    graphVersion.value = 0
    graphTabOpen.value = false
    graphTabActive.value = false
    graphFilters.value = defaultGraphFilters()
    graphLayers.value = DEFAULT_LAYERS
    graphExpanded.value = false
    error.value = null
  }

  /** 应用启动时调用一次：绑定工作区与当前笔记 */
  function init(): void {
    // 未暴露知识库 API 时不做任何订阅，整个知识库功能静默降级
    if (api() === null) return

    const fileStore = useFileStore()

    watch(
      () => fileStore.openedFolderPath,
      async (folderPath) => {
        if (!folderPath) {
          clear()
          return
        }
        await ensureIndex()
        await Promise.all([loadTags(), loadUnresolved(), loadNotes()])
      },
      { immediate: true }
    )

    stopProgress = window.electronAPI.onKnowledgeProgress((progress) => {
      status.value = {
        ...status.value,
        state: progress.phase === 'idle' ? status.value.state : 'building',
        progress
      }
      // 构建结束时回读一次权威状态（fileCount / degraded）
      if (progress.phase === 'idle') void refreshStatus()
    })

    watch(
      activeRelPath,
      async (relPath) => {
        if (relPath === null) {
          backlinks.value = []
          backlinksPath.value = null
          return
        }
        await loadBacklinks(relPath)
      },
      { immediate: true }
    )
  }

  /** 解除进度订阅（应用卸载时调用） */
  function dispose(): void {
    stopProgress?.()
    stopProgress = null
  }

  return {
    status,
    backlinks,
    backlinksPath,
    tags,
    unresolved,
    loading,
    error,
    building,
    degraded,
    brokenCount,
    root,
    activeRelPath,
    resolveAbsolute,
    refreshStatus,
    ensureIndex,
    rebuildIndex,
    loadBacklinks,
    loadTags,
    loadUnresolved,
    loadNotesByTag,
    search,
    resolveTargets,
    notes,
    loadNotes,
    graph,
    graphLoading,
    graphLoaded,
    graphVersion,
    graphTabOpen,
    graphTabActive,
    graphFilters,
    graphLayers,
    graphExpanded,
    openGraphTab,
    activateGraphTab,
    deactivateGraphTab,
    closeGraphTab,
    updateGraphFilters,
    resetGraphFilters,
    toggleGraphLayer,
    expandGraph,
    collapseGraph,
    loadGraph,
    convertMention,
    refreshAll,
    clear,
    init,
    dispose
  }
})
