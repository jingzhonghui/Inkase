<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { GraphEdge, GraphNode } from '../../../shared/graph/types'
import { useGraphStore } from '../../stores/graph'
import { useThemeStore } from '../../stores/theme'
import { useFileStore } from '../../stores/file'
import { themedCursor } from '../../utils/cursor'
import { nodeRadius, renderGraph } from '../../utils/graph/render'
import { createSimulation, type GraphSimulation } from '../../utils/graph/simulation'
import {
  IDENTITY_TRANSFORM,
  boundsOf,
  centerOn,
  fitToBounds,
  hitTest,
  screenToWorld,
  zoomAt,
  type ViewportTransform
} from '../../utils/graph/viewport'

/**
 * 图谱画布。
 *
 * 职责边界：这个组件只管「把世界坐标画到屏幕上」与「把鼠标事件换算成世界坐标」。
 * 数据、过滤、选中状态都在 store 里，因此换任何一块视图都不影响索引逻辑。
 *
 * 两条性能纪律：
 * 1. 过滤只改渲染集合，**不重建仿真**——否则每次点 chip 图都会重排，头晕；
 * 2. `alpha < 0.001` 后停掉 rAF，静止不耗电。
 */

const emit = defineEmits<{
  (event: 'node-context', nodeId: string, position: { x: number; y: number }): void
  (event: 'canvas-context', position: { x: number; y: number }): void
}>()

const graphStore = useGraphStore()
const themeStore = useThemeStore()
const fileStore = useFileStore()

const containerRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)

const width = ref(0)
const height = ref(0)
const transform = ref<ViewportTransform>({ ...IDENTITY_TRANSFORM })

const simulation = shallowRef<GraphSimulation | null>(null)
let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null
/** 首次拿到数据时自动「适应内容」，之后不再打扰用户的视口 */
let pendingFit = true
/**
 * 布局稳定后还要再对齐一次。
 *
 * 首帧适配发生在仿真刚开始时——那一刻节点还挤在初始种子上，包围盒很小；
 * 等它们铺开（往往一两百帧之后），整簇的中心早就偏了。
 * 所以「首帧对齐」只负责别让画面空着，「稳定后再对齐」才负责真正居中。
 */
let settledFitPending = false
/**
 * 用户动过视口（滚轮、拖拽、缩放按钮、定位到某点）之后，自动适配一律停止。
 * 否则布局收敛时那一次「补对齐」会把人正在看的地方甩走。
 */
let userTouchedView = false

// ===== 光标 =====
// 原生 grab/grabbing 是白色手形位图，浅色主题画布上几乎看不见；这里换成按主题配色
// 的自绘 SVG 光标（见 utils/cursor.ts），并保留 crosshair 作为兜底关键字。
const cursorVars = computed(() => ({
  '--graph-cursor': themedCursor(themeStore.isDark, 'crosshair'),
  '--graph-cursor-active': themedCursor(themeStore.isDark, 'crosshair', true)
}))

// ===== 仿真用的节点集合 =====
// 全局模式下过滤不改这个集合（所以不重排）；局部模式下它随中心/深度变化
function baseNodes(): GraphNode[] {
  const payload = graphStore.effectivePayload
  if (!payload) return []
  if (graphStore.mode === 'local') {
    const ids = graphStore.localResult?.nodeIds
    if (!ids) return []
    return payload.nodes.filter((node) => ids.has(node.id))
  }
  return payload.nodes
}

function baseEdges(): GraphEdge[] {
  const payload = graphStore.effectivePayload
  if (!payload) return []
  const ids = new Set(baseNodes().map((node) => node.id))
  return payload.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
}

function simulationSignature(): string {
  return baseNodes()
    .map((node) => node.id)
    .join('\u0000')
}

let lastSignature = ''

function rebuildSimulation(): void {
  const nodes = baseNodes()
  const previous = new Map<string, { x: number; y: number }>()
  const current = simulation.value
  if (current) {
    for (const [id, position] of current.positions) {
      previous.set(id, { x: position.x, y: position.y })
    }
  }
  simulation.value?.stop()

  if (nodes.length === 0) {
    simulation.value = null
    lastSignature = ''
    draw()
    return
  }

  // 已有的旧坐标一律沿用：重建后只有新增节点需要播种，图不会「跳一下」
  simulation.value = createSimulation({
    nodes: nodes.map((node) => ({ id: node.id, radius: nodeRadius(node) })),
    links: baseEdges().map((edge) => ({
      source: edge.source,
      target: edge.target,
      count: edge.count
    })),
    previousPositions: previous
  })

  lastSignature = simulationSignature()
  startLoop()
}

