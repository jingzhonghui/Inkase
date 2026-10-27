<script setup lang="ts">
/**
 * 思维导图属性栏（右侧）
 *
 * 布局对齐 XMind：左边画布、右边属性栏。属性栏不持有渲染库实例，
 * 只接收「当前选中主题的纯数据快照」并把用户的修改以事件抛回去——
 * 这样修改数据、重绘、落盘这些副作用仍然集中在 MindMapEditor 里，
 * 避免两处各写一套 `refresh()`。
 *
 * 几个刻意的决定：
 * 1. 没有选中主题时显示占位说明而不是空白。属性栏一直存在（固定宽度），
 *    空着会让人以为面板坏了。
 * 2. 输入框保存草稿再显式提交（按钮 / Ctrl+Enter / 失焦），而不是逐键写回：
 *    逐键写回会每敲一个字就 `refresh()` 一次画布，逆光和选中态都会闪。
 * 3. 草稿只在「换了主题」时整体重置；同一主题上的外部变更（撤销/重做）
 *    只在用户没改过草稿时跟随，避免把用户正在输入的内容顶掉。
 * 4. 两个标签页把「单个主题的属性」和「整张画布的视图操作」分开：
 *    「属性」是主题文字/备注/分支颜色；「画布」原本是浮在画布右下角的控制条，
 *    浮层会压住导图右下角的内容，收进面板后画布是干净的。
 * 5. 标签页选中项不随选中主题复位：用户切到「画布」再点主题，不该被拽回「属性」。
 */
import { computed, ref, watch } from 'vue'
import type { MindMapSelectionInfo } from '../../utils/mindmap/branch-color'

const props = defineProps<{
  /** 当前选中主题；null 表示没有选中（或选中了多个） */
  info: MindMapSelectionInfo | null
  /** 分支颜色候选（当前明暗模式下的调色板） */
  palette: string[]
  /** 是否开启彩虹分支（关闭时颜色区显示「单色模式」提示） */
  rainbow: boolean
}>()

const emit = defineEmits<{
  (event: 'update-text', value: string): void
  (event: 'update-note', value: string): void
  (event: 'pick-color', value: string | null): void
}>()

/** 属性栏的两个标签页 */
type InspectorTab = 'properties' | 'canvas'
const activeTab = ref<InspectorTab>('properties')

const tabs: { value: InspectorTab; label: string }[] = [
  { value: 'properties', label: '属性' },
  { value: 'canvas', label: '画布' }
]

const textDraft = ref('')
const noteDraft = ref('')

/** 上一次从 props 同步过来的值，用来判断草稿是否被用户改过 */
let lastText = ''
let lastNote = ''
let knownId: string | null = null

function syncDrafts(): void {
  const info = props.info
  const text = info?.text ?? ''
  const note = info?.note ?? ''
  const idChanged = (info?.id ?? null) !== knownId
  knownId = info?.id ?? null
  // 换了主题 → 整体重置；同一主题 → 只在草稿没被改过时跟随外部变化
  if (idChanged || textDraft.value === lastText) textDraft.value = text
  if (idChanged || noteDraft.value === lastNote) noteDraft.value = note
  lastText = text
  lastNote = note
}

watch(() => props.info, syncDrafts, { immediate: true })

const canSaveText = computed(() => {
  const value = textDraft.value.trim()
  if (!props.info || !value) return false
  return value !== props.info.text
})

const canSaveNote = computed(() => {
  if (!props.info) return false
  return noteDraft.value.trim() !== props.info.note
})

const hasNote = computed(() => Boolean(props.info?.note))

/** 显示用的层级描述：根主题 / 一级主题 / N 级主题 */
const depthLabel = computed(() => {
  const depth = props.info?.depth ?? 0
  if (depth === 0) return '根主题'
  return `第 ${depth} 级主题`
})

function saveText(): void {
  if (!canSaveText.value) return
  emit('update-text', textDraft.value.trim())
}

function saveNote(): void {
  if (!canSaveNote.value) return
  emit('update-note', noteDraft.value.trim())
}

