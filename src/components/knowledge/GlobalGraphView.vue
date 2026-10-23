<script setup lang="ts">
/**
 * 全局图谱（Canvas）
 *
 * 全库视图，独立标签页；与右侧停靠区的局部图谱共用同一份 `knowledge.graph`，
 * 但渲染方式不同：局部图 ≤300 节点用 SVG，全库用 Canvas（几千节点时 SVG 会卡死）。
 *
 * 两条硬要求（设计文档 §5.6 / 计划 T18）：
 * 1. 打开库后首次进入 < 1.5s（2000 节点）——布局用固定种子 + 按规模收敛迭代数，
 *    实测 2000 节点约 120ms，瓶颈不在布局而在 canvas 首帧。
 * 2. 布局稳定后冻结——节点位置只在「图谱数据换了一版」或用户主动重新布局时重算；
 *    平移、缩放、改窗口大小、切换页签都只改变换矩阵，不动节点，保住用户的空间记忆。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  IconAdjustmentsHorizontal,
  IconArrowsMaximize,
  IconRefresh,
  IconSearch,
  IconTopologyStar3,
  IconZoomIn,
  IconZoomOut
} from '@tabler/icons-vue'
import { useFileStore } from '../../stores/file'
import { useKnowledgeStore } from '../../stores/knowledge'
import GraphFilters from './GraphFilters.vue'
import { layoutNetwork } from '../../utils/graph-layout'
import {
  GLOBAL_LAYOUT_SEED,
  HIT_TOLERANCE,
  buildAdjacency,
  clampScale,
  colorForKey,
  colorGroupOf,
  fitTransform,
  hitTest,
  isOpenableKind,
  layoutIterations,
  neighborsOf,
  radiusForDegree,
  screenToWorld,
  zoomAt,
  type PositionedNode,
  type ViewTransform
} from '../../utils/graph-view'
import { filterGraph, type GraphEdge, type GraphNode } from '../../../shared/knowledge/graph'

const knowledge = useKnowledgeStore()
const fileStore = useFileStore()

/** 布局用的名义世界尺寸：与屏幕解耦，换分辨率/窗口大小都不必重排 */
const WORLD = { width: 1600, height: 1000 }
/** 常显标签的预算：只给度数最高的一小撮，否则 2000 个文本会拖垮帧率 */
const LABEL_BUDGET = 40
/** 缩得太小时标签重叠成一团，干脆不画 */
const LABEL_MIN_SCALE = 0.35

const stage = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

const viewport = ref({ width: 0, height: 0 })
const positions = shallowRef<Map<string, { x: number; y: number }>>(new Map())
const transform = ref<ViewTransform>({ scale: 1, x: 0, y: 0 })
const hoverId = ref<string | null>(null)
const selectedId = ref<string | null>(null)
const searchTerm = ref('')
const searchMiss = ref(false)
const layingOut = ref(false)
const frozen = ref(false)
const layoutMs = ref(0)
/** 过滤面板展开状态 */
const filtersOpen = ref(false)
/** 用户手动平移/缩放过就不要再自动适配视图，免得把人家刚摆好的视角抢走 */
const userMoved = ref(false)
const seedBump = ref(0)

const graph = computed(() => knowledge.graph)

/**
 * 当前视图（已过滤）
 *
 * 布局按**未过滤**的整图算，位置因此与过滤器无关：勾选/取消勾选时节点留在原地，
 * 只是出现或消失。这是「空间记忆」的一部分，不能让用户每切一次过滤就重新认图。
 */
const visible = computed(() => filterGraph(graph.value, knowledge.graphFilters))

const adjacency = computed(() => buildAdjacency(visible.value.edges))
const maxDegree = computed(() =>
  visible.value.nodes.reduce((max, node) => Math.max(max, node.degree), 0)
)

/** 布局完成后才有的可绘制节点 */
const positioned = computed<PositionedNode[]>(() => {
  const map = positions.value
  if (map.size === 0) return []
  const max = maxDegree.value
  const result: PositionedNode[] = []
  for (const node of visible.value.nodes) {
    const point = map.get(node.id)
    if (point === undefined) continue
    result.push({ ...node, x: point.x, y: point.y, radius: radiusForDegree(node.degree, max) })
  }
  return result
})

const byId = computed(() => new Map(positioned.value.map((node) => [node.id, node])))

