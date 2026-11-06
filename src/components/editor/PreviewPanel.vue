<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useFileStore } from '../../stores/file'
import { useThemeStore } from '../../stores/theme'
import { renderMarkdown } from '../../utils/markdown'
import { getHighlighter, type Highlighter } from '../../utils/shiki'
import { requestDialog } from '../../utils/dialog'
import { useEditorFontZoom } from '../../composables/useEditorFontZoom'
import { restoreScroll, scrollRestoreTarget, scrollTargetForViewportOffset } from '../../utils/editor-scroll'
import Tooltip from '../common/Tooltip.vue'

interface Props {
  enableScrollSync?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  enableScrollSync: false
})

const emit = defineEmits<{
  (e: 'scroll', ratio: number): void
}>()

const fileStore = useFileStore()
const themeStore = useThemeStore()

const previewRef = ref<HTMLDivElement>()
const previewWrapperRef = ref<HTMLDivElement>()
const shikiHighlighter = ref<Highlighter | null>(null)
const isShikiReady = ref(false)

// Ctrl+滚轮缩放编辑区字号
const { attach: attachFontZoom } = useEditorFontZoom()

let renderDebounceTimer: ReturnType<typeof setTimeout> | null = null

// ────── Task 6: markdown-it render cache ──────
let lastRenderedContent = ''
let lastRenderedHtml = ''

const previewHtml = computed(() => {
  const content = fileStore.fileContent
  if (content === lastRenderedContent) return lastRenderedHtml
  const html = renderMarkdown(content, fileStore.imageAssets)
  lastRenderedContent = content
  lastRenderedHtml = html
  return html
})

// ────── Viewport helpers ──────
function isInViewport(el: Element, margin: number): boolean {
  const scrollContainer = previewRef.value?.parentElement
  if (!scrollContainer) return false
  const containerRect = scrollContainer.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  return rect.bottom >= containerRect.top - margin &&
         rect.top <= containerRect.bottom + margin
}

