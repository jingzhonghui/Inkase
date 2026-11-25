<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useFileStore } from '../../stores/file'
import { useThemeStore } from '../../stores/theme'
import { themedCursor } from '../../utils/cursor'
import { IMAGE_ZOOM_PROFILE, useZoomStore } from '../../stores/zoom'

const fileStore = useFileStore()
const themeStore = useThemeStore()
const zoomStore = useZoomStore()

/**
 * 拖动时的光标：原生 `grabbing` 是白色手形位图，浅色主题下压在亮图片上就看不见了。
 * 换成按主题配色的自绘四向箭头（`utils/cursor.ts`），兜底仍是黑白双色的系统 `move`。
 */
const panCursor = computed(() => themedCursor(themeStore.isDark, 'move', true))

const activeTab = computed(() => fileStore.activeTab)
const imageDataUrl = computed(() => activeTab.value?.imageDataUrl ?? '')
const fileName = computed(() => activeTab.value?.fileInfo?.name ?? '')
const loadError = ref(false)
const naturalSize = ref<{ w: number; h: number } | null>(null)
const containerSize = ref<{ w: number; h: number } | null>(null)

const tabId = computed(() => fileStore.activeTabId)

/**
 * 缩放倍率住在 zoom store 里（按标签页），这里只做读写。
 * 状态栏右下角的读数是同一份值，切标签会跟着换，不会出现「两处各说各话」。
 */
const zoom = computed<number>({
  get: () => zoomStore.valueOf(tabId.value),
  set: (value) => zoomStore.set(tabId.value, value, IMAGE_ZOOM_PROFILE)
})

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

const stageRef = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null
/** 注销「适应窗口」动作 */
let disposeFit: (() => void) | null = null

// 放大模式下拖拽平移
const isPanning = ref(false)
let panStartX = 0
let panStartY = 0
let panScrollLeft = 0
let panScrollTop = 0

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

async function centerStage(): Promise<void> {
  await nextTick()
  const el = stageRef.value
  if (!el) return
  el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2)
  el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2)
}

/** 适应窗口：图片的 100% 本身就是「整图放进窗口」，重置即适应 */
function fitToWindow(): void {
  zoom.value = 1
}

function onStageWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return
  event.preventDefault()
  zoomStore.step(tabId.value, IMAGE_ZOOM_PROFILE, event.deltaY < 0 ? 1 : -1)
}

/**
 * 缩放变化后重新居中。
 *
 * 缩放可能来自滚轮、也可能来自状态栏右下角，统一在这里收口——各写入点各调一次
 * 会漏（状态栏那条路径根本碰不到这个组件）。
 */
watch(zoom, () => {
  void centerStage()
})

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
  // 把「适应窗口」登记到状态栏的下拉里
  disposeFit = zoomStore.registerFit(tabId.value, fitToWindow)
})

onUnmounted(() => {
  stageRef.value?.removeEventListener('wheel', onStageWheel)
  resizeObserver?.disconnect()
  resizeObserver = null
  disposeFit?.()
  disposeFit = null
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
      :style="{ '--pan-cursor': panCursor }"
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
  /* 自绘光标按主题取色；平台不认 SVG 光标时回退到系统 move（黑白双色，任何底色可见） */
  cursor: var(--pan-cursor, move);
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
</style>
