<script setup lang="ts">
/**
 * 图谱过滤器
 *
 * 全部是视图态：不触发重新索引，也不改变孤立判定（那是整库事实）。
 * 唯一的例外是「目录层级」——L6 边由主进程按需生成，切换它会重新拉一次图。
 *
 * 规模护栏的手动解除也放在这里：护栏的意义是「默认别把用户淹了」，
 * 但用户明确要看全部时必须给出口，且要明确告知代价。
 */
import { computed } from 'vue'
import { filterGraph, type GraphLayer, type OrphanMode } from '../../../shared/knowledge/graph'
import { useKnowledgeStore } from '../../stores/knowledge'

const knowledge = useKnowledgeStore()

interface LayerOption {
  layer: GraphLayer
  label: string
  hint: string
}

const LAYER_OPTIONS: LayerOption[] = [
  { layer: 'link', label: '链接', hint: '[[链接]] 与 Markdown 内部链接' },
  { layer: 'resource', label: '资源', hint: '笔记引用的图片、PDF、附件' },
  { layer: 'tag', label: '标签', hint: '行内 #tag 与 frontmatter tags' },
  { layer: 'relation', label: '关系', hint: 'frontmatter 的 up / related / source' },
  { layer: 'mention', label: '提及', hint: '正文提到但还没建立链接的笔记' },
  { layer: 'folder', label: '目录', hint: '文件夹层级（需要重新计算）' }
]

const ORPHAN_OPTIONS: Array<{ mode: OrphanMode; label: string }> = [
  { mode: 'all', label: '全部' },
  { mode: 'only', label: '仅孤立' },
  { mode: 'hide', label: '隐藏孤立' }
]

const layers = computed(() => new Set(knowledge.graphFilters.layers))

