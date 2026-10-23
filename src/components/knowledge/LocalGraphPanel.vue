<script setup lang="ts">
/**
 * 局部图谱（SVG）
 *
 * 与当前笔记联动：以当前笔记为种子，沿六层边双向取 1–3 跳的邻居。
 * 切换笔记时**只在本地的图缓存上重新聚焦**，不重新构建索引、也不重新拉整库图，
 * 所以翻笔记时不会卡。
 *
 * 渲染取舍：局部图谱最多 300 个节点，按度数截断（保留中心节点），
 * 标签只在中心、悬停邻居与高度数节点上显示——面板很窄，全显示等于全看不清。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { IconArrowsMaximize, IconRefresh, IconTopologyStar3 } from '@tabler/icons-vue'
import {
  MAX_FOCUS_DEPTH,
  MIN_FOCUS_DEPTH,
  focusSubgraph,
  isStructuralNode,
  type GraphEdge,
  type GraphNode
} from '../../../shared/knowledge/graph'
import { layoutNetwork } from '../../utils/graph-layout'
import { useFileStore } from '../../stores/file'
import { useKnowledgeStore } from '../../stores/knowledge'

const fileStore = useFileStore()
const knowledge = useKnowledgeStore()

/** 局部图谱的节点上限（设计文档 §5.6：邻居 ≤ 300） */
const MAX_LOCAL_NODES = 300

const MIN_RADIUS = 3.5
const MAX_RADIUS = 11

/** 画布尺寸量化步长：拖拽停靠区宽度时避免每一像素都重算布局 */
const SIZE_STEP = 32

const container = ref<HTMLElement | null>(null)
const size = ref({ width: 320, height: 420 })
const depth = ref(2)
const hoveredId = ref<string | null>(null)

/** 按当前笔记聚焦出的子图 */
const focused = computed(() => {
  const seed = knowledge.activeRelPath
  if (seed === null) return null
  const base = knowledge.graph
  if (!base.nodes.some((node) => node.id === seed)) return null
  return focusSubgraph(base, seed, depth.value)
})

/** 节点数超限时按度数截断，中心节点必留 */
const clamped = computed(() => {
  const graph = focused.value
  if (graph === null) return null
  if (graph.nodes.length <= MAX_LOCAL_NODES) return graph

  const center = knowledge.activeRelPath
  const ranked = [...graph.nodes].sort((a, b) => {
    if (a.id === center) return -1
    if (b.id === center) return 1
    if (a.degree !== b.degree) return b.degree - a.degree
    return a.id.localeCompare(b.id)
  })
  const kept = new Set(ranked.slice(0, MAX_LOCAL_NODES).map((node) => node.id))
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => kept.has(node.id)),
    edges: graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to))
  }
})

/** 稳定种子：同一篇笔记每次打开形状一致，不同笔记形状不同 */
function hashSeed(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const layout = computed(() => {
  const graph = clamped.value
  if (graph === null) return new Map<string, { x: number; y: number }>()
  return layoutNetwork(
    graph.nodes.map((node) => ({ id: node.id })),
    graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    {
      width: size.value.width,
      height: size.value.height,
      seed: hashSeed(knowledge.activeRelPath ?? '')
    }
  )
})

/** 悬停节点及其邻居（悬停时其余节点淡出） */
const focusSet = computed<ReadonlySet<string> | null>(() => {
  const hovered = hoveredId.value
  if (hovered === null) return null
  const graph = clamped.value
  const set = new Set<string>([hovered])
  if (graph !== null) {
    for (const edge of graph.edges) {
      if (edge.from === hovered) set.add(edge.to)
      if (edge.to === hovered) set.add(edge.from)
    }
  }
  return set
})

/** 颜色按顶层目录取色；同一目录下的笔记同色，便于肉眼聚类 */
function colorFor(node: GraphNode): string {
  if (node.kind === 'tag') return 'var(--color-text-tertiary)'
  if (node.kind === 'cluster') return 'var(--color-border)'
  if (node.isolated) return 'var(--color-text-tertiary)'
  const folder = node.folder === '' ? '根目录' : node.folder
  let hash = 0
  for (let index = 0; index < folder.length; index++) {
    hash = (hash * 31 + folder.charCodeAt(index)) % 360
  }
  return `hsl(${hash} 62% 52%)`
}

function radiusFor(node: GraphNode, maxDegree: number): number {
  if (maxDegree <= 0) return MIN_RADIUS + 1.5
  const ratio = Math.sqrt(node.degree / maxDegree)
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * ratio
}

interface ViewNode {
  id: string
  label: string
  kind: GraphNode['kind']
  x: number
  y: number
  radius: number
  color: string
  isCenter: boolean
  dimmed: boolean
  showLabel: boolean
}

interface ViewEdge {
  key: string
  from: string
  to: string
  layer: GraphEdge['layer']
  x1: number
  y1: number
  x2: number
  y2: number
}

const viewNodes = computed<ViewNode[]>(() => {
  const graph = clamped.value
  if (graph === null) return []
  const center = knowledge.activeRelPath
  const maxDegree = graph.nodes.reduce((max, node) => Math.max(max, node.degree), 0)
  const focus = focusSet.value

  return graph.nodes.map((node) => {
    const point = layout.value.get(node.id) ?? { x: 0, y: 0 }
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      x: point.x,
      y: point.y,
      radius: radiusFor(node, maxDegree),
      color: colorFor(node),
      isCenter: node.id === center,
      dimmed: focus !== null && !focus.has(node.id),
      showLabel: node.id === center || (focus !== null && focus.has(node.id)) || node.degree >= 5
    }
  })
})

