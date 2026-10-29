import { folderColor, unresolvedColor, type GraphTheme } from '../../../shared/graph/colors'
import type { GraphEdge, GraphNode } from '../../../shared/graph/types'
import { nodeShape, type NodeShape } from './shape'
import type { SimNode } from './simulation'
import type { ViewportTransform } from './viewport'

/**
 * Canvas 2D 绘制。
 *
 * 每帧只做三件事：清屏（点阵底）、批量画边、批量画节点与标签。
 * 不给每个节点建 DOM —— 2000 个元素的选择器查询、样式重算与合成会直接卡死，
 * 而 Canvas 画 2000 个圆是毫秒级的事。
 *
 * 四条视觉编码，互不重叠：
 * - 颜色 = 顶层目录
 * - 形状 = 文档格式（圆点正文 / 菱形导图 / 方形图表）
 * - 半径 = 入链数
 * - 虚线空心 = 断链幽灵节点
 */

export interface RenderGraphOptions {
  ctx: CanvasRenderingContext2D
  /** CSS 像素尺寸（不含 DPR） */
  width: number
  height: number
  transform: ViewportTransform
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  positions: ReadonlyMap<string, SimNode>
  theme: GraphTheme
  /** 由 hover 决定的高亮集合（自身 + 一跳邻居）；null 表示没有 hover */
  highlightIds: ReadonlySet<string> | null
  selectedId: string | null
  /** 搜索命中集合：命中项保持明亮，其余变暗 */
  searchMatches: ReadonlySet<string> | null
  /** 是否绘制文字标签 */
  showLabels: boolean
  /** 当前焦点（hover 优先于选中）：它的邻接边会被强调并带方向箭头 */
  focusId: string | null
}

/** 节点半径：按入链数缩放，上限 14 */
export function nodeRadius(node: GraphNode): number {
  return Math.min(14, 3 + 2 * Math.sqrt(Math.max(0, node.inDegree)))
}

const DIMMED_ALPHA = 0.18
const LABEL_LIMIT = 400
/** 菱形比同半径的圆看起来小一圈，放大一点让各种形状的「面积」接近 */
const DIAMOND_SCALE = 1.15
/** 三角：顶点上探、底边只到 0.62r，重心才落在节点坐标上 */
const TRIANGLE_APEX = 1.1
const TRIANGLE_HALF_BASE = 1
const TRIANGLE_BASE = 0.62
/** 到这一档连接度才配得上「等高线」——太低的节点挂上光晕只会变脏 */
const HALO_DEGREE = 4

function edgeWidth(count: number): number {
  return count >= 2 ? 1.5 : 1
}

