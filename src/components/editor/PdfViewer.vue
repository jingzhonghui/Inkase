<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { useFileStore } from '../../stores/file'
import { useOutlineStore } from '../../stores/outline'
import Tooltip from '../common/Tooltip.vue'
import {
  activeOutlineIndex,
  clampScale,
  fitWidthScale,
  flattenOutline,
  pageAtScroll,
  scaledPageSize,
  scrollOffsetsForPage,
  type OutlineFlatNode,
  type OutlineNode,
  type PageLayout
} from '../../utils/pdf-viewer'

// pdfjs 依赖 DOMMatrix 等浏览器 API，且体积较大，按需惰性加载（jsdom 测试环境无法在模块顶层加载）
type PdfjsModule = typeof import('pdfjs-dist')
let pdfjsLib: PdfjsModule | null = null

async function ensurePdfjs(): Promise<PdfjsModule> {
  if (!pdfjsLib) {
    // 使用 legacy 构建：其在 Uint8Array.prototype.toHex 缺失时内置 polyfill，
    // 而默认构建直接依赖该原生方法（Chromium 133 / Electron 35+ 才提供），
    // 在本应用的 Electron 34（Chromium 132）中打开 PDF 会报 "toHex is not a function"。
    const [lib, workerModule] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker')
    ])
    lib.GlobalWorkerOptions.workerPort = new workerModule.default()
    pdfjsLib = lib
  }
  return pdfjsLib
}

const fileStore = useFileStore()
const outlineStore = useOutlineStore()

const activeTab = computed(() => fileStore.activeTab)
const fileName = computed(() => activeTab.value?.fileInfo?.name ?? '')

const STAGE_PADDING = 24
const containerRef = ref<HTMLElement | null>(null)
const pageCount = ref(0)
const currentPage = ref(1)
const scale = ref(1)
const pageWidth = ref(612)
const loading = ref(true)
const loadError = ref('')

const scalePercent = computed(() => `${Math.round(scale.value * 100)}%`)
const pageInput = ref('')
const pageInputEl = ref<HTMLInputElement | null>(null)

const outlineItems = ref<OutlineFlatNode[]>([])

// 滚动导致当前页变化时，同步页码输入框与侧栏大纲高亮（用户正在输入时不打断输入框）
watch(currentPage, (page) => {
  outlineStore.setActiveIndex(activeOutlineIndex(outlineItems.value, page))
  if (pageInputEl.value && document.activeElement === pageInputEl.value) return
  pageInput.value = String(page)
})

/** 页面基准尺寸（scale=1，取第一页；多数 PDF 各页尺寸一致） */
const basePageSize = ref({ width: 612, height: 792 })

/** 渲染前的页面占位尺寸，保证初始布局测量准确 */
const placeholderStyle = computed(() => {
  const size = scaledPageSize(basePageSize.value, scale.value)
  return { width: `${size.width}px`, height: `${size.height}px` }
})

interface RenderedPage {
  layout: PageLayout
  rendered: boolean
}

let pdfDoc: PDFDocumentProxy | null = null
let pages: RenderedPage[] = []
let renderGeneration = 0
let resizeObserver: ResizeObserver | null = null
let scrollTimer: number | null = null

async function loadPdf(): Promise<void> {
  renderGeneration++
  const generation = renderGeneration
  pdfDoc = null
  pages = []
  pageCount.value = 0
  currentPage.value = 1
  loading.value = true
  loadError.value = ''
  outlineItems.value = []
  outlineStore.setLoading('pdf')

  const base64 = activeTab.value?.pdfBase64
  if (!base64) {
    loading.value = false
    loadError.value = 'PDF 数据为空'
    return
  }

  try {
    const binary = atob(base64)
    const data = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i)

    const lib = await ensurePdfjs()
    const doc = await lib.getDocument({ data }).promise
    if (generation !== renderGeneration) {
      doc.destroy()
      return
    }
    pdfDoc = doc
    pageCount.value = doc.numPages
    pageInput.value = '1'
    void loadOutline(doc, generation)

    const firstPage = await doc.getPage(1)
    if (generation !== renderGeneration) return
    const baseViewport = firstPage.getViewport({ scale: 1 })
    pageWidth.value = baseViewport.width
    basePageSize.value = { width: baseViewport.width, height: baseViewport.height }

    // 初始缩放：适应宽度
    const el = containerRef.value
    if (el && el.clientWidth > 0) {
      scale.value = fitWidthScale(el.clientWidth, pageWidth.value, STAGE_PADDING * 2)
    }
    loading.value = false
    await nextTick()
    // 先填充布局快照，再渲染可见页（renderPage 依赖 pages 数组）
    measureLayouts()
    renderVisiblePages()
  } catch (err) {
    if (generation === renderGeneration) {
      loading.value = false
      loadError.value = err instanceof Error ? err.message : '无法加载 PDF'
    }
  }
}

