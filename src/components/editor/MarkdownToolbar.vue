<script setup lang="ts">
/**
 * Markdown 编辑工具栏（`.mdx` / `.md` 专用）。
 *
 * 三条设计约束：
 * 1. **只发命令，不管执行**。按钮一律往 `window` 上派发 `editor:*` 事件，
 *    真正干活的是当前挂载的那个编辑器。`EditorPanel` 里即时渲染 / 源码 / 分屏
 *    左栏是三个 `v-if` 分支，工具栏不需要知道此刻是哪一个。
 * 2. **不抢焦点**。所有按钮 `@mousedown.prevent`：一旦让按钮拿走焦点，
 *    编辑器选区会丢失（或滚动回跳），点了「加粗」等于对空选区操作。
 * 3. **高亮是编辑器的回声**。按钮亮不亮由 `editor:format-state` 决定，
 *    工具栏自己不维护任何「已按下」状态——否则点完按钮的瞬间它就和正文脱节了。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Component } from 'vue'
import {
  IconBlockquote,
  IconBold,
  IconChevronDown,
  IconCode,
  IconCodeblock,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
  IconMinus,
  IconPhoto,
  IconPilcrow,
  IconStrikethrough,
  IconTable
} from '@tabler/icons-vue'
import { useListboxMenu } from '../../composables/useListboxMenu'
import { useFileStore } from '../../stores/file'
import {
  EDITOR_FORMAT_STATE_EVENT,
  EMPTY_EDITOR_FORMAT_STATE,
  type EditorFormatState
} from '../../types/editor-format-state'
import Tooltip from '../common/Tooltip.vue'

const fileStore = useFileStore()

/** 光标处的格式快照；编辑器每次选区/文档变化会回灌一份 */
const formatState = ref<EditorFormatState>({ ...EMPTY_EDITOR_FORMAT_STATE })

function onFormatState(event: Event): void {
  const detail = (event as CustomEvent<EditorFormatState>).detail
  if (detail) formatState.value = detail
}

/**
 * 派发不带参数的命令。
 *
 * `detail` 要老实给出来：`new CustomEvent(name)` 的 `detail` 是 `null`，
 * 而处理器那边是 `const { language } = detail` 这种解构写法——解构 `null`
 * 会抛 TypeError，整个事件回调直接中断，表现就是「点了没反应」。
 */
function sendCommand(name: string, detail?: unknown): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

function applyFormat(format: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('editor:format', { detail: format }))
}

function applyHeading(level: number): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('editor:heading', { detail: level }))
}

// ===== 标题下拉 =====
/** 0 级即「正文」：与 `applyHeadingLevel(null)` 的语义对齐 */
const HEADING_OPTIONS = [
  { level: 0, label: '正文', short: '正文' },
  { level: 1, label: '标题 1', short: 'H1' },
  { level: 2, label: '标题 2', short: 'H2' },
  { level: 3, label: '标题 3', short: 'H3' },
  { level: 4, label: '标题 4', short: 'H4' },
  { level: 5, label: '标题 5', short: 'H5' },
  { level: 6, label: '标题 6', short: 'H6' }
] as const

const {
  triggerRef: headingTriggerRef,
  menuRef: headingMenuRef,
  open: headingOpen,
  activeIndex: headingActiveIndex,
  menuPosition: headingPosition,
  toggle: toggleHeadingMenu,
  choose: chooseHeading,
  onTriggerKeydown: onHeadingTriggerKeydown
} = useListboxMenu({
  count: () => HEADING_OPTIONS.length,
  // 工具栏在顶部，菜单向下弹
  prefer: 'bottom',
  itemHeight: 30,
  selectedIndex: () => Math.max(0, HEADING_OPTIONS.findIndex((item) => item.level === formatState.value.heading)),
  onChoose: (index) => {
    const option = HEADING_OPTIONS[index]
    if (option) applyHeading(option.level)
  }
})

// ===== 按钮表 =====
/** 只有「开关型」格式进这张表：标题有两个维度（有/无 + 级别），走单独的下拉 */
type ToggleKey =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'blockquote'
  | 'bulletList'
  | 'orderedList'
  | 'codeBlock'

interface ToolButton {
  /** 与 `EditorFormatState` 的键对齐，工具栏靠它决定高亮 */
  key: ToggleKey
  label: string
  /** tooltip 里的补充说明（快捷键等） */
  hint?: string
  icon: Component
  run: () => void
}

const MARK_BUTTONS: readonly ToolButton[] = [
  { key: 'bold', label: '加粗', hint: 'Ctrl+B', icon: IconBold, run: () => applyFormat('bold') },
  { key: 'italic', label: '斜体', hint: 'Ctrl+I', icon: IconItalic, run: () => applyFormat('italic') },
  { key: 'strikethrough', label: '删除线', hint: 'Ctrl+Shift+X', icon: IconStrikethrough, run: () => applyFormat('strikethrough') },
  { key: 'code', label: '行内代码', icon: IconCode, run: () => applyFormat('code') }
]