const folders = computed<string[]>(() => {
  const set = new Set<string>()
  for (const node of knowledge.graph.nodes) {
    if (node.kind === 'tag') continue
    set.add(node.folder)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
})

function folderLabel(folder: string): string {
  return folder === '' ? '（库根）' : folder
}

const tags = computed(() => {
  return knowledge.graph.nodes
    .filter((node) => node.kind === 'tag')
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
})

const visibleCount = computed(
  () => filterGraph(knowledge.graph, knowledge.graphFilters).nodes.length
)

const allConsidered = computed(() => knowledge.graph.nodes.length)

function isFolderActive(folder: string): boolean {
  const selected = knowledge.graphFilters.folders
  return selected === null || selected.includes(folder)
}

function isTagActive(tag: string): boolean {
  const selected = knowledge.graphFilters.tags
  return selected === null || selected.includes(tag)
}

function toggleFolder(folder: string): void {
  const all = folders.value
  const active = new Set(knowledge.graphFilters.folders ?? all)
  if (active.has(folder)) active.delete(folder)
  else active.add(folder)
  // 全选等价于不过滤，回到 null 以免以后新增目录被悄悄排除
  knowledge.updateGraphFilters({ folders: active.size === all.length ? null : [...active] })
}

function toggleTag(tag: string): void {
  const all = tags.value.map((node) => node.id)
  const active = new Set(knowledge.graphFilters.tags ?? all)
  if (active.has(tag)) active.delete(tag)
  else active.add(tag)
  knowledge.updateGraphFilters({ tags: active.size === all.length ? null : [...active] })
}

function setOrphans(mode: OrphanMode): void {
  knowledge.updateGraphFilters({ orphans: mode })
}

function toggleFilesOnly(): void {
  knowledge.updateGraphFilters({ filesOnly: !knowledge.graphFilters.filesOnly })
}

async function toggleLayer(layer: GraphLayer): Promise<void> {
  await knowledge.toggleGraphLayer(layer)
}
</script>

<template>
  <section
    class="graph-filters"
    data-testid="graph-filters"
  >
    <header class="filters-header">
      <span class="filters-title">过滤</span>
      <span
        class="filters-count"
        data-testid="filter-summary"
      >{{ visibleCount }} / {{ allConsidered }}</span>
      <button
        type="button"
        class="filters-reset"
        data-testid="filter-reset"
        @click="knowledge.resetGraphFilters()"
      >
        重置
      </button>
    </header>

    <div class="filters-body">
      <div class="filter-group">
        <h3 class="group-title">
          边类型
        </h3>
        <label
          v-for="option in LAYER_OPTIONS"
          :key="option.layer"
          class="filter-row"
          :title="option.hint"
        >
          <input
            type="checkbox"
            :checked="layers.has(option.layer)"
            :data-testid="`filter-layer-${option.layer}`"
            @change="toggleLayer(option.layer)"
          >
          <span class="row-label">{{ option.label }}</span>
        </label>
      </div>

      <div class="filter-group">
        <h3 class="group-title">
          视图
        </h3>
        <div class="segmented">
          <button
            v-for="option in ORPHAN_OPTIONS"
            :key="option.mode"
            type="button"
            class="segment"
            :class="{ active: knowledge.graphFilters.orphans === option.mode }"
            :data-testid="`filter-orphans-${option.mode}`"
            @click="setOrphans(option.mode)"
          >
            {{ option.label }}
          </button>
        </div>
        <label class="filter-row">
          <input
            type="checkbox"
            :checked="knowledge.graphFilters.filesOnly"
            data-testid="filter-files-only"
            @change="toggleFilesOnly"
          >
          <span class="row-label">仅文件节点</span>
        </label>
      </div>

      <div
        v-if="folders.length > 1"
        class="filter-group"
      >
        <h3 class="group-title">
          文件夹
        </h3>
        <label
          v-for="folder in folders"
          :key="folder"
          class="filter-row"
        >
          <input
            type="checkbox"
            :checked="isFolderActive(folder)"
            :data-testid="`filter-folder-${folder === '' ? '__root__' : folder}`"
            @change="toggleFolder(folder)"
          >
          <span class="row-label">{{ folderLabel(folder) }}</span>
        </label>
      </div>

      <div
        v-if="tags.length > 0"
        class="filter-group"
      >
        <h3 class="group-title">
          标签
        </h3>
        <label
          v-for="tag in tags"
          :key="tag.id"
          class="filter-row"
        >
          <input
            type="checkbox"
            :checked="isTagActive(tag.id)"
            :data-testid="`filter-tag-${tag.id}`"
            @change="toggleTag(tag.id)"
          >
          <span class="row-label">{{ tag.label }}</span>
          <span class="row-count">{{ tag.degree }}</span>
        </label>
      </div>

      <div
        v-if="knowledge.graph.aggregated || knowledge.graphExpanded"
        class="filter-group guardrail"
        data-testid="filter-guardrail"
      >
        <h3 class="group-title">
          规模护栏
        </h3>
        <p
          v-if="knowledge.graph.aggregated"
          class="guardrail-note"
          data-testid="filter-aggregated-note"
        >
          节点过多，已自动聚合 {{ knowledge.graph.hiddenCount }} 个节点（按目录折叠）。
        </p>
        <p
          v-else
          class="guardrail-note"
          data-testid="filter-expanded-note"
        >
          正在显示全部节点，首帧与交互可能变慢。
        </p>
        <button
          v-if="knowledge.graph.aggregated"
          type="button"
          class="guardrail-action"
          data-testid="filter-expand"
          @click="knowledge.expandGraph()"
        >
          显示全部节点
        </button>
        <button
          v-else
          type="button"
          class="guardrail-action"
          data-testid="filter-collapse"
          @click="knowledge.collapseGraph()"
        >
          恢复自动聚合
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.graph-filters {
  display: flex;
  flex-direction: column;
  width: 224px;
  max-height: 100%;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  font-size: calc(var(--ui-font-size) - 3px);
}

.filters-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-border);
}

.filters-title {
  color: var(--color-text);
  font-weight: 500;
}

.filters-count {
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.filters-reset {
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: inherit;
  cursor: pointer;
}

.filters-reset:hover {
  color: var(--color-text);
  border-color: var(--color-text-tertiary);
}

.filters-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0 10px;
}

.filter-group {
  padding: 6px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
}

.filter-group:last-child {
  border-bottom: 0;
}

.group-title {
  margin: 0 0 4px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 4px);
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.filter-row:hover {
  color: var(--color-text);
}

.filter-row input {
  width: 12px;
  height: 12px;
  margin: 0;
  accent-color: var(--color-primary);
  cursor: pointer;
}

.row-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-count {
  margin-left: auto;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.segmented {
  display: flex;
  gap: 2px;
  margin-bottom: 4px;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
}

.segment {
  flex: 1;
  padding: 3px 0;
  border: 0;
  border-radius: calc(var(--radius-sm) - 1px);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: inherit;
  cursor: pointer;
}

.segment:hover {
  color: var(--color-text);
}

.segment.active {
  background: var(--color-bg-primary);
  color: var(--color-primary);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 10%, transparent);
}

.guardrail-note {
  margin: 0 0 6px;
  color: var(--color-text-tertiary);
  line-height: 1.5;
}

.guardrail-action {
  width: 100%;
  padding: 4px 0;
  border: 1px solid color-mix(in srgb, var(--color-primary) 45%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
  font-size: inherit;
  cursor: pointer;
}

.guardrail-action:hover {
  background: color-mix(in srgb, var(--color-primary) 20%, transparent);
}
</style>