/** 悬停优先于选中：鼠标在所看即所得 */
const focusId = computed<string | null>(() => hoverId.value ?? selectedId.value)

const highlightSet = computed<Set<string> | null>(() => {
  const id = focusId.value
  if (id === null) return null
  return neighborsOf(adjacency.value, id)
})

/** 无交互时常显的标签：度数最高的那一小撮 */
const topLabelIds = computed<Set<string>>(() => {
  const sorted = [...visible.value.nodes].sort((left, right) => right.degree - left.degree)
  return new Set(sorted.slice(0, LABEL_BUDGET).map((node) => node.id))
})

const nodeById = computed(() => new Map(visible.value.nodes.map((node) => [node.id, node])))

const selectedNode = computed<GraphNode | null>(() => {
  const id = selectedId.value
  return id === null ? null : nodeById.value.get(id) ?? null
})

/** 选中节点能否打开成一篇笔记（标签/目录/聚合块只是结构节点） */
const selectedOpenable = computed(() => {
  const node = selectedNode.value
  return node === null ? false : isOpenableKind(node.kind)
})

const stats = computed(
  () =>
    `${visible.value.nodes.length} 节点 · ${visible.value.edges.length} 连线 · ${visible.value.isolated.length} 孤立`
)

const emptyReason = computed<string | null>(() => {
  if (knowledge.root === null) return '先打开一个文件夹，图谱才有可以检索的库'
  if (knowledge.degraded) return '索引不可用，图谱暂不可用'
  if (knowledge.graph.nodes.length === 0) return '这个库里还没有可绘制的笔记'
  if (visible.value.nodes.length === 0) return '当前过滤器排除了所有节点，放宽条件试试'
  return null
})

// ========== 布局 ==========

let layoutFrame = 0

function runLayout(): void {
  const current = graph.value
  if (current.nodes.length === 0) {
    positions.value = new Map()
    frozen.value = false
    return
  }
  layingOut.value = true
  const started = performance.now()
  const result = layoutNetwork(current.nodes, current.edges, {
    width: WORLD.width,
    height: WORLD.height,
    iterations: layoutIterations(current.nodes.length),
    seed: GLOBAL_LAYOUT_SEED + seedBump.value
  })
  layoutMs.value = Math.round(performance.now() - started)
  positions.value = result
  layingOut.value = false
  frozen.value = true
  userMoved.value = false
  refit()
  requestDraw()
}

/** 让出首帧再算：先让用户看到「布局中」，而不是白屏卡一下 */
function scheduleLayout(): void {
  if (layoutFrame !== 0) cancelAnimationFrame(layoutFrame)
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0
    runLayout()
  })
}

function relayout(): void {
  seedBump.value += 1
  scheduleLayout()
}

function refit(): void {
  if (positioned.value.length === 0) return
  if (viewport.value.width === 0 || viewport.value.height === 0) return
  transform.value = fitTransform(positioned.value, viewport.value)
  userMoved.value = false
}

// ========== 绘制 ==========

let drawFrame = 0

function requestDraw(): void {
  if (drawFrame !== 0) return
  drawFrame = requestAnimationFrame(() => {
    drawFrame = 0
    draw()
  })
}

