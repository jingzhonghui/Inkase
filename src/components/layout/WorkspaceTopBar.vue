<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  IconMessageChatbot,
  IconRefresh,
  IconSearch,
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
 * 图谱段的排布照官网 §知识图谱 那块面板的 `.grf__bar`：
 * 分段 · 弹簧 · 「已筛选」标记 · 搜索 · 四个计数 · 两个图标按钮。
 * 四个计数（节点 / 链接 / 断链 / 孤儿）只出现在这里，一行说完图的规模；
 * 断链与孤儿可点，点开的是画布上的库健康抽屉。侧栏因此不必再有一份"概况"——
 * 同一份数据不该在两处各有一个入口。
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

// ===== 四个计数 =====
/**
 * 计数的真相在 `stats`；局部图等拿不到 stats 的场景退回到 payload / issues 的长度。
 * 加载中不给数：宁可整块不显示，也不要先闪一个 0 再跳成 137。
 */
const stats = computed(() => graphStore.stats)
const showCounts = computed(() => Boolean(stats.value) && !graphStore.loading)
const nodeCount = computed(
  () => stats.value?.nodeCount ?? graphStore.effectivePayload?.nodes.length ?? 0
)
const edgeCount = computed(
  () => stats.value?.edgeCount ?? graphStore.effectivePayload?.edges.length ?? 0
)
const unresolvedCount = computed(
  () => stats.value?.unresolvedCount ?? graphStore.issues.unresolved.length
)
const orphanCount = computed(() => stats.value?.orphanCount ?? graphStore.issues.orphans.length)

/** 悬停才给的次要信息：扫描了多少文件、花了多久 */
const statsTitle = computed(() => {
  const current = stats.value
  if (!current) return ''
  const parts = [`已扫描 ${current.filesScanned} 个文件`]
  if (current.elapsedMs > 0) parts.push(`用时 ${Math.round(current.elapsedMs)} ms`)
  if (current.truncated) parts.push('已达文件上限，结果不完整')
  return parts.join(' · ')
})

const filtered = computed(() => graphStore.isFiltered)
/** 标记不写死成「已筛选」：搜索时把词说出来，用户才知道自己还挂着一个条件 */
const filterLabel = computed(() => {
  const keyword = graphStore.filters.query.trim()
  return keyword ? `搜「${keyword}」` : '已筛选'
})
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
          :size="13"
          stroke="1.8"
        />
        <span>{{ segment.label }}</span>
      </button>
    </div>

    <div
      v-if="isGraph"
      class="ws-bar__trail"
    >
      <span
        v-if="filtered"
        class="ws-chip"
        title="当前有筛选条件；取消在侧栏底部"
      >{{ filterLabel }}</span>

      <label class="ws-search">
        <IconSearch
          class="ws-search__icon"
          :size="12"
          stroke="2"
        />
        <input
          v-model="query"
          type="search"
          placeholder="搜索标题…"
          autocomplete="off"
          @input="applyQuery"
          @keydown.enter.prevent="onSearchEnter"
        >
        <button
          v-if="query"
          class="ws-search__clear"
          title="清除"
          @click.prevent="clearQuery"
        >
          ×
        </button>
      </label>

      <div
        v-if="showCounts"
        class="ws-counts"
        :title="statsTitle"
      >
        <span>节点 <b>{{ nodeCount }}</b></span>
        <span>链接 <b>{{ edgeCount }}</b></span>
        <button
          type="button"
          class="ws-count"
          :class="{ 'is-warn': unresolvedCount > 0, 'is-zero': unresolvedCount === 0 }"
          title="查看断链清单"
          @click="graphStore.openIssues('unresolved')"
        >
          断链 <b>{{ unresolvedCount }}</b>
        </button>
        <button
          type="button"
          class="ws-count"
          :class="{ 'is-warn': orphanCount > 0, 'is-zero': orphanCount === 0 }"
          title="查看孤儿清单"
          @click="graphStore.openIssues('orphans')"
        >
          孤儿 <b>{{ orphanCount }}</b>
        </button>
      </div>

      <button
        class="ws-bar__icon"
        :class="{ active: workspaceStore.expanded }"
        :title="workspaceStore.expanded ? '显示侧栏' : '收起侧栏，让画布占满'"
        @click="workspaceStore.toggleExpanded()"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <rect
            x="3"
            y="4"
            width="18"
            height="16"
            rx="2"
          /><path d="M9 4v16" />
        </svg>
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
  height: 40px;
  flex-shrink: 0;
  padding: 0 12px;
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
  padding: 2px;
  border-radius: 6px;
  background: var(--color-bg);
}

.ws-seg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: inherit;
  white-space: nowrap;
  cursor: pointer;
}

.ws-seg:hover {
  color: var(--color-text);
}

/* 当前段＝实心浅蓝胶囊（官网同一做法）：两段之间只靠留白与底色区分，
   不给按钮加边框，否则一栏里会同时出现三种「按钮」 */
.ws-seg.active {
  background: var(--color-primary-light);
  color: var(--color-on-primary-light);
  font-weight: 600;
}

.ws-bar__trail {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  margin-left: auto;
}

/* 有筛选条件时的标记：不是按钮，出口在侧栏底部的「重置筛选」 */
.ws-chip {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  background: var(--color-primary-light);
  color: var(--color-on-primary-light);
  font-size: calc(var(--ui-font-size) - 1.5px);
  white-space: nowrap;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ws-search {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 152px;
  padding: 3px 9px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-primary);
  color: var(--color-text-tertiary);
}

.ws-search:focus-within {
  border-color: var(--color-primary);
}

.ws-search__icon {
  flex-shrink: 0;
}

.ws-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  color: var(--color-text);
  font: inherit;
  font-size: calc(var(--ui-font-size) - 1px);
}

.ws-search input::placeholder {
  color: var(--color-text-tertiary);
}

/* 原生 search 的清除按钮各平台长得都不一样，统一用自己的 × */
.ws-search input::-webkit-search-cancel-button {
  display: none;
}

.ws-search__clear {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  padding: 0 2px;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.ws-search__clear:hover {
  color: var(--color-text);
}

/* ===== 四个计数：文字 + 数字，等宽数字不动，点击跳问题清单 ===== */
.ws-counts {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 1.5px);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.ws-counts > span,
.ws-count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.ws-counts b {
  font-weight: 600;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

/* 断链 / 孤儿是入口：给一点可点的余地，但不要长成一排按钮 */
.ws-count {
  padding: 2px 4px;
  margin: -2px -4px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  font-family: var(--font-mono);
  font-size: inherit;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

.ws-count:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

/* 有问题时数字发红（颜色落在读数上，因为这一行本身就是入口） */
.ws-count.is-warn b {
  color: var(--color-danger, #b91c1c);
}

.ws-count.is-zero b {
  color: var(--color-text-tertiary);
}

.ws-bar__icon {
  width: 24px;
  height: 24px;
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
