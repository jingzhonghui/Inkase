import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { localSubgraph } from '../../shared/graph/local'
import {
  GRAPH_FORMAT_LABELS,
  type GraphEdge,
  type GraphNode,
  type GraphNodeFormat,
  type GraphPayload
} from '../../shared/graph/types'
import { useAiStore } from './ai'
import { useFileStore } from './file'
import { applyDirtyOverlay, toWorkspaceRelative, type DirtyGraphFile } from '../utils/graph/dirty-overlay'

/**
 * 知识图谱的视图状态。
 *
 * 图谱是**视图不是文档**：它不进入 `fileStore.tabs`，因此不污染会话恢复、
 * 最近文件、`findTabByPath`、外部文件监听这一串「tab 即文件」的假设。
 * 面板开合沿用 AI 面板的合成标签模式，两者（以及文档视图）互斥。
 */

export type GraphMode = 'global' | 'local'

export interface GraphFilters {
  /** 选中的顶层目录；'' 表示根目录 */
  folders: string[]
  formats: GraphNodeFormat[]
  showUnresolved: boolean
  query: string
}

/** 递归目录在过滤 chips 里的显示名 */
export const ROOT_FOLDER_CHIP = ''

function createDefaultFilters(): GraphFilters {
  return {
    folders: [],
    formats: ['mdx', 'markdown', 'mindmap', 'diagram', 'attachment'],
    showUnresolved: true,
    query: ''
  }
}

