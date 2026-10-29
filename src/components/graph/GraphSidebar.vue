<script setup lang="ts">
import { computed } from 'vue'
import { ROOT_FOLDER_LABEL, folderColor } from '../../../shared/graph/colors'
import type { GraphNodeFormat } from '../../../shared/graph/types'
import { useGraphStore } from '../../stores/graph'
import { useThemeStore } from '../../stores/theme'
import { SHAPE_GROUPS } from '../../utils/graph/shape'

/**
 * 图谱左侧栏：把「图例」和「过滤器」合成同一个东西。
 *
 * 之前颜色说明在底部图例、过滤 chip 在顶部工具条，两处描述的是同一份数据
 * （顶层目录），却分散在图的两端，而且各自的截断长度还不一样（8 / 12），
 * 看起来像没做完。合成一栏之后，每一项都是「样本 + 名字 + 计数」：
 * 既是读法也是开关，且不做静默截断——目录再多也在这一栏里滚动看全。
 */

const emit = defineEmits<{
  (event: 'open-issues', section: 'unresolved' | 'orphans'): void
}>()

const graphStore = useGraphStore()
const themeStore = useThemeStore()

const theme = computed(() => (themeStore.isDark ? 'dark' : 'light'))

const isLocal = computed(() => graphStore.mode === 'local')

const centerLabel = computed(() => {
  const id = graphStore.centerId
  if (!id) return ''
  const node = graphStore.effectivePayload?.nodes.find((item) => item.id === id)
  return node?.label ?? id
})

// ===== 目录 =====
const folderRows = computed(() => {
  const base = graphStore.effectivePayload
  const counts = new Map<string, number>()
  if (base) {
    for (const node of base.nodes) {
      if (node.unresolved) continue
      counts.set(node.folder, (counts.get(node.folder) ?? 0) + 1)
    }
  }
  return graphStore.allFolders.map((folder) => ({
    folder,
    label: folder || ROOT_FOLDER_LABEL,
    count: counts.get(folder) ?? 0,
    swatch: folderColor(folder, theme.value).swatch
  }))
})

const allFoldersActive = computed(() => graphStore.filters.folders.length === 0)

function isFolderActive(folder: string): boolean {
  const selected = graphStore.filters.folders
  if (selected.length === 0) return true
  return selected.includes(folder)
}

function showAllFolders(): void {
  graphStore.filters.folders = []
}

// ===== 类型（按形状分组，一次开关一组格式）=====
const typeRows = computed(() => {
  const base = graphStore.effectivePayload
  const counts = new Map<GraphNodeFormat, number>()
  if (base) {
    for (const node of base.nodes) {
      if (node.unresolved) continue
      counts.set(node.format, (counts.get(node.format) ?? 0) + 1)
    }
  }
  const active = graphStore.filters.formats
  return SHAPE_GROUPS.map((group) => ({
    id: group.id,
    shape: group.shape,
    title: group.title,
    extensions: group.extensions,
    formats: group.formats,
    count: group.formats.reduce((sum, format) => sum + (counts.get(format) ?? 0), 0),
    active: group.formats.every((format) => active.includes(format))
  }))
})

/** `.mdx` 与 `.md` 归一类：用户关心的是「正文文档」，不是容器后缀 */
function toggleType(formats: readonly GraphNodeFormat[]): void {
  const current = graphStore.filters.formats
  const allOn = formats.every((format) => current.includes(format))
  graphStore.filters.formats = allOn
    ? current.filter((format) => !formats.includes(format))
    : [...new Set([...current, ...formats])]
}

// ===== 断链幽灵 =====
const unresolvedTotal = computed(
  () => graphStore.effectivePayload?.nodes.filter((node) => node.unresolved).length ?? 0
)

const showUnresolved = computed({
  get: () => graphStore.filters.showUnresolved,
  set: (value: boolean) => {
    graphStore.filters.showUnresolved = value
  }
})

// ===== 质量 =====
const unresolvedIssues = computed(() => graphStore.issues.unresolved.length)
const orphanIssues = computed(() => graphStore.issues.orphans.length)
</script>