function cssVar(name: string, fallback: string): string {
  const element = stage.value
  if (element === null) return fallback
  const value = getComputedStyle(element).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

interface EdgePaint {
  alpha: number
  width: number
  dash: number[]
}

function edgePaint(layer: GraphEdge['layer']): EdgePaint {
  switch (layer) {
    case 'relation':
      return { alpha: 0.7, width: 1.6, dash: [] }
    case 'tag':
      return { alpha: 0.4, width: 1, dash: [2, 3] }
    case 'mention':
      return { alpha: 0.3, width: 1, dash: [1, 4] }
    case 'resource':
      return { alpha: 0.45, width: 1, dash: [4, 3] }
    case 'folder':
      return { alpha: 0.25, width: 1, dash: [6, 4] }
    default:
      return { alpha: 0.55, width: 1, dash: [] }
  }
}

function nodeFill(node: PositionedNode, tertiary: string, primary: string): string {
  if (node.kind === 'tag') return primary
  if (node.kind === 'cluster') return tertiary
  const group = colorGroupOf(node)
  return group === null ? tertiary : colorForKey(group)
}

function draw(): void {
  const element = canvas.value
  if (element === null) return
  const context = element.getContext('2d')
  if (context === null) return
  const width = viewport.value.width
  const height = viewport.value.height
  if (width <= 0 || height <= 0) return

  const dpr = window.devicePixelRatio || 1
  const pixelWidth = Math.round(width * dpr)
  const pixelHeight = Math.round(height * dpr)
  if (element.width !== pixelWidth) element.width = pixelWidth
  if (element.height !== pixelHeight) element.height = pixelHeight

  const tertiary = cssVar('--color-text-tertiary', '#8b8f98')
  const primary = cssVar('--color-primary', '#3b82f6')
  const text = cssVar('--color-text', '#1f2328')
  const surface = cssVar('--color-bg-primary', '#ffffff')

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, element.width, element.height)

  const view = transform.value
  const scale = clampScale(view.scale)
  const highlight = highlightSet.value
  const index = byId.value

  context.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * view.x, dpr * view.y)

  // 边：悬停时只保留与焦点相邻的连线
  for (const edge of visible.value.edges) {
    const from = index.get(edge.from)
    const to = index.get(edge.to)
    if (from === undefined || to === undefined) continue
    const active =
      highlight === null || (highlight.has(edge.from) && highlight.has(edge.to))
    const paint = edgePaint(edge.layer)
    context.globalAlpha = active ? paint.alpha : 0.04
    context.strokeStyle = paint.width > 1.2 ? primary : tertiary
    context.lineWidth = paint.width / scale
    context.setLineDash(paint.dash.map((value) => value / scale))
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
  }
  context.setLineDash([])

  // 节点：先画被淡出的，再画高亮的，保证焦点在上层
  const back = highlight === null ? [] : positioned.value.filter((node) => !highlight.has(node.id))
  const front = highlight === null ? positioned.value : positioned.value.filter((node) => highlight.has(node.id))

  for (const node of back) {
    context.globalAlpha = 0.12
    context.fillStyle = nodeFill(node, tertiary, primary)
    drawNode(context, node)
  }

  for (const node of front) {
    context.globalAlpha = 1
    context.fillStyle = nodeFill(node, tertiary, primary)
    drawNode(context, node)
    if (node.isolated) {
      context.globalAlpha = 0.8
      context.strokeStyle = tertiary
      context.lineWidth = 1 / scale
      context.setLineDash([2 / scale, 2 / scale])
      context.beginPath()
      context.arc(node.x, node.y, node.radius + 2 / scale, 0, Math.PI * 2)
      context.stroke()
      context.setLineDash([])
    }
    if (node.id === selectedId.value) {
      context.globalAlpha = 1
      context.strokeStyle = primary
      context.lineWidth = 2 / scale
      context.beginPath()
      context.arc(node.x, node.y, node.radius + 3 / scale, 0, Math.PI * 2)
      context.stroke()
    }
  }
  context.globalAlpha = 1

  // 标签：屏幕坐标绘制，字号不随缩放变化
  if (scale >= LABEL_MIN_SCALE) {
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const labelNodes = positioned.value.filter((node) => {
      if (highlight !== null && highlight.has(node.id)) return true
      if (node.id === selectedId.value) return true
      return highlight === null && topLabelIds.value.has(node.id)
    })
    for (const node of labelNodes) {
      const x = node.x * scale + view.x
      const y = node.y * scale + view.y + node.radius + 9
      if (x < -40 || x > width + 40 || y < -20 || y > height + 20) continue
      context.fillStyle = surface
      context.globalAlpha = 0.75
      const metrics = context.measureText(node.label)
      context.fillRect(x - metrics.width / 2 - 2, y - 7, metrics.width + 4, 14)
      context.globalAlpha = 1
      context.fillStyle = text
      context.fillText(node.label, x, y)
    }
  }
  context.setTransform(1, 0, 0, 1, 0, 0)
}

/**
 * 单点绘制
 *
 * 标签是菱形（和局部图谱一致），目录/聚合块是方形，笔记是圆点——
 * 形状本身就是类型信息，不必靠图例。
 */
