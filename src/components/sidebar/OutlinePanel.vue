<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useFileStore } from '../../stores/file'
import { useOutlineStore } from '../../stores/outline'

const fileStore = useFileStore()
const outlineStore = useOutlineStore()

const listRef = ref<HTMLUListElement>()

const hasFile = computed(() => fileStore.tabs.length > 0 && fileStore.activeTabId !== null)
/** 当前标签是否为 PDF（PDF 目录也在此面板展示） */
const isPdf = computed(() => hasFile.value && fileStore.activeTab?.fileInfo?.format === 'pdf')
/** 非 Markdown 文本/图片/HTML 一律为 plain 模式，不支持大纲 */
const isMarkdown = computed(() => hasFile.value && fileStore.effectiveEditorMode !== 'plain')
const headings = computed(() => outlineStore.headings)

/** 是否展示条目列表（Markdown 标题或 PDF 目录，且非加载中） */
const showList = computed(
  () => (isMarkdown.value || isPdf.value) && !outlineStore.loading && headings.value.length > 0
)

const emptyMessage = computed(() => {
  if (!hasFile.value) return '未打开文件'
  if (isPdf.value) return outlineStore.loading ? '正在加载目录…' : '该 PDF 无目录'
  if (!isMarkdown.value) return '当前文件不支持大纲'
  return '暂无标题'
})

function jumpTo(index: number): void {
  window.dispatchEvent(new CustomEvent('inkase:outline-jump', { detail: { index } }))
}

// 当前高亮项随滚动变化时保持在面板可视范围内
watch(
  () => outlineStore.activeIndex,
  () => {
    const active = listRef.value?.querySelector<HTMLElement>('.outline-item.is-active')
    active?.scrollIntoView?.({ block: 'nearest' })
  }
)
</script>

<template>
  <div class="outline-panel">
    <ul
      v-if="showList"
      ref="listRef"
      class="outline-list"
    >
      <li
        v-for="(item, i) in headings"
        :key="i"
        class="outline-item"
        :class="{ 'is-active': i === outlineStore.activeIndex }"
        :style="{ paddingLeft: `${10 + (item.level - 1) * 14}px` }"
        :title="item.text"
        @click="jumpTo(i)"
      >
        <span class="outline-item-text">{{ item.text || '(无标题)' }}</span>
        <span
          v-if="item.page != null"
          class="outline-item-page"
        >{{ item.page }}</span>
      </li>
    </ul>
    <div
      v-else
      class="outline-empty"
    >
      {{ emptyMessage }}
    </div>
  </div>
</template>

<style scoped>
.outline-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.outline-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  list-style: none;
}

.outline-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  font-size: var(--ui-font-size);
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  transition: background-color 0.12s, color 0.12s;
}

.outline-item:hover {
  color: var(--color-text);
  background: var(--color-bg-secondary);
}

.outline-item.is-active {
  font-weight: 500;
  color: var(--color-primary);
  background: var(--color-primary-light);
}

.outline-item-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.outline-item-page {
  flex-shrink: 0;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
}

.outline-empty {
  padding: 16px 12px;
  font-size: var(--ui-font-size);
  color: var(--color-text-tertiary);
}
</style>
