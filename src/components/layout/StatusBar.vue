<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component } from 'vue'
import {
  IconChartDots,
  IconCode,
  IconColumns,
  IconFileText,
  IconFileTypePdf,
  IconPhoto,
  IconSitemap
} from '@tabler/icons-vue'
import { useFileStore, type EditorMode } from '../../stores/file'
import { useWorkspaceStore } from '../../stores/workspace'
import { resolveViewLabel } from '../../utils/view-label'
import { resolveZoomProfile, useZoomStore } from '../../stores/zoom'
import Tooltip from '../common/Tooltip.vue'
import ZoomControl from './ZoomControl.vue'

const fileStore = useFileStore()
const workspaceStore = useWorkspaceStore()
const zoomStore = useZoomStore()
const appVersion = ref('')

/**
 * 三种 Markdown 编辑模式。
 *
 * 状态栏给三个并列按钮：点哪个就切到哪个，不必像旧版单按钮那样循环。
 * 顺序与「视图 → 编辑器模式」菜单一致（即时渲染 / 源码编辑 / 分屏预览）；
 * 快捷键 Ctrl+/ 仍是循环切换（见 shortcuts/registry.ts 的 `editor.toggle-mode`）。
 */
const MODE_OPTIONS: ReadonlyArray<{
  value: Exclude<EditorMode, 'plain'>
  label: string
  title: string
  icon: Component
}> = [
  { value: 'ir', label: '即时渲染', title: '即时渲染（Ctrl+/ 循环切换）', icon: IconFileText },
  { value: 'source', label: '源码编辑', title: '源码编辑（Ctrl+/ 循环切换）', icon: IconCode },
  { value: 'split', label: '分屏预览', title: '分屏预览（Ctrl+/ 循环切换）', icon: IconColumns }
]

/** 当前生效的编辑模式：非 .md/.mdx 文件（如 .txt）实际按源码编辑显示 */
const effectiveMode = computed<EditorMode>(() =>
  fileStore.effectiveEditorMode
)

/** 当前标签是否为思维导图（不属于编辑模式体系，只做展示） */
const isMindMapActive = computed(() => fileStore.activeTab?.fileInfo?.format === 'mindmap')

/** 当前标签是否为图表：内容是一坨 XML，字数统计对它没意义（store 里换成了图元数） */
const isDiagramActive = computed(() => fileStore.activeTab?.fileInfo?.format === 'diagram')

/** 当前标签是否为图片：只读查看，正文是空的 */
const isImageActive = computed(() => fileStore.activeTab?.fileInfo?.format === 'image')

/** 只读媒体（图片 / PDF）：没有正文、没有光标，`content` 恒为空串 */
const isMediaActive = computed(() => isImageActive.value || fileStore.isPdfActiveTab)

/** 画布类视图（导图 / 图表）：有统计意义，但没有光标行列 */
const isCanvasActive = computed(() => isMindMapActive.value || isDiagramActive.value)

/**
 * 光标行列只对文本编辑器有意义。
 *
 * 图片 / PDF / 导图 / 图表上永远停在「行 1, 列 1」——那个 1 不是位置，是没人写过。
 */
const showsCursor = computed(() => !isMediaActive.value && !isCanvasActive.value)

/**
 * 字数：图片 / PDF 没有正文可数（`content` 是空串，统计出来恒为 0）。
 * 导图数的是节点文字、图表数的是图元，两者都有意义，保留。
 */
const showsWordCount = computed(() => !isMediaActive.value)

/** 计数标签名：图表统计的是图元个数 */
const countLabel = computed(() => (isDiagramActive.value ? '图元' : '字数'))

onMounted(async () => {
  try {
    appVersion.value = await window.electronAPI.getVersion()
  } catch {
    appVersion.value = ''
  }
})

const appLabel = computed(() => {
  return appVersion.value ? `Inkase v${appVersion.value}` : 'Inkase'
})

/**
 * 文件大小。
 *
 * 文本按正文算——正文就是文件内容。图片 / PDF 的正文是空串（内容在
 * `imageDataUrl` / `pdfBase64` 里），按正文算会显示成「0 B」，所以这两种从
 * base64 载荷还原真实字节数：每 4 个字符 3 字节，末尾的 `=` 是补位。
 */
const fileSize = computed(() => {
  const bytes = isMediaActive.value ? mediaPayloadBytes() : new Blob([fileStore.fileContent]).size
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
})

function mediaPayloadBytes(): number {
  const tab = fileStore.activeTab
  const payload = tab?.imageDataUrl ?? tab?.pdfBase64 ?? ''
  if (!payload) return 0
  const comma = payload.indexOf(',')
  const body = comma >= 0 ? payload.slice(comma + 1) : payload
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding)
}