/** 形状在 y 方向的实际半高，用来把标签推到图形下方而不是压在描边上 */
function shapeExtent(shape: NodeShape, radius: number): number {
  if (shape === 'diamond') return radius * DIAMOND_SCALE
  if (shape === 'triangle') return radius * TRIANGLE_BASE
  return radius
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.arcTo(x + width, y, x + width, y + r, r)
  ctx.lineTo(x + width, y + height - r)
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r)
  ctx.lineTo(x + r, y + height)
  ctx.arcTo(x, y + height, x, y + height - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

function traceNodePath(
  ctx: CanvasRenderingContext2D,
  shape: NodeShape,
  x: number,
  y: number,
  radius: number
): void {
  if (shape === 'diamond') {
    const d = radius * DIAMOND_SCALE
    ctx.beginPath()
    ctx.moveTo(x, y - d)
    ctx.lineTo(x + d, y)
    ctx.lineTo(x, y + d)
    ctx.lineTo(x - d, y)
    ctx.closePath()
    return
  }
  if (shape === 'square') {
    // 圆角方：直角在小尺寸下会显得比圆点「重」，收一点角正好
    roundedRectPath(ctx, x - radius, y - radius, radius * 2, radius * 2, radius * 0.38)
    return
  }
  if (shape === 'triangle') {
    // 重心居中：顶点上探 1.1r，底边落在 +0.62r，视觉重量才和圆点相当
    ctx.beginPath()
    ctx.moveTo(x, y - radius * TRIANGLE_APEX)
    ctx.lineTo(x + radius * TRIANGLE_HALF_BASE, y + radius * TRIANGLE_BASE)
    ctx.lineTo(x - radius * TRIANGLE_HALF_BASE, y + radius * TRIANGLE_BASE)
    ctx.closePath()
    return
  }
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
}

/**
 * 点阵底。
 *
 * 平色背景里的节点没有空间参照，图看起来像贴在一块白板上；
 * 一层极淡的点阵就足够把「无限画布」这件事说清楚，代价是每帧一次 fillRect 循环。
 * 缩得过小时把间距翻倍，否则点会连成一层灰雾。
 */
const GRID_STEP = 28
const GRID_MIN_SCREEN = 15

/**
 * 纸面暗角。
 *
 * 平涂的底色让画布像一块没有边的白板；一层几乎看不出来的径向渐变
 * 就能把「这是一张铺开的纸」说清楚——中心亮、四角沉，
 * 视线自然收在中间那一簇上。渐变按尺寸缓存，不要每帧重建。
 */
interface VignetteCache {
  key: string
  gradient: CanvasGradient
}

let vignetteCache: VignetteCache | null = null

function paperGradient(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dark: boolean
): CanvasGradient | null {
  const key = `${width}x${height}:${dark ? 'd' : 'l'}`
  if (vignetteCache && vignetteCache.key === key) return vignetteCache.gradient
  if (typeof ctx.createRadialGradient !== 'function') return null

  const gradient = ctx.createRadialGradient(
    width * 0.5,
    height * 0.46,
    Math.min(width, height) * 0.12,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.78
  )
  gradient.addColorStop(0, dark ? 'rgba(0, 0, 0, 0)' : 'rgba(255, 253, 248, 0)')
  gradient.addColorStop(1, dark ? 'rgba(0, 0, 0, 0.42)' : 'rgba(84, 76, 66, 0.07)')
  vignetteCache = { key, gradient }
  return gradient
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  transform: ViewportTransform,
  dark: boolean
): void {
  let step = GRID_STEP
  while (step * transform.k < GRID_MIN_SCREEN) step *= 2
  const screenStep = step * transform.k
  if (!Number.isFinite(screenStep) || screenStep < 4) return

  // 世界原点的屏幕位置对间距取模，得到第一个落进视口的格点
  const offsetX = ((transform.x % screenStep) + screenStep) % screenStep
  const offsetY = ((transform.y % screenStep) + screenStep) % screenStep

  // 更淡一层：点阵是纸的纹理，不是网格
  ctx.fillStyle = dark ? 'rgba(148, 163, 184, 0.1)' : 'rgba(92, 84, 74, 0.12)'
  for (let x = offsetX; x < width; x += screenStep) {
    for (let y = offsetY; y < height; y += screenStep) {
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1)
    }
  }
}

interface LabelBox {
  left: number
  top: number
  right: number
  bottom: number
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/**
 * 标签避让（空间哈希版）。
 *
 * 高密度区里标签会叠成一团糊字，而全量两两比较在 400 个标签时是 8 万次判定，
 * 每帧都做撑不住。按 72px 网格分桶后，单个标签只需比对邻近几桶。
 */
class LabelSpace {
  private readonly cells = new Map<string, LabelBox[]>()

  constructor(private readonly cell = 72) {}

  private keys(box: LabelBox): string[] {
    const keys: string[] = []
    const fromX = Math.floor(box.left / this.cell)
    const toX = Math.floor(box.right / this.cell)
    const fromY = Math.floor(box.top / this.cell)
    const toY = Math.floor(box.bottom / this.cell)
    for (let cx = fromX; cx <= toX; cx++) {
      for (let cy = fromY; cy <= toY; cy++) keys.push(`${cx}:${cy}`)
    }
    return keys
  }

