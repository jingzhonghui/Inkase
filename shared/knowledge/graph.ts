/**
 * 图谱的共享类型与纯函数
 *
 * 放在 `shared/` 而不是 `electron/knowledge/`：`focusSubgraph` 与
 * `applyGuardrail` 只操作已构建好的图，**不需要索引**，渲染层（局部图谱
 * 跟随当前笔记、护栏手动解除）必须能直接调用，不能为了两个 BFS 走 IPC。
 *
 * `buildGraph` 依赖索引与链接解析，仍留在 `electron/knowledge/graph-service.ts`。
 *
 * 设计文档：docs/superpowers/specs/2026-10-21-knowledge-base-design.md §5.6
 */

import type { NodeKind } from './types'

/** 六层边（权重不同） */
export type GraphLayer = 'link' | 'resource' | 'tag' | 'relation' | 'mention' | 'folder'

/** 节点类型：库内文件类型 + 标签节点 + 目录节点 + 护栏团块 */
export type GraphNodeKind = NodeKind | 'tag' | 'folder' | 'cluster'

export interface GraphNode {
  /**
   * 节点标识
   *
   * 笔记 = 库内相对路径；标签 = `#tag`；目录 = `folder:<dir>`；
   * 护栏团块 = `cluster:<顶层目录>`。
   */
  id: string
  kind: GraphNodeKind
  /** 显示名：笔记去扩展名的 basename、`#tag`、目录名 */
  label: string
  /** 顶层目录（`''` 表示库根），用于着色与团块聚合 */
  folder: string
  /** 度数（不含 L6 目录边） */
  degree: number
  /** 是否孤立（无任何 L1–L5 边） */
  isolated: boolean
}

export interface GraphEdge {
  from: string
  to: string
  layer: GraphLayer
  /** L4 的关系类型（`up` / `related` / `source`） */
  relation?: string
  /** L1 是否为嵌入 `![[...]]` */
  embed?: boolean
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 孤立笔记（无任何 L1–L5 边），按 id 排序 */
  isolated: string[]
  /** 连通分量（按节点数降序、组内按 id 排序；不含目录边） */
  components: string[][]
  /** 是否被规模护栏聚合过 */
  aggregated: boolean
  /** 被折叠进团块（或丢弃）的原始节点数 */
  hiddenCount: number
}

/** 默认启用的层（L6 目录边默认关闭） */
export const DEFAULT_LAYERS: readonly GraphLayer[] = [
  'link',
  'resource',
  'tag',
  'relation',
  'mention'
]

/** 全部六层（含目录层级）；目录边只在用户显式打开时才由主进程生成 */
export const ALL_LAYERS: readonly GraphLayer[] = [...DEFAULT_LAYERS, 'folder']

/** 孤立节点的显示方式 */
export type OrphanMode = 'all' | 'only' | 'hide'

/**
 * 图谱视图过滤器
 *
 * 全部是**视图属性**，不影响索引、不影响孤立判定（判定结果仍是整库事实）。
 * `null` 表示「不按这一维过滤」，空数组表示「一个都不显示」——两者语义不同，
 * 不能合并成 `length === 0`。
 */
export interface GraphFilters {
  /** 显示的边层 */
  layers: readonly GraphLayer[]
  /** 顶层目录白名单 */
  folders: readonly string[] | null
  /** 标签白名单（节点 id，形如 `#tag`） */
  tags: readonly string[] | null
  /** 孤立节点：全部 / 只看孤立 / 隐藏孤立 */
  orphans: OrphanMode
  /** 只显示真实文件节点（隐藏标签、目录与聚合块） */
  filesOnly: boolean
}

/** 默认过滤器：全开、不过滤 */
export function defaultGraphFilters(): GraphFilters {
  return { layers: DEFAULT_LAYERS, folders: null, tags: null, orphans: 'all', filesOnly: false }
}

/** 规模护栏默认阈值：超过即自动聚合 */
export const GUARDRAIL_LIMIT = 1500

/** 局部图谱跳数范围 */
export const MIN_FOCUS_DEPTH = 1
export const MAX_FOCUS_DEPTH = 3

/** 空图 */
export function emptyGraph(): Graph {
  return { nodes: [], edges: [], isolated: [], components: [], aggregated: false, hiddenCount: 0 }
}

/** 是否属于结构性节点（标签 / 目录 / 团块），不参与孤立判定与度数计算 */
export function isStructuralNode(node: GraphNode): boolean {
  return node.kind === 'tag' || node.kind === 'folder' || node.kind === 'cluster'
}

