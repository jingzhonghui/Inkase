<script setup lang="ts">
import { computed } from 'vue'
import type { GraphIssue } from '../../../shared/graph/types'
import { useGraphStore } from '../../stores/graph'

/**
 * 库健康抽屉：断链与孤儿。
 *
 * 它是一张**浮在画布上**的卡片（288px，贴右手边，上下各留 14px），
 * 不是挤在画布旁边的第三栏——抽屉一开就重排画布，等于每看一眼问题清单
 * 图就跳一次位，而仿真的坐标是活的。
 *
 * 数量为 0 时仍保留分区并显示正向空态：藏起来会让人以为「没做这个功能」，
 * 而看到了「没有断链」才知道自己这个库是干净的。
 */

const emit = defineEmits<{ close: [] }>()

const graphStore = useGraphStore()
// 受控分段：顶条的「断链 / 孤儿」两个计数直接把抽屉打开到对应分区，
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
    <div class="graph-issues__head">
      <span class="graph-issues__k">库健康</span>
      <button
        class="graph-issues__close"
        title="关闭"
        @click="emit('close')"
      >
        ×
      </button>
    </div>

    <div class="graph-issues__tabs">
      <button
        :class="{ 'is-on': section === 'unresolved' }"
        @click="section = 'unresolved'"
      >
        断链 <span class="graph-issues__n">{{ unresolved.length }}</span>
      </button>
      <button
        :class="{ 'is-on': section === 'orphans' }"
        @click="section = 'orphans'"
      >
        孤儿 <span class="graph-issues__n">{{ orphans.length }}</span>
      </button>
    </div>

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
          >{{ hrefLabel(issue) }}<span
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
          在图中
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
/* 浮卡而不是第三栏：开抽屉不该让画布重排 */
.graph-issues {
  position: absolute;
  top: 14px;
  right: 14px;
  bottom: 14px;
  z-index: 12;
  width: 288px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border-hover);
  border-radius: var(--radius-lg);
  background: var(--color-bg-primary);
  box-shadow: 0 10px 24px rgba(16, 24, 40, 0.1);
  overflow: hidden;
}

.graph-issues__head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 0;
}

/* 与选中卡片同一个眉标：大写间距的小字，只做定位不做标题 */
.graph-issues__k {
  font-size: calc(var(--ui-font-size) - 3px);
  letter-spacing: 0.1em;
  color: var(--color-text-tertiary);
}

.graph-issues__close {
  margin-left: auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-tertiary);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.graph-issues__close:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

/* 两个分区是一条等宽分段的变体：槽底色 + 选中项浮起 */
.graph-issues__tabs {
  display: flex;
  gap: 2px;
  margin: 8px 10px 0;
  padding: 2px;
  border-radius: 5px;
  background: var(--color-bg-secondary);
}

.graph-issues__tabs button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 3px 0;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1.5px);
  cursor: pointer;
}

.graph-issues__tabs button.is-on {
  background: var(--color-bg-primary);
  color: var(--color-text);
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
}

.graph-issues__n {
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 2.5px);
  font-variant-numeric: tabular-nums;
}

.graph-issues__hint {
  margin: 0;
  padding: 8px 12px 6px;
  font-size: calc(var(--ui-font-size) - 2px);
  line-height: 1.65;
  color: var(--color-text-tertiary);
}

.graph-issues__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.graph-issues__row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 5px;
}

.graph-issues__row:hover {
  background: var(--color-bg-secondary);
}

.graph-issues__open {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 6px;
  border: none;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.graph-issues__source {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(var(--ui-font-size) - 1.5px);
  color: var(--color-text-secondary);
}

/* 目标走等宽 + 断链红：这一行说的是「它本该指向哪里」 */
.graph-issues__target {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-danger, #b91c1c);
}

.graph-issues__line {
  color: var(--color-text-tertiary);
}

.graph-issues__locate {
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px 5px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
  cursor: pointer;
}

.graph-issues__row:hover .graph-issues__locate {
  color: var(--color-primary);
}

.graph-issues__empty {
  flex: 1;
  margin: 0;
  padding: 24px 16px;
  text-align: center;
  font-size: calc(var(--ui-font-size) - 1.5px);
  line-height: 1.7;
  color: var(--color-text-tertiary);
}
</style>
