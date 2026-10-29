/**
 * 画布视口：世界坐标 ⇄ 屏幕坐标的平移缩放变换与命中测试。
 *
 * 纯计算，不碰 DOM，方便单测；GraphCanvas 只负责把事件换算成这里的入参。
 */

export interface ViewportTransform {
  /** 屏幕平移量（像素） */
  x: number
  y: number
  /** 缩放系数 */
  k: number
}

export interface Point {
  x: number
  y: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4

export const IDENTITY_TRANSFORM: ViewportTransform = { x: 0, y: 0, k: 1 }

export function clampZoom(k: number): number {
  if (!Number.isFinite(k)) return 1
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k))
}

export function worldToScreen(
  transform: ViewportTransform,
  point: Point
): Point {
  return {
    x: point.x * transform.k + transform.x,
    y: point.y * transform.k + transform.y
  }
}

export function screenToWorld(
  transform: ViewportTransform,
  point: Point
): Point {
  return {
    x: (point.x - transform.x) / transform.k,
    y: (point.y - transform.y) / transform.k
  }
}

/**
 * 以屏幕上的某点为锚点缩放：锚点下的世界坐标在缩放前后保持不变。
 * 滚轮缩放就是靠这个让「光标下的那一点」不动。
 */
export function zoomAt(
  transform: ViewportTransform,
  factor: number,
  anchor: Point
): ViewportTransform {
  const nextK = clampZoom(transform.k * factor)
  if (nextK === transform.k) return transform
  const world = screenToWorld(transform, anchor)
  return {
    k: nextK,
    x: anchor.x - world.x * nextK,
    y: anchor.y - world.y * nextK
  }
}

export function panBy(transform: ViewportTransform, dx: number, dy: number): ViewportTransform {
  return { ...transform, x: transform.x + dx, y: transform.y + dy }
}

export function boundsOf(points: Iterable<Point>): Bounds | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let seen = false

  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    seen = true
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }

  return seen ? { minX, minY, maxX, maxY } : null
}

/** 计算「适应内容」的变换：内容居中且完整可见 */
export function fitToBounds(
  bounds: Bounds | null,
  width: number,
  height: number,
  padding = 48
): ViewportTransform {
  if (!bounds) return { x: width / 2, y: height / 2, k: 1 }

  const contentWidth = Math.max(1, bounds.maxX - bounds.minX)
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY)
  const usableWidth = Math.max(1, width - padding * 2)
  const usableHeight = Math.max(1, height - padding * 2)

  // 单节点或退化图形：不要放大到荒谬的倍数
  const k = clampZoom(Math.min(usableWidth / contentWidth, usableHeight / contentHeight, 2))
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2

  return {
    k,
    x: width / 2 - centerX * k,
    y: height / 2 - centerY * k
  }
}

/** 把某个世界坐标点移到视口中心 */
export function centerOn(
  transform: ViewportTransform,
  point: Point,
  width: number,
  height: number
): ViewportTransform {
  return {
    k: transform.k,
    x: width / 2 - point.x * transform.k,
    y: height / 2 - point.y * transform.k
  }
}

export interface HitCandidate {
  id: string
  x: number
  y: number
  radius: number
}

/**
 * 命中测试：线性扫描。
 *
 * 2000 个节点每次 mousemove 遍历一遍的开销可以忽略，
 * 为此维护一棵四叉树只会引入状态不同步的 bug。
 */
export function hitTest(
  candidates: readonly HitCandidate[],
  worldPoint: Point,
  tolerance = 3
): string | null {
  let bestId: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    const dx = candidate.x - worldPoint.x
    const dy = candidate.y - worldPoint.y
    const distance = Math.hypot(dx, dy)
    if (distance > candidate.radius + tolerance) continue
    if (distance < bestDistance) {
      bestDistance = distance
      bestId = candidate.id
    }
  }

  return bestId
}