export const useGraphStore = defineStore('graph', () => {
  // ===== 面板 / 标签页 =====
  const panelOpen = ref(false)
  const panelActive = ref(false)

  // ===== 数据 =====
  const payload = shallowRef<GraphPayload | null>(null)
  const loading = ref(false)
  const progress = ref<{ scanned: number; total: number } | null>(null)
  const error = ref<string | null>(null)
  /** 上次构建的工作区根，用于判断是否需要重建 */
  const builtRoot = ref<string | null>(null)

  // ===== 交互 =====
  const mode = ref<GraphMode>('global')
  const depth = ref(1)
  /** 局部图的中心节点 */
  const centerId = ref<string | null>(null)
  const selectedId = ref<string | null>(null)
  const hoveredId = ref<string | null>(null)
  const filters = ref<GraphFilters>(createDefaultFilters())
  /**
   * 一次性的「把某个节点居中」请求。
   *
   * 搜索框已经上移到工作台顶条，而画布在工作台内部的 GraphView 里，
   * 中间隔着一层组件，拿不到 canvas 的 ref。让顶条只发请求、GraphView 响应，
   * 比自己再维护一份画布引用干净。
   */
  const focusRequest = ref<{ id: string; nonce: number } | null>(null)

  function requestFocus(id: string): void {
    focusRequest.value = { id, nonce: (focusRequest.value?.nonce ?? 0) + 1 }
  }

  // ===== 派生：脏标签覆盖后的数据 =====
  const dirtyFiles = computed<DirtyGraphFile[]>(() => {
    const fileStore = useFileStore()
    const root = fileStore.openedFolderPath
    if (!root) return []

    const result: DirtyGraphFile[] = []
    for (const tab of fileStore.tabs) {
      const info = tab.fileInfo
      if (!info?.path || !info.modified) continue
      if (info.format !== 'mdx' && info.format !== 'markdown') continue
      const relative = toWorkspaceRelative(root, info.path)
      if (!relative) continue
      result.push({ path: relative, content: tab.content })
    }
    return result
  })

  /** 真正用于渲染的数据：磁盘索引 + 未保存标签的覆盖 */
  const effectivePayload = computed<GraphPayload | null>(() => {
    const base = payload.value
    if (!base) return null
    const dirty = dirtyFiles.value
    if (dirty.length === 0) return base
    return applyDirtyOverlay(base, dirty)
  })

  // ===== 派生：可见集合（过滤只影响渲染，不重跑仿真） =====
  const allFolders = computed<string[]>(() => {
    const base = effectivePayload.value
    if (!base) return []
    const folders = new Set<string>()
    for (const node of base.nodes) {
      if (node.unresolved) continue
      folders.add(node.folder)
    }
    return [...folders].sort((a, b) => {
      if (a === b) return 0
      if (!a) return -1
      if (!b) return 1
      return a.localeCompare(b)
    })
  })

  const searchMatches = computed<Set<string> | null>(() => {
    const base = effectivePayload.value
    const query = filters.value.query.trim().toLowerCase()
    if (!base || !query) return null
    const matches = new Set<string>()
    for (const node of base.nodes) {
      if (node.label.toLowerCase().includes(query)) matches.add(node.id)
      else if (node.path?.toLowerCase().includes(query)) matches.add(node.id)
    }
    return matches
  })

  const localResult = computed(() => {
    const base = effectivePayload.value
    if (!base || mode.value !== 'local' || !centerId.value) return null
    return localSubgraph(base, { centerId: centerId.value, depth: depth.value })
  })

  const visibleNodes = computed<GraphNode[]>(() => {
    const base = effectivePayload.value
    if (!base) return []

    const localSet = mode.value === 'local' ? (localResult.value?.nodeIds ?? null) : null
    const selectedFolders = new Set(filters.value.folders)
    const allFoldersSelected = selectedFolders.size === 0 || selectedFolders.size === allFolders.value.length
    const selectedFormats = new Set(filters.value.formats)

    return base.nodes.filter((node) => {
      if (node.unresolved && !filters.value.showUnresolved) return false
      if (localSet && !localSet.has(node.id)) return false
      if (!selectedFormats.has(node.format)) return false
      if (!allFoldersSelected && !node.unresolved && !selectedFolders.has(node.folder)) return false
      return true
    })
  })

  const visibleNodeIds = computed(() => new Set(visibleNodes.value.map((node) => node.id)))

  const visibleEdges = computed<GraphEdge[]>(() => {
    const base = effectivePayload.value
    if (!base) return []
    const ids = visibleNodeIds.value
    const localSet = mode.value === 'local' ? (localResult.value?.nodeIds ?? null) : null
    return base.edges.filter((edge) => {
      if (!ids.has(edge.source) || !ids.has(edge.target)) return false
      if (localSet && (!localSet.has(edge.source) || !localSet.has(edge.target))) return false
      return true
    })
  })

  /** hover 或选中时高亮自身与一跳邻居 */
  const highlightIds = computed<Set<string> | null>(() => {
    const focus = hoveredId.value ?? selectedId.value
    const base = effectivePayload.value
    if (!focus || !base) return null

    const ids = new Set<string>([focus])
    for (const edge of base.edges) {
      if (edge.source === focus) ids.add(edge.target)
      else if (edge.target === focus) ids.add(edge.source)
    }
    return ids
  })

  const selectedNode = computed<GraphNode | null>(() => {
    const base = effectivePayload.value
    if (!base || !selectedId.value) return null
    return base.nodes.find((node) => node.id === selectedId.value) ?? null
  })

  /** 局部图里还有多少邻居没显示 */
  const hiddenNeighborCount = computed(() => localResult.value?.hiddenNeighbors ?? 0)

  const stats = computed(() => effectivePayload.value?.stats ?? null)
  const issues = computed(() => effectivePayload.value?.issues ?? { unresolved: [], orphans: [] })
  const warnings = computed(() => effectivePayload.value?.warnings ?? [])

  const hasGraph = computed(() => (effectivePayload.value?.nodes.length ?? 0) > 0)
  const isFiltered = computed(() => {
    const current = filters.value
    return (
      current.query.trim().length > 0 ||
      current.folders.length > 0 ||
      current.formats.length < 4 ||
      !current.showUnresolved
    )
  })

  const formatLabel = (format: GraphNodeFormat): string => GRAPH_FORMAT_LABELS[format]

  let progressUnsubscribe: (() => void) | null = null

  function ensureProgressListener(): void {
    if (progressUnsubscribe) return
    progressUnsubscribe =
      window.electronAPI?.onGraphProgress?.((event) => {
        progress.value = event
      }) ?? null
  }

  function resetData(): void {
    payload.value = null
    builtRoot.value = null
    error.value = null
    progress.value = null
    selectedId.value = null
    hoveredId.value = null
    centerId.value = null
  }

  // ===== 面板生命周期 =====
  async function openPanel(centerFilePath?: string): Promise<void> {
    const fileStore = useFileStore()
    const aiStore = useAiStore()

    if (aiStore.panelOpen) aiStore.deactivatePanel()
    panelOpen.value = true
    panelActive.value = true

    if (centerFilePath && fileStore.openedFolderPath) {
      const relative = toWorkspaceRelative(fileStore.openedFolderPath, centerFilePath)
      if (relative) {
        centerId.value = relative
        mode.value = 'local'
      }
    }

    await build(true)
  }

  function activatePanel(): void {
    if (!panelOpen.value) return
    const aiStore = useAiStore()
    if (aiStore.panelOpen) aiStore.deactivatePanel()
    panelActive.value = true
  }

  function deactivatePanel(): void {
    panelActive.value = false
  }

  function closePanel(): void {
    panelOpen.value = false
    panelActive.value = false
    resetData()
  }

  // ===== 构建 =====
  async function build(force = false): Promise<void> {
    const fileStore = useFileStore()
    const root = fileStore.openedFolderPath

    if (!root) {
      resetData()
      error.value = '先打开一个文件夹，知识图谱以工作区为范围'
      return
    }

    if (!force && builtRoot.value === root && payload.value) return
    if (!window.electronAPI?.buildGraph) {
      error.value = '当前版本不支持知识图谱'
      return
    }

    ensureProgressListener()
    loading.value = true
    error.value = null
    progress.value = null

    try {
      const result = await window.electronAPI.buildGraph(root)
      // 构建期间用户可能已经切了工作区或关掉了面板
      if (fileStore.openedFolderPath !== root) return
      if (!result.success || !result.data) {
        error.value = result.error || '构建图谱失败'
        payload.value = null
        builtRoot.value = null
        return
      }

      payload.value = result.data
      builtRoot.value = root
      // 局部模式的中心失效时退回全库，否则会看到一张空图
      if (centerId.value && !result.data.nodes.some((node) => node.id === centerId.value)) {
        centerId.value = null
        mode.value = 'global'
      }
      if (selectedId.value && !result.data.nodes.some((node) => node.id === selectedId.value)) {
        selectedId.value = null
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '构建图谱失败'
    } finally {
      loading.value = false
      progress.value = null
    }
  }

  async function refresh(): Promise<void> {
    await build(true)
  }

  // ===== 交互 =====
  function setMode(next: GraphMode): void {
    if (next === 'local') {
      const fileStore = useFileStore()
      const fallback = selectedId.value ?? activeFileRelativePath(fileStore.openedFolderPath)
      if (!fallback) {
        // 没有中心就退回全库，比给一张空图好
        mode.value = 'global'
        return
      }
      centerId.value = fallback
      mode.value = 'local'
      return
    }
    mode.value = 'global'
  }

  function activeFileRelativePath(root: string | null): string | null {
    if (!root) return null
    const fileStore = useFileStore()
    const path = fileStore.activeTab?.fileInfo?.path
    if (!path) return null
    return toWorkspaceRelative(root, path)
  }

  function setDepth(next: number): void {
    depth.value = Math.max(1, Math.min(3, Math.trunc(next)))
  }

  function setCenter(id: string | null): void {
    centerId.value = id
    if (id) mode.value = 'local'
  }

  function selectNode(id: string | null): void {
    selectedId.value = id
  }

  function setHovered(id: string | null): void {
    hoveredId.value = id
  }

  function setQuery(query: string): void {
    filters.value.query = query
  }

  function toggleFolder(folder: string): void {
    const current = filters.value.folders
    if (current.includes(folder)) {
      filters.value.folders = current.filter((item) => item !== folder)
    } else {
      // 空数组表示「全选」；点第一个 chip 时要把其余目录显式排除，
      // 否则取消一个之后反而是全选，看着像点错了
      filters.value.folders = current.length === 0
        ? allFolders.value.filter((item) => item !== folder)
        : [...current, folder]
    }
  }

  function toggleFormat(format: GraphNodeFormat): void {
    const current = filters.value.formats
    if (current.includes(format)) {
      filters.value.formats = current.filter((item) => item !== format)
    } else {
      filters.value.formats = [...current, format]
    }
  }

  function resetFilters(): void {
    filters.value = createDefaultFilters()
  }

  function focusIssue(path: string): void {
    void useFileStore().openFile(path.startsWith('/') || /^[a-zA-Z]:/.test(path) ? path : joinRoot(path))
  }

  function joinRoot(relativePath: string): string {
    const root = useFileStore().openedFolderPath
    if (!root) return relativePath
    const separator = root.includes('\\') ? '\\' : '/'
    return `${root.replace(/[\\/]+$/, '')}${separator}${relativePath.split('/').join(separator)}`
  }

  function dispose(): void {
    progressUnsubscribe?.()
    progressUnsubscribe = null
  }

  // 工作区切换后旧数据必须作废，否则会看到上一个库的图
  watch(
    () => useFileStore().openedFolderPath,
    (root) => {
      if (!panelOpen.value) return
      if (builtRoot.value && builtRoot.value !== root) {
        resetData()
        void build(true)
      }
    }
  )

  return {
    // 面板
    panelOpen,
    panelActive,
    openPanel,
    activatePanel,
    deactivatePanel,
    closePanel,

    // 数据
    payload,
    effectivePayload,
    loading,
    progress,
    error,
    builtRoot,
    stats,
    issues,
    warnings,
    hasGraph,

    // 交互
    mode,
    depth,
    centerId,
    selectedId,
    hoveredId,
    filters,
    allFolders,
    localResult,
    visibleNodes,
    visibleEdges,
    visibleNodeIds,
    searchMatches,
    highlightIds,
    selectedNode,
    hiddenNeighborCount,
    isFiltered,
    focusRequest,
    requestFocus,
    setMode,
    setDepth,
    setCenter,
    selectNode,
    setHovered,
    setQuery,
    toggleFolder,
    toggleFormat,
    resetFilters,
    formatLabel,
    focusIssue,
    joinRoot,

    // 生命周期
    build,
    refresh,
    dispose
  }
})
