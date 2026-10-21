<script setup lang="ts">
/**
 * 搜索面板（结构化查询）
 *
 * 渲染层只负责把输入组装成 `KnowledgeQuery`，查询语义全部在主进程解释
 * （见 `electron/knowledge/search-service.ts`）——渲染层不接触 fs。
 *
 * 支持的最小查询语法：
 * - `tag:foo`   标签筛选（可多个，AND）
 * - `path:dir/` 路径包含
 * - `prop:key=value` frontmatter 属性等值
 * - 其余文本为全文关键词；`/正则/` 形式按正则搜索
 */
import { computed, ref } from 'vue'
import { IconSearch } from '@tabler/icons-vue'
import { useFileStore } from '../../stores/file'
import { useKnowledgeStore } from '../../stores/knowledge'
import { parseQuery } from '../../utils/knowledge-query'
import type { SearchHit } from '../../../shared/knowledge/types'

const fileStore = useFileStore()
const knowledge = useKnowledgeStore()

const input = ref('')
const hits = ref<SearchHit[]>([])
const searching = ref(false)
const searched = ref(false)

async function run(): Promise<void> {
  const { query, hint } = parseQuery(input.value)
  if (hint !== null) {
    hits.value = []
    searched.value = false
    return
  }
  searching.value = true
  try {
    hits.value = await knowledge.search(query)
    searched.value = true
  } finally {
    searching.value = false
  }
}

/** 打开命中项并定位到行 */
async function openHit(hit: SearchHit): Promise<void> {
  const absPath = knowledge.resolveAbsolute(hit.path)
  if (absPath === null) return
  await fileStore.openFile(absPath, { addToRecent: false })
  fileStore.requestReveal(absPath, hit.line, hit.column)
}

const resultLabel = computed(() => {
  if (searching.value) return '搜索中…'
  if (!searched.value) return ''
  return hits.value.length === 0 ? '没有结果' : `${hits.value.length} 条结果`
})

/** 路径末段，便于在窄侧栏里辨认 */
function basename(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? path : path.slice(at + 1)
}
</script>

<template>
  <div
    class="search-panel"
    data-testid="search-panel"
  >
    <div class="search-box">
      <IconSearch class="search-icon" />
      <input
        v-model="input"
        class="search-input"
        type="search"
        placeholder="关键词  tag:x  path:dir/  prop:k=v"
        data-testid="search-input"
        @keydown.enter="run"
      >
    </div>

    <p
      v-if="knowledge.degraded"
      class="search-hint is-warning"
    >
      知识库索引不可用，标签与属性条件无法生效。
    </p>

    <p
      v-if="resultLabel !== ''"
      class="search-hint"
      data-testid="search-status"
    >
      {{ resultLabel }}
    </p>

    <ul
      v-if="hits.length > 0"
      class="hit-list"
      data-testid="search-results"
    >
      <li
        v-for="hit in hits"
        :key="`${hit.path}:${hit.line}:${hit.column}`"
      >
        <button
          class="hit-item"
          type="button"
          :title="`${hit.path}:${hit.line}`"
          @click="openHit(hit)"
        >
          <span class="hit-head">
            <span class="hit-name">{{ basename(hit.path) }}</span>
            <span class="hit-line">{{ hit.line }}</span>
          </span>
          <span class="hit-dir">{{ hit.path }}</span>
          <span
            v-if="hit.text !== ''"
            class="hit-text"
          >{{ hit.text }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  flex-shrink: 0;
}

.search-icon {
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--color-text-tertiary);
}

.search-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.search-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.search-hint {
  margin: 0;
  padding: 4px 10px;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
}

.search-hint.is-warning {
  color: var(--color-warning);
}

.hit-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.hit-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 5px 10px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
}

.hit-item:hover {
  background: var(--color-bg-secondary);
}

.hit-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.hit-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text);
}

.hit-line {
  flex: none;
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.hit-dir,
.hit-text {
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit-text {
  color: var(--color-text-secondary);
}
</style>
