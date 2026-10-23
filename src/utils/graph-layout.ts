/**
 * 力导向布局（确定性、无依赖）
 *
 * 图谱要「布局稳定」：同一份数据每次打开图形状一致，否则用户会失去空间记忆。
 * 因此这里用固定种子的伪随机数做初始抖动，不使用 `Math.random()`；
 * 结尾做一次等比缩放把结果装进画布，等比缩放不会改变节点间的距离排序。
 *
 * 算法是 Fruchterman-Reingold：斥力用**空间网格**分桶，只和相邻格子里的
 * 节点互斥，避免 O(n²)——局部图谱 ≤300 节点，全局图谱受护栏限制在 1500，
 * 网格让两者都在可接受时间内跑完。
 *
 * 为什么自实现而不是引 `d3-force`：设计文档 §5.6 把这点留给实现者，
 * 而依赖越少越好，这个文件也就能纯函数单测。
 */

export interface LayoutNodeInput {
  id: string
}

export interface LayoutEdgeInput {
  from: string
  to: string
}

export interface LayoutPoint {
  x: number
  y: number
}

export interface LayoutOptions {
  width: number
  height: number
  /** 迭代轮数；默认按节点数自适应 */
  iterations?: number
  /** 随机种子，保证同一份数据的布局可复现 */
  seed?: number
}

/** 画布极小的兜底尺寸 */
const MIN_SIZE = 1

/** 四周留白比例（避免节点贴边被裁掉） */
const PADDING_RATIO = 0.06

/** 判定「退化」的容差 */
const EPSILON = 1e-6

/** 默认种子 */
const DEFAULT_SEED = 1

/** 32 位确定性伪随机数（mulberry32） */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 按节点数挑迭代轮数：小图多跑几轮，大图少跑几轮 */
function defaultIterations(count: number): number {
  if (count <= 60) return 300
  if (count <= 200) return 200
  return 120
}

/** 递归整数的 key（负坐标也要落到唯一格子） */
function cellKey(x: number, y: number): string {
  return `${x}\u0000${y}`
}

/**
 * 计算布局
 *
 * 返回 `id → 坐标`；坐标已等比缩放到画布内（含留白）。
 * 空输入返回空 Map，单节点放在画布正中。
 */