<template>
  <aside class="graph-rail">
    <section class="graph-rail__section">
      <h2 class="graph-rail__title">
        视图
      </h2>
      <div class="graph-rail__segmented">
        <button
          class="graph-rail__segment"
          :class="{ active: !isLocal }"
          title="整库"
          @click="graphStore.setMode('global')"
        >
          全库
        </button>
        <button
          class="graph-rail__segment"
          :class="{ active: isLocal }"
          title="只看当前文件的邻居"
          @click="graphStore.setMode('local')"
        >
          局部
        </button>
      </div>
      <p
        v-if="isLocal"
        class="graph-rail__center"
        :title="centerLabel"
      >
        {{ centerLabel }}
      </p>
      <label
        v-if="isLocal"
        class="graph-rail__depth"
      >
        深度
        <input
          type="range"
          min="1"
          max="3"
          step="1"
          :value="graphStore.depth"
          @input="graphStore.setDepth(Number(($event.target as HTMLInputElement).value))"
        >
        <span class="graph-rail__depth-value">{{ graphStore.depth }}</span>
      </label>
    </section>

    <section class="graph-rail__section graph-rail__section--grow">
      <h2 class="graph-rail__title">
        目录
        <span class="graph-rail__badge-num">{{ folderRows.length }}</span>
      </h2>
      <ul class="graph-rail__list">
        <li>
          <button
            class="graph-rail__row"
            :class="{ active: allFoldersActive }"
            @click="showAllFolders"
          >
            <span class="graph-rail__name">全部目录</span>
          </button>
        </li>
        <li
          v-for="row in folderRows"
          :key="row.folder || '__root__'"
        >
          <button
            class="graph-rail__row"
            :class="{ active: isFolderActive(row.folder) }"
            :title="row.folder || ROOT_FOLDER_LABEL"
            @click="graphStore.toggleFolder(row.folder)"
          >
            <span
              class="graph-rail__bar"
              :style="{ backgroundColor: row.swatch }"
            />
            <span class="graph-rail__name">{{ row.label }}</span>
            <span class="graph-rail__num">{{ row.count }}</span>
          </button>
        </li>
      </ul>
    </section>

    <section class="graph-rail__section">
      <h2 class="graph-rail__title">
        类型
      </h2>
      <ul class="graph-rail__list">
        <li
          v-for="row in typeRows"
          :key="row.id"
        >
          <button
            class="graph-rail__row"
            :class="{ active: row.active }"
            :aria-pressed="row.active"
            :title="`开关 ${row.extensions}`"
            @click="toggleType(row.formats)"
          >
            <span
              class="graph-rail__shape"
              :class="`graph-rail__shape--${row.shape}`"
            />
            <span class="graph-rail__name">
              {{ row.title }}
              <span class="graph-rail__ext">{{ row.extensions }}</span>
            </span>
            <span class="graph-rail__num">{{ row.count }}</span>
          </button>
        </li>
        <li>
          <button
            class="graph-rail__row"
            :class="{ active: showUnresolved }"
            :aria-pressed="showUnresolved"
            title="链接指向不存在的文件的节点"
            @click="showUnresolved = !showUnresolved"
          >
            <span class="graph-rail__shape graph-rail__shape--ghost" />
            <span class="graph-rail__name">断链目标</span>
            <span class="graph-rail__num">{{ unresolvedTotal }}</span>
          </button>
        </li>
      </ul>
    </section>

    <section class="graph-rail__section">
      <h2 class="graph-rail__title">
        质量
      </h2>
      <ul class="graph-rail__list">
        <li>
          <button
            class="graph-rail__row graph-rail__row--issue"
            data-issue="unresolved"
            @click="emit('open-issues', 'unresolved')"
          >
            <span class="graph-rail__name">断链</span>
            <span
              class="graph-rail__num"
              :class="{ warn: unresolvedIssues > 0 }"
            >{{ unresolvedIssues }}</span>
            <span class="graph-rail__go">›</span>
          </button>
        </li>
        <li>
          <button
            class="graph-rail__row graph-rail__row--issue"
            data-issue="orphans"
            @click="emit('open-issues', 'orphans')"
          >
            <span class="graph-rail__name">孤儿</span>
            <span
              class="graph-rail__num"
              :class="{ warn: orphanIssues > 0 }"
            >{{ orphanIssues }}</span>
            <span class="graph-rail__go">›</span>
          </button>
        </li>
      </ul>
    </section>

    <footer class="graph-rail__footer">
      <button
        v-if="graphStore.isFiltered"
        class="graph-rail__reset"
        @click="graphStore.resetFilters()"
      >
        重置筛选
      </button>
      <p class="graph-rail__hint">
        颜色＝目录 · 形状＝格式 · 大小＝入链数
      </p>
    </footer>
  </aside>
