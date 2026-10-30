import { folderColor, graphPalette, unresolvedColor, type GraphTheme } from '../../../shared/graph/colors'
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
 * - 颜色 = 顶层目录（实心填充，只出现在点上）
 * - 形状 = 文档格式（圆点正文 / 菱形导图 / 方形图表 / 三角其他文件）
 * - 半径 = 入链数
 * - 虚线空心 = 断链幽灵节点
 *
 * 配色与官网的知识图谱面板逐项对齐（底色、边、标签、选中光环、断链），
 * 具体值见 `shared/graph/colors.ts` 的 `graphPalette`。把风格收敛到一处的原因是：
 * 画布拿不到 CSS 变量，颜色只能以纯函数随主题给出，官网则用同名令牌表达同一套语义，
 * 两边各写一份值等于放任它们漂移。
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

/** 节点半径：按入链数缩放，上限 11 */
export function nodeRadius(node: GraphNode): number {
  return Math.min(11, 4 + 1.6 * Math.sqrt(Math.max(0, node.inDegree)))
}

const DIMMED_ALPHA = 0.16
const LABEL_LIMIT = 400
/** 菱形比同半径的圆看起来小一圈，放大一点让各种形状的「面积」接近 */
const DIAMOND_SCALE = 1.15
/** 三角：顶点上探、底边只到 0.62r，重心才落在节点坐标上 */
const TRIANGLE_APEX = 1.1
const TRIANGLE_HALF_BASE = 1
const TRIANGLE_BASE = 0.62
/** 选中光环与图形之间留的空隙 */
const HALO_OFFSET = 6
/**
 * 标签用等宽字体。
 *
 * 图上的标签大多是文件名（`发布流程.drawio`、`eris流水线`），等宽字让点和它的名字
 * 看起来属于同一套「技术文档」的语言；也让不同宽度的标签在下沿排得很齐。
 * 尺寸与官网一致：只有颜色区分主次，不靠放大字号。
 */
const LABEL_FONT = '11px Consolas, Monaco, "Courier New", monospace'

function edgeWidth(count: number): number {
  return count >= 2 ? 1.4 : 1.2
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
 * 平色画布里的节点没有空间参照，拖拽平移时会失去「我移动了多远」的体感；
 * 一层几乎看不出来的点阵就够把「无限画布」这件事说清楚。
 * 颜色压到 10% 以下：它该是纸的纹理，不该让人看见「这里有网格」。
 * 缩得过小时把间距翻倍，否则点会连成一层灰雾。
 */
const GRID_STEP = 28
const GRID_MIN_SCREEN = 15

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  transform: ViewportTransform,
  color: string
): void {
  let step = GRID_STEP
  while (step * transform.k < GRID_MIN_SCREEN) step *= 2
  const screenStep = step * transform.k
  if (!Number.isFinite(screenStep) || screenStep < 4) return

  // 世界原点的屏幕位置对间距取模，得到第一个落进视口的格点
  const offsetX = ((transform.x % screenStep) + screenStep) % screenStep
  const offsetY = ((transform.y % screenStep) + screenStep) % screenStep

  ctx.fillStyle = color
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
  /** 焦点 / 命中 / 选中：标签永远画，且参与避让优先级最高 */
  pinned: boolean
}

