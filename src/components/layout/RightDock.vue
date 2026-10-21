<script setup lang="ts">
/**
 * 右侧三合一停靠面板
 *
 * 反链 / 图谱 / AI 共用一个可调宽面板（图谱为 P1 内容，此处先占位）；
 * 宽度与当前页签持久化在 dock store 中。
 */
import { computed, onUnmounted, ref } from 'vue'
import { IconLink, IconMaximize, IconMessageChatbot, IconTopologyStar3, IconX } from '@tabler/icons-vue'
import { clampDockWidth, useDockStore, type DockTab } from '../../stores/dock'
import AiPanel from '../ai/AiPanel.vue'
import BacklinksPanel from '../knowledge/BacklinksPanel.vue'

const props = defineProps<{ ready: boolean }>()
const emit = defineEmits<{ openSettings: []; expandAi: [] }>()

const dock = useDockStore()

const tabs: ReadonlyArray<{ id: DockTab; label: string; icon: unknown }> = [
  { id: 'backlinks', label: '反链', icon: IconLink },
  { id: 'graph', label: '图谱', icon: IconTopologyStar3 },
  { id: 'ai', label: 'AI', icon: IconMessageChatbot }
]

/** 拖拽过程中的临时宽度（松手才落库，避免每次 mousemove 都写 localStorage） */
const dragWidth = ref<number | null>(null)
const panelWidth = computed(() => dragWidth.value ?? dock.width)

let dragStartX = 0
let dragStartWidth = 0

function onResizeStart(event: MouseEvent): void {
  dragStartX = event.clientX
  dragStartWidth = dock.width
  dragWidth.value = dock.width
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', onResizeEnd)
  event.preventDefault()
}

function onResizeMove(event: MouseEvent): void {
  // 面板位于右侧：向左拖拽变宽
  dragWidth.value = clampDockWidth(dragStartWidth - (event.clientX - dragStartX))
}

function onResizeEnd(): void {
  if (dragWidth.value !== null) dock.setWidth(dragWidth.value)
  dragWidth.value = null
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', onResizeEnd)
}

onUnmounted(() => {
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', onResizeEnd)
})
</script>

<template>
  <aside
    class="right-dock"
    :style="{ width: `${panelWidth}px` }"
    aria-label="右侧面板"
    data-testid="right-dock"
  >
    <div
      class="dock-resizer"
      data-testid="dock-resizer"
      @mousedown="onResizeStart"
    />

    <header class="dock-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="dock-tab"
        :class="{ active: dock.activeTab === tab.id }"
        :data-testid="`dock-tab-${tab.id}`"
        @click="dock.setTab(tab.id)"
      >
        <component
          :is="tab.icon"
          :size="15"
          :stroke-width="1.8"
        />
        <span>{{ tab.label }}</span>
      </button>
      <button
        v-if="dock.activeTab === 'ai'"
        type="button"
        class="dock-close"
        aria-label="全屏 AI 助手"
        data-testid="dock-ai-expand"
        @click="emit('expandAi')"
      >
        <IconMaximize
          :size="15"
          :stroke-width="1.8"
        />
      </button>
      <button
        type="button"
        class="dock-close"
        :class="{ 'dock-close-pushed': dock.activeTab === 'ai' }"
        aria-label="关闭面板"
        data-testid="dock-close"
        @click="dock.close()"
      >
        <IconX
          :size="15"
          :stroke-width="1.8"
        />
      </button>
    </header>

    <div class="dock-body">
      <BacklinksPanel v-if="dock.activeTab === 'backlinks'" />
      <div
        v-else-if="dock.activeTab === 'graph'"
        class="dock-placeholder"
        data-testid="dock-graph-placeholder"
      >
        图谱视图开发中
      </div>
      <AiPanel
        v-else
        :ready="props.ready"
        @open-settings="emit('openSettings')"
      />
    </div>
  </aside>
</template>

<style scoped>
.right-dock {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-primary);
}

.dock-resizer {
  position: absolute;
  top: 0;
  left: -2px;
  z-index: 2;
  width: 5px;
  height: 100%;
  cursor: col-resize;
}

.dock-resizer:hover {
  background: color-mix(in srgb, var(--color-primary) 40%, transparent);
}

.dock-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 34px;
  padding: 0 6px;
  border-bottom: 1px solid var(--color-border);
}

.dock-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
  cursor: pointer;
}

.dock-tab:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.dock-tab.active {
  background: var(--color-bg-secondary);
  color: var(--color-primary);
}

.dock-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: auto;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

/* AI 页签下「全屏」按钮在前，关闭按钮不再顶到最右 */
.dock-close-pushed {
  margin-left: 0;
}

.dock-close:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.dock-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dock-placeholder {
  padding: 16px 12px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}
</style>
