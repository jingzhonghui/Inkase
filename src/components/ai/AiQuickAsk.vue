<script setup lang="ts">
/**
 * 选中文本的快捷提问浮层
 *
 * 选区由编辑器发布到 fileStore.editorSelection，这里只消费归一化后的
 * Markdown 偏移；写回统一走 fileStore.updateTabContent，因此 IR 与源码
 * 模式共用同一套替换 / 插入 / 追加逻辑。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconArrowDown,
  IconCheck,
  IconCopy,
  IconPlus,
  IconSparkles,
  IconX
} from '@tabler/icons-vue'
import { useFileStore } from '../../stores/file'
import { useAiStore } from '../../stores/ai'
import type { EditorSelectionSnapshot } from '../../stores/file/types'
import { extractAnalysisBlock } from '../../utils/ai/analysis-block'
import { renderAiMarkdown } from '../../utils/ai/markdown'
import {
  applyQuickAskAction,
  buildQuickAskPrompt,
  type QuickAskAction
} from '../../utils/ai/quick-ask'

const props = defineProps<{ ready: boolean }>()
const emit = defineEmits<{ openSettings: [] }>()

const fileStore = useFileStore()
const aiStore = useAiStore()

const PANEL_WIDTH = 380
const QUOTE_LIMIT = 180

const selection = computed(() => fileStore.editorSelection)
const hasSelection = computed(() => {
  const current = selection.value
  return (
    current !== null &&
    current.tabId === fileStore.activeTabId &&
    current.text.trim().length > 0
  )
})

const trigger = ref({ visible: false, top: 0, left: 0 })
const panelPosition = ref({ top: 0, left: 0 })
const open = ref(false)
const pending = ref(false)
const applied = ref(false)
const question = ref('')
const quote = ref('')
const answer = ref('')
const error = ref('')
const flash = ref('')
const flashIsError = ref(false)

const panelRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)

let askSelection: EditorSelectionSnapshot | null = null
let anchorRect: DOMRect | null = null
let answerBaseline = 0
let frame: number | null = null
let closeTimer: number | null = null
let settleTimer: number | null = null

const quotePreview = computed(() => {
  const text = quote.value.trim()
  if (text.length <= QUOTE_LIMIT) return text
  return `${text.slice(0, QUOTE_LIMIT)}…`
})

const answerText = computed(() => answer.value.trim())
const renderedAnswer = computed(() => renderAiMarkdown(answerText.value))

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** 只接受编辑区里的真实 DOM 选区，侧栏、AI 面板里的选中不弹气泡 */
function domSelectionRect(): DOMRect | null {
  if (typeof window === 'undefined') return null
  const domSelection = window.getSelection()
  if (!domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) return null

  const anchor = domSelection.anchorNode
  const element = anchor?.nodeType === 1 ? (anchor as Element) : anchor?.parentElement
  if (!element || !element.closest('.source-container, .ir-container')) return null

  const rect = domSelection.getRangeAt(0).getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    const editor = element.closest<HTMLElement>('.source-container, .ir-container')
    const editorRect = editor?.getBoundingClientRect()
    if (!editorRect) return null
    return {
      top: editorRect.top + 24,
      left: editorRect.left + 24,
      right: editorRect.left + 25,
      bottom: editorRect.top + 25,
      width: 1,
      height: 1
    } as DOMRect
  }
  return rect
}

function updateTrigger(): void {
  if (open.value) return
  if (!hasSelection.value) {
    trigger.value.visible = false
    return
  }

  const rect = domSelectionRect()
  if (!rect) {
    trigger.value.visible = false
    return
  }

  const center = rect.left + rect.width / 2
  trigger.value = {
    visible: true,
    top: Math.max(8, rect.top - 38),
    left: clamp(center, 52, window.innerWidth - 52)
  }
}

function panelPositionFor(rect: DOMRect | null): { top: number; left: number } {
  const viewportWidth = window.innerWidth
  const width = Math.min(PANEL_WIDTH, viewportWidth - 24)
  const left = rect
    ? clamp(rect.left, 12, viewportWidth - width - 12)
    : Math.max(12, (viewportWidth - width) / 2)
  const estimatedHeight = 360
  let top = rect ? rect.bottom + 10 : 120
  if (rect && top + estimatedHeight > window.innerHeight - 12) {
    top = Math.max(12, rect.top - estimatedHeight - 10)
  }
  return { top, left }
}