</template>

<style scoped>
.graph-rail {
  width: 236px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px 8px 8px;
  gap: 14px;
  border-right: 1px solid var(--color-border);
  background-color: var(--color-bg-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
  /* 侧栏自己滚动：目录可能很长，窗口也可能很矮，两级都不该被裁掉 */
  overflow-y: auto;
}

.graph-rail__section {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex-shrink: 0;
}

.graph-rail__section--grow {
  min-height: 0;
}

/* 分组标题：小号 + 字距。中文没有大小写可用，层级只能靠字重与字距建立 */
.graph-rail__title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 3px;
  padding: 0 6px;
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--color-text-tertiary);
}

.graph-rail__badge-num {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
}

.graph-rail__segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--color-bg-tertiary);
}

.graph-rail__segment {
  flex: 1;
  padding: 3px 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: inherit;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.graph-rail__segment.active {
  background: var(--color-bg-primary);
  color: var(--color-text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.graph-rail__center {
  margin: 2px 0 0;
  padding: 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--color-primary);
}

.graph-rail__depth {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  color: var(--color-text-tertiary);
}

.graph-rail__depth input {
  flex: 1;
  min-width: 0;
}

.graph-rail__depth-value {
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

.graph-rail__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

/* 目录可能上百条：只给这一栏设上限并独立滚动，其余分组始终可见 */
.graph-rail__section--grow .graph-rail__list {
  max-height: 34vh;
  overflow-y: auto;
}

.graph-rail__row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 4px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.graph-rail__row:hover {
  background: var(--color-bg-primary);
  color: var(--color-text);
}

.graph-rail__row.active {
  background: var(--color-primary-light);
  color: var(--color-primary);
}

/* 目录色条：竖向小方块，比圆点更像「抽屉上的色标」，也顺着列表的竖排方向 */
.graph-rail__bar {
  width: 3px;
  height: 12px;
  flex-shrink: 0;
  border-radius: 2px;
}

.graph-rail__shape {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  background: currentColor;
  opacity: 0.85;
}

.graph-rail__shape--circle {
  border-radius: 50%;
}

.graph-rail__shape--diamond {
  transform: rotate(45deg);
}

.graph-rail__shape--square {
  border-radius: 2px;
}

/* CSS 画三角只能靠边框：左右各 4.5px 透明、底边 8px 实色 */
.graph-rail__shape--triangle {
  width: 0;
  height: 0;
  background: transparent;
  border-left: 4.5px solid transparent;
  border-right: 4.5px solid transparent;
  border-bottom: 8px solid currentColor;
}

.graph-rail__shape--ghost {
  border: 1px dashed currentColor;
  border-radius: 50%;
  background: transparent;
}

.graph-rail__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-rail__ext {
  margin-left: 5px;
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-text-tertiary);
  letter-spacing: 0.02em;
}

.graph-rail__row.active .graph-rail__ext {
  color: inherit;
  opacity: 0.7;
}

.graph-rail__num {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-text-tertiary);
}

.graph-rail__row.active .graph-rail__num {
  color: inherit;
}

.graph-rail__num.warn {
  color: var(--color-danger, #d9534f);
  font-weight: 600;
}

.graph-rail__go {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
}

.graph-rail__footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--color-border);
}

.graph-rail__reset {
  align-self: flex-start;
  padding: 3px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 2px);
  cursor: pointer;
}

.graph-rail__reset:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

/* 图例替代品：这是解释「每个视觉通道代表什么」的唯一一行，必须读得清 */
.graph-rail__hint {
  margin: 0;
  font-size: calc(var(--ui-font-size) - 2px);
  line-height: 1.5;
  color: var(--color-text-tertiary);
}
</style>