const BLOCK_BUTTONS: readonly ToolButton[] = [
  { key: 'blockquote', label: '引用', icon: IconBlockquote, run: () => applyFormat('blockquote') },
  { key: 'bulletList', label: '无序列表', icon: IconList, run: () => applyFormat('unorderedList') },
  { key: 'orderedList', label: '有序列表', icon: IconListNumbers, run: () => applyFormat('orderedList') },
  { key: 'codeBlock', label: '代码块', icon: IconCodeblock, run: () => sendCommand('editor:codeBlock', { language: '' }) }
]

function isActive(button: ToolButton): boolean {
  return Boolean(formatState.value[button.key])
}

// ===== 插入类按钮（没有「当前是否生效」的概念）=====
/** 链接复用顶栏那个对话框，不再造第二个「插入链接」实现 */
function insertLink(): void {
  sendCommand('editor:showLinkDialog')
}

/**
 * 图片直接开系统文件选择器。
 *
 * 必须走 `fileStore.addImage`：它负责压缩、写进 `.mdx` 的 `assets/images/`
 * 并把包内路径回给正文。早先那个「读成 data URL 直接塞进 Markdown」的做法
 * 会让图片变成正文里的一坨 base64，既进不了资源包也没法再编辑。
 */
async function insertImage(): Promise<void> {
  const file = await pickFile('image/*')
  if (!file) return
  const result = await fileStore.addImage(file)
  if (!result.success || !result.path) {
    await window.electronAPI?.showMessageBox({
      type: 'error',
      title: '插入图片失败',
      message: result.error || '无法把图片加入当前文档。'
    })
    return
  }
  window.dispatchEvent(
    new CustomEvent('editor:image', { detail: { src: result.path, alt: file.name } })
  )
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

onMounted(() => {
  window.addEventListener(EDITOR_FORMAT_STATE_EVENT, onFormatState)
})

onBeforeUnmount(() => {
  window.removeEventListener(EDITOR_FORMAT_STATE_EVENT, onFormatState)
})

/** 标题按钮的文案跟着光标走：在二级标题里就显示 H2 */
const headingShort = computed(() => {
  const option = HEADING_OPTIONS.find((item) => item.level === formatState.value.heading)
  return option?.short ?? '正文'
})
</script>

<template>
  <div
    class="md-toolbar"
    role="toolbar"
    aria-label="格式工具栏"
  >
    <!-- 标题：下拉选级别 -->
    <button
      ref="headingTriggerRef"
      type="button"
      class="md-tool md-heading-trigger"
      :class="{ active: formatState.heading > 0 }"
      data-format-trigger="heading"
      aria-haspopup="listbox"
      :aria-expanded="headingOpen"
      aria-label="标题级别"
      title="标题级别"
      @mousedown.prevent
      @click="toggleHeadingMenu"
      @keydown="onHeadingTriggerKeydown"
    >
      <IconPilcrow
        :size="15"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <span class="md-heading-trigger__text">{{ headingShort }}</span>
      <IconChevronDown
        :size="12"
        class="md-heading-trigger__chevron"
        :class="{ 'is-open': headingOpen }"
        aria-hidden="true"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="headingOpen"
        ref="headingMenuRef"
        class="md-heading-menu"
        role="listbox"
        aria-label="标题级别"
        :style="{
          left: `${headingPosition.left}px`,
          top: `${headingPosition.top}px`,
          width: `${headingPosition.width}px`
        }"
        @pointerdown.prevent
      >
        <button
          v-for="(option, index) in HEADING_OPTIONS"
          :key="option.level"
          type="button"
          class="md-heading-menu__item"
          role="option"
          :data-heading-level="option.level"
          :aria-selected="option.level === formatState.heading"
          :class="{
            'is-active': index === headingActiveIndex,
            'is-selected': option.level === formatState.heading
          }"
          @mouseenter="headingActiveIndex = index"
          @click="chooseHeading(index)"
        >
          <span :class="`md-heading-menu__label md-heading-menu__label--${option.level}`">
            {{ option.label }}
          </span>
        </button>
      </div>
    </Teleport>

    <span class="md-toolbar__divider" />

    <!-- 行内标记 -->
    <Tooltip
      v-for="button in MARK_BUTTONS"
      :key="button.key"
      :content="button.hint ? `${button.label} ${button.hint}` : button.label"
    >
      <button
        type="button"
        class="md-tool"
        :class="{ active: isActive(button) }"
        :data-format="button.key"
        :aria-label="button.label"
        :aria-pressed="isActive(button)"
        @mousedown.prevent
        @click="button.run"
      >
        <component
          :is="button.icon"
          :size="16"
          :stroke-width="1.8"
        />
      </button>
    </Tooltip>

    <span class="md-toolbar__divider" />

    <!-- 块级结构 -->
    <Tooltip
      v-for="button in BLOCK_BUTTONS"
      :key="button.key"
      :content="button.label"
    >
      <button
        type="button"
        class="md-tool"
        :class="{ active: isActive(button) }"
        :data-format="button.key"
        :aria-label="button.label"
        :aria-pressed="isActive(button)"
        @mousedown.prevent
        @click="button.run"
      >
        <component
          :is="button.icon"
          :size="16"
          :stroke-width="1.8"
        />
      </button>
    </Tooltip>

    <span class="md-toolbar__divider" />

    <!-- 插入 -->
    <Tooltip content="链接">
      <button
        type="button"
        class="md-tool"
        data-format="link"
        aria-label="插入链接"
        @mousedown.prevent
        @click="insertLink"
      >
        <IconLink
          :size="16"
          :stroke-width="1.8"
        />
      </button>
    </Tooltip>
    <Tooltip content="图片">
      <button
        type="button"
        class="md-tool"
        data-format="image"
        aria-label="插入图片"
        @mousedown.prevent
        @click="insertImage"
      >
        <IconPhoto
          :size="16"
          :stroke-width="1.8"
        />
      </button>
    </Tooltip>
    <Tooltip content="表格">
      <button
        type="button"
        class="md-tool"
        data-format="table"
        aria-label="插入表格"
        @mousedown.prevent
        @click="applyFormat('table')"
      >
        <IconTable
          :size="16"
          :stroke-width="1.8"
        />
      </button>
    </Tooltip>
    <Tooltip content="分割线">
      <button
        type="button"
        class="md-tool"
        data-format="horizontalRule"
        aria-label="插入分割线"
        @mousedown.prevent
        @click="applyFormat('horizontalRule')"
      >
        <IconMinus
          :size="16"
          :stroke-width="1.8"
        />
      </button>
    </Tooltip>
  </div>
