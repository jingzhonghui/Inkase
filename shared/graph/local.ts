import type { GraphEdge, GraphPayload } from './types'

/**
 * 局部图：以某节点为中心按无向边 BFS 展开。
 *
 * 「无向」是关键——用户问的是「这篇连着谁」，入链和出链都是连接关系。
 * 只沿出链走会漏掉所有引用本文件的笔记，正好丢掉最想知道的那一半。
 */

export const MIN_LOCAL_DEPTH = 1
export const MAX_LOCAL_DEPTH = 3

/** 局部图节点上限：超过就没法看清，也给仿真留余量 */
export const DEFAULT_LOCAL_MAX_NODES = 3000

export interface LocalSubgraphOptions {
  centerId: string
  /** BFS 跳数，1–3 */
  depth: number
  maxNodes?: number
}

export interface LocalSubgraphResult {
  /** 子图内的节点 id（含中心） */
  nodeIds: Set<string>
  /** 两端都在子图内的边 */
  edges: GraphEdge[]
  /** 与子图相邻、但没显示出来的节点数 */
  hiddenNeighbors: number
  /** 中心节点是否存在于图中（用于「退回到全库」判断） */
  found: boolean
}

function buildAdjacency(payload: GraphPayload): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    const bucket = adjacency.get(a)
    if (bucket) bucket.add(b)
    else adjacency.set(a, new Set([b]))
  }
  for (const edge of payload.edges) {
    if (edge.source === edge.target) continue
    link(edge.source, edge.target)
    link(edge.target, edge.source)
  }
  return adjacency
}

export function clampLocalDepth(depth: number): number {
  if (!Number.isFinite(depth)) return MIN_LOCAL_DEPTH
  return Math.max(MIN_LOCAL_DEPTH, Math.min(MAX_LOCAL_DEPTH, Math.trunc(depth)))
}

export function localSubgraph(
  payload: GraphPayload,
  options: LocalSubgraphOptions
): LocalSubgraphResult {
  const maxNodes = options.maxNodes ?? DEFAULT_LOCAL_MAX_NODES
  const depth = clampLocalDepth(options.depth)
  const known = new Set(payload.nodes.map((node) => node.id))

  if (!known.has(options.centerId)) {
    return { nodeIds: new Set(), edges: [], hiddenNeighbors: 0, found: false }
  }

  const adjacency = buildAdjacency(payload)
  const nodeIds = new Set<string>([options.centerId])
  let frontier: string[] = [options.centerId]

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: string[] = []
    for (const id of frontier) {
      if (nodeIds.size >= maxNodes) break
      for (const neighbor of adjacency.get(id) ?? []) {
        if (nodeIds.has(neighbor)) continue
        nodeIds.add(neighbor)
        next.push(neighbor)
        if (nodeIds.size >= maxNodes) break
      }
    }
    frontier = next
  }

  const edges = payload.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
  )

  const hidden = new Set<string>()
  for (const id of nodeIds) {
    for (const neighbor of adjacency.get(id) ?? []) {
      if (!nodeIds.has(neighbor)) hidden.add(neighbor)
    }
  }

  return { nodeIds, edges, hiddenNeighbors: hidden.size, found: true }
}