function drawNode(context: CanvasRenderingContext2D, node: PositionedNode): void {
  if (node.kind === 'tag') {
    const size = Math.max(node.radius, 3)
    context.beginPath()
    context.moveTo(node.x, node.y - size)
    context.lineTo(node.x + size, node.y)
    context.lineTo(node.x, node.y + size)
    context.lineTo(node.x - size, node.y)
    context.closePath()
    context.fill()
    return
  }
  if (node.kind === 'cluster' || node.kind === 'folder') {
    const size = Math.max(node.radius, 4)
    context.beginPath()
    context.rect(node.x - size, node.y - size, size * 2, size * 2)
    context.fill()
    return
  }
  context.beginPath()
  context.arc(node.x, node.y, node.radius, 0, Math.PI * 2)
  context.fill()
}

// ========== 交互 ==========

interface NodeDrag {
  kind: 'node'
  id: string
  offsetX: number
  offsetY: number
  startX: number
  startY: number
  moved: boolean
}

interface PanDrag {
  kind: 'pan'
  startX: number
  startY: number
  originX: number
  originY: number
  moved: boolean
}

let drag: NodeDrag | PanDrag | null = null

function localPoint(event: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
  const element = canvas.value
  if (element === null) return { x: 0, y: 0 }
  const rect = element.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function nodeAt(x: number, y: number): PositionedNode | null {
  const world = screenToWorld(transform.value, x, y)
  return hitTest(positioned.value, world.x, world.y, HIT_TOLERANCE / clampScale(transform.value.scale))
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  const point = localPoint(event)
  const hit = nodeAt(point.x, point.y)
  if (event.pointerId !== undefined) {
    try {
      canvas.value?.setPointerCapture(event.pointerId)
    } catch {
      // 指针已经抬起（拖动跨窗口）时捕获会失败，忽略即可
    }
  }
  if (hit !== null) {
    const world = screenToWorld(transform.value, point.x, point.y)
    drag = {
      kind: 'node',
      id: hit.id,
      offsetX: world.x - hit.x,
      offsetY: world.y - hit.y,
      startX: point.x,
      startY: point.y,
      moved: false
    }
    return
  }
  drag = {
    kind: 'pan',
    startX: point.x,
    startY: point.y,
    originX: transform.value.x,
    originY: transform.value.y,
    moved: false
  }
}

function onPointerMove(event: PointerEvent): void {
  const point = localPoint(event)
  if (drag === null) {
    const hit = nodeAt(point.x, point.y)
    const next = hit?.id ?? null
    if (next !== hoverId.value) {
      hoverId.value = next
      requestDraw()
    }
    return
  }

  if (drag.kind === 'node') {
    const world = screenToWorld(transform.value, point.x, point.y)
    const next = new Map(positions.value)
    next.set(drag.id, { x: world.x - drag.offsetX, y: world.y - drag.offsetY })
    positions.value = next
    // 只有真的挪过位置才算「拖拽固定」，否则轻点会变成误拖
    if (Math.abs(point.x - drag.startX) > 2 || Math.abs(point.y - drag.startY) > 2) {
      drag.moved = true
      // 手动摆过节点就视为用户接管，窗口变化不再自动适配
      userMoved.value = true
    }
    requestDraw()
    return
  }

  const dx = point.x - drag.startX
  const dy = point.y - drag.startY
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    drag.moved = true
    userMoved.value = true
  }
  transform.value = { ...transform.value, x: drag.originX + dx, y: drag.originY + dy }
  requestDraw()
}

function onPointerUp(event: PointerEvent): void {
  try {
    if (event.pointerId !== undefined) canvas.value?.releasePointerCapture(event.pointerId)
  } catch {
    // 未捕获成功时释放会抛错，忽略
  }
  const current = drag
  drag = null
  if (current === null) return
  if (current.moved) return
  if (current.kind === 'node') {
    selectedId.value = selectedId.value === current.id ? null : current.id
  } else {
    selectedId.value = null
  }
  requestDraw()
}

/** 鼠标离开画布：清掉悬停高亮，否则会一直停在最后一个节点上 */
function onPointerLeave(): void {
  if (drag !== null) return
  if (hoverId.value === null) return
  hoverId.value = null
  requestDraw()
}

function onDoubleClick(event: MouseEvent): void {
  const point = localPoint(event)
  const hit = nodeAt(point.x, point.y)
  if (hit === null) return
  void openNode(hit.id)
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const point = localPoint(event)
  const factor = Math.pow(1.0015, -event.deltaY)
  transform.value = zoomAt(transform.value, factor, point.x, point.y)
  userMoved.value = true
  requestDraw()
}

