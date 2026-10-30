<script setup lang="ts">
import { computed } from 'vue'
import type { GraphIssue } from '../../../shared/graph/types'
import { useGraphStore } from '../../stores/graph'

/**
 * 问题清单：断链与孤儿。
 *
 * 数量为 0 时也保留分区并显示正向空态——藏起来会让人以为「没做这个功能」，
 * 而看到了「没有断链」才知道自己这个库是干净的。
 */

const emit = defineEmits<{ close: [] }>()

const graphStore = useGraphStore()
// 受控分段：侧栏的「断链 / 孤儿」两行可以直接把抽屉打开到对应分区，
// 否则点了「孤儿」出来的却是断链清单，等于没点对
const section = defineModel<'unresolved' | 'orphans'>('section', { default: 'unresolved' })

const unresolved = computed(() => graphStore.issues.unresolved)
const orphans = computed(() => graphStore.issues.orphans)
const rows = computed<GraphIssue[]>(() =>
  section.value === 'unresolved' ? unresolved.value : orphans.value
)

function openIssue(issue: GraphIssue): void {
  graphStore.focusIssue(issue.path)
}

function highlightIssue(issue: GraphIssue): void {
  // 断链高亮到幽灵节点；孤儿高亮到自己
  const target =
    section.value === 'unresolved'
      ? graphStore.effectivePayload?.nodes.find(
          (node) => node.unresolved && node.label === issue.href
        )
      : graphStore.effectivePayload?.nodes.find((node) => node.path === issue.path)
  if (target) {
    graphStore.selectNode(target.id)
  }
}

function hrefLabel(issue: GraphIssue): string {
  return issue.href ?? '—'
}
</script>

<template>
  <aside class="graph-issues">
    <header class="graph-issues__header">
      <div class="graph-issues__tabs">
        <button
          :class="{ active: section === 'unresolved' }"
          @click="section = 'unresolved'"
        >
          断链 <span class="count">{{ unresolved.length }}</span>
        </button>
        <button
          :class="{ active: section === 'orphans' }"
          @click="section = 'orphans'"
        >
          孤儿 <span class="count">{{ orphans.length }}</span>
        </button>
      </div>
      <button
        class="graph-issues__close"
        title="关闭"
        @click="emit('close')"
      >
        ×
      </button>
    </header>

    <p class="graph-issues__hint">
      {{ section === 'unresolved'
        ? '这些链接指向了不存在的文件，点击跳到来源文档的对应行。'
        : '这些笔记既没有出链也没有入链，点击打开。' }}
    </p>

    <ul
      v-if="rows.length > 0"
      class="graph-issues__list"
    >
      <li
        v-for="(issue, index) in rows"
        :key="`${issue.path}-${issue.line ?? index}`"
        class="graph-issues__row"
      >
        <button
          class="graph-issues__open"
          :title="issue.path"
          @click="openIssue(issue)"
        >
          <span class="graph-issues__source">{{ issue.label }}</span>
          <span
            v-if="section === 'unresolved'"
            class="graph-issues__target"
          >› {{ hrefLabel(issue) }}<span
            v-if="issue.line !== null"
            class="graph-issues__line"
          >:{{ issue.line }}</span></span>
          <span
            v-else
            class="graph-issues__target"
          >{{ issue.path }}</span>
        </button>
        <button
          class="graph-issues__locate"
          title="在图中高亮"
          @click="highlightIssue(issue)"
        >
          ◎
        </button>
      </li>
    </ul>

    <p
      v-else
      class="graph-issues__empty"
    >
      {{ section === 'unresolved' ? '没有断链，所有链接都能打开。' : '没有孤儿笔记，每篇都连着别人。' }}
    </p>
  </aside>
</template>

<style scoped>
.graph-issues {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--color-border);
  /* 与侧栏同一档底色：抽屉是图谱这一屏的一部分，不该另起一块「更亮的面板」 */
  background-color: var(--color-bg);
}

.graph-issues__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
}

.graph-issues__tabs {
  display: flex;
  gap: 4px;
}

.graph-issues__tabs button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  font-size: calc(var(--ui-font-size) - 1px);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.graph-issues__tabs button.active {
  /* 与侧栏命中行同一套：实心浅蓝底 + 正文墨色，不用边框圈出当前页 */
  background: var(--color-primary-light);
  border-color: transparent;
  color: var(--color-text);
}

.count {
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 3px);
  opacity: 0.8;
}

.graph-issues__close {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  border-radius: var(--radius-sm);
}

.graph-issues__close:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.graph-issues__hint {
  margin: 8px 12px 0;
  font-size: calc(var(--ui-font-size) - 2px);
  line-height: 1.5;
  color: var(--color-text-tertiary);
}

.graph-issues__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 8px 0;
  padding: 0 6px;
}

.graph-issues__row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: var(--radius-sm);
}

.graph-issues__row:hover {
  background: var(--color-bg-tertiary);
}

.graph-issues__open {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.graph-issues__source {
  font-size: var(--ui-font-size);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.graph-issues__target {
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.graph-issues__line {
  color: var(--color-primary);
}

.graph-issues__locate {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

.graph-issues__locate:hover {
  color: var(--color-primary);
  background: var(--color-bg-primary);
}

.graph-issues__empty {
  padding: 24px 16px;
  text-align: center;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-tertiary);
}
</style>