export function layoutNetwork(
  nodes: readonly LayoutNodeInput[],
  edges: readonly LayoutEdgeInput[],
  options: LayoutOptions
): Map<string, LayoutPoint> {
  const positions = new Map<string, LayoutPoint>()

  // 去重但保持输入顺序（顺序稳定 = 结果可复现）
  const ids: string[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.id)) continue
    seen.add(node.id)
    ids.push(node.id)
  }

  const count = ids.length
  if (count === 0) return positions

  const width = Math.max(MIN_SIZE, Number.isFinite(options.width) ? options.width : MIN_SIZE)
  const height = Math.max(MIN_SIZE, Number.isFinite(options.height) ? options.height : MIN_SIZE)

  if (count === 1) {
    positions.set(ids[0], { x: width / 2, y: height / 2 })
    return positions
  }

  const slot = new Map<string, number>()
  ids.forEach((id, index) => slot.set(id, index))

  // 只保留两端都存在的边
  const links: Array<[number, number]> = []
  for (const edge of edges) {
    const from = slot.get(edge.from)
    const to = slot.get(edge.to)
    if (from === undefined || to === undefined || from === to) continue
    links.push([from, to])
  }

  const random = mulberry32(options.seed ?? DEFAULT_SEED)
  const iterations = Math.max(
    0,
    Math.floor(options.iterations ?? defaultIterations(count))
  )

  // 初始位置：圆环 + 抖动。圆环比纯随机收敛更快，也更不容易出现对称塌陷
  const x = new Float64Array(count)
  const y = new Float64Array(count)
  const radius = Math.min(width, height) * 0.35
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2 + (random() - 0.5) * 0.6
    const jitter = 0.75 + random() * 0.5
    x[index] = Math.cos(angle) * radius * jitter
    y[index] = Math.sin(angle) * radius * jitter
  }

  // 理想边长：让每个节点分到大致相等的面积
  const area = width * height
  const k = Math.sqrt(area / count) * 0.85
  const cellSize = Math.max(k * 1.6, EPSILON)
  const cutoff = cellSize * 1.5
  const cutoffSq = cutoff * cutoff
  const maxStep = Math.min(width, height) * 0.12

  const dispX = new Float64Array(count)
  const dispY = new Float64Array(count)

  for (let round = 0; round < iterations; round++) {
    dispX.fill(0)
    dispY.fill(0)

    // 斥力：只和相邻 3×3 格子里的节点算
    const buckets = new Map<string, number[]>()
    for (let index = 0; index < count; index++) {
      const key = cellKey(Math.floor(x[index] / cellSize), Math.floor(y[index] / cellSize))
      const list = buckets.get(key)
      if (list === undefined) buckets.set(key, [index])
      else list.push(index)
    }

    for (let index = 0; index < count; index++) {
      const gx = Math.floor(x[index] / cellSize)
      const gy = Math.floor(y[index] / cellSize)
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bucket = buckets.get(cellKey(gx + ox, gy + oy))
          if (bucket === undefined) continue
          for (const other of bucket) {
            if (other === index) continue
            let dx = x[index] - x[other]
            let dy = y[index] - y[other]
            let distanceSq = dx * dx + dy * dy
            if (distanceSq < EPSILON) {
              // 完全重合时给一个确定性的微小位移，避免除零与 NaN
              dx = (random() - 0.5) * EPSILON
              dy = (random() - 0.5) * EPSILON
              distanceSq = dx * dx + dy * dy + EPSILON
            }
            if (distanceSq > cutoffSq) continue
            const force = (k * k) / distanceSq
            dispX[index] += dx * force
            dispY[index] += dy * force
          }
        }
      }
    }

    // 引力：每条边把两端拉近
    for (const [from, to] of links) {
      const dx = x[to] - x[from]
      const dy = y[to] - y[from]
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance < EPSILON) continue
      const force = (distance * distance) / k
      const ux = (dx / distance) * force
      const uy = (dy / distance) * force
      dispX[from] += ux
      dispY[from] += uy
      dispX[to] -= ux
      dispY[to] -= uy
    }

    // 向心力：防止互不相连的分量飘散到无穷远
    for (let index = 0; index < count; index++) {
      dispX[index] -= x[index] * 0.01
      dispY[index] -= y[index] * 0.01
    }

    // 位移限幅并线性降温
    const step = maxStep * (1 - round / (iterations + 1))
    for (let index = 0; index < count; index++) {
      const length = Math.sqrt(dispX[index] * dispX[index] + dispY[index] * dispY[index])
      if (length < EPSILON) continue
      const limited = Math.min(length, step)
      x[index] += (dispX[index] / length) * limited
      y[index] += (dispY[index] / length) * limited
    }
  }

  // 等比缩放装进画布：等比才不会破坏距离排序
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let index = 0; index < count; index++) {
    if (x[index] < minX) minX = x[index]
    if (x[index] > maxX) maxX = x[index]
    if (y[index] < minY) minY = y[index]
    if (y[index] > maxY) maxY = y[index]
  }

  const padding = Math.min(width, height) * PADDING_RATIO
  const spanX = maxX - minX
  const spanY = maxY - minY
  const usableWidth = Math.max(width - padding * 2, MIN_SIZE)
  const usableHeight = Math.max(height - padding * 2, MIN_SIZE)

  const scaleX = spanX < EPSILON ? Infinity : usableWidth / spanX
  const scaleY = spanY < EPSILON ? Infinity : usableHeight / spanY
  const scale = Math.min(scaleX, scaleY)
  const finiteScale = Number.isFinite(scale) ? scale : 1

  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  for (let index = 0; index < count; index++) {
    const px = (x[index] - centerX) * finiteScale + width / 2
    const py = (y[index] - centerY) * finiteScale + height / 2
    positions.set(ids[index], {
      x: Math.min(Math.max(px, 0), width),
      y: Math.min(Math.max(py, 0), height)
    })
  }

  return positions
}