function zoomBy(factor: number): void {
  const centerX = viewport.value.width / 2
  const centerY = viewport.value.height / 2
  transform.value = zoomAt(transform.value, factor, centerX, centerY)
  userMoved.value = true
  requestDraw()
}

/** 定位：把第一个命中的笔记移到视口中心，保留当前缩放 */
function locate(): void {
  const term = searchTerm.value.trim().toLowerCase()
  if (term === '') {
    searchMiss.value = false
    return
  }
  // 只在当前视图里找：被过滤器藏掉的节点定位过去也看不见
  const candidates = visible.value.nodes
  const match =
    candidates.find((node) => node.label.toLowerCase() === term) ??
    candidates.find((node) => node.label.toLowerCase().includes(term))
  if (match === undefined) {
    searchMiss.value = true
    return
  }
  const point = positions.value.get(match.id)
  if (point === undefined) {
    searchMiss.value = true
    return
  }
  searchMiss.value = false
  selectedId.value = match.id
  const scale = clampScale(transform.value.scale)
  transform.value = {
    scale,
    x: viewport.value.width / 2 - point.x * scale,
    y: viewport.value.height / 2 - point.y * scale
  }
  userMoved.value = true
  requestDraw()
}

async function openNode(id: string): Promise<void> {
  const absPath = knowledge.resolveAbsolute(id)
  if (absPath === null) return
  knowledge.deactivateGraphTab()
  await fileStore.openFile(absPath, { addToRecent: false })
}

async function openSelected(): Promise<void> {
  const node = selectedNode.value
  if (node === null) return
  await openNode(node.id)
}

// ========== 生命周期 ==========

let observer: ResizeObserver | null = null

onMounted(() => {
  if (!knowledge.graphLoaded) void knowledge.loadGraph()

  const element = stage.value
  if (element === null) return
  observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect
    if (box === undefined) return
    const width = Math.max(0, Math.round(box.width))
    const height = Math.max(0, Math.round(box.height))
    if (width === viewport.value.width && height === viewport.value.height) return
    viewport.value = { width, height }
    // 冻结的含义：改窗口大小只改变换矩阵，不重排节点
    if (!userMoved.value) refit()
    requestDraw()
  })
  observer.observe(element)

  if (knowledge.graph.nodes.length > 0 && positions.value.size === 0) scheduleLayout()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (layoutFrame !== 0) cancelAnimationFrame(layoutFrame)
  if (drawFrame !== 0) cancelAnimationFrame(drawFrame)
  layoutFrame = 0
  drawFrame = 0
})

// 图谱数据换了一版才重排；其余情况（缩放/平移/改窗口）复用已有位置
watch(
  () => knowledge.graphVersion,
  () => {
    positions.value = new Map()
    scheduleLayout()
  }
)

watch(
  () => viewport.value,
  () => requestDraw()
)

// 过滤器只改变可见集合，不重排；但画布必须重绘，否则会停在旧画面上
watch(
  () => knowledge.graphFilters,
  () => requestDraw()
)
</script>