/** 解析目录节点 dest → 页码（从 1 开始）；dest 缺失或无法解析返回 null */
async function resolveOutlinePage(doc: PDFDocumentProxy, node: OutlineNode): Promise<number | null> {
  try {
    if (typeof node.dest === 'string') {
      const dest = await doc.getDestination(node.dest)
      if (!dest) return null
      return (await doc.getPageIndex(dest[0] as never)) + 1
    }
    if (Array.isArray(node.dest) && node.dest.length > 0) {
      return (await doc.getPageIndex(node.dest[0] as never)) + 1
    }
    return null
  } catch {
    return null
  }
}

/** 异步加载并解析目录并发布到大纲 store（无目录/失败则发布空列表） */
async function loadOutline(doc: PDFDocumentProxy, generation: number): Promise<void> {
  let items: OutlineFlatNode[] = []
  try {
    const raw = await doc.getOutline()
    if (raw && raw.length > 0) {
      items = await flattenOutline(raw, (node) => resolveOutlinePage(doc, node))
    }
  } catch {
    items = []
  }
  // 已切换到其它 PDF/标签时丢弃过期结果
  if (generation !== renderGeneration) return
  outlineItems.value = items
  outlineStore.setHeadings(
    items.map((it) => ({ level: it.depth + 1, text: it.title, page: it.page })),
    'pdf'
  )
  outlineStore.setActiveIndex(activeOutlineIndex(items, currentPage.value))
}

async function renderPage(pageNumber: number): Promise<void> {
  const doc = pdfDoc
  if (!doc) return
  const entry = pages[pageNumber - 1]
  if (!entry || entry.rendered) return
  entry.rendered = true

  let page: PDFPageProxy
  try {
    page = await doc.getPage(pageNumber)
  } catch {
    entry.rendered = false
    return
  }

  const canvas = containerRef.value?.querySelector<HTMLCanvasElement>(
    `canvas[data-page="${pageNumber}"]`
  )
  const host = canvas?.parentElement
  if (!canvas || !host || !containerRef.value) {
    entry.rendered = false
    return
  }

  const viewport = page.getViewport({ scale: scale.value })
  canvas.width = Math.floor(viewport.width * window.devicePixelRatio)
  canvas.height = Math.floor(viewport.height * window.devicePixelRatio)
  canvas.style.width = `${Math.floor(viewport.width)}px`
  canvas.style.height = `${Math.floor(viewport.height)}px`

  try {
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
    await renderTextLayer(page, host, viewport)
  } catch {
    entry.rendered = false
  }
}

async function renderTextLayer(page: PDFPageProxy, host: HTMLElement, viewport: ReturnType<PDFPageProxy['getViewport']>): Promise<void> {
  let textLayerEl: HTMLElement | null = host.querySelector('.pdf-text-layer')
  if (!textLayerEl) {
    textLayerEl = document.createElement('div')
    textLayerEl.className = 'pdf-text-layer'
    host.appendChild(textLayerEl)
  }
  textLayerEl.innerHTML = ''
  textLayerEl.style.width = `${Math.floor(viewport.width)}px`
  textLayerEl.style.height = `${Math.floor(viewport.height)}px`

  const textContent = await page.getTextContent()
  const lib = await ensurePdfjs()
  for (const item of textContent.items) {
    if (!('str' in item) || !item.str) continue
    const span = document.createElement('span')
    span.textContent = item.str
    const tx = lib.Util.transform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    span.style.left = `${tx[4]}px`
    span.style.top = `${tx[5] - fontHeight}px`
    span.style.fontSize = `${fontHeight}px`
    textLayerEl.appendChild(span)
  }
}