// ===== 绘制循环 =====
function draw(): void {
  const canvas = canvasRef.value
  const sim = simulation.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const targetWidth = Math.max(1, Math.round(width.value * dpr))
  const targetHeight = Math.max(1, Math.round(height.value * dpr))
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth
    canvas.height = targetHeight
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  if (!sim) {
    ctx.clearRect(0, 0, width.value, height.value)
    return
  }

  const visible = graphStore.visibleNodes
  const labelBudget = visible.length <= 800

  renderGraph({
    ctx,
    width: width.value,
    height: height.value,
    transform: transform.value,
    nodes: visible,
    edges: graphStore.visibleEdges,
    positions: sim.positions,
    theme: themeStore.isDark ? 'dark' : 'light',
    highlightIds: graphStore.highlightIds,
    selectedId: graphStore.selectedId,
    searchMatches: graphStore.searchMatches,
    showLabels: labelBudget,
    // hover 优先于选中：鼠标停在哪就把哪一簇点亮
    focusId: graphStore.hoveredId ?? graphStore.selectedId
  })
}

function step(): void {
  rafId = null
  const sim = simulation.value
  if (!sim) return

  const running = sim.tick()
  // 首帧对齐：尺寸已知才消费 pendingFit。挂在隐藏分段里时 clientWidth 是 0，
  // 那一刻适配是算不出结果的——早年的写法会在这里把标志吃掉，
  // 结果切到图谱时画布停在单位变换上，图看起来贴在左上角。
  if (pendingFit && width.value > 0 && height.value > 0) {
    pendingFit = false
    autoFit()
  } else if (!running && settledFitPending && !userTouchedView && width.value > 0 && height.value > 0) {
    // 布局收敛后的补对齐：这才是「居中」真正生效的那一次
    settledFitPending = false
    autoFit()
  }
  draw()
  if (running) rafId = requestAnimationFrame(step)
}

function startLoop(): void {
  if (rafId !== null) return
  rafId = requestAnimationFrame(step)
}

/** 重新加热并继续跑（拖拽、重建之后） */
function reheat(alpha = 0.6): void {
  simulation.value?.reheat(alpha)
  startLoop()
}

// ===== 视口 =====
function fitContent(): void {
  const sim = simulation.value
  if (!sim || width.value === 0 || height.value === 0) return
  transform.value = fitToBounds(boundsOf(sim.positions.values()), width.value, height.value)
  pendingFit = false
  settledFitPending = false
  draw()
}

/** 内部自动对齐用：不改「用户是否动过」的语义 */
function autoFit(): void {
  const sim = simulation.value
  if (!sim || width.value === 0 || height.value === 0) return
  transform.value = fitToBounds(boundsOf(sim.positions.values()), width.value, height.value)
  draw()
}

function centerOnNode(id: string | null): void {
  const sim = simulation.value
  if (!id || !sim) return
  const position = sim.positions.get(id)
  if (!position) return
  userTouchedView = true
  transform.value = centerOn(transform.value, position, width.value, height.value)
  draw()
}

function zoomBy(factor: number): void {
  userTouchedView = true
  transform.value = zoomAt(transform.value, factor, {
    x: width.value / 2,
    y: height.value / 2
  })
  draw()
}

// ===== 指针交互 =====
interface PointerState {
  mode: 'none' | 'pan' | 'drag-node'
  startClientX: number
  startClientY: number
  lastClientX: number
  lastClientY: number
  nodeId: string | null
  /** 拖动节点时的偏移（避免节点跳到手心） */
  offsetX: number
  offsetY: number
}

let pointer: PointerState = {
  mode: 'none',
  startClientX: 0,
  startClientY: 0,
  lastClientX: 0,
  lastClientY: 0,
  nodeId: null,
  offsetX: 0,
  offsetY: 0
}