function scheduleTriggerUpdate(): void {
  if (typeof window === 'undefined' || frame !== null) return
  if (typeof window.requestAnimationFrame === 'function') {
    frame = window.requestAnimationFrame(() => {
      frame = null
      updateTrigger()
    })
    return
  }
  frame = window.setTimeout(() => {
    frame = null
    updateTrigger()
  }, 16)
}

function cancelScheduledUpdate(): void {
  if (frame === null) return
  if (typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(frame)
  } else {
    window.clearTimeout(frame)
  }
  frame = null
}

function openPanel(): void {
  if (!hasSelection.value) return
  if (!props.ready) {
    emit('openSettings')
    return
  }

  const current = selection.value
  if (!current) return

  askSelection = { ...current }
  anchorRect = domSelectionRect()
  open.value = true
  pending.value = false
  applied.value = false
  question.value = ''
  quote.value = current.text
  answer.value = ''
  error.value = ''
  flash.value = ''
  flashIsError.value = false
  panelPosition.value = panelPositionFor(anchorRect)
  trigger.value.visible = false
  void nextTick(() => inputRef.value?.focus())
}

function closePanel(): void {
  if (pending.value) {
    void aiStore.cancelRun()
  }
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer)
    closeTimer = null
  }
  if (settleTimer !== null) {
    window.clearTimeout(settleTimer)
    settleTimer = null
  }
  open.value = false
  pending.value = false
  applied.value = false
  scheduleTriggerUpdate()
}

function setFlash(message: string, isError = false): void {
  flash.value = message
  flashIsError.value = isError
}

function settleAnswer(): void {
  if (!pending.value) return
  pending.value = false
  if (!answerText.value && !error.value) {
    error.value = 'AI 没有返回内容'
  }
}

async function ask(): Promise<void> {
  const target = askSelection
  const text = question.value.trim()
  if (!target || !text || pending.value) return
  if (!props.ready) {
    emit('openSettings')
    return
  }
  if (aiStore.running) {
    setFlash('AI 正在处理上一个问题，请稍候', true)
    return
  }

  answerBaseline = aiStore.messages.length
  pending.value = true
  applied.value = false
  answer.value = ''
  error.value = ''
  flash.value = ''

  try {
    await aiStore.sendMessage(buildQuickAskPrompt(text, target.text))
  } catch (err) {
    pending.value = false
    error.value = err instanceof Error ? err.message : 'AI 请求失败'
  }
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void ask()
}

function applyAction(action: QuickAskAction): void {
  const target = askSelection
  const text = answerText.value
  if (!target || !text || applied.value) return

  const tab = fileStore.tabs.find((item) => item.id === target.tabId)
  if (!tab) {
    setFlash('原文已关闭，无法写回', true)
    return
  }

  const result = applyQuickAskAction(tab.content, target, action, text)
  if (!result.ok) {
    setFlash(result.reason, true)
    return
  }

  fileStore.updateTabContent(target.tabId, result.content)
  applied.value = true
  const labels: Record<QuickAskAction, string> = {
    replace: '已替换选中文本',
    insert: '已插入到选区之后',
    append: '已追加到笔记末尾'
  }
  setFlash(labels[action])
  closeTimer = window.setTimeout(() => {
    closeTimer = null
    closePanel()
  }, 700)
}

async function copyAnswer(): Promise<void> {
  if (!answerText.value) return
  try {
    await navigator.clipboard.writeText(answerText.value)
    setFlash('已复制到剪贴板')
  } catch {
    setFlash('复制失败，请手动选择答案', true)
  }
}

function onDocumentMouseDown(event: MouseEvent): void {
  if (!open.value) return
  const target = event.target
  if (!(target instanceof Node)) return
  if (panelRef.value?.contains(target) || triggerRef.value?.contains(target)) return
  closePanel()
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return
  event.stopPropagation()
  closePanel()
}

function repositionPanel(): void {
  if (!open.value) return
  panelPosition.value = panelPositionFor(anchorRect)
}

watch(selection, () => {
  if (!open.value) scheduleTriggerUpdate()
}, { deep: true })

watch(
  () => fileStore.activeTabId,
  () => {
    if (open.value) {
      closePanel()
      return
    }
    scheduleTriggerUpdate()
  }
)