export function renderGraph(options: RenderGraphOptions): void {
  const { ctx, width, height, transform, positions, theme } = options
  const palette = graphPalette(theme)
  const zoom = transform.k

  ctx.save()
  ctx.clearRect(0, 0, width, height)

  // 背景只有一层平色 + 极淡点阵：画布属于面板，不是一张独立的白纸。
  // 早先那层径向暗角会让人误以为画布有自己的「光源」，而面板里并没有。
  ctx.fillStyle = palette.canvas
  ctx.fillRect(0, 0, width, height)
  drawGrid(ctx, width, height, transform, palette.grid)

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
  // 等宽、中性、细：边是结构，不是主角。颜色只留给「与焦点相连」的那几条，
  // 且用的也是中性灰的深一档，不借用节点色——借色会让整张图变成一锅彩色面条。
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

    // 非焦点的边不额外降透明度：颜色本身已经够淡（浅色 #d1d5db、深色 #4b5563），
    // 再叠一层 alpha 会在浅色主题里直接消失。
    ctx.globalAlpha = visible ? 1 : DIMMED_ALPHA * 0.5
    ctx.strokeStyle = edge.unresolved
      ? unresolvedColor(theme)
      : emphasized
        ? palette.edgeFocus
        : palette.edge
    ctx.lineWidth = emphasized ? edgeWidth(edge.count) + 0.6 : edgeWidth(edge.count)
    if (edge.unresolved) ctx.setLineDash([4, 3])
    else ctx.setLineDash([])

    // 线止于节点边缘，不从圆点里穿过去；断在边缘上，整张图才是「点 + 线」。
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
        ctx.globalAlpha = 1
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
    // 幽灵节点没有真实格式，一律画成圆 + 虚线；形状只给真实文件用
    const shape: NodeShape = node.unresolved ? 'circle' : nodeShape(node.format)
    const selected = node.id === options.selectedId

    ctx.globalAlpha = focus ? 1 : DIMMED_ALPHA

    // 选中：一枚强调色的细光环，和官网选中态一致。
    // 不再用「双环取景框」：两道中性环在浅色底上几乎看不见，在深色底上又像描边画粗了。
    if (selected) {
      const extent = shapeExtent(shape, Math.max(3, radius))
      traceNodePath(ctx, shape, screenX, screenY, extent + HALO_OFFSET)
      ctx.globalAlpha = focus ? 0.55 : DIMMED_ALPHA
      ctx.lineWidth = 1.3
      ctx.strokeStyle = palette.halo
      ctx.stroke()
      ctx.globalAlpha = focus ? 1 : DIMMED_ALPHA
    }

    if (node.unresolved) {
      // 断链：空心 + 红色虚线描边，与所有实心簇节点区分开
      traceNodePath(ctx, shape, screenX, screenY, Math.max(3, radius))
      ctx.setLineDash([3, 2])
      ctx.lineWidth = 1.5
      ctx.strokeStyle = unresolvedColor(theme)
      ctx.stroke()
      ctx.setLineDash([])
    } else {
      // 实心填充，不描边：颜色本身就是边界，一圈描边只会把点画成「硬币」
      traceNodePath(ctx, shape, screenX, screenY, radius)
      ctx.fillStyle = folderColor(node.folder, theme).fill
      ctx.fill()
    }

    if (!options.showLabels) continue

    // 渐进披露：待看的东西先给你标签，其余靠放大或悬停换。
    // 原来的「缩放 ≥ 0.8 就全铺」在几百个节点的图上会直接糊满。
    const pinned = focus && (highlight !== null || (hasSearch && matches!.has(node.id)))
    const showLabel =
      pinned ||
      selected ||
      node.unresolved ||
      (zoom >= 0.9 && radius >= 5) ||
      zoom >= 1.7

    if (showLabel) {
      labelCandidates.push({
        node,
        screenX,
        screenY,
        extent: shapeExtent(shape, Math.max(3, radius)),
        pinned: pinned || selected
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
    ctx.font = LABEL_FONT
    const space = new LabelSpace()
    let placed = 0

    for (const item of labelCandidates) {
      if (placed >= LABEL_LIMIT) break

      const text = truncateLabel(item.node.label)
      const textWidth = ctx.measureText(text).width
      const boxX = item.screenX - textWidth / 2 - 4
      const boxY = item.screenY + item.extent + 6
      const boxW = textWidth + 8
      const boxH = 15

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

      // 不做白色药丸底：底会截断线条、把图切成一格一格。
      // 改用「描一圈底色的字」做晕影——文字浮在线上面，画布的平色质感还在。
      ctx.globalAlpha = item.pinned ? 1 : 0.85
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
      ctx.lineWidth = item.pinned ? 4 : 3.4
      ctx.strokeStyle = palette.labelHalo
      ctx.strokeText(text, item.screenX, boxY)

      ctx.fillStyle = item.pinned ? palette.labelFocus : palette.label
      ctx.fillText(text, item.screenX, boxY)
      placed++
    }
  }

  ctx.globalAlpha = 1
  ctx.restore()
}

function truncateLabel(label: string): string {
  const MAX = 18
  return label.length > MAX ? `${label.slice(0, MAX - 1)}…` : label
}
