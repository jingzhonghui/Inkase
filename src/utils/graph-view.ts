/**
 * 全局图谱的视图层纯函数
 *
 * 只做坐标/尺寸/取色/邻接这些可单测的数学，不碰 DOM 与 canvas，
 * 这样 2000 节点视图的「视口/命中/缩放」逻辑不依赖真实渲染即可验证。
 */

import type { GraphEdge, GraphNode, GraphNodeKind } from '../../shared/knowledge/graph'

/** 世界坐标点 */
export interface Point {
  x: number
  y: number
}

/** 视口尺寸（CSS 像素） */
export interface Viewport {
  width: number
  height: number
}

/** 屏幕坐标 = 世界坐标 * scale + (x, y) */
export interface ViewTransform {
  scale: number
  x: number
  y: number
}

/** 已定位、可直接绘制的节点 */
export interface PositionedNode extends GraphNode {
  x: number
  y: number
  radius: number
}

/** 缩放下限（再小就看不清结构） */
export const MIN_SCALE = 0.05
/** 缩放上限（再大只是看几个点） */
export const MAX_SCALE = 5
export const MIN_NODE_RADIUS = 2.5
export const MAX_NODE_RADIUS = 12
/** 适配视图时四周留白 */
export const FIT_PADDING = 48
/** 命中判定在节点半径之外额外放宽的像素 */
export const HIT_TOLERANCE = 3

/** 全局布局固定种子：同一张图每次打开必须长成同一张脸 */
export const GLOBAL_LAYOUT_SEED = 0x1f2e3d4c

/**
 * 节点半径随度数增长，但用平方根压一压，
 * 否则少数枢纽点会把其余节点衬成看不见的沙粒。
 */
export function radiusForDegree(degree: number, maxDegree: number): number {
  if (maxDegree <= 0 || degree <= 0) return MIN_NODE_RADIUS
  const ratio = Math.sqrt(Math.min(1, degree / maxDegree))
  return MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * ratio
}

/**
 * 迭代次数按规模收敛
 *
 * 2000 节点的库是常见的上限，此时线性降低迭代数换取首屏时间；
 * 力导向的收敛速度本来就快于线性，少迭代主要损失细节而非结构。
 */
export function layoutIterations(nodeCount: number): number {
  if (nodeCount > 1200) return 90
  if (nodeCount > 400) return 140
  return 220
}

/** 无向邻接表（图谱的连线是有向语义，但可视化上双向可达） */
export function buildAdjacency(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  const link = (from: string, to: string): void => {
    let set = adjacency.get(from)
    if (set === undefined) {
      set = new Set<string>()
      adjacency.set(from, set)
    }
    set.add(to)
  }
  for (const edge of edges) {
    link(edge.from, edge.to)
    link(edge.to, edge.from)
  }
  return adjacency
}

/** 悬停时应保持高亮的集合：自己 + 直接邻居 */
export function neighborsOf(adjacency: Map<string, Set<string>>, id: string): Set<string> {
  const result = new Set<string>([id])
  const direct = adjacency.get(id)
  if (direct !== undefined) {
    for (const other of direct) result.add(other)
  }
  return result
}

/**
 * 命中最近的节点
 *
 * 用「半径 + 容差」而不是纯粹的点距，小节点也要点得中。
 */
export function hitTest(
  nodes: readonly PositionedNode[],
  x: number,
  y: number,
  tolerance: number = HIT_TOLERANCE
): PositionedNode | null {
  let best: PositionedNode | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    const dx = node.x - x
    const dy = node.y - y
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (distance > node.radius + tolerance) continue
    if (distance < bestDistance) {
      best = node
      bestDistance = distance
    }
  }
  return best
}

/** 世界坐标包围盒；空集合返回原点，避免调用方到处判空 */
export function worldBounds(points: readonly Point[]): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  return { minX, minY, maxX, maxY }
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** 把整张图装进视口并居中 */
export function fitTransform(
  points: readonly Point[],
  viewport: Viewport,
  padding: number = FIT_PADDING
): ViewTransform {
  if (points.length === 0) {
    return { scale: 1, x: viewport.width / 2, y: viewport.height / 2 }
  }
  const bounds = worldBounds(points)
  const spanX = Math.max(bounds.maxX - bounds.minX, 1)
  const spanY = Math.max(bounds.maxY - bounds.minY, 1)
  const usableWidth = Math.max(viewport.width - padding * 2, 1)
  const usableHeight = Math.max(viewport.height - padding * 2, 1)
  const scale = clampScale(Math.min(usableWidth / spanX, usableHeight / spanY))
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  return {
    scale,
    x: viewport.width / 2 - centerX * scale,
    y: viewport.height / 2 - centerY * scale
  }
}

export function screenToWorld(
  transform: ViewTransform,
  x: number,
  y: number
): Point {
  const scale = clampScale(transform.scale)
  return { x: (x - transform.x) / scale, y: (y - transform.y) / scale }
}

/** 以屏幕锚点为中心缩放：锚点下的世界坐标保持不动 */
export function zoomAt(
  transform: ViewTransform,
  factor: number,
  anchorX: number,
  anchorY: number
): ViewTransform {
  const current = clampScale(transform.scale)
  const scale = clampScale(current * factor)
  const world = screenToWorld({ ...transform, scale: current }, anchorX, anchorY)
  return { scale, x: anchorX - world.x * scale, y: anchorY - world.y * scale }
}

/**
 * 文件夹取色
 *
 * 与局部图谱使用同一套算法，保证「同一个文件夹在两个视图里颜色一致」，
 * 用户的颜色记忆才有意义。
 */
export function colorForKey(key: string): string {
  let hash = 0
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) % 360
  }
  return `hsl(${hash} 62% 52%)`
}

/** 取色用的分组键；孤立节点与标签不按文件夹上色 */
export function colorGroupOf(node: GraphNode): string | null {
  if (node.kind === 'tag' || node.kind === 'cluster') return null
  if (node.isolated) return null
  return node.folder === '' ? '根目录' : node.folder
}

/** 只有真实文件才能打开；标签、目录、聚合块只是结构节点 */
export function isOpenableKind(kind: GraphNodeKind): boolean {
  return kind !== 'tag' && kind !== 'cluster' && kind !== 'folder'
}