function measureLayouts(): void {
  const el = containerRef.value
  if (!el) return
  const containerRect = el.getBoundingClientRect()
  const scrollTop = el.scrollTop
  const hosts = el.querySelectorAll<HTMLElement>('.pdf-page')
  pages = Array.from(hosts).map((host, i) => {
    const rect = host.getBoundingClientRect()
    return {
      layout: { top: rect.top - containerRect.top + scrollTop, height: rect.height },
      rendered: pages[i]?.rendered ?? false
    }
  })
}

function renderVisiblePages(): void {
  const el = containerRef.value
  if (!el || !pdfDoc) return
  const margin = 600
  const viewTop = el.scrollTop - margin
  const viewBottom = el.scrollTop + el.clientHeight + margin

  const hosts = el.querySelectorAll<HTMLElement>('.pdf-page')
  hosts.forEach((host) => {
    const pageNumber = Number(host.dataset.page)
    const top = host.offsetTop
    const bottom = top + host.offsetHeight
    if (bottom >= viewTop && top <= viewBottom) {
      void renderPage(pageNumber)
    }
  })
}

function onScroll(): void {
  const el = containerRef.value
  if (!el) return
  // 布局快照缺失时（如初始滚动早于测量）先补测，避免页码卡死
  if (pages.length === 0 && pdfDoc) measureLayouts()
  currentPage.value = pageAtScroll(pages.map((p) => p.layout), el.scrollTop, el.clientHeight)
  if (scrollTimer !== null) return
  scrollTimer = window.setTimeout(() => {
    scrollTimer = null
    measureLayouts()
    renderVisiblePages()
  }, 120)
}

function rerenderAll(): void {
  const el = containerRef.value
  if (!el || !pdfDoc) return
  pages = []
  // 尺寸变化后重新测量布局并重新渲染可见页
  void nextTick(() => {
    measureLayouts()
    renderVisiblePages()
  })
}

function zoomIn(): void {
  scale.value = clampScale(scale.value + 0.25)
  rerenderAll()
}

function zoomOut(): void {
  scale.value = clampScale(scale.value - 0.25)
  rerenderAll()
}

/** Ctrl+滚轮缩放（与图片查看器一致） */
function onStageWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return
  event.preventDefault()
  scale.value = clampScale(scale.value + (event.deltaY < 0 ? 0.25 : -0.25))
  rerenderAll()
}

function fitWidth(): void {
  const el = containerRef.value
  if (!el) return
  scale.value = fitWidthScale(el.clientWidth, pageWidth.value, STAGE_PADDING * 2)
  rerenderAll()
}

function goToPage(): void {
  const target = Number(pageInput.value)
  if (!Number.isFinite(target)) return
  const clamped = Math.min(pageCount.value, Math.max(1, Math.round(target)))
  jumpToPage(clamped)
}

function jumpToPage(page: number): void {
  const el = containerRef.value
  if (!el) return
  el.scrollTop = scrollOffsetsForPage(pages.map((p) => p.layout), page)
  currentPage.value = page
  pageInput.value = String(page)
}

/** 响应侧栏大纲点击：按索引跳到对应页码 */
function handleOutlineJump(event: Event): void {
  const index = (event as CustomEvent<{ index: number }>).detail?.index
  const item = index == null ? undefined : outlineItems.value[index]
  if (!item || item.page === null) return
  jumpToPage(item.page)
  outlineStore.setActiveIndex(index as number)
}

function onPageInputEnter(event: KeyboardEvent): void {
  if (event.key === 'Enter') goToPage()
}

watch(
  () => activeTab.value?.pdfBase64,
  () => {
    void loadPdf()
  },
  { immediate: true }
)

resizeObserver = new ResizeObserver(() => {
  measureLayouts()
  renderVisiblePages()
})

onMounted(() => {
  containerRef.value?.addEventListener('wheel', onStageWheel, { passive: false })
  window.addEventListener('inkase:outline-jump', handleOutlineJump)
})

watch(
  containerRef,
  (el) => {
    if (el) resizeObserver?.observe(el)
  },
  { immediate: true }
)