<template>
  <section
    class="global-graph"
    data-testid="global-graph"
  >
    <header class="graph-toolbar">
      <span class="graph-title">
        <IconTopologyStar3
          :size="15"
          :stroke-width="1.8"
        />
        全局图谱
      </span>

      <span
        v-if="emptyReason === null"
        class="graph-stats"
        data-testid="graph-stats"
      >{{ stats }}</span>

      <span
        v-if="frozen && layoutMs > 0"
        class="graph-frozen"
        data-testid="graph-frozen"
      >布局已冻结 · {{ layoutMs }}ms</span>

      <span
        v-if="graph.aggregated"
        class="graph-aggregated"
        data-testid="graph-aggregated"
      >已聚合 {{ graph.hiddenCount }} 个节点</span>

      <div class="graph-actions">
        <label class="graph-search">
          <IconSearch
            :size="13"
            :stroke-width="1.8"
          />
          <input
            v-model="searchTerm"
            type="search"
            placeholder="定位笔记"
            data-testid="graph-search"
            @keydown.enter.prevent="locate"
          >
        </label>
        <button
          type="button"
          class="icon-button"
          aria-label="放大"
          data-testid="graph-zoom-in"
          @click="zoomBy(1.25)"
        >
          <IconZoomIn
            :size="15"
            :stroke-width="1.8"
          />
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label="缩小"
          data-testid="graph-zoom-out"
          @click="zoomBy(0.8)"
        >
          <IconZoomOut
            :size="15"
            :stroke-width="1.8"
          />
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label="适配视图"
          data-testid="graph-fit"
          @click="refit(); requestDraw()"
        >
          <IconArrowsMaximize
            :size="15"
            :stroke-width="1.8"
          />
        </button>
        <button
          type="button"
          class="icon-button"
          :class="{ active: filtersOpen }"
          :aria-pressed="filtersOpen"
          aria-label="过滤图谱"
          data-testid="graph-filters-toggle"
          @click="filtersOpen = !filtersOpen"
        >
          <IconAdjustmentsHorizontal
            :size="15"
            :stroke-width="1.8"
          />
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label="重新布局"
          data-testid="graph-relayout"
          @click="relayout"
        >
          <IconRefresh
            :size="15"
            :stroke-width="1.8"
          />
        </button>
      </div>
    </header>

    <div class="graph-body">
      <GraphFilters v-if="filtersOpen" />

      <div
        ref="stage"
        class="graph-stage"
      >
        <canvas
          ref="canvas"
          class="graph-surface"
          data-testid="graph-canvas"
          @pointerdown.prevent="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @pointerleave="onPointerLeave"
          @dblclick="onDoubleClick"
          @wheel="onWheel"
        />

        <p
          v-if="emptyReason !== null"
          class="graph-empty"
          data-testid="graph-empty"
        >
          <IconTopologyStar3
            :size="26"
            :stroke-width="1.3"
          />
          <span>{{ emptyReason }}</span>
        </p>

        <p
          v-else-if="layingOut || (!frozen && positioned.length === 0)"
          class="graph-empty"
          data-testid="graph-laying-out"
        >
          <span>正在计算布局…</span>
        </p>

        <p
          v-if="searchMiss"
          class="graph-search-miss"
          data-testid="graph-search-miss"
        >
          没有找到匹配的笔记
        </p>

        <footer
          v-if="selectedNode !== null"
          class="graph-selection"
          data-testid="graph-selected"
        >
          <span class="selection-name">{{ selectedNode.label }}</span>
          <span class="selection-meta">{{ selectedNode.kind }} · 度数 {{ selectedNode.degree }}</span>
          <button
            v-if="selectedOpenable"
            type="button"
            class="selection-open"
            data-testid="graph-open-selected"
            @click="openSelected"
          >
            打开笔记
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
.global-graph {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-primary);
}

.graph-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.graph-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--color-text);
  font-weight: 500;
}

.graph-stats,
.graph-frozen {
  color: var(--color-text-tertiary);
}

.graph-frozen {
  padding-left: 10px;
  border-left: 1px solid var(--color-border);
  font-variant-numeric: tabular-nums;
}

.graph-aggregated {
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
}

.graph-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.graph-search {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text-tertiary);
}

.graph-search input {
  width: 120px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-size: inherit;
}

.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

.icon-button:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.icon-button.active {
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  color: var(--color-primary);
}

.graph-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.graph-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.graph-surface {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

.graph-surface:active {
  cursor: grabbing;
}

.graph-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 0;
  padding: 0 24px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
  line-height: 1.6;
  text-align: center;
  pointer-events: none;
}

.graph-search-miss {
  position: absolute;
  top: 10px;
  left: 50%;
  margin: 0;
  padding: 4px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-bg-secondary) 92%, transparent);
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
  transform: translateX(-50%);
}

.graph-selection {
  position: absolute;
  bottom: 12px;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-bg-secondary) 94%, transparent);
  box-shadow: 0 4px 14px color-mix(in srgb, #000 12%, transparent);
  font-size: calc(var(--ui-font-size) - 2px);
  transform: translateX(-50%);
  backdrop-filter: blur(6px);
}

.selection-name {
  max-width: 320px;
  overflow: hidden;
  color: var(--color-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selection-meta {
  color: var(--color-text-tertiary);
}

.selection-open {
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 45%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
  font-size: inherit;
  cursor: pointer;
}

.selection-open:hover {
  background: color-mix(in srgb, var(--color-primary) 20%, transparent);
}
</style>