watch(
  () => aiStore.messages,
  (messages) => {
    if (!pending.value) return
    const candidate = messages
      .slice(Math.max(0, answerBaseline))
      .reverse()
      .find((message) => message.role === 'assistant')
    if (candidate) {
      answer.value = extractAnalysisBlock(candidate.content).answer.trim()
    }
    if (!aiStore.running && candidate) {
      settleAnswer()
    }
  },
  { deep: true }
)

watch(
  () => aiStore.running,
  (running) => {
    if (!pending.value || running) return
    if (settleTimer !== null) window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      settleTimer = null
      settleAnswer()
    }, 0)
  }
)

onMounted(() => {
  document.addEventListener('selectionchange', scheduleTriggerUpdate)
  document.addEventListener('mouseup', scheduleTriggerUpdate, true)
  document.addEventListener('keyup', scheduleTriggerUpdate, true)
  document.addEventListener('scroll', scheduleTriggerUpdate, true)
  document.addEventListener('mousedown', onDocumentMouseDown, true)
  document.addEventListener('keydown', onDocumentKeydown, true)
  window.addEventListener('resize', repositionPanel)
  scheduleTriggerUpdate()
})

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', scheduleTriggerUpdate)
  document.removeEventListener('mouseup', scheduleTriggerUpdate, true)
  document.removeEventListener('keyup', scheduleTriggerUpdate, true)
  document.removeEventListener('scroll', scheduleTriggerUpdate, true)
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  document.removeEventListener('keydown', onDocumentKeydown, true)
  window.removeEventListener('resize', repositionPanel)
  cancelScheduledUpdate()
  if (closeTimer !== null) window.clearTimeout(closeTimer)
  if (settleTimer !== null) window.clearTimeout(settleTimer)
})
</script>

<template>
  <!-- eslint-disable vue/no-v-html -->
  <Teleport to="body">
    <button
      v-if="trigger.visible && !open"
      ref="triggerRef"
      data-testid="quick-ask-trigger"
      type="button"
      class="quick-trigger"
      aria-label="就选中文本询问 AI"
      :style="{ top: `${trigger.top}px`, left: `${trigger.left}px` }"
      @mousedown.prevent
      @click="openPanel"
    >
      <IconSparkles
        :size="14"
        :stroke-width="2"
      />
      问 AI
    </button>

    <section
      v-if="open"
      ref="panelRef"
      data-testid="quick-ask-panel"
      class="quick-panel"
      role="dialog"
      aria-label="问 AI"
      :style="{ top: `${panelPosition.top}px`, left: `${panelPosition.left}px` }"
    >
      <header class="quick-head">
        <div class="quick-title">
          <IconSparkles
            :size="16"
            :stroke-width="2"
          />
          <span>问 AI</span>
          <span class="quick-count">{{ quote.length }} 字</span>
        </div>
        <button
          type="button"
          class="quick-icon-btn"
          aria-label="关闭"
          @click="closePanel"
        >
          <IconX :size="16" />
        </button>
      </header>

      <div
        class="quick-quote"
        :title="quote"
      >
        <span class="quick-quote-label">选中</span>
        <p>{{ quotePreview }}</p>
      </div>

      <textarea
        ref="inputRef"
        v-model="question"
        class="quick-input"
        rows="3"
        placeholder="解释、改写、续写…（Enter 发送，Shift+Enter 换行）"
        :disabled="pending"
        @keydown="onInputKeydown"
      />

      <div class="quick-send-row">
        <span
          v-if="aiStore.running && !pending"
          class="quick-hint quick-warn"
        >AI 正在处理其他问题</span>
        <span
          v-else
          class="quick-hint"
        >Enter 发送 · Shift+Enter 换行</span>
        <button
          type="button"
          class="quick-send"
          :disabled="!question.trim() || pending || aiStore.running"
          @click="ask"
        >
          <IconArrowDown
            :size="14"
            :stroke-width="2"
          />
          提问
        </button>
      </div>

      <div
        v-if="pending || answerText || error"
        class="quick-result"
      >
        <div
          v-if="pending && !answerText"
          class="quick-thinking"
        >
          <span class="quick-dot" />
          正在思考…
        </div>
        <div
          v-else-if="error && !answerText"
          class="quick-error"
        >
          <IconAlertTriangle
            :size="14"
            :stroke-width="2"
          />
          <span>{{ error }}</span>
        </div>
        <div
          v-else
          class="quick-answer"
          v-html="renderedAnswer"
        />

        <div
          v-if="answerText && !pending"
          class="quick-actions"
        >
          <button
            type="button"
            class="quick-action primary"
            :disabled="applied"
            title="用答案替换选中的原文"
            @click="applyAction('replace')"
          >
            <IconCheck
              :size="13"
              :stroke-width="2"
            />
            替换
          </button>
          <button
            type="button"
            class="quick-action"
            :disabled="applied"
            title="插入到选中内容之后"
            @click="applyAction('insert')"
          >
            <IconPlus
              :size="13"
              :stroke-width="2"
            />
            插入
          </button>
          <button
            type="button"
            class="quick-action"
            :disabled="applied"
            title="追加到笔记末尾"
            @click="applyAction('append')"
          >
            <IconArrowDown
              :size="13"
              :stroke-width="2"
            />
            追加
          </button>
          <button
            type="button"
            class="quick-action"
            @click="copyAnswer"
          >
            <IconCopy
              :size="13"
              :stroke-width="2"
            />
            复制
          </button>
        </div>
      </div>

      <p
        v-if="flash"
        class="quick-flash"
        :class="{ error: flashIsError }"
      >
        {{ flash }}
      </p>
    </section>
  </Teleport>
