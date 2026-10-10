<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import Tooltip from '../common/Tooltip.vue'
import { useFileStore } from '../../stores/file'

const fileStore = useFileStore()

const activeTab = computed(() => fileStore.activeTab)
const imageDataUrl = computed(() => activeTab.value?.imageDataUrl ?? '')
const fileName = computed(() => activeTab.value?.fileInfo?.name ?? '')
const loadError = ref(false)
const naturalSize = ref<{ w: number; h: number } | null>(null)
const containerSize = ref<{ w: number; h: number } | null>(null)
const zoom = ref(1)

const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const ZOOM_STEP = 0.25
const STAGE_PADDING = 24

/** 适应窗口的缩放比例：100% = 图片完整显示在窗口内的最大尺寸 */
const fitRatio = computed(() => {
  const base = naturalSize.value
  const box = containerSize.value
  if (!base || !box || base.w === 0 || base.h === 0) return 1
  const availableW = Math.max(1, box.w - STAGE_PADDING * 2)
  const availableH = Math.max(1, box.h - STAGE_PADDING * 2)
  return Math.min(availableW / base.w, availableH / base.h, 1)
})

const imageStyle = computed(() => {
  const base = naturalSize.value
  if (!base) return {}
  const ratio = fitRatio.value
  const width = Math.max(1, Math.round(base.w * ratio * zoom.value))
  const height = Math.max(1, Math.round(base.h * ratio * zoom.value))
  return {
    width: `${width}px`,
    height: `${height}px`,
    maxWidth: 'none',
    maxHeight: 'none'
  }
})

const stageContentStyle = computed(() => {
  const base = naturalSize.value
  const box = containerSize.value
  if (!base || !box) return {}

  const ratio = fitRatio.value
  const imageWidth = Math.max(1, Math.round(base.w * ratio * zoom.value))
  const imageHeight = Math.max(1, Math.round(base.h * ratio * zoom.value))
  return {
    width: `${Math.max(box.w, imageWidth + STAGE_PADDING * 2)}px`,
    height: `${Math.max(box.h, imageHeight + STAGE_PADDING * 2)}px`
  }
})

const zoomPercent = computed(() => `${Math.round(zoom.value * 100)}%`)

const stageRef = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null

// 放大模式下拖拽平移
const isPanning = ref(false)
let panStartX = 0
let panStartY = 0
let panScrollLeft = 0
let panScrollTop = 0

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +(value).toFixed(2)))
}

function measureContainer(): void {
  const el = stageRef.value
  if (!el) return
  containerSize.value = { w: el.clientWidth, h: el.clientHeight }
}

function onLoad(event: Event): void {
  const img = event.target as HTMLImageElement
  naturalSize.value = { w: img.naturalWidth, h: img.naturalHeight }
}

function onError(): void {
  loadError.value = true
}

function zoomIn(): void {
  zoom.value = clampZoom(zoom.value + ZOOM_STEP)
  void centerStage()
}

function zoomOut(): void {
  zoom.value = clampZoom(zoom.value - ZOOM_STEP)
  void centerStage()
}

function resetZoom(): void {
  zoom.value = 1
  void centerStage()
}

async function centerStage(): Promise<void> {
  await nextTick()
  const el = stageRef.value
  if (!el) return
  el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2)
  el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2)
}

function onStageWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return
  event.preventDefault()
  zoom.value = clampZoom(zoom.value + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))
  void centerStage()
}

/** 放大模式下按住左键拖动移动图片；非放大模式不做处理 */
function onStagePointerDown(event: PointerEvent): void {
  if (zoom.value <= 1) return
  if (event.button !== 0) return
  const el = stageRef.value
  if (!el) return
  isPanning.value = true
  panStartX = event.clientX
  panStartY = event.clientY
  panScrollLeft = el.scrollLeft
  panScrollTop = el.scrollTop
  el.setPointerCapture(event.pointerId)
}

function onStagePointerMove(event: PointerEvent): void {
  if (!isPanning.value) return
  const el = stageRef.value
  if (!el) return
  el.scrollLeft = panScrollLeft - (event.clientX - panStartX)
  el.scrollTop = panScrollTop - (event.clientY - panStartY)
}

function onStagePointerUp(event: PointerEvent): void {
  if (!isPanning.value) return
  isPanning.value = false
  const el = stageRef.value
  if (el?.hasPointerCapture(event.pointerId)) {
    el.releasePointerCapture(event.pointerId)
  }
}

onMounted(() => {
  stageRef.value?.addEventListener('wheel', onStageWheel, { passive: false })
  resizeObserver = new ResizeObserver(measureContainer)
  if (stageRef.value) resizeObserver.observe(stageRef.value)
  measureContainer()
})

onUnmounted(() => {
  stageRef.value?.removeEventListener('wheel', onStageWheel)
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div class="image-viewer">
    <div
      v-if="loadError"
      class="image-error"
    >
      无法加载图片
    </div>
    <div
      v-else
      ref="stageRef"
      class="image-stage"
      :class="{ 'is-panning': isPanning }"
      @pointerdown="onStagePointerDown"
      @pointermove="onStagePointerMove"
      @pointerup="onStagePointerUp"
      @pointercancel="onStagePointerUp"
    >
      <div
        v-if="imageDataUrl"
        class="image-stage-content"
        :style="stageContentStyle"
      >
        <img
          :src="imageDataUrl"
          :alt="fileName"
          class="image-canvas"
          :style="imageStyle"
          draggable="false"
          @load="onLoad"
          @error="onError"
        >
      </div>
    </div>
    <div class="image-info">
      <span class="image-name">{{ fileName }}</span>
      <span
        v-if="naturalSize"
        class="image-size"
      >{{ naturalSize.w }} × {{ naturalSize.h }} px</span>
      <div class="image-zoom-controls">
        <Tooltip content="缩小">
          <button
            class="zoom-btn"
            @click="zoomOut"
          >
            −
          </button>
        </Tooltip>
        <Tooltip content="重置缩放">
          <button
            class="zoom-btn zoom-reset"
            @click="resetZoom"
          >
            {{ zoomPercent }}
          </button>
        </Tooltip>
        <Tooltip content="放大">
          <button
            class="zoom-btn"
            @click="zoomIn"
          >
            +
          </button>
        </Tooltip>
      </div>
    </div>
  </div>
</template>

<style scoped>
.image-viewer {
  flex: 1;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--color-bg-primary);
}

.image-stage {
  flex: 1;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: auto;
  background-color: var(--color-bg-secondary);
}

.image-canvas {
  user-select: none;
  transition: width 0.1s ease, height 0.1s ease;
  flex-shrink: 0;
  margin: auto;
}

.image-stage-content {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.image-stage.is-panning {
  cursor: grabbing;
  user-select: none;
}

.image-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-tertiary);
  font-size: var(--ui-font-size);
}

.image-info {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.image-name {
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.image-size {
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.image-zoom-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
}

/* Tooltip 默认会让触发器 flex: 1；缩放按钮必须按自身宽度排列。 */
.image-zoom-controls :deep(.tooltip-trigger) {
  flex: 0 0 auto;
}

.zoom-btn {
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  font-size: calc(var(--ui-font-size) + 1px);
  line-height: 1;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.zoom-btn:hover {
  border-color: var(--color-border-hover);
  background: var(--color-bg-secondary);
}

.zoom-btn:active {
  border-color: var(--color-primary);
}

.zoom-reset {
  font-size: calc(var(--ui-font-size) - 1px);
  min-width: 44px;
}
</style>