const viewEdges = computed<ViewEdge[]>(() => {
  const graph = clamped.value
  if (graph === null) return []

  return graph.edges.flatMap((edge, index) => {
    const from = layout.value.get(edge.from)
    const to = layout.value.get(edge.to)
    if (from === undefined || to === undefined) return []
    return [
      {
        key: `${edge.from}\u0000${edge.to}\u0000${edge.layer}\u0000${index}`,
        from: edge.from,
        to: edge.to,
        layer: edge.layer,
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y
      }
    ]
  })
})

/** 边是否应该淡出（悬停时只保留与悬停节点相连的边） */
function edgeDimmed(edge: ViewEdge): boolean {
  const hovered = hoveredId.value
  if (hovered === null) return false
  return edge.from !== hovered && edge.to !== hovered
}

const summary = computed(() => {
  const graph = clamped.value
  if (graph === null) return ''
  return `${graph.nodes.length} 节点 · ${graph.edges.length} 边`
})

const emptyReason = computed<string | null>(() => {
  if (knowledge.degraded) return '索引不可用，图谱暂不可用'
  if (knowledge.activeRelPath === null) return '打开一篇笔记后，这里显示它与其它笔记的关系'
  if (knowledge.graph.nodes.length === 0) return '还没有可绘制的图谱，先给笔记建立链接'
  if (focused.value === null) return '这篇笔记尚未进入索引'
  return null
})

async function open(node: ViewNode): Promise<void> {
  if (isStructuralNode({ ...node, folder: '', degree: 0, isolated: false })) return
  if (node.id === knowledge.activeRelPath) return
  const absPath = knowledge.resolveAbsolute(node.id)
  if (absPath === null) return
  await fileStore.openFile(absPath, { addToRecent: false })
}

function clampDepth(value: number): void {
  depth.value = Math.min(MAX_FOCUS_DEPTH, Math.max(MIN_FOCUS_DEPTH, value))
}

async function refresh(): Promise<void> {
  await knowledge.loadGraph()
}

let observer: ResizeObserver | null = null

