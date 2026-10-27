<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import {
  IconMessageChatbot,
  IconX,
  type Icon
} from '@tabler/icons-vue'
import { useFileStore } from '../../stores/file'
import { useAiStore } from '../../stores/ai'
import { useAppearanceStore } from '../../stores/appearance'
import type { TabInfo } from '../../stores/file'
import { FILE_ICON_COMPONENTS, getFileIconKey, type FileIconKey } from '../../utils/file-icons'
import { fitMiddleEllipsis } from '../../utils/middle-ellipsis'
import { buildBarItems } from '../../utils/tab-order'
import Tooltip from '../common/Tooltip.vue'

const fileStore = useFileStore()
const aiStore = useAiStore()
const appearanceStore = useAppearanceStore()

// 标签过多时，自动把当前活动标签滚动到可见区域
watch(
  () => fileStore.activeTabId,
  (id) => {
    if (!id) return
    nextTick(() => {
      const el = document.querySelector(`[data-tab-id="${id}"]`) as HTMLElement | null
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
)

// 标签不再压缩后，标签栏可能横向滚动；AI 面板激活时把 AI 标签带回可见区域
watch(
  () => aiStore.panelActive,
  (active) => {
    if (!active) return
    nextTick(() => {
      const el = document.querySelector('[data-testid="ai-tab"]') as HTMLElement | null
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
)

async function handleTabClick(tabId: string): Promise<void> {
  aiStore.deactivatePanel()
  await fileStore.setActiveTab(tabId)
}

/** 双击预览标签将其转正（普通标签无操作） */
function handleTabDblClick(tabId: string): Promise<void> {
  if (fileStore.tabs.find((tab) => tab.id === tabId)?.isPreview) {
    fileStore.pinActivePreviewTab()
  }
  return Promise.resolve()
}

function handleAiMiddleClick(event: MouseEvent): void {
  if (event.button !== 1) return
  event.preventDefault()
  void aiStore.requestClosePanel()
}

function handleAiClose(event: MouseEvent): void {
  event.stopPropagation()
  void aiStore.requestClosePanel()
}

function handleMiddleClick(tabId: string, event: MouseEvent): void {
  if (event.button === 1) {
    event.preventDefault()
    fileStore.closeTab(tabId)
  }
}

async function handleCloseTab(tabId: string, event: MouseEvent): Promise<void> {
  event.stopPropagation()
  await fileStore.closeTab(tabId)
}

// ========== 拖动排序 ==========
const barItems = computed(() => buildBarItems(fileStore.tabs, aiStore.panelOpen, aiStore.tabIndex))

const dragTabId = ref<string | null>(null)
const dropIndex = ref<number | null>(null)

function resetDrag(): void {
  dragTabId.value = null
  dropIndex.value = null
}

function onTabDragStart(key: string, event: DragEvent): void {
  dragTabId.value = key
  dropIndex.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', key)
  }
}

function onTabDragOver(index: number, event: DragEvent): void {
  if (!dragTabId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const after = event.clientX > rect.left + rect.width / 2
  dropIndex.value = after ? index + 1 : index
}

function onTabDrop(event: DragEvent): void {
  event.preventDefault()
  const draggedKey = dragTabId.value
  const index = dropIndex.value
  resetDrag()
  if (draggedKey === null || index === null) return

  const items = barItems.value
  const from = items.findIndex((item) => item.key === draggedKey)
  if (from === -1) return
  const to = Math.max(0, Math.min(index, items.length))
  if (to === from || to === from + 1) return

  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(from < to ? to - 1 : to, 0, moved)

  // AI 位置按统一序列重新推导：文件标签跨过 AI 时也必须更新 AI 索引，
  // 否则「文件相对顺序不变」会导致拖拽结果丢失
  const aiIndex = next.findIndex((item) => item.kind === 'ai')
  if (aiIndex !== -1 && aiIndex !== items.findIndex((item) => item.kind === 'ai')) {
    aiStore.setTabIndex(aiIndex)
  }
  fileStore.reorderTabs(next.filter((item) => item.kind === 'file').map((item) => item.key))
}

function onTabDragEnd(): void {
  resetDrag()
}

function getTabLabel(tab: TabInfo): string {
  return tab.fileInfo?.name || '未命名.mdx'
}

// ========== 文件名中间省略 ==========
/** 标签最大宽度（px），与 .tab 的 max-width 保持一致 */
const TAB_MAX_WIDTH = 200
/** 除文件名外标签内的固定占位：左右内边距 18 + 图标 14 + 两处间距 12 + 关闭按钮 18 + 左右描边 2 */
const TAB_CHROME_WIDTH = 64
/** 未保存圆点及其与文件名之间的间距 */
const TAB_MODIFIED_DOT_WIDTH = 14
/** 测量余量，避免四舍五入后又被 CSS 省略一次 */
const TAB_LABEL_SAFETY = 2

let measureCtx: OffscreenCanvasRenderingContext2D | null | undefined
let measureFontFamily = ''

function getBodyFontFamily(): string {
  if (!measureFontFamily && typeof document !== 'undefined') {
    measureFontFamily = window.getComputedStyle(document.body).fontFamily || 'sans-serif'
  }
  return measureFontFamily || 'sans-serif'
}

function getMeasureContext(): OffscreenCanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx
  if (typeof OffscreenCanvas === 'undefined') {
    measureCtx = null
    return measureCtx
  }
  try {
    measureCtx = new OffscreenCanvas(1, 1).getContext('2d')
  } catch {
    measureCtx = null
  }
  return measureCtx
}

/**
 * 按当前主界面字号测量文本宽度。
 * 测试环境没有 OffscreenCanvas，退化为字符估算，保证逻辑可验证。
 */
function measureLabelWidth(value: string): number {
  const fontSize = appearanceStore.uiFontSize
  const ctx = getMeasureContext()
  if (ctx) {
    ctx.font = `${fontSize}px ${getBodyFontFamily()}`
    return ctx.measureText(value).width
  }
  let width = 0
  for (const char of value) {
    width += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char) ? fontSize : fontSize * 0.55
  }
  return width
}

function getLabelMaxWidth(tab: TabInfo): number {
  const dotWidth = tab.fileInfo?.modified ? TAB_MODIFIED_DOT_WIDTH : 0
  return Math.max(0, TAB_MAX_WIDTH - TAB_CHROME_WIDTH - dotWidth - TAB_LABEL_SAFETY)
}

/** 逐标签缓存显示文本：只有超宽的文件名才做中间省略，tooltip 始终用完整名称 */
const tabDisplayLabels = computed<Record<string, string>>(() => {
  const labels: Record<string, string> = {}
  for (const tab of fileStore.tabs) {
    labels[tab.id] = fitMiddleEllipsis(getTabLabel(tab), getLabelMaxWidth(tab), measureLabelWidth)
  }
  return labels
})

function getTabIconKey(tab: TabInfo): FileIconKey {
  return getFileIconKey(getTabLabel(tab), false)
}

function getTabIcon(tab: TabInfo): Icon {
  return FILE_ICON_COMPONENTS[getTabIconKey(tab)]
}

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'inkase:close-context-menus'

interface ContextMenuItem {
  label: string
  action: () => void
}

const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  items: [] as ContextMenuItem[]
})

function closeContextMenu(): void {
  contextMenu.visible = false
}

function showContextMenu(event: MouseEvent, items: ContextMenuItem[]): void {
  window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
  contextMenu.items = items
  contextMenu.x = event.clientX
  contextMenu.y = event.clientY
  contextMenu.visible = true

  nextTick(() => {
    const menuEl = document.querySelector('.tab-context-menu') as HTMLElement | null
    if (!menuEl) return
    const rect = menuEl.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      contextMenu.x = window.innerWidth - rect.width - 8
    }
    if (rect.bottom > window.innerHeight) {
      contextMenu.y = window.innerHeight - rect.height - 8
    }
  })
}

function onTabContextMenu(event: MouseEvent, tab: TabInfo): void {
  const items: ContextMenuItem[] = [
    {
      label: '导出 PDF',
      action: () => { void fileStore.exportTabToPdf(tab.id) }
    },
    {
      label: '关闭',
      action: () => { void fileStore.closeTab(tab.id) }
    },
    {
      label: '关闭其他',
      action: () => { void fileStore.closeOtherTabs(tab.id) }
    },
    {
      label: '关闭全部',
      action: () => { void fileStore.closeAllTabs() }
    },
    // 未保存的临时文档没有磁盘路径，显示该项只会静默无反应
    ...(tab.fileInfo?.path
      ? [{
          label: '打开文件所在位置',
          action: () => { void fileStore.revealInExplorer(tab.fileInfo!.path) }
        }]
      : [])
  ]
  showContextMenu(event, items)
}

onMounted(() => {
  document.addEventListener('click', closeContextMenu)
  document.addEventListener('contextmenu', closeContextMenu, true)
  window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeContextMenu)
  window.addEventListener('blur', closeContextMenu)
})

onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
  document.removeEventListener('contextmenu', closeContextMenu, true)
  window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeContextMenu)
  window.removeEventListener('blur', closeContextMenu)
})
</script>

<template>
  <div
    v-if="barItems.length > 0"
    class="tab-bar"
  >
    <template
      v-for="(item, index) in barItems"
      :key="item.key"
    >
      <div
        v-if="item.kind === 'file'"
        :data-tab-id="item.tab.id"
        class="tab"
        :class="{ active: !aiStore.panelActive && item.tab.id === fileStore.activeTabId, preview: item.tab.isPreview, dragging: dragTabId === item.key }"
        draggable="true"
        @click="handleTabClick(item.tab.id)"
        @dblclick="handleTabDblClick(item.tab.id)"
        @mousedown="handleMiddleClick(item.tab.id, $event)"
        @contextmenu.prevent.stop="onTabContextMenu($event, item.tab)"
        @dragstart="onTabDragStart(item.key, $event)"
        @dragover="onTabDragOver(index, $event)"
        @drop="onTabDrop"
        @dragend="onTabDragEnd"
      >
        <span
          v-if="dropIndex === index"
          class="drop-indicator drop-indicator-start"
        />
        <span
          v-if="dropIndex === index + 1"
          class="drop-indicator drop-indicator-end"
        />

        <!-- 图标 + 文件名 + 修改指示器统一放进 Tooltip 触发器：
             鼠标落在标签内容区的任意位置都能看到完整文件名，而不只是悬停在文字上 -->
        <Tooltip :content="getTabLabel(item.tab)">
          <component
            :is="getTabIcon(item.tab)"
            class="tab-icon"
            :data-file-icon="getTabIconKey(item.tab)"
            :size="16"
            stroke="1.8"
          />

          <span class="tab-label">{{ tabDisplayLabels[item.tab.id] ?? getTabLabel(item.tab) }}</span>

          <!-- 修改指示器（未保存时显示圆点） -->
          <span
            v-if="item.tab.fileInfo?.modified"
            class="tab-modified-dot"
          />
        </Tooltip>

        <!-- 关闭按钮 -->
        <button
          class="tab-close-btn"
          draggable="false"
          @click="handleCloseTab(item.tab.id, $event)"
        >
          <IconX :size="14" />
        </button>
      </div>

      <div
        v-else
        class="tab ai-tab"
        :class="{ active: aiStore.panelActive, dragging: dragTabId === item.key }"
        data-testid="ai-tab"
        draggable="true"
        @click="aiStore.activatePanel()"
        @mousedown="handleAiMiddleClick"
        @dragstart="onTabDragStart(item.key, $event)"
        @dragover="onTabDragOver(index, $event)"
        @drop="onTabDrop"
        @dragend="onTabDragEnd"
      >
        <span
          v-if="dropIndex === index"
          class="drop-indicator drop-indicator-start"
        />
        <span
          v-if="dropIndex === index + 1"
          class="drop-indicator drop-indicator-end"
        />

        <IconMessageChatbot
          class="tab-icon"
          :size="16"
          stroke="1.8"
        />
        <span class="tab-label">AI 助手</span>
        <Tooltip
          v-if="aiStore.pendingApprovals.length > 0"
          content="等待审批"
        >
          <span
            class="ai-status-marker approval"
            data-testid="ai-approval-marker"
          >!</span>
        </Tooltip>
        <Tooltip
          v-else-if="aiStore.running"
          content="正在生成"
        >
          <span
            class="ai-status-marker running"
            data-testid="ai-running-marker"
          />
        </Tooltip>
        <Tooltip content="关闭 AI 助手">
          <button
            class="tab-close-btn"
            data-testid="ai-tab-close"
            draggable="false"
            @click="handleAiClose"
          >
            <IconX :size="14" />
          </button>
        </Tooltip>
      </div>
    </template>
  </div>

  <teleport to="body">
    <div
      v-if="contextMenu.visible"
      class="tab-context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <div
        v-for="(item, index) in contextMenu.items"
        :key="index"
        class="context-menu-item"
        @click="closeContextMenu(); item.action()"
      >
        {{ item.label }}
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  height: 36px;
  padding: 0 6px;
  gap: 4px;
  background-color: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
  scrollbar-width: thin;
}

