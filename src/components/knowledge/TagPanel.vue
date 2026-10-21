<script setup lang="ts">
/**
 * 标签总览面板
 *
 * 列出库内全部标签（按使用次数降序），选中后展示该标签下的笔记。
 * 标签来源分两种：正文里的 `#标签` 与 frontmatter 的 `tags:`，
 * 同一标签可能两者兼有——用不同徽标区分，方便判断该标签是否随笔记正文传播。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { IconHash, IconRefresh } from '@tabler/icons-vue'
import Tooltip from '../common/Tooltip.vue'
import { useFileStore } from '../../stores/file'
import { useKnowledgeStore } from '../../stores/knowledge'
import type { TagNote, TagSource } from '../../../shared/knowledge/types'

const fileStore = useFileStore()
const knowledge = useKnowledgeStore()

const selectedTag = ref<string | null>(null)
const notes = ref<TagNote[]>([])
const loadingNotes = ref(false)
/** 过滤输入（按标签名模糊匹配） */
const filter = ref('')

const visibleTags = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  if (keyword === '') return knowledge.tags
  return knowledge.tags.filter((item) => item.tag.toLowerCase().includes(keyword))
})

/** 选中标签的统计信息 */
const selectedSummary = computed(() =>
  knowledge.tags.find((item) => item.tag === selectedTag.value) ?? null
)

async function selectTag(tag: string): Promise<void> {
  selectedTag.value = tag
  loadingNotes.value = true
  try {
    notes.value = await knowledge.loadNotesByTag(tag)
  } finally {
    loadingNotes.value = false
  }
}

/** 打开某笔记（库内相对路径 → 绝对路径） */
async function openNote(path: string): Promise<void> {
  const absPath = knowledge.resolveAbsolute(path)
  if (absPath === null) return
  await fileStore.openFile(absPath, { addToRecent: false })
}

/** 徽标文案：来源组合的紧凑表示 */
function sourceLabel(sources: TagSource[]): string {
  if (sources.includes('inline') && sources.includes('frontmatter')) return '行内 + 属性'
  return sources.includes('inline') ? '行内' : '属性'
}

async function refresh(): Promise<void> {
  await knowledge.loadTags()
  if (selectedTag.value !== null) await selectTag(selectedTag.value)
}

// 切换工作区后标签集合会变，清掉失效的选中项
watch(
  () => knowledge.tags,
  (list) => {
    if (selectedTag.value !== null && !list.some((item) => item.tag === selectedTag.value)) {
      selectedTag.value = null
      notes.value = []
    }
  }
)

onMounted(() => {
  if (knowledge.tags.length === 0) void knowledge.loadTags()
})
</script>

<template>
  <div
    class="tag-panel"
    data-testid="tag-panel"
  >
    <div class="tag-toolbar">
      <input
        v-model="filter"
        class="tag-filter"
        type="search"
        placeholder="过滤标签"
        data-testid="tag-filter"
      >
      <Tooltip content="刷新标签">
        <button
          class="tag-refresh"
          type="button"
          aria-label="刷新标签"
          data-testid="tag-refresh"
          @click="refresh"
        >
          <IconRefresh />
        </button>
      </Tooltip>
    </div>

    <p
      v-if="knowledge.degraded"
      class="tag-hint is-warning"
    >
      知识库索引不可用，标签列表可能不完整。
    </p>

    <p
      v-if="visibleTags.length === 0"
      class="tag-hint"
      data-testid="tag-empty"
    >
      {{ knowledge.tags.length === 0 ? '库内还没有标签' : '没有匹配的标签' }}
    </p>

    <ul
      v-else
      class="tag-list"
    >
      <li
        v-for="item in visibleTags"
        :key="item.tag"
      >
        <button
          class="tag-item"
          :class="{ 'is-active': item.tag === selectedTag }"
          type="button"
          :data-testid="`tag-item-${item.tag}`"
          @click="selectTag(item.tag)"
        >
          <IconHash class="tag-icon" />
          <span class="tag-name">{{ item.tag }}</span>
          <span class="tag-count">{{ item.count }}</span>
        </button>
      </li>
    </ul>

    <div
      v-if="selectedTag !== null"
      class="tag-notes"
      data-testid="tag-notes"
    >
      <div class="tag-notes-header">
        <span class="tag-notes-title">#{{ selectedTag }}</span>
        <span
          v-if="selectedSummary"
          class="tag-notes-meta"
        >
          行内 {{ selectedSummary.inline }} · 属性 {{ selectedSummary.frontmatter }}
        </span>
      </div>

      <p
        v-if="loadingNotes"
        class="tag-hint"
      >
        载入中…
      </p>
      <p
        v-else-if="notes.length === 0"
        class="tag-hint"
      >
        没有笔记使用该标签
      </p>
      <ul
        v-else
        class="note-list"
      >
        <li
          v-for="note in notes"
          :key="note.path"
        >
          <button
            class="note-item"
            type="button"
            :title="note.path"
            @click="openNote(note.path)"
          >
            <span class="note-name">{{ note.path }}</span>
            <span
              class="source-badge"
              :class="note.sources.includes('inline') ? 'is-inline' : 'is-frontmatter'"
            >{{ sourceLabel(note.sources) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.tag-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
}

.tag-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  flex-shrink: 0;
}

.tag-filter {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.tag-filter:focus {
  outline: none;
  border-color: var(--color-primary);
}

.tag-refresh {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.tag-refresh:hover {
  color: var(--color-text);
  background: var(--color-bg-secondary);
}

.tag-refresh svg {
  width: 15px;
  height: 15px;
}

.tag-hint {
  margin: 0;
  padding: 6px 10px;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
}

.tag-hint.is-warning {
  color: var(--color-warning);
}

.tag-list,
.note-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tag-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 10px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
}

.tag-item:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.tag-item.is-active {
  background: var(--color-bg-secondary);
  color: var(--color-primary);
}

.tag-icon {
  width: 13px;
  height: 13px;
  flex: none;
  opacity: 0.7;
}

.tag-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-count {
  flex: none;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.tag-notes {
  border-top: 1px solid var(--color-border);
  margin-top: 4px;
  padding-top: 4px;
}

.tag-notes-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 10px;
}

.tag-notes-title {
  font-size: calc(var(--ui-font-size) - 1px);
  font-weight: 600;
  color: var(--color-text);
}

.tag-notes-meta {
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-text-tertiary);
}

.note-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 10px 4px 20px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
}

.note-item:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.note-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-badge {
  flex: none;
  padding: 1px 5px;
  font-size: calc(var(--ui-font-size) - 3px);
  border-radius: var(--radius-sm);
  border: 1px solid currentColor;
  opacity: 0.85;
}

.source-badge.is-inline {
  color: var(--color-primary);
}

.source-badge.is-frontmatter {
  color: var(--color-text-tertiary);
}
</style>