const saveStatus = computed(() => {
  if (fileStore.isLoading) return '加载中...'
  if (fileStore.isModified) return '未保存'
  return '已保存'
})

const saveStatusClass = computed(() => {
  if (fileStore.isLoading) return 'loading'
  if (fileStore.isModified) return 'modified'
  return 'saved'
})

/**
 * 只读标签的图标：按「当前是什么视图」选，与标签栏的文件图标保持一致
 * （图片 `IconPhoto`、导图 `IconSitemap`、图表 `IconChartDots`，见 `utils/file-icons.ts`）。
 */
const modeIconComponent = computed<Component>(() => {
  if (fileStore.isPdfActiveTab) return IconFileTypePdf
  if (isImageActive.value) return IconPhoto
  if (isMindMapActive.value) return IconSitemap
  if (isDiagramActive.value) return IconChartDots
  if (effectiveMode.value === 'split') return IconColumns
  if (effectiveMode.value === 'ir') return IconFileText
  return IconCode
})

/**
 * 获取模式展示名。
 *
 * 非 Markdown 的文件 `effectiveEditorMode` 一律是 `plain`，名字交给
 * `resolveViewLabel` 按格式/后缀给出（图片、PDF、导图、图表都不该被叫成「纯文本」）。
 */
const modeLabel = computed(() => {
  if (effectiveMode.value === 'plain') {
    return resolveViewLabel({
      format: fileStore.activeTab?.fileInfo?.format,
      name: fileStore.activeTab?.fileInfo?.name
    })
  }
  const labels: Record<Exclude<EditorMode, 'plain'>, string> = {
    split: '分屏预览',
    source: '源码编辑',
    ir: '即时渲染'
  }
  return labels[effectiveMode.value]
})

/**
 * 不可切换的文件（PDF / 导图 / 纯文本）只展示当前形态，
 * 提示语不再写「点击切换」——那个按钮在这种文件上是 disabled 的。
 */
const modeTooltip = computed(() => modeLabel.value)

/**
 * 右下角的缩放控件：能力按「当前标签的格式」查表，数值按 tabId 从 zoom store 取。
 * 不支持缩放的视图（.drawio 图表、HTML 预览）返回 null，整组不渲染。
 *
 * 两道前置判断都不能少，它们不是「格式」问题而是「当前有没有文档视图」的问题：
 * - **工作台在前台**（图谱 / AI）：它不是文档视图，没有任何缩放语义。切到工作台时
 *   `activeTabId` 仍停留在上一个文件上（工作台与文件标签是并列的前台状态，不是同一个
 *   列表），不挡这一层就会按那个文件的格式冒出一个失效的读数；
 * - **没有活动标签**（欢迎页）：同理，没有可缩放的东西。
 */
const zoomProfile = computed(() => {
  if (workspaceStore.active) return null
  if (fileStore.activeTabId === null) return null
  return resolveZoomProfile({
    format: fileStore.activeTab?.fileInfo?.format,
    isHtmlFile: fileStore.isHtmlFile,
    htmlPreviewActive: fileStore.htmlPreviewActive
  })
})

const zoomTabId = computed(() => fileStore.activeTabId)
const zoomValue = computed(() => zoomStore.valueOf(zoomTabId.value))
const zoomCanFit = computed(() => zoomStore.hasFit(zoomTabId.value))

function onZoomStep(direction: 1 | -1): void {
  const profile = zoomProfile.value
  if (!profile) return
  zoomStore.step(zoomTabId.value, profile, direction)
}

function onZoomSet(value: number): void {
  const profile = zoomProfile.value
  if (!profile) return
  zoomStore.set(zoomTabId.value, value, profile)
}

function onZoomFit(): void {
  zoomStore.requestFit(zoomTabId.value)
}

// 标签关闭后它的缩放倍率没有意义了。tabId 是自增的，重开不会复用旧值，
// 但残留的键会一直躺在 store 里，顺手清掉。
watch(
  () => fileStore.tabs.map((tab) => tab.id),
  (ids) => zoomStore.prune(ids),
  { immediate: true }
)
</script>

