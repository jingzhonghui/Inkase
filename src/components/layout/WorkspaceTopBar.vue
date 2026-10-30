<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  IconMessageChatbot,
  IconRefresh,
  IconTopologyStar3,
  type Icon
} from '@tabler/icons-vue'
import { useGraphStore } from '../../stores/graph'
import { WORKSPACE_SEGMENTS, useWorkspaceStore, type WorkspaceSegment } from '../../stores/workspace'

/**
 * 工作台顶条。
 *
 * 原来图谱与 AI 各自带一条页头（标题 + 统计 + 刷新），搬进工作台后如果两套都留，
 * 顶部会叠出两条 40px 的横条——"双页头"是这类容器最常见的塌陷方式。
 * 所以段内页头统一收到这一条：左边只负责"我在哪一段"，右边负责"这一段能做什么"。
 *
 * 这一条只放**操作**（搜索、收起侧栏、重扫），不放**读数**：
 * 节点/链接/断链/孤儿四个计数统一在图谱侧栏的「概况」分组里，
 * 同一份数据不再出现在两处，用户也不必在两块地方之间对数字。
 *
 * 也刻意没有「关闭」按钮：回到文档有两条更自然的出口——点标签栏上的文件标签，
 * 或点「工作台」标签本身；再放一个 × 只会让人以为要"关掉"什么。
 */

const workspaceStore = useWorkspaceStore()
const graphStore = useGraphStore()

const SEGMENT_ICONS: Record<WorkspaceSegment, Icon> = {
  graph: IconTopologyStar3,
  ai: IconMessageChatbot
}

const segments = WORKSPACE_SEGMENTS

const isGraph = computed(() => workspaceStore.segment === 'graph')

// ===== 图谱段的搜索：变量与 store 双向同步，切段回来不丢 =====
const query = ref(graphStore.filters.query)
watch(
  () => graphStore.filters.query,
  (next) => {
    if (next !== query.value) query.value = next
  }
)

function applyQuery(): void {
  graphStore.setQuery(query.value)
}

function onSearchEnter(): void {
  applyQuery()
  const matches = graphStore.searchMatches
  if (!matches || matches.size === 0) return
  const first = graphStore.visibleNodes.find((node) => matches.has(node.id))
  if (!first) return
  graphStore.selectNode(first.id)
  graphStore.requestFocus(first.id)
}

function clearQuery(): void {
  query.value = ''
  applyQuery()
}
</script>

<template>
  <div class="ws-bar">
    <div class="ws-bar__segments">
      <button
        v-for="segment in segments"
        :key="segment.id"
        class="ws-seg"
        :class="{ active: workspaceStore.segment === segment.id }"
        :title="segment.hint"
        :data-segment="segment.id"
        @click="workspaceStore.setSegment(segment.id)"
      >
        <component
          :is="SEGMENT_ICONS[segment.id]"
          :size="14"
          stroke="1.8"
        />
        <span>{{ segment.label }}</span>
      </button>
    </div>

    <div
      v-if="isGraph"
      class="ws-bar__trail"
    >
      <div class="ws-bar__search">
        <input
          v-model="query"
          type="search"
          placeholder="搜索笔记名…"
          @input="applyQuery"
          @keydown.enter.prevent="onSearchEnter"
        >
        <button
          v-if="query"
          class="ws-bar__clear"
          title="清除"
          @click="clearQuery"
        >
          ×
        </button>
      </div>

      <button
        class="ws-bar__icon"
        :class="{ active: workspaceStore.expanded }"
        :title="workspaceStore.expanded ? '显示侧栏' : '收起侧栏，让画布占满'"
        @click="workspaceStore.toggleExpanded()"
      >
        ◫
      </button>
      <button
        class="ws-bar__icon"
        :disabled="graphStore.loading"
        title="重新扫描工作区"
        @click="graphStore.refresh()"
      >
        <IconRefresh
          :size="14"
          stroke="1.8"
        />
      </button>
    </div>
  </div>
</template>

<style scoped>
.ws-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  flex-shrink: 0;
  padding: 0 10px;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-bg-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
}

/* ===== 分段切换：整屏只有一个"我在哪"的控件 ===== */
.ws-bar__segments {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.ws-seg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: inherit;
  cursor: pointer;
}

.ws-seg:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

.ws-seg.active {
  background: var(--color-bg-primary);
  color: var(--color-text);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--color-border);
}

.ws-bar__trail {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-left: auto;
}

.ws-bar__search {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 168px;
}

.ws-bar__search input {
  width: 100%;
  padding: 3px 20px 3px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text);
  font-size: inherit;
  outline: none;
}

.ws-bar__search input:focus {
  border-color: var(--color-primary);
}

.ws-bar__clear {
  position: absolute;
  right: 2px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  padding: 0 4px;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.ws-bar__icon {
  width: 24px;
  height: 22px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.ws-bar__icon:hover:not(:disabled) {
  background: var(--color-bg-primary);
  border-color: var(--color-border);
  color: var(--color-text);
}

.ws-bar__icon.active {
  border-color: var(--color-border);
  background: var(--color-bg-primary);
  color: var(--color-primary);
}

.ws-bar__icon:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