/** 清空并保存 = 删除备注（与右键菜单的行为一致） */
function clearNote(): void {
  noteDraft.value = ''
  emit('update-note', '')
}

function pickColor(color: string | null): void {
  emit('pick-color', color)
}

/** 输入框里的回车不应该冒到画布上去（否则会新建主题） */
function stopEnter(event: KeyboardEvent): void {
  event.stopPropagation()
}

/**
 * 备注输入框的按键：Ctrl/Cmd+Enter 保存备注，其他按键只是拦下冒泡。
 * 写成一个函数而不是 `@keydown.enter.ctrl` + `@keydown` 两个监听：
 * 两个监听会让「Ctrl+Shift+Enter」这类组合的归属变得含糊。
 */
function onNoteKeydown(event: KeyboardEvent): void {
  event.stopPropagation()
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    saveNote()
  }
}
</script>

<template>
  <div class="mind-map-inspector">
    <div
      class="mind-map-inspector-tabs"
      role="tablist"
      aria-label="思维导图面板"
    >
      <button
        v-for="tab in tabs"
        :key="tab.value"
        type="button"
        role="tab"
        class="mind-map-inspector-tab"
        :class="{ 'is-active': activeTab === tab.value }"
        :aria-selected="activeTab === tab.value"
        :data-tab="tab.value"
        @click="activeTab = tab.value"
      >
        {{ tab.label }}
      </button>
    </div>

    <div
      v-if="activeTab === 'properties'"
      class="mind-map-inspector-panel"
      role="tabpanel"
      aria-label="属性"
    >
      <div
        v-if="!info"
        class="mind-map-inspector-empty"
      >
        <p class="mind-map-inspector-empty-title">
          未选中主题
        </p>
        <p class="mind-map-inspector-empty-hint">
          在左侧画布上点选一个主题，即可在这里修改文字、备注和分支颜色。
        </p>
      </div>

      <div
        v-else
        class="mind-map-inspector-body"
      >
        <p class="mind-map-inspector-meta">
          {{ depthLabel }} · {{ info.childCount }} 个子主题<template v-if="info.childCount > 0">
            <span v-if="info.collapsed">（已折叠）</span>
          </template>
        </p>

        <section class="mind-map-inspector-section">
          <label
            class="mind-map-inspector-label"
            for="mind-map-inspector-text"
          >主题文字</label>
          <textarea
            id="mind-map-inspector-text"
            v-model="textDraft"
            class="mind-map-inspector-input"
            rows="2"
            spellcheck="false"
            placeholder="输入主题文字"
            @keydown.enter.prevent.stop="saveText"
            @keydown.escape="textDraft = info.text"
            @keydown="stopEnter"
          />
          <div class="mind-map-inspector-actions">
            <button
              type="button"
              class="mind-map-inspector-button is-primary"
              :disabled="!canSaveText"
              @click="saveText"
            >
              保存文字
            </button>
          </div>
        </section>

        <section class="mind-map-inspector-section">
          <label
            class="mind-map-inspector-label"
            for="mind-map-inspector-note"
          >备注</label>
          <textarea
            id="mind-map-inspector-note"
            v-model="noteDraft"
            class="mind-map-inspector-input is-note"
            rows="3"
            spellcheck="false"
            placeholder="补充说明、待办、链接…"
            @keydown="onNoteKeydown"
          />
          <div class="mind-map-inspector-actions">
            <button
              type="button"
              class="mind-map-inspector-button is-primary"
              :disabled="!canSaveNote"
              @click="saveNote"
            >
              保存备注
            </button>
            <button
              type="button"
              class="mind-map-inspector-button"
              :disabled="!hasNote"
              @click="clearNote"
            >
              删除备注
            </button>
          </div>
        </section>

        <section
          v-if="!info.isRoot"
          class="mind-map-inspector-section"
        >
          <p class="mind-map-inspector-label">
            分支颜色
          </p>
          <p
            v-if="!rainbow"
            class="mind-map-inspector-hint"
          >
            当前为单色模式，开启彩虹分支后各分支才会使用不同颜色。
          </p>
          <div class="mind-map-inspector-colors">
            <button
              v-for="color in palette"
              :key="color"
              type="button"
              class="mind-map-inspector-color"
              :class="{
                'is-active': info.explicitColor && info.color.toLowerCase() === color.toLowerCase()
              }"
              :style="{ backgroundColor: color }"
              :title="color"
              :aria-label="`分支颜色 ${color}`"
              @click="pickColor(color)"
            />
            <button
              type="button"
              class="mind-map-inspector-color is-auto"
              :class="{ 'is-active': !info.explicitColor }"
              title="跟随调色板自动分配"
              @click="pickColor(null)"
            >
              自动
            </button>
          </div>
          <p class="mind-map-inspector-hint">
            {{ info.explicitColor ? '当前使用自定义颜色' : '当前跟随调色板自动分配' }}
          </p>
        </section>
      </div>
    </div>

    <div
      v-else
      class="mind-map-inspector-panel"
      role="tabpanel"
      aria-label="画布"
    >
      <p class="mind-map-inspector-hint">
        缩放、适应画布、折叠展开、彩虹分支与结构方向。这些操作作用于整张导图，不需要先选中主题。
      </p>
      <!-- 控制条由 MindMapEditor 注入：缩放/方向这些状态与渲染库实例都在那边 -->
      <slot name="controls" />
    </div>
  </div>