onUnmounted(() => {
  renderGeneration++
  containerRef.value?.removeEventListener('wheel', onStageWheel)
  window.removeEventListener('inkase:outline-jump', handleOutlineJump)
  resizeObserver?.disconnect()
  resizeObserver = null
  if (scrollTimer !== null) window.clearTimeout(scrollTimer)
  if (pdfDoc) {
    void pdfDoc.destroy()
    pdfDoc = null
  }
})
</script>

<template>
  <div class="pdf-viewer">
    <div class="pdf-toolbar">
      <span class="pdf-file-name">{{ fileName }}</span>
      <div class="pdf-toolbar-controls">
        <div class="pdf-page-nav">
          <input
            ref="pageInputEl"
            v-model="pageInput"
            class="pdf-page-input"
            :disabled="pageCount === 0"
            @keydown="onPageInputEnter"
          >
          <span class="pdf-page-total">/ {{ pageCount }}</span>
        </div>
        <div class="pdf-zoom-controls">
          <Tooltip content="缩小">
            <button
              class="pdf-btn"
              :disabled="loading || !!loadError"
              @click="zoomOut"
            >
              −
            </button>
          </Tooltip>
          <Tooltip content="适应宽度">
            <button
              class="pdf-btn pdf-scale-reset"
              :disabled="loading || !!loadError"
              @click="fitWidth"
            >
              {{ scalePercent }}
            </button>
          </Tooltip>
          <Tooltip content="放大">
            <button
              class="pdf-btn"
              :disabled="loading || !!loadError"
              @click="zoomIn"
            >
              +
            </button>
          </Tooltip>
        </div>
      </div>
    </div>

    <div class="pdf-body">
      <div class="pdf-stage">
        <div
          v-if="loadError"
          class="pdf-error"
        >
          {{ loadError }}
        </div>
        <div
          v-else-if="loading"
          class="pdf-error"
        >
          正在加载 PDF…
        </div>
        <div
          v-show="!loading && !loadError"
          ref="containerRef"
          class="pdf-scroll"
          @scroll="onScroll"
        >
          <div class="pdf-pages">
            <div
              v-for="n in pageCount"
              :key="n"
              class="pdf-page"
              :data-page="n"
              :style="placeholderStyle"
            >
              <canvas :data-page="n" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pdf-viewer {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--color-bg-primary);
}

.pdf-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.pdf-file-name {
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.pdf-toolbar-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.pdf-page-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pdf-page-input {
  width: 40px;
  height: 24px;
  padding: 0 4px;
  font-size: calc(var(--ui-font-size) - 1px);
  text-align: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text);
}

.pdf-page-total {
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-tertiary);
}

.pdf-zoom-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pdf-btn {
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

.pdf-btn:hover:not(:disabled) {
  border-color: var(--color-border-hover);
  background: var(--color-bg-secondary);
}

.pdf-btn:active:not(:disabled) {
  border-color: var(--color-primary);
}

.pdf-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.pdf-scale-reset {
  font-size: calc(var(--ui-font-size) - 1px);
  min-width: 44px;
}

.pdf-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
}

.pdf-stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.pdf-scroll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background-color: var(--color-bg-secondary);
}

.pdf-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px;
  gap: 16px;
}

.pdf-page {
  position: relative;
  background: white;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  flex-shrink: 0;
  /* 深色模式夜间阅读反色（变量定义于 index.css，浅色为 none） */
  filter: var(--pdf-page-filter);
}

.pdf-page canvas {
  display: block;
  /* 渲染前填满占位区；渲染后由 renderPage 写入的内联尺寸覆盖 */
  width: 100%;
  height: 100%;
}

.pdf-page :deep(.pdf-text-layer) {
  position: absolute;
  inset: 0;
  overflow: hidden;
  line-height: 1;
  opacity: 1;
}

.pdf-page :deep(.pdf-text-layer span) {
  position: absolute;
  white-space: pre;
  transform-origin: 0 0;
  color: transparent;
  cursor: text;
}

.pdf-page :deep(.pdf-text-layer span::selection) {
  background: rgba(0, 120, 212, 0.35);
}

.pdf-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-tertiary);
  font-size: var(--ui-font-size);
}
</style>