</template>

<style scoped>
.md-toolbar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
  height: 36px;
  padding: 0 8px;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-bg-secondary);
  /* 窄窗口下允许横向滚动，但不画滚动条：36px 高的条里露出半截滚动条很难看 */
  scrollbar-width: none;
}

.md-toolbar::-webkit-scrollbar {
  display: none;
}

.md-toolbar__divider {
  flex: 0 0 auto;
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background-color: var(--color-border);
}

/*
 * `Tooltip` 的触发器默认 `flex: 1`（它是为了让菜单项里的内容撑满整行而设的）。
 * 放进这条横排工具栏会变成「每个按钮外面的壳平分剩余宽度」——按钮之间被拉开
 * 一道道的空档，看着像漏了图标。
 */
.md-toolbar :deep(.tooltip-trigger) {
  flex: 0 0 auto;
}

.md-tool {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;
}

.md-tool:hover {
  background-color: var(--color-bg-tertiary);
  color: var(--color-text);
}

/* 当前生效的格式：浅蓝底 + 主题色，和顶栏「当前段」同一种表达 */
.md-tool.active {
  background-color: var(--color-primary-light);
  color: var(--color-on-primary-light);
}

.md-tool:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

/* ===== 标题下拉触发器 ===== */
.md-heading-trigger {
  gap: 5px;
  width: auto;
  min-width: 62px;
  padding: 0 6px;
  font-size: calc(var(--ui-font-size) - 1px);
  white-space: nowrap;
}

.md-heading-trigger__text {
  min-width: 22px;
  text-align: left;
}

.md-heading-trigger__chevron {
  color: var(--color-text-tertiary);
  transition: transform 0.15s ease;
}

.md-heading-trigger__chevron.is-open {
  transform: rotate(180deg);
}

.md-heading-menu {
  position: fixed;
  z-index: var(--z-popover);
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  box-shadow: 0 10px 28px rgb(0 0 0 / 20%);
  animation: md-heading-in 0.12s ease-out;
}

.md-heading-menu__item {
  display: flex;
  width: 100%;
  align-items: center;
  padding: 6px 9px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-size: calc(var(--ui-font-size) - 1px);
  text-align: left;
  cursor: pointer;
}

.md-heading-menu__item.is-active {
  background-color: var(--color-bg-tertiary);
}

.md-heading-menu__item.is-selected {
  color: var(--color-primary);
  font-weight: 600;
}

/* 菜单里按级别给出视觉大小：选级别这件事靠字形分辨比读数字快 */
.md-heading-menu__label--0 { font-weight: 400; }
.md-heading-menu__label--1 { font-size: 15px; font-weight: 700; }
.md-heading-menu__label--2 { font-size: 14px; font-weight: 700; }
.md-heading-menu__label--3 { font-size: 13px; font-weight: 600; }
.md-heading-menu__label--4,
.md-heading-menu__label--5,
.md-heading-menu__label--6 { font-weight: 600; }

@keyframes md-heading-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .md-heading-menu { animation: none; }
  .md-heading-trigger__chevron { transition: none }
}
</style>