</template>

<style scoped>
/*
 * 面板本身不滚动：标签栏固定，只有面板内容滚动。
 * 否则标签栏会跟着内容一起滚走，切页还要先滚回顶部。
 */
.mind-map-inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  font-size: var(--ui-font-size);
}

.mind-map-inspector-tabs {
  flex-shrink: 0;
  display: flex;
  gap: 2px;
  padding: 6px 8px 0;
  border-bottom: 1px solid var(--color-border);
}

.mind-map-inspector-tab {
  padding: 5px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  background-color: transparent;
  color: var(--color-text-secondary);
  font-size: inherit;
  cursor: pointer;
}

.mind-map-inspector-tab:hover {
  color: var(--color-text);
}

.mind-map-inspector-tab.is-active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.mind-map-inspector-panel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 16px;
}

.mind-map-inspector-empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 0;
}

.mind-map-inspector-empty-title {
  margin: 0;
  color: var(--color-text-secondary);
}

.mind-map-inspector-empty-hint {
  margin: 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.6;
}

.mind-map-inspector-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.mind-map-inspector-meta {
  margin: 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.mind-map-inspector-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mind-map-inspector-label {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.mind-map-inspector-input {
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--ui-font-size);
  line-height: 1.6;
  resize: vertical;
}

.mind-map-inspector-input.is-note {
  background-color: var(--color-bg-secondary);
}

.mind-map-inspector-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.mind-map-inspector-actions {
  display: flex;
  gap: 8px;
}

.mind-map-inspector-button {
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  color: var(--color-text);
  font-size: calc(var(--ui-font-size) - 1px);
  cursor: pointer;
}

.mind-map-inspector-button.is-primary {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.mind-map-inspector-button:disabled {
  color: var(--color-text-tertiary);
  border-color: var(--color-border);
  cursor: default;
}

.mind-map-inspector-colors {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mind-map-inspector-color {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  cursor: pointer;
}

.mind-map-inspector-color:hover {
  transform: scale(1.12);
}

/* 选中色块用外圈描边表示，避免改色块本身的填充色 */
.mind-map-inspector-color.is-active {
  box-shadow:
    0 0 0 2px var(--color-bg-primary),
    0 0 0 3px var(--color-primary);
}

.mind-map-inspector-color.is-auto {
  width: auto;
  height: 22px;
  padding: 0 8px;
  border-radius: 11px;
  background-color: transparent;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.mind-map-inspector-hint {
  margin: 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
  line-height: 1.5;
}
</style>