<template>
  <footer class="status-bar">
    <!-- 左侧统计：字数与光标行列只对「有正文 / 有光标」的视图有意义 -->
    <div class="status-left">
      <template v-if="showsWordCount">
        <span class="status-item">{{ countLabel }}: {{ fileStore.wordCount }}</span>
        <span class="status-separator">|</span>
      </template>
      <span class="status-item">文件大小: {{ fileSize }}</span>
      <template v-if="showsCursor">
        <span class="status-separator">|</span>
        <span class="status-item">
          行 {{ fileStore.cursorLine }}, 列 {{ fileStore.cursorColumn }}
        </span>
      </template>
    </div>

    <div class="status-right">
      <!-- 编辑模式：可切换时给三个并列按钮，点哪个切哪个；其余文件类型维持只读标签 -->
      <div
        v-if="fileStore.canSwitchEditorMode"
        class="mode-switch"
        role="group"
        aria-label="编辑模式"
      >
        <button
          v-for="option in MODE_OPTIONS"
          :key="option.value"
          class="mode-switch-btn"
          :class="[option.value, { active: effectiveMode === option.value }]"
          :title="option.title"
          :aria-label="option.label"
          :aria-pressed="effectiveMode === option.value"
          @click="fileStore.setEditorMode(option.value)"
        >
          <component :is="option.icon" />
          <span class="mode-label">{{ option.label }}</span>
        </button>
      </div>
      <!-- 不可切换（PDF / 图片 / 思维导图 / 图表 / 纯文本）：展示当前形态，不再提供切换 -->
      <Tooltip
        v-else
        :content="modeTooltip"
      >
        <button
          class="mode-toggle-btn"
          :class="effectiveMode"
          disabled
        >
          <component :is="modeIconComponent" />
          <span class="mode-label">{{ modeLabel }}</span>
        </button>
      </Tooltip>

      <span class="status-separator">|</span>

      <span
        class="status-item"
        :class="saveStatusClass"
      >
        {{ saveStatus }}
      </span>
      <template v-if="appVersion">
        <span class="status-separator">|</span>
        <span class="status-item">{{ appLabel }}</span>
      </template>

      <!-- 缩放读数固定在右下角：支持缩放的文件才渲染，其余类型整组隐藏 -->
      <template v-if="zoomProfile">
        <span class="status-separator">|</span>
        <ZoomControl
          :profile="zoomProfile"
          :value="zoomValue"
          :can-fit="zoomCanFit"
          @step="onZoomStep"
          @set="onZoomSet"
          @fit="onZoomFit"
        />
      </template>
    </div>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--statusbar-height);
  padding: 0 var(--spacing-md);
  background-color: var(--color-bg-secondary);
  border-top: 1px solid var(--color-border);
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.status-right > :deep(.tooltip-trigger) {
  flex: 0 0 auto;
}

.status-item {
  white-space: nowrap;
}

.status-separator {
  color: var(--color-border-hover);
  user-select: none;
}

.saved {
  color: var(--color-success);
}

.modified {
  color: var(--color-warning);
}

.loading {
  color: var(--color-text-tertiary);
}

/* 模式切换：三个并列按钮组成的分段控件。
   选中靠整块圆角高亮表示，按钮之间不画分隔线 */
.mode-switch {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
}

.mode-switch-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  font-size: calc(var(--ui-font-size) - 1px);
  font-weight: 500;
  color: var(--color-text-secondary);
  background-color: transparent;
  border: 0;
  /* 圆角在这里：选中时整块背景左右两端都是圆角，不会被容器裁成直角 */
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.mode-switch-btn svg {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}

.mode-switch-btn:hover {
  color: var(--color-text);
  background-color: var(--color-bg-secondary);
}

/* 选中态：圆角高亮块 */
.mode-switch-btn.active {
  font-weight: 600;
}

.mode-switch-btn.active.split {
  color: #8b5cf6;
  background-color: rgba(139, 92, 246, 0.16);
}

.mode-switch-btn.active.source {
  color: #10b981;
  background-color: rgba(16, 185, 129, 0.16);
}

.mode-switch-btn.active.ir {
  color: #f59e0b;
  background-color: rgba(245, 158, 11, 0.16);
}

/* 模式切换按钮（不可切换文件上的只读标签） */
.mode-toggle-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: calc(var(--ui-font-size) - 1px);
  font-weight: 500;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.mode-toggle-btn svg {
  width: 14px;
  height: 14px;
}

.mode-toggle-btn:hover {
  border-color: var(--color-border-hover);
  background-color: var(--color-bg-secondary);
}

.mode-toggle-btn.split {
  color: #8b5cf6;
  border-color: #8b5cf6;
  background-color: rgba(139, 92, 246, 0.1);
}

.mode-toggle-btn.source {
  color: #10b981;
  border-color: #10b981;
  background-color: rgba(16, 185, 129, 0.1);
}

.mode-toggle-btn.ir {
  color: #f59e0b;
  border-color: #f59e0b;
  background-color: rgba(245, 158, 11, 0.1);
}

.mode-toggle-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mode-toggle-btn:disabled:hover {
  border-color: var(--color-border);
  background-color: var(--color-bg-primary);
}

.mode-label {
  white-space: nowrap;
}
</style>