// ────── Task 7: Shiki viewport-aware highlighting ──────
async function highlightSingleBlock(pre: Element): Promise<void> {
  const hl = shikiHighlighter.value
  if (!hl || pre.hasAttribute('data-shiki-done')) return
  const codeEl = pre.querySelector('code')
  if (!codeEl) return
  const match = codeEl.className.match(/language-([\w+#.-]+)/)
  const lang = match ? match[1] : 'text'
  try {
    const wrapper = document.createElement('div')
    wrapper.innerHTML = hl.codeToHtml(codeEl.textContent || '', { lang, theme: shikiTheme.value })
    const newPre = wrapper.querySelector('pre')
    if (newPre) {
      newPre.setAttribute('data-shiki-done', '')
      pre.replaceWith(newPre)
    }
  } catch { /* unsupported language */ }
}

async function highlightVisibleCodeBlocks(): Promise<void> {
  if (!shikiHighlighter.value || !previewRef.value) return
  const scrollContainer = previewRef.value.parentElement
  if (!scrollContainer) return
  const margin = scrollContainer.clientHeight
  const pending: Promise<void>[] = []
  for (const codeBlock of previewRef.value.querySelectorAll('pre code')) {
    const pre = codeBlock.closest('pre')
    if (!pre || pre.hasAttribute('data-shiki-done')) continue
    if (isInViewport(pre, margin)) {
      pending.push(highlightSingleBlock(pre))
    }
  }
  await Promise.all(pending)
}

// ────── Task 8: Image lazy loading ──────
const imageLoadInflight = new Set<string>()

async function loadPreviewImage(img: HTMLImageElement, filePath: string | undefined, cacheKey: string, margin: number): Promise<void> {
  if (!isInViewport(img, margin)) return
  try {
    const result = await fileStore.getImage(img.getAttribute('src')!, filePath)
    if ((fileStore.currentFile?.path || undefined) !== filePath) return
    if (result.success && result.data) {
      fileStore.setCachedImage(cacheKey, result.data)
      img.src = result.data
    }
  } catch { /* ignore */ }
  imageLoadInflight.delete(cacheKey)
}

async function loadVisibleImages(): Promise<void> {
  if (!previewRef.value || !fileStore.document) return
  const scrollContainer = previewRef.value.parentElement
  if (!scrollContainer) return
  const filePath = fileStore.currentFile?.path || undefined
  const margin = scrollContainer.clientHeight
  const pending: Promise<void>[] = []
  for (const img of previewRef.value.querySelectorAll('img')) {
    const src = img.getAttribute('src')
    if (!src || /^(https?:|data:)/i.test(src)) continue
    const cacheKey = `${filePath ?? ''}:${src}`
    const cached = fileStore.getCachedImage(cacheKey)
    if (cached) {
      img.src = cached
      continue
    }
    if (imageLoadInflight.has(cacheKey)) continue
    if (!isInViewport(img, margin)) continue
    imageLoadInflight.add(cacheKey)
    pending.push(loadPreviewImage(img as HTMLImageElement, filePath, cacheKey, margin))
  }
  await Promise.all(pending)
}

// ────── Scroll-driven lazy pipeline ──────
let scrollLazyTimer: ReturnType<typeof setTimeout> | null = null

function scheduleScrollLazy(): void {
  if (scrollLazyTimer) return
  scrollLazyTimer = setTimeout(async () => {
    scrollLazyTimer = null
    await Promise.all([highlightVisibleCodeBlocks(), loadVisibleImages()])
  }, 150)
}

function teardownScrollLazy(): void {
  if (scrollLazyTimer) { clearTimeout(scrollLazyTimer); scrollLazyTimer = null }
  const scroller = previewRef.value?.parentElement
  if (scroller) scroller.removeEventListener('scroll', scheduleScrollLazy)
}

function setupScrollLazy(): void {
  teardownScrollLazy()
  const scroller = previewRef.value?.parentElement
  if (scroller) scroller.addEventListener('scroll', scheduleScrollLazy, { passive: true })
}

// ────── Render pipeline ──────
function renderPreview(): void {
  if (renderDebounceTimer) clearTimeout(renderDebounceTimer)
  const delay = fileStore.fileContent.length > 100_000 ? 300 : 100
  renderDebounceTimer = setTimeout(async () => {
    await highlightVisibleCodeBlocks()
    await loadVisibleImages()
    setupScrollLazy()
  }, delay)
}

async function initShiki(): Promise<void> {
  try {
    shikiHighlighter.value = await getHighlighter()
    isShikiReady.value = true
    renderPreview()
  } catch (err) {
    console.error('Shiki 初始化失败:', err)
    isShikiReady.value = false
  }
}

const shikiTheme = computed(() => themeStore.isDark ? 'github-dark' : 'github-light')

// ────── Link click ──────
function handleLinkClick(event: MouseEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  if (event.button !== 0) return

  const target = event.target as HTMLElement
  const link = target.closest('a.md-link')
  if (!link) return

  const href = link.getAttribute('data-link-href')
  if (!href) return

  event.preventDefault()

  const currentFilePath = fileStore.currentFile?.path || undefined
  const openedFolderPath = fileStore.openedFolderPath || undefined

  window.electronAPI.openLink(href, currentFilePath, openedFolderPath).then(result => {
    if (result.success && result.data) {
      fileStore.openFile(result.data, { addToRecent: true })
    } else if (result.error && !result.data) {
      requestDialog({
        title: '无法打开链接',
        message: result.error,
        buttons: [{ label: '确定', value: 0, primary: true }]
      })
    }
  })
}

// ────── Scroll sync ──────
function handleScroll(): void {
  // 恢复阅读位置期间，程序触发的滚动不应同步回源码编辑器
  if (isRestoringScroll) return
  if (!previewRef.value || !props.enableScrollSync) return
  const container = previewRef.value.parentElement
  if (!container) return
  const maxScroll = container.scrollHeight - container.clientHeight
  const ratio = maxScroll > 0 ? container.scrollTop / maxScroll : 0
  emit('scroll', ratio)
}

// ────── 阅读位置恢复 ──────
// 分屏里预览只是源码编辑器的视图：阅读位置由源码编辑器保存，
// 预览滚动时 EditorPanel 会把同一比例同步回源码编辑器，因此这里只负责恢复。
let cancelScrollRestore: (() => void) | null = null
/** 恢复期间抑制滚动同步，避免两侧互相按比例拉扯 */
let isRestoringScroll = false
/** 抑制令牌：新的恢复开始时让旧的解除定时器失效 */
let scrollRestoreToken = 0

/** 恢复上次阅读进度（组件随分屏模式重建时调用） */
function restoreScrollPosition(): void {
  const container = previewRef.value?.parentElement
  const tabId = fileStore.activeTabId
  if (!container || !tabId) return
  const tab = fileStore.tabs.find((t) => t.id === tabId)
  const saved = tab?.savedEditorPosition
  if (!saved) return

  cancelScrollRestore?.()
  const token = ++scrollRestoreToken
  isRestoringScroll = true
  // 恢复结束的最后一帧仍会冒一个 scroll 事件；立即解除抑制会让它按比例把源码编辑器拉走，
  // 所以延迟一小段再恢复同步（用户此时滚动最多晚 150ms 生效，感知不到）。
  const onDone = (): void => {
    setTimeout(() => {
      if (token === scrollRestoreToken) isRestoringScroll = false
    }, 150)
  }

  // 预览按锚点行 + 屏幕偏移定位（它不保存自己的像素位置，像素值属于源码编辑器）。
  // 图片在预览里很高，只按行号把块顶到顶部会让文字大幅跳动。
  if (saved.anchorLine != null) {
    const anchorLine = saved.anchorLine
    const offset = saved.anchorOffsetPx ?? 0
    cancelScrollRestore = restoreScroll(container, {
      resolve: () => {
        const block = findBlockAtLine(anchorLine)
        return block ? scrollTargetForViewportOffset(container, block, offset) : null
      }
    }, { onDone })
    return
  }

  const target = scrollRestoreTarget(saved, fileStore.effectiveEditorMode)
  if (!target) {
    isRestoringScroll = false
    return
  }
  cancelScrollRestore = restoreScroll(container, target, { onDone })
}

/**
 * 找到锚点行所在的块：优先「起始行等于锚点行」的第一个块，否则退回
 * 「起始行不超过锚点行」的最后一个块（锚点行可能落在块内部）。
 */
function findBlockAtLine(line: number): HTMLElement | null {
  const preview = previewRef.value
  if (!preview) return null
  const blocks = Array.from(preview.querySelectorAll<HTMLElement>('[data-source-line]'))
  if (blocks.length === 0) return null
  let best: HTMLElement | null = null
  for (const block of blocks) {
    const blockLine = Number(block.getAttribute('data-source-line'))
    if (!Number.isFinite(blockLine)) continue
    if (blockLine === line) return block
    if (blockLine < line) best = block
    else break
  }
  return best ?? blocks[0]
}

function scrollTo(ratio: number): void {
  const container = previewRef.value?.parentElement
  if (!container) return
  // 外部（分屏滚动同步）接管滚动时停止尚未完成的恢复重试
  cancelScrollRestore?.()
  cancelScrollRestore = null
  isRestoringScroll = false
  const maxScroll = container.scrollHeight - container.clientHeight
  container.scrollTop = ratio * maxScroll
}

function scrollToLine(line: number): void {
  if (!previewRef.value) return
  const headings = previewRef.value.querySelectorAll('h1, h2, h3, h4, h5, h6')
  if (headings.length > 0 && line <= headings.length) {
    const target = headings[line - 1]
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }
}

/** 按 0 起始的标题序号定位（供侧栏大纲跳转） */
function scrollToHeading(index: number): void {
  if (!previewRef.value) return
  const headings = previewRef.value.querySelectorAll('h1, h2, h3, h4, h5, h6')
  headings[index]?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

/** 响应侧栏大纲点击 */
function handleOutlineJump(event: Event): void {
  const index = (event as CustomEvent<{ index: number }>).detail?.index
  if (index == null) return
  scrollToHeading(index)
}

// ────── Watchers ──────
watch(() => fileStore.fileContent, () => {
  teardownScrollLazy()
  nextTick(() => renderPreview())
})

watch(() => fileStore.currentFile?.path, (newPath, oldPath) => {
  if (newPath !== oldPath) {
    fileStore.clearImageCache()
    imageLoadInflight.clear()
  }
})

watch(() => themeStore.isDark, () => {
  nextTick(async () => {
    // Re-highlight all already-processed blocks
    if (previewRef.value) {
      for (const pre of previewRef.value.querySelectorAll('pre[data-shiki-done]')) {
        pre.removeAttribute('data-shiki-done')
      }
    }
    await highlightVisibleCodeBlocks()
  })
})

// ────── Lifecycle ──────
onMounted(() => {
  initShiki()
  renderPreview()
  restoreScrollPosition()
  if (previewWrapperRef.value) attachFontZoom(previewWrapperRef.value)
  window.addEventListener('inkase:outline-jump', handleOutlineJump)
})

onUnmounted(() => {
  cancelScrollRestore?.()
  cancelScrollRestore = null
  teardownScrollLazy()
  window.removeEventListener('inkase:outline-jump', handleOutlineJump)
})

defineExpose({
  scrollTo,
  scrollToLine
})
</script>

<template>
  <div class="preview-container">
    <div
      v-if="!isShikiReady"
      class="preview-header"
    >
      <div class="preview-actions">
        <Tooltip content="代码高亮加载中">
          <button class="preview-status">
            <span class="loading-dot" />
            加载中
          </button>
        </Tooltip>
      </div>
    </div>
    <div
      ref="previewWrapperRef"
      class="preview-content-wrapper"
      @scroll="handleScroll"
      @click="handleLinkClick"
    >
      <div
        ref="previewRef"
        class="preview-content"
        v-html="previewHtml"
      />
    </div>
  </div>
</template>

<style scoped>
.preview-container {
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg-primary);
  border-left: 1px solid var(--color-border);
  overflow: hidden;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 4px 16px;
  background-color: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.preview-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-status {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--color-text-tertiary);
  background: transparent;
  border: none;
  cursor: default;
}

.loading-dot {
  width: 6px;
  height: 6px;
  background-color: var(--color-primary);
  border-radius: 50%;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.preview-content-wrapper {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.preview-content {
  padding: 24px 32px;
  font-family: var(--editor-font-family, var(--font-sans));
  font-size: calc(var(--editor-font-size, 16px) - 1px);
  line-height: var(--editor-line-height, 1.8);
  color: var(--color-text);
  max-width: 100%;
}

/* Markdown 样式 */
.preview-content :deep(h1),
.preview-content :deep(h2),
.preview-content :deep(h3),
.preview-content :deep(h4),
.preview-content :deep(h5),
.preview-content :deep(h6) {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--color-text);
}

.preview-content :deep(h1) {
  font-size: 2em;
  border-bottom: 2px solid var(--color-border);
  padding-bottom: 0.3em;
}

.preview-content :deep(h2) {
  font-size: 1.5em;
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 0.3em;
}

.preview-content :deep(h3) {
  font-size: 1.25em;
}

.preview-content :deep(h4) {
  font-size: 1em;
}

.preview-content :deep(h5) {
  font-size: 0.875em;
}

.preview-content :deep(h6) {
  font-size: 0.85em;
  color: var(--color-text-secondary);
}

.preview-content :deep(p) {
  margin: 0 0 16px;
}

.preview-content :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
}

.preview-content :deep(a:hover) {
  text-decoration: underline;
}

.preview-content :deep(ul) {
  list-style-type: disc;
}

.preview-content :deep(ol) {
  list-style-type: decimal;
}

.preview-content :deep(ul),
.preview-content :deep(ol) {
  margin: 0 0 16px;
  padding-left: 2em;
}

.preview-content :deep(ul ul),
.preview-content :deep(ul ol),
.preview-content :deep(ol ul),
.preview-content :deep(ol ol) {
  margin-top: 0;
  margin-bottom: 0;
}

.preview-content :deep(li) {
  margin: 0.25em 0;
}

.preview-content :deep(li + li) {
  margin-top: 0.25em;
}

.preview-content :deep(li > p) {
  margin-top: 16px;
}

.preview-content :deep(li + li > p) {
  margin-top: 0;
}

.preview-content :deep(li > p:first-child) {
  margin-top: 0;
}

.preview-content :deep(li > p:last-child) {
  margin-bottom: 0;
}

/* 任务列表：渲染层已输出真实 <input type="checkbox">，这里只负责外观（只读态） */
.preview-content :deep(li.task-list-item) {
  list-style-type: none;
  padding-left: 1.5em;
  position: relative;
}

.preview-content :deep(li.task-list-item .task-checkbox) {
  appearance: none;
  -webkit-appearance: none;
  position: absolute;
  left: 0;
  top: 0.4em;
  width: 1em;
  height: 1em;
  margin: 0;
  border: 2px solid var(--color-border);
  border-radius: 3px;
  background-color: var(--color-bg-primary);
  cursor: default;
}

.preview-content :deep(li.task-list-item .task-checkbox:checked) {
  background-color: var(--color-primary);
  border-color: var(--color-primary);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='white'%3E%3Cpath d='M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z'/%3E%3C/svg%3E");
  background-size: 75%;
  background-position: center;
  background-repeat: no-repeat;
}

/* 只给本项文字划线，嵌套子列表不受影响 */
.preview-content :deep(li.task-list-item[data-checked="true"] .task-text) {
  text-decoration: line-through;
  color: var(--color-text-tertiary);
}

.preview-content :deep(blockquote) {
  margin: 0 0 16px;
  padding: 0 1em;
  color: var(--color-text-secondary);
  border-left: 4px solid var(--color-border);
}

.preview-content :deep(blockquote > :first-child) {
  margin-top: 0;
}

.preview-content :deep(blockquote > :last-child) {
  margin-bottom: 0;
}

.preview-content :deep(code) {
  padding: 0.2em 0.4em;
  margin: 0;
  font-size: 85%;
  font-family: var(--editor-mono-font-family, var(--font-mono));
  background-color: var(--color-bg-secondary);
  border-radius: 3px;
}

.preview-content :deep(pre) {
  padding: 16px;
  overflow: auto;
  font-size: 85%;
  line-height: 1.45;
  background-color: var(--color-bg-secondary);
  border-radius: 6px;
  margin: 0 0 16px;
}

.preview-content :deep(pre code) {
  display: inline;
  max-width: auto;
  padding: 0;
  margin: 0;
  overflow: visible;
  line-height: inherit;
  word-wrap: normal;
  background-color: transparent;
  border: 0;
}

/* Shiki 高亮样式 */
.preview-content :deep(.shiki) {
  background-color: var(--color-bg-secondary) !important;
  border-radius: 6px;
  padding: 16px;
  overflow-x: auto;
}

.preview-content :deep(.shiki code) {
  background: none;
  padding: 0;
  font-size: 100%;
}

.preview-content :deep(table) {
  display: block;
  width: 100%;
  overflow: auto;
  margin: 0 0 16px;
  border-spacing: 0;
  border-collapse: collapse;
}

.preview-content :deep(table th),
.preview-content :deep(table td) {
  padding: 6px 13px;
  border: 1px solid var(--color-border);
}

.preview-content :deep(table tr) {
  background-color: var(--color-bg-primary);
  border-top: 1px solid var(--color-border);
}

.preview-content :deep(table tr:nth-child(2n)) {
  background-color: var(--color-bg-secondary);
}

.preview-content :deep(table th) {
  font-weight: 600;
  background-color: var(--color-bg-secondary);
}

.preview-content :deep(img) {
  max-width: 100%;
  box-sizing: content-box;
  background-color: var(--color-bg-primary);
  border-radius: 4px;
}

.preview-content :deep(hr) {
  height: 4px;
  padding: 0;
  margin: 24px 0;
  background-color: var(--color-border);
  border: 0;
}

.preview-content :deep(del) {
  text-decoration: line-through;
  color: var(--color-text-tertiary);
}

.preview-content :deep(.emoji) {
  font-size: 1.2em;
}

/* 代码块语言标签 */
.preview-content :deep(pre[class*="language-"]) {
  position: relative;
}

.preview-content :deep(pre[class*="language-"])::before {
  content: attr(data-lang);
  position: absolute;
  top: 0;
  right: 0;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--color-text-tertiary);
  background-color: var(--color-bg-tertiary);
  border-bottom-left-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
</style>