.tab-bar::-webkit-scrollbar {
  height: 3px;
}

.tab-bar::-webkit-scrollbar-thumb {
  background-color: var(--color-border);
  border-radius: 2px;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 10px;
  /* 上下留白让胶囊与编辑区之间保持间隔，不再连成一体 */
  margin: 4px 0;
  max-width: 200px;
  /* 不压缩：超出时由标签栏横向滚动，避免把文件名挤到无法阅读 */
  flex: 0 0 auto;
  position: relative;
  white-space: nowrap;
  font-size: var(--ui-font-size);
  color: var(--color-text-secondary);
  /* 未选中标签使用实心底色，与标签栏底色区分；深浅主题各有一套变量 */
  background-color: var(--color-tab-bg);
  /* 未选中也有圆角描边；border-hover 在深浅两套主题下都区别于标签栏底色 */
  border: 1px solid var(--color-border-hover);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s, box-shadow 0.15s;
  user-select: none;
}

.tab:hover {
  background-color: var(--color-tab-bg-hover);
  color: var(--color-text);
}

.tab.active {
  background-color: var(--color-bg-primary);
  color: var(--color-text);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
}

.tab.active:hover {
  background-color: var(--color-bg-primary);
}

/* 图标 + 文件名 + 修改圆点所在的 Tooltip 触发器：撑满标签内容区。
   AI 标签里的 Tooltip 只包状态标记，不能参与拉伸，故排除 .ai-tab */
