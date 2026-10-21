<script setup lang="ts">
/**
 * `[[` 链接补全弹层（纯展示）
 *
 * 键盘导航与查询状态由编辑器持有（ProseMirror 的按键与事务都在那边），
 * 这里只负责把候选画出来并汇报用户意图，便于单独调整样式。
 */

import type { NoteEntry } from '../../../shared/knowledge/types'

interface Props {
  items: NoteEntry[]
  activeIndex: number
  /** 相对编辑容器的定位；为 null 表示不显示 */
  position: { x: number; y: number } | null
  /** 当前已输入的关键词，用于空态文案 */
  query: string
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'select', index: number): void
  (e: 'hover', index: number): void
}>()

/** 取不带扩展名的笔记名（补全插入的就是它） */
function noteName(note: NoteEntry): string {
  return note.path.replace(/^.*\//, '').replace(/\.[^./]+$/, '')
}

/** 候选里的目录部分，便于区分同名笔记 */
function noteDir(note: NoteEntry): string {
  const at = note.path.lastIndexOf('/')
  return at === -1 ? '' : note.path.slice(0, at + 1)
}
</script>

<template>
  <div
    v-if="position && items.length > 0"
    class="link-autocomplete"
    data-testid="link-autocomplete"
    :style="{ left: `${position.x}px`, top: `${position.y}px` }"
  >
    <div class="link-autocomplete-hint" data-testid="link-autocomplete-hint">
      链接到笔记{{ query.trim() === '' ? '' : `：${query.trim()}` }}
    </div>
    <ul class="link-autocomplete-list" role="listbox">
      <li
        v-for="(item, index) in items"
        :key="item.path"
        class="link-autocomplete-item"
        :class="{ 'is-active': index === activeIndex }"
        :data-testid="`link-option-${index}`"
        role="option"
        :aria-selected="index === activeIndex"
        @mousedown.prevent="emit('select', index)"
        @mouseenter="emit('hover', index)"
      >
        <span class="link-autocomplete-name">{{ noteName(item) }}</span>
        <span v-if="noteDir(item)" class="link-autocomplete-dir">{{ noteDir(item) }}</span>
        <span v-if="item.aliases.length > 0" class="link-autocomplete-alias">
          {{ item.aliases.join('、') }}
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.link-autocomplete {
  position: absolute;
  z-index: 40;
  min-width: 200px;
  max-width: 360px;
  max-height: 240px;
  overflow-y: auto;
  padding: 4px 0;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background-color: var(--color-bg-primary);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
}

.link-autocomplete-hint {
  padding: 2px 10px 6px;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.link-autocomplete-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.link-autocomplete-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 10px;
  font-size: 13px;
  color: var(--color-text-primary);
  cursor: pointer;
}

.link-autocomplete-item.is-active {
  background-color: var(--color-bg-tertiary);
}

.link-autocomplete-name {
  flex-shrink: 0;
}

.link-autocomplete-dir,
.link-autocomplete-alias {
  overflow: hidden;
  font-size: 11px;
  color: var(--color-text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