function localPoint(event: MouseEvent): { x: number; y: number } {
  const canvas = canvasRef.value
  if (!canvas) return { x: 0, y: 0 }
  const rect = canvas.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function hitAt(screenPoint: { x: number; y: number }): string | null {
  const sim = simulation.value
  if (!sim) return null
  const world = screenToWorld(transform.value, screenPoint)
  const candidates = graphStore.visibleNodes
    .map((node) => {
      const position = sim.positions.get(node.id)
      return position
        ? { id: node.id, x: position.x, y: position.y, radius: nodeRadius(node) }
        : null
    })
    .filter((item): item is { id: string; x: number; y: number; radius: number } => item !== null)

  // 缩小时命中范围按世界坐标放大，否则小图上根本点不中
  return hitTest(candidates, world, 3 / Math.max(0.2, transform.value.k))
}

function onMouseDown(event: MouseEvent): void {
  if (event.button !== 0) return
  const point = localPoint(event)
  const hitId = hitAt(point)

  pointer.startClientX = event.clientX
  pointer.startClientY = event.clientY
  pointer.lastClientX = event.clientX
  pointer.lastClientY = event.clientY
  pointer.nodeId = hitId

  if (hitId) {
    const sim = simulation.value
    const position = sim?.positions.get(hitId)
    const world = screenToWorld(transform.value, point)
    pointer.mode = 'drag-node'
    pointer.offsetX = position ? position.x - world.x : 0
    pointer.offsetY = position ? position.y - world.y : 0
    graphStore.selectNode(hitId)
    draw()
    return
  }

  pointer.mode = 'pan'
  graphStore.selectNode(null)
  draw()
}

function onMouseMove(event: MouseEvent): void {
  const point = localPoint(event)

  if (pointer.mode === 'pan') {
    const dx = event.clientX - pointer.lastClientX
    const dy = event.clientY - pointer.lastClientY
    pointer.lastClientX = event.clientX
    pointer.lastClientY = event.clientY
    // 真的挪了才算「用户接管了视口」。只按下不移动（加载中误点一下）
    // 不该取消之后那次居中——那正是首屏最容易发生的事。
    if (dx !== 0 || dy !== 0) userTouchedView = true
    transform.value = { ...transform.value, x: transform.value.x + dx, y: transform.value.y + dy }
    draw()
    return
  }

  if (pointer.mode === 'drag-node' && pointer.nodeId) {
    userTouchedView = true
    pointer.lastClientX = event.clientX
    pointer.lastClientY = event.clientY
    const world = screenToWorld(transform.value, point)
    simulation.value?.pin(
      pointer.nodeId,
      world.x + pointer.offsetX,
      world.y + pointer.offsetY
    )
    // 拖动期间持续按小 alpha 加热：钉住的节点会走，邻居必须跟着重新舒展，
    // 否则拖完一整张图只有那一个点动了，看上去像「卡住了」
    reheat(0.2)
    return
  }

  const hitId = hitAt(point)
  if (hitId !== graphStore.hoveredId) {
    graphStore.setHovered(hitId)
    draw()
  }
}

function onMouseUp(): void {
  if (pointer.mode === 'pan' && pointer.nodeId === null) {
    const moved =
      Math.abs(pointer.lastClientX - pointer.startClientX) > 3 ||
      Math.abs(pointer.lastClientY - pointer.startClientY) > 3
    if (moved) graphStore.selectNode(null)
  }
  pointer.mode = 'none'
  pointer.nodeId = null
}

function onMouseLeave(): void {
  if (graphStore.hoveredId) {
    graphStore.setHovered(null)
    draw()
  }
  pointer.mode = 'none'
  pointer.nodeId = null
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  userTouchedView = true
  const point = localPoint(event)
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
  transform.value = zoomAt(transform.value, factor, point)
  draw()
}

function onDblClick(event: MouseEvent): void {
  const point = localPoint(event)
  const hitId = hitAt(point)

  if (!hitId) {
    fitContent()
    return
  }

  // 双击同时「释放钉住」与「打开文件」：拖过的节点需要一条退路（设计 §4.2）。
  // 释放后必须重新加热，否则节点停在钉子位置、图也不会再舒展回来。
  simulation.value?.release(hitId)
  reheat(0.35)

  const node = graphStore.payload?.nodes.find((item) => item.id === hitId)
  if (node?.path) {
    void fileStore.openFile(graphStore.joinRoot(node.path))
  }
}

function onContextMenu(event: MouseEvent): void {
  const point = localPoint(event)
  const hitId = hitAt(point)
  if (hitId) emit('node-context', hitId, point)
  else emit('canvas-context', point)
}

// ===== 尺寸 =====
function measure(): void {
  const element = containerRef.value
  if (!element) return
  const nextWidth = element.clientWidth
  const nextHeight = element.clientHeight
  const wasEmpty = width.value === 0 || height.value === 0
  const deltaX = (nextWidth - width.value) / 2
  const deltaY = (nextHeight - height.value) / 2
  width.value = nextWidth
  height.value = nextHeight

  // 尺寸从无到有：第一次真正能对准的时机（组件挂在隐藏的分段里、
  // 或窗口从最小化恢复）。只消费「尽快对齐」，「稳定后再对齐」必须留着——
  // 此刻布局通常还在铺开，清掉它就会把图定格在中间态上。
  if (wasEmpty && nextWidth > 0 && nextHeight > 0 && (pendingFit || settledFitPending)) {
    pendingFit = false
    autoFit()
    draw()
    return
  }

  // 尺寸变了但不是从无到有：视口整体补偿差值的一半，内容中心原地不动。
  // 不做这件事的话，适配时量到的高度和最终高度不一致，图会永久偏半个差值——
  // 首屏最容易遇上（顶条、侧栏、字体都在挂载后才把高度顶开）。
  if (deltaX !== 0 || deltaY !== 0) {
    transform.value = {
      ...transform.value,
      x: transform.value.x + deltaX,
      y: transform.value.y + deltaY
    }
  }
  draw()
}

onMounted(() => {
  measure()
  resizeObserver = new ResizeObserver(() => measure())
  if (containerRef.value) resizeObserver.observe(containerRef.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  simulation.value?.stop()
  simulation.value = null
})

// 数据或模式变化 → 节点集合变了就重建，否则只重绘
watch(
  () => [graphStore.effectivePayload, graphStore.mode, graphStore.localResult] as const,
  () => {
    if (simulationSignature() === lastSignature) {
      draw()
      return
    }
    pendingFit = true
    // 布局要重新跑一遍，收敛后还得再对一次才算居中
    settledFitPending = true
    rebuildSimulation()
  }
)

// 过滤 / 高亮变化 → 只重绘，绝不重排
watch(
  () => [
    graphStore.visibleNodes,
    graphStore.visibleEdges,
    graphStore.highlightIds,
    graphStore.selectedId,
    graphStore.searchMatches
  ] as const,
  () => draw()
)

watch(
  () => themeStore.isDark,
  () => draw()
)

// 首次挂载时若数据已经在，直接建一次仿真。
// 这条路径同样要预约「稳定后再对齐」：挂载瞬间节点还落在种子上，
// 只做首帧适配的话，簇会在铺开之后偏离中心。
if (graphStore.effectivePayload) {
  settledFitPending = true
  rebuildSimulation()
}

defineExpose({
  fitContent,
  zoomBy,
  centerOnNode
})
</script>

<template>
  <div
    ref="containerRef"
    class="graph-canvas"
  >
    <canvas
      ref="canvasRef"
      class="graph-canvas__surface"
      :style="cursorVars"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseLeave"
      @wheel="onWheel"
      @dblclick="onDblClick"
      @contextmenu.prevent="onContextMenu"
    />

    <div class="graph-canvas__zoom">
      <button
        title="放大"
        @click="zoomBy(1.25)"
      >
        +
      </button>
      <button
        title="缩小"
        @click="zoomBy(1 / 1.25)"
      >
        −
      </button>
      <button
        title="适应内容"
        @click="fitContent"
      >
        ⤢
      </button>
    </div>
  </div>
</template>

<style scoped>
.graph-canvas {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background-color: var(--color-bg-primary);
}

.graph-canvas__surface {
  display: block;
  width: 100%;
  height: 100%;
  /* 自绘光标按主题取色；万一平台不认 SVG 光标，回退到原生 crosshair（黑白双色，任何底色可见） */
  cursor: var(--graph-cursor, crosshair);
}

.graph-canvas__surface:active {
  cursor: var(--graph-cursor-active, crosshair);
}

.graph-canvas__zoom {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.graph-canvas__zoom button {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-bg-secondary) 88%, transparent);
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s;
  backdrop-filter: blur(4px);
}

.graph-canvas__zoom button:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
</style>