</template>

<style scoped>
.quick-trigger {
  position: fixed;
  z-index: 3000;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg-primary);
  color: var(--color-text);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
  font-size: calc(var(--ui-font-size) - 1px);
  font-weight: 500;
  cursor: pointer;
  transform: translateX(-50%);
  transition: border-color 0.15s, color 0.15s, box-shadow 0.15s;
}

.quick-trigger:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  box-shadow: 0 5px 18px rgba(0, 0, 0, 0.18);
}

.quick-panel {
  position: fixed;
  z-index: 3001;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(380px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-primary);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  box-sizing: border-box;
}

.quick-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.quick-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--color-text);
  font-size: var(--ui-font-size);
  font-weight: 600;
}

.quick-count {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 400;
}

.quick-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  flex: none;
}

.quick-icon-btn:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.quick-quote {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-left: 2px solid var(--color-primary);
  border-radius: 4px;
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 2px);
  line-height: 1.55;
}

.quick-quote-label {
  flex: none;
  color: var(--color-text-tertiary);
}

.quick-quote p {
  margin: 0;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.quick-input {
  width: 100%;
  min-height: 64px;
  max-height: 140px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  outline: none;
  background: var(--color-bg-primary);
  color: var(--color-text);
  font: inherit;
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.55;
  resize: vertical;
  box-sizing: border-box;
}

.quick-input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-light);
}

.quick-send-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.quick-hint {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
}

.quick-warn {
  color: var(--color-warning, #b45309);
}

.quick-send {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: white;
  font-size: calc(var(--ui-font-size) - 1px);
  cursor: pointer;
  flex: none;
}

.quick-send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.quick-result {
  min-height: 0;
  padding-top: 10px;
  border-top: 1px solid var(--color-border);
  overflow-y: auto;
}

.quick-thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.quick-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: quick-ask-pulse 1s ease-in-out infinite;
}

@keyframes quick-ask-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

.quick-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--color-danger, #dc2626);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.5;
}

.quick-answer {
  max-height: 240px;
  overflow-y: auto;
  color: var(--color-text);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.65;
  word-break: break-word;
}

.quick-answer :deep(p) {
  margin: 0 0 8px;
}

.quick-answer :deep(p:last-child) {
  margin-bottom: 0;
}

.quick-answer :deep(ul),
.quick-answer :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 20px;
}

.quick-answer :deep(code) {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--color-bg-secondary);
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 2px);
}

.quick-answer :deep(pre) {
  margin: 6px 0;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  overflow-x: auto;
}

.quick-answer :deep(pre code) {
  padding: 0;
  background: transparent;
}

.quick-answer :deep(blockquote) {
  margin: 6px 0;
  padding-left: 10px;
  border-left: 2px solid var(--color-border);
  color: var(--color-text-secondary);
}

.quick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.quick-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 2px);
  cursor: pointer;
}

.quick-action:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.quick-action.primary {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.quick-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.quick-flash {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.quick-flash.error {
  color: var(--color-danger, #dc2626);
}
</style>