.tab:not(.ai-tab) :deep(.tooltip-trigger) {
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
}

.tab.dragging {
  opacity: 0.45;
}

.drop-indicator {
  position: absolute;
  top: 4px;
  bottom: 4px;
  width: 2px;
  border-radius: 1px;
  background-color: var(--color-primary);
  pointer-events: none;
  z-index: 1;
}

.drop-indicator-start {
  left: -1px;
}

.drop-indicator-end {
  right: -1px;
}

.tab-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--file-icon-color, var(--color-text-secondary));
}

.tab.active .tab-icon {
  color: var(--color-primary);
}

.tab.preview .tab-label {
  font-style: italic;
}

.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}

/* Tooltip 的根节点是 fragment（span + Teleport），父组件的 scoped 选择器
   只有配合 :deep 才能命中；否则状态标记所在的触发器会被撑开 */
.ai-tab :deep(.tooltip-trigger) {
  flex: 0 0 auto;
}

.tab-modified-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--color-warning);
  flex-shrink: 0;
}

.ai-status-marker {
  flex-shrink: 0;
}

.ai-status-marker.running {
  width: 8px;
  height: 8px;
  border: 2px solid var(--color-primary);
  border-right-color: transparent;
  border-radius: 50%;
  animation: ai-tab-spin 0.8s linear infinite;
}

.ai-status-marker.approval {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  color: white;
  background: var(--color-warning);
  border-radius: 50%;
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 700;
}

@keyframes ai-tab-spin {
  to { transform: rotate(360deg); }
}

.tab-close-btn {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s, background-color 0.15s, color 0.15s;
  padding: 0;
}

.tab:hover .tab-close-btn,
.tab.active .tab-close-btn,
.tab-close-btn:focus-visible {
  opacity: 1;
}

.tab-close-btn:focus-visible {
  outline: 1px solid var(--color-primary);
  outline-offset: -1px;
}

.tab-close-btn:hover {
  background-color: rgba(128, 128, 128, 0.2);
  color: var(--color-text);
}

.tab-close-btn svg {
  width: 12px;
  height: 12px;
}
</style>

<style>
.tab-context-menu {
  position: fixed;
  z-index: 10001;
  min-width: 160px;
  padding: 4px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}

.tab-context-menu .context-menu-item {
  padding: 6px 14px;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s;
}

.tab-context-menu .context-menu-item:hover {
  background: var(--color-bg-secondary);
}
</style>