onMounted(() => {
  if (!knowledge.graphLoaded) void knowledge.loadGraph()

  const element = container.value
  if (element === null) return
  observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect
    if (box === undefined) return
    // 量化尺寸，避免拖拽停靠区宽度时连续重算布局
    const width = Math.max(SIZE_STEP, Math.round(box.width / SIZE_STEP) * SIZE_STEP)
    const height = Math.max(SIZE_STEP, Math.round(box.height / SIZE_STEP) * SIZE_STEP)
    if (width !== size.value.width || height !== size.value.height) {
      size.value = { width, height }
    }
  })
  observer.observe(element)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <section
    class="local-graph"
    data-testid="local-graph"
  >
    <header class="graph-header">
      <div class="graph-controls">
        <span class="graph-label">跳数</span>
        <button
          v-for="hop in [1, 2, 3]"
          :key="hop"
          type="button"
          class="depth-button"
          :class="{ active: depth === hop }"
          :data-testid="`graph-depth-${hop}`"
          @click="clampDepth(hop)"
        >
          {{ hop }}
        </button>
      </div>
      <div class="graph-actions">
        <button
          type="button"
          class="graph-expand"
          aria-label="打开全局图谱"
          data-testid="graph-expand"
          @click="knowledge.openGraphTab()"
        >
          <IconArrowsMaximize
            :size="14"
            :stroke-width="1.8"
          />
        </button>
        <button
          type="button"
          class="graph-refresh"
          :class="{ spinning: knowledge.graphLoading }"
          aria-label="刷新图谱"
          data-testid="graph-refresh"
          @click="refresh"
        >
          <IconRefresh
            :size="14"
            :stroke-width="1.8"
          />
        </button>
      </div>
    </header>

    <div
      ref="container"
      class="graph-canvas-wrap"
    >
      <p
        v-if="emptyReason !== null"
        class="graph-empty"
        data-testid="graph-empty"
      >
        <IconTopologyStar3
          :size="22"
          :stroke-width="1.4"
        />
        <span>{{ emptyReason }}</span>
      </p>

      <svg
        v-else
        class="graph-canvas"
        :viewBox="`0 0 ${size.width} ${size.height}`"
        role="img"
        aria-label="局部图谱"
        data-testid="graph-svg"
        @mouseleave="hoveredId = null"
      >
        <g class="graph-edges">
          <line
            v-for="edge in viewEdges"
            :key="edge.key"
            :x1="edge.x1"
            :y1="edge.y1"
            :x2="edge.x2"
            :y2="edge.y2"
            :class="['graph-edge', `graph-edge-${edge.layer}`, { dimmed: edgeDimmed(edge) }]"
          />
        </g>

        <g class="graph-nodes">
          <g
            v-for="node in viewNodes"
            :key="node.id"
            class="graph-node"
            :class="{ dimmed: node.dimmed, center: node.isCenter }"
            :data-graph-node="node.id"
            @mouseenter="hoveredId = node.id"
            @click="open(node)"
          >
            <circle
              v-if="node.kind !== 'tag' && node.kind !== 'cluster'"
              :cx="node.x"
              :cy="node.y"
              :r="node.radius"
              :fill="node.color"
            />
            <rect
              v-else-if="node.kind === 'tag'"
              :x="node.x - node.radius"
              :y="node.y - node.radius"
              :width="node.radius * 2"
              :height="node.radius * 2"
              :transform="`rotate(45 ${node.x} ${node.y})`"
              :fill="node.color"
            />
            <rect
              v-else
              :x="node.x - node.radius"
              :y="node.y - node.radius * 0.7"
              :width="node.radius * 2"
              :height="node.radius * 1.4"
              rx="2.5"
              :fill="node.color"
            />
            <circle
              v-if="node.isCenter"
              class="center-ring"
              :cx="node.x"
              :cy="node.y"
              :r="node.radius + 3.5"
            />
            <text
              v-if="node.showLabel"
              class="graph-node-label"
              :x="node.x"
              :y="node.y - node.radius - 4"
              text-anchor="middle"
            >{{ node.label.length > 16 ? `${node.label.slice(0, 16)}…` : node.label }}</text>
          </g>
        </g>
      </svg>
    </div>

    <footer
      v-if="emptyReason === null"
      class="graph-footer"
    >
      <span data-testid="graph-summary">{{ summary }}</span>
      <span
        v-if="knowledge.graph.aggregated"
        class="graph-aggregated"
        data-testid="graph-aggregated"
      >
        已聚合 {{ knowledge.graph.hiddenCount }} 个节点
      </span>
    </footer>
  </section>
</template>

<style scoped>
.local-graph {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.graph-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
}

.graph-controls {
  display: flex;
  align-items: center;
  gap: 2px;
}

.graph-label {
  margin-right: 2px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
}

.depth-button {
  min-width: 22px;
  height: 22px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
  cursor: pointer;
}

.depth-button:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.depth-button.active {
  border-color: color-mix(in srgb, var(--color-primary) 45%, transparent);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
}

.graph-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.graph-expand,
.graph-refresh {
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

.graph-expand:hover,
.graph-refresh:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.graph-refresh.spinning svg {
  animation: graph-spin 900ms linear infinite;
}

@keyframes graph-spin {
  to {
    transform: rotate(360deg);
  }
}

.graph-canvas-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.graph-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.graph-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  margin: 0;
  padding: 0 18px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
  line-height: 1.5;
  text-align: center;
}

.graph-edge {
  stroke: color-mix(in srgb, var(--color-text-tertiary) 55%, transparent);
  stroke-width: 1;
}

/* 边类型在视觉上可区分（设计文档 §5.6） */
.graph-edge-resource {
  stroke: color-mix(in srgb, var(--color-primary) 45%, transparent);
}

.graph-edge-tag {
  stroke: color-mix(in srgb, var(--color-text-tertiary) 35%, transparent);
  stroke-dasharray: 2 3;
}

.graph-edge-relation {
  stroke: color-mix(in srgb, var(--color-primary) 65%, transparent);
  stroke-width: 1.4;
}

.graph-edge-mention {
  stroke-dasharray: 4 3;
  opacity: 0.75;
}

.graph-edge.dimmed {
  opacity: 0.12;
}

.graph-node {
  cursor: pointer;
}

.graph-node.dimmed {
  opacity: 0.18;
}

.graph-node.center circle:first-child {
  stroke: var(--color-primary);
  stroke-width: 1.5;
}

.graph-node.dimmed,
.graph-edge.dimmed {
  transition: opacity 120ms ease;
}

.node-isolated {
  stroke-dasharray: 2 2;
}

.center-ring {
  fill: none;
  stroke: color-mix(in srgb, var(--color-primary) 70%, transparent);
  stroke-width: 1;
  stroke-dasharray: 3 2;
}

.graph-node-label {
  fill: var(--color-text-secondary);
  font-size: 10px;
  pointer-events: none;
  paint-order: stroke;
  stroke: var(--color-bg-primary);
  stroke-width: 2.5px;
  stroke-linejoin: round;
}

.graph-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
}

.graph-aggregated {
  margin-left: auto;
  color: #d97706;
}
</style>