/** 按 id 排序的节点表 → Map */
export function indexNodes(nodes: GraphNode[]): Map<string, GraphNode> {
  const byId = new Map<string, GraphNode>()
  for (const node of nodes) byId.set(node.id, node)
  return byId
}

/** 统计度数（不含目录边） */
export function computeDegree(edges: GraphEdge[]): Map<string, number> {
  const degrees = new Map<string, number>()
  for (const edge of edges) {
    if (edge.layer === 'folder') continue
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1)
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1)
  }
  return degrees
}

/** 连通分量（只走非目录边） */
export function computeComponents(nodeIds: string[], edges: GraphEdge[]): string[][] {
  const adjacency = new Map<string, string[]>()
  for (const id of nodeIds) adjacency.set(id, [])
  for (const edge of edges) {
    if (edge.layer === 'folder') continue
    adjacency.get(edge.from)?.push(edge.to)
    adjacency.get(edge.to)?.push(edge.from)
  }

  const seen = new Set<string>()
  const components: string[][] = []

  for (const id of nodeIds) {
    if (seen.has(id)) continue
    const group: string[] = []
    const queue = [id]
    seen.add(id)

    while (queue.length > 0) {
      const current = queue.pop() as string
      group.push(current)
      for (const neighbour of adjacency.get(current) ?? []) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        queue.push(neighbour)
      }
    }

    group.sort((a, b) => a.localeCompare(b))
    components.push(group)
  }

  components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
  return components
}

/**
 * 以某节点为中心取局部子图
 *
 * 沿非目录边**双向**遍历（局部图谱要看「谁引用我」和「我引用谁」），
 * 跳数夹到 1–3。子图内重新计算度数与连通分量：局部视图的节点大小
 * 应该反映局部重要性，而不是整库地位。
 */
export function focusSubgraph(graph: Graph, seed: string, depth: number): Graph {
  const hops = Math.min(
    MAX_FOCUS_DEPTH,
    Math.max(MIN_FOCUS_DEPTH, Number.isFinite(depth) ? Math.floor(depth) : MIN_FOCUS_DEPTH)
  )

  const byId = indexNodes(graph.nodes)
  if (!byId.has(seed)) return emptyGraph()

  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (edge.layer === 'folder') continue
    for (const [from, to] of [
      [edge.from, edge.to],
      [edge.to, edge.from]
    ]) {
      const list = adjacency.get(from)
      if (list === undefined) adjacency.set(from, [to])
      else list.push(to)
    }
  }

  const included = new Set<string>([seed])
  let frontier: string[] = [seed]

  for (let hop = 0; hop < hops; hop++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbour of adjacency.get(id) ?? []) {
        if (included.has(neighbour)) continue
        included.add(neighbour)
        next.push(neighbour)
      }
    }
    frontier = next
  }

  const nodes = graph.nodes.filter((node) => included.has(node.id)).map((node) => ({ ...node }))
  const edges = graph.edges.filter((edge) => included.has(edge.from) && included.has(edge.to))

  const degrees = computeDegree(edges)
  for (const node of nodes) node.degree = degrees.get(node.id) ?? 0

  const isolated = nodes
    .filter((node) => !isStructuralNode(node) && node.degree === 0)
    .map((node) => node.id)
    .sort((a, b) => a.localeCompare(b))
  const isolatedSet = new Set(isolated)
  for (const node of nodes) node.isolated = isolatedSet.has(node.id)

  return {
    nodes,
    edges,
    isolated,
    components: computeComponents(
      nodes.filter((node) => !isStructuralNode(node)).map((node) => node.id),
      edges
    ),
    aggregated: false,
    hiddenCount: 0
  }
}

/**
 * 规模护栏
 *
 * 超过阈值时只保留「非孤立 + 度数 top-N」，其余按顶层目录聚成团块。
 * 依据：图谱在高节点数下「好看但没用」是本领域的典型死法（设计文档 §5.6）。
 * 聚合后重算度数，保证节点大小与看到的图一致，且**不留悬空边**。
 */