  /** 能放下返回 true 并占位；与已占位标签冲突返回 false */
  tryPlace(box: LabelBox): boolean {
    const keys = this.keys(box)
    for (const key of keys) {
      const bucket = this.cells.get(key)
      if (!bucket) continue
      for (const other of bucket) {
        if (overlaps(box, other)) return false
      }
    }
    for (const key of keys) {
      const bucket = this.cells.get(key)
      if (bucket) bucket.push(box)
      else this.cells.set(key, [box])
    }
    return true
  }
}

interface LabelCandidate {
  node: GraphNode
  screenX: number
  screenY: number
  extent: number
  shape: NodeShape
  /** 焦点 / 命中 / 选中：标签永远画，且参与避让优先级最高 */
  pinned: boolean
}

export function renderGraph(options: RenderGraphOptions): void {
  const { ctx, width, height, transform, positions, theme } = options
  const dark = theme === 'dark'
  const zoom = transform.k

  ctx.save()
  ctx.clearRect(0, 0, width, height)

  // 背景：一层纸色 + 一层暗角，之后才是点阵
  ctx.fillStyle = dark ? '#141518' : '#ffffff'
  ctx.fillRect(0, 0, width, height)
  const paper = paperGradient(ctx, width, height, dark)
  if (paper) {
    ctx.fillStyle = paper
    ctx.fillRect(0, 0, width, height)
  }
  drawGrid(ctx, width, height, transform, dark)

  const highlight = options.highlightIds
  const matches = options.searchMatches
  const hasSearch = matches !== null && matches.size > 0
  const focusId = options.focusId

  /** 一个节点是否应该「亮着」 */
  const isFocus = (id: string): boolean => {
    if (highlight) return highlight.has(id)
    if (hasSearch) return matches!.has(id)
    return true
  }

  // ===== 边 =====
  // 细若游丝：边是结构，不是主角。整屏 0.2 上下的透明度让它退成纸上的线，
  // 只有和焦点直接相连的那几条才升到前排。
  const focusPalette =
    focusId === null
      ? null
      : (() => {
          const node = options.nodes.find((item) => item.id === focusId)
          if (!node) return null
          return node.unresolved ? unresolvedColor(theme) : folderColor(node.folder, theme)
        })()

  ctx.lineCap = 'round'
  for (const edge of options.edges) {
    const source = positions.get(edge.source)
    const target = positions.get(edge.target)
    if (!source || !target) continue

    const focused = !highlight || (highlight.has(edge.source) && highlight.has(edge.target))
    const searched = !hasSearch || (matches!.has(edge.source) || matches!.has(edge.target))
    const visible = focused && searched

    // 与焦点直接相连的边：更实、更粗，并加一个指向目标的箭头。
    // 方向只在这一小簇上出现——2000 条边全挂箭头会糊成一片。
    const nearFocus = focusId !== null && (edge.source === focusId || edge.target === focusId)
    const emphasized = visible && nearFocus

    const x1 = source.x * zoom + transform.x
    const y1 = source.y * zoom + transform.y
    const x2 = target.x * zoom + transform.x
    const y2 = target.y * zoom + transform.y

    ctx.globalAlpha = visible ? (emphasized ? 0.95 : edge.unresolved ? 0.55 : 0.26) : DIMMED_ALPHA * 0.4
    // 焦点边借焦点节点的墨色，其余保持中性——颜色只在「正在看的东西」上出现
    ctx.strokeStyle = edge.unresolved
      ? unresolvedColor(theme).stroke
      : emphasized && focusPalette
        ? focusPalette.stroke
        : dark
          ? 'rgba(166, 170, 182, 0.85)'
          : 'rgba(58, 53, 48, 0.9)'
    ctx.lineWidth = emphasized ? edgeWidth(edge.count) + 0.6 : edgeWidth(edge.count)
    if (edge.unresolved) ctx.setLineDash([4, 3])
    else ctx.setLineDash([])

    // 线止于节点边缘，不从圆点里穿过去。
    // 节点底现在是半透的淡彩，穿过去的线会在点内部留下一道阴影；
    // 断在边缘上，整张图才是「点 + 线」，而不是「线被点盖住」。
    const dx = x2 - x1
    const dy = y2 - y1
    const length = Math.hypot(dx, dy)
    const gapStart = Math.max(2, source.radius * zoom) + 1.2
    const gapEnd = Math.max(2, target.radius * zoom) + 1.2
    if (length > gapStart + gapEnd + 0.5) {
      const ux = dx / length
      const uy = dy / length
      ctx.beginPath()
      ctx.moveTo(x1 + ux * gapStart, y1 + uy * gapStart)
      ctx.lineTo(x2 - ux * gapEnd, y2 - uy * gapEnd)
      ctx.stroke()
    }

    if (emphasized && !edge.unresolved) {
      const backoff = gapEnd + 2
      if (length > backoff + 7) {
        const ux = dx / length
        const uy = dy / length
        const tipX = x2 - ux * backoff
        const tipY = y2 - uy * backoff
        const size = 5
        const wingX = -uy * size * 0.62
        const wingY = ux * size * 0.62
        ctx.globalAlpha = 0.95
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.moveTo(tipX - ux * size + wingX, tipY - uy * size + wingY)
        ctx.lineTo(tipX, tipY)
        ctx.lineTo(tipX - ux * size - wingX, tipY - uy * size - wingY)
        ctx.stroke()
      }
    }
  }
  ctx.setLineDash([])

  // ===== 节点 =====
  const labelCandidates: LabelCandidate[] = []

  for (const node of options.nodes) {
    const position = positions.get(node.id)
    if (!position) continue

    const screenX = position.x * zoom + transform.x
    const screenY = position.y * zoom + transform.y
    const radius = Math.max(2, nodeRadius(node) * zoom)

    // 视口外直接跳过：大图上这一条能省掉大半绘制
    if (
      screenX + radius < -40 ||
      screenX - radius > width + 40 ||
      screenY + radius < -40 ||
      screenY - radius > height + 40
    ) {
      continue
    }

    const focus = isFocus(node.id)
    const palette = node.unresolved ? unresolvedColor(theme) : folderColor(node.folder, theme)
    // 幽灵节点没有真实格式，一律画成圆 + 虚线；形状只给真实文件用
    const shape: NodeShape = node.unresolved ? 'circle' : nodeShape(node.format)

    ctx.globalAlpha = focus ? 1 : DIMMED_ALPHA

    // 等高线：连接度高的节点外面套一两圈极淡的同心线。
    // 这是整张图里唯一的「装饰」，但它编码的是真实的度量（连接度），
    // 顺带把枢纽点从一片同尺寸的圆点里托了出来，像地图上的山峰。
    const degree = node.inDegree + node.outDegree
    if (focus && !node.unresolved && degree >= HALO_DEGREE && zoom >= 0.45) {
      const extent = shapeExtent(shape, radius)
      ctx.strokeStyle = palette.stroke
      ctx.lineWidth = 1
      for (const [offset, alpha] of [
        [4.5, 0.16],
        [8, 0.07]
      ] as const) {
        traceNodePath(ctx, shape, screenX, screenY, extent + offset)
        ctx.globalAlpha = alpha
        ctx.stroke()
      }
      ctx.globalAlpha = focus ? 1 : DIMMED_ALPHA
    }

    if (node.unresolved) {
      // 断链：空心 + 虚线描边，与所有实心簇节点区分开
      traceNodePath(ctx, shape, screenX, screenY, Math.max(3, radius))
      ctx.setLineDash([3, 2])
      ctx.lineWidth = 1.5
      ctx.strokeStyle = palette.stroke
      ctx.fillStyle = dark ? 'rgba(20,21,24,0.9)' : 'rgba(255,255,255,0.9)'
      ctx.fill()
      ctx.stroke()
      ctx.setLineDash([])
    } else {
      traceNodePath(ctx, shape, screenX, screenY, radius)
      ctx.fillStyle = palette.fill
      ctx.fill()
      ctx.lineWidth = node.id === options.selectedId ? 1.8 : 1.15
      ctx.strokeStyle = node.id === options.selectedId ? palette.label : palette.stroke
      ctx.stroke()
    }

    // 选中：一枚双环的取景框，而不是把圆点加粗一圈
    if (node.id === options.selectedId) {
      const extent = shapeExtent(shape, Math.max(3, radius))
      const ink = dark ? 'rgba(255,255,255,0.86)' : 'rgba(24,22,20,0.78)'
      traceNodePath(ctx, shape, screenX, screenY, extent + 3.5)
      ctx.lineWidth = 1.2
      ctx.strokeStyle = ink
      ctx.stroke()
      traceNodePath(ctx, shape, screenX, screenY, extent + 7)
      ctx.globalAlpha = 0.32
      ctx.lineWidth = 0.8
      ctx.stroke()
      ctx.globalAlpha = focus ? 1 : DIMMED_ALPHA
    }

    if (!options.showLabels) continue

    // 渐进披露：待看的东西先给你标签，其余靠放大或悬停换。
    // 原来的「缩放 ≥ 0.8 就全铺」在几百个节点的图上会直接糊满。
    const pinned = focus && (highlight !== null || (hasSearch && matches!.has(node.id)))
    const showLabel =
      pinned ||
      node.id === options.selectedId ||
      node.unresolved ||
      (zoom >= 0.9 && radius >= 5) ||
      zoom >= 1.7

    if (showLabel) {
      labelCandidates.push({
        node,
        screenX,
        screenY,
        extent: shapeExtent(shape, Math.max(3, radius)),
        shape,
        pinned
      })
    }
  }

  // ===== 标签（放在最后画，保证盖在节点上） =====
  if (labelCandidates.length > 0) {
    // 焦点优先，其次大节点（大 = 被引得多 = 更可能是用户要找的）
    labelCandidates.sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.extent - a.extent
    )

    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const space = new LabelSpace()
    let placed = 0

    for (const item of labelCandidates) {
      if (placed >= LABEL_LIMIT) break

      ctx.font = item.pinned
        ? '600 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
        : '500 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
      // 轻微的字距：小字号下「松一点」比「粗一点」更清楚，也更像图注
      setLetterSpacing(ctx, item.pinned ? '0.04em' : '0.02em')

      const text = truncateLabel(item.node.label)
      const textWidth = ctx.measureText(text).width
      const boxX = item.screenX - textWidth / 2 - 4
      const boxY = item.screenY + item.extent + 5
      const boxW = textWidth + 8
      const boxH = item.pinned ? 17 : 15

      // 焦点标签不许被挤掉，其余按碰撞情况放弃
      if (!item.pinned) {
        const fits = space.tryPlace({
          left: boxX - 1,
          top: boxY - 1,
          right: boxX + boxW + 1,
          bottom: boxY + boxH + 1
        })
        if (!fits) continue
      } else {
        space.tryPlace({
          left: boxX - 1,
          top: boxY - 1,
          right: boxX + boxW + 1,
          bottom: boxY + boxH + 1
        })
      }

      const palette = item.node.unresolved
        ? unresolvedColor(theme)
        : folderColor(item.node.folder, theme)

      // 不做白色药丸底：底会截断线条、把图切成一格一格。
      // 改用「描一圈纸色的字」做晕影——文字浮在线上面，纸的质感还在。
      const halo = dark
        ? item.pinned
          ? 'rgba(20, 21, 24, 0.95)'
          : 'rgba(20, 21, 24, 0.82)'
        : item.pinned
          ? 'rgba(255, 255, 255, 1)'
          : 'rgba(255, 255, 255, 0.9)'
      ctx.globalAlpha = item.pinned ? 1 : 0.8
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
      ctx.lineWidth = item.pinned ? 4 : 3.4
      ctx.strokeStyle = halo
      ctx.strokeText(text, item.screenX, boxY + (item.pinned ? 1.5 : 0.5))

      ctx.fillStyle = palette.label
      ctx.fillText(text, item.screenX, boxY + (item.pinned ? 1.5 : 0.5))
      placed++
    }
    setLetterSpacing(ctx, '0px')
  }

  ctx.globalAlpha = 1
  ctx.restore()
}

function truncateLabel(label: string): string {
  const MAX = 18
  return label.length > MAX ? `${label.slice(0, MAX - 1)}…` : label
}

/**
 * 字距。
 *
 * `letterSpacing` 是较新的 Canvas 属性，老引擎上没有——静默跳过，
 * 字号和颜色仍然保证标签可读。
 */
function setLetterSpacing(ctx: CanvasRenderingContext2D, value: string): void {
  const target = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
  if ('letterSpacing' in target) target.letterSpacing = value
}