export function applyGuardrail(graph: Graph, limit: number = GUARDRAIL_LIMIT): Graph {
  const requested = Number.isFinite(limit) ? Math.floor(limit) : 0
  const max = requested > 0 ? requested : GUARDRAIL_LIMIT

  if (graph.nodes.length <= max) {
    return { ...graph, aggregated: false, hiddenCount: 0 }
  }

  const ranked = [...graph.nodes].sort((a, b) => {
    if (a.isolated !== b.isolated) return a.isolated ? 1 : -1
    if (a.degree !== b.degree) return b.degree - a.degree
    return a.id.localeCompare(b.id)
  })

  const kept = new Set(ranked.slice(0, max).map((node) => node.id))
  const byId = indexNodes(graph.nodes)

  /** 折叠后的 id：保留原样、并入团块、或丢弃（结构性节点不聚团） */
  const mapId = (id: string): string | null => {
    if (kept.has(id)) return id
    const node = byId.get(id)
    if (node === undefined || isStructuralNode(node)) return null
    return `cluster:${node.folder}`
  }

  const clusterMeta = new Map<string, { folder: string; count: number }>()
  for (const node of ranked.slice(max)) {
    const mapped = mapId(node.id)
    if (mapped === null || !mapped.startsWith('cluster:')) continue
    const current = clusterMeta.get(mapped)
    if (current === undefined) clusterMeta.set(mapped, { folder: node.folder, count: 1 })
    else current.count++
  }

  const nodes: GraphNode[] = graph.nodes
    .filter((node) => kept.has(node.id))
    .map((node) => ({ ...node, degree: 0 }))

  for (const [id, meta] of clusterMeta) {
    nodes.push({
      id,
      kind: 'cluster',
      label: meta.folder === '' ? '（根目录）' : meta.folder,
      folder: meta.folder,
      degree: 0,
      isolated: false
    })
  }

  // 边重映射 + 去重 + 去掉自环，确保不悬空
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (const edge of graph.edges) {
    const from = mapId(edge.from)
    const to = mapId(edge.to)
    if (from === null || to === null || from === to) continue
    const key = `${from}\u0000${to}\u0000${edge.layer}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ ...edge, from, to })
  }

  const degrees = computeDegree(edges)
  for (const node of nodes) node.degree = degrees.get(node.id) ?? 0
  nodes.sort((a, b) => a.id.localeCompare(b.id))

  return {
    nodes,
    edges,
    isolated: graph.isolated.filter((id) => kept.has(id)),
    components: computeComponents(
      nodes.filter((node) => !isStructuralNode(node)).map((node) => node.id),
      edges
    ),
    aggregated: true,
    hiddenCount: graph.nodes.length - kept.size
  }
}

/**
 * 视图过滤
 *
 * 只做「看得见什么」，不改变图谱事实：过滤后按可见边重算度数与孤立标记，
 * 所以统计数字与画面永远一致（这正是过滤存在的意义——用户看到的就是他筛的）。
 * 位置由未过滤的整图布局提供，切换过滤不会让节点乱跳。
 */
export function filterGraph(graph: Graph, filters: GraphFilters): Graph {
  const layers = new Set<GraphLayer>(filters.layers)
  const folders = filters.folders === null ? null : new Set<string>(filters.folders)
  const tags = filters.tags === null ? null : new Set<string>(filters.tags)

  const kept = new Set<string>()
  for (const node of graph.nodes) {
    const structural = isStructuralNode(node)
    if (filters.filesOnly && structural) continue
    if (filters.orphans === 'only' && (structural || !node.isolated)) continue
    if (filters.orphans === 'hide' && node.isolated) continue
    // 标签没有目录归属（folder 恒为 ''），按 tags 维度单独过滤
    if (folders !== null && node.kind !== 'tag' && !folders.has(node.folder)) continue
    if (tags !== null && node.kind === 'tag' && !tags.has(node.id)) continue
    kept.add(node.id)
  }

  const nodes = graph.nodes.filter((node) => kept.has(node.id)).map((node) => ({ ...node }))
  const edges = graph.edges.filter(
    (edge) => layers.has(edge.layer) && kept.has(edge.from) && kept.has(edge.to)
  )

  const degrees = computeDegree(edges)
  for (const node of nodes) node.degree = degrees.get(node.id) ?? 0

  const isolated = nodes
    .filter((node) => !isStructuralNode(node) && node.degree === 0)
    .map((node) => node.id)
    .sort((a, b) => a.localeCompare(b))
  const isolatedSet = new Set(isolated)
  for (const node of nodes) node.isolated = isolatedSet.has(node.id)

  return {
    nodes,
    edges,
    isolated,
    components: computeComponents(
      nodes.filter((node) => !isStructuralNode(node)).map((node) => node.id),
      edges
    ),
    // 聚合状态是数据层事实，不随视图过滤变化
    aggregated: graph.aggregated,
    hiddenCount: graph.hiddenCount
  }
}
