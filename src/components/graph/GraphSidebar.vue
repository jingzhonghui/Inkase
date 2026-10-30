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
    // 与画布上的点同一个值：侧栏色标不是「图例里的示意色」，而是那个点本身
    fill: folderColor(folder, theme.value).fill
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

// ===== 概况：四个计数统一在侧栏 =====
/**
 * 节点 / 链接 / 断链 / 孤儿是「这张图有多大、有多脏」的四个读数，
 * 它们只出现在这一处：顶条只放操作（搜索、收起侧栏、重扫），不再重复读数。
 * 计数的真相在 `stats`；局部图等拿不到 stats 的场景退回到 payload / issues 的长度。
 */
const stats = computed(() => graphStore.stats)
/** 加载中没有可信数字：宁可整块不显示，也不要先闪一个 0 再跳成 137 */
const showStats = computed(() => Boolean(stats.value) && !graphStore.loading)
const nodeCount = computed(
  () => stats.value?.nodeCount ?? graphStore.effectivePayload?.nodes.length ?? 0
)
const edgeCount = computed(
  () => stats.value?.edgeCount ?? graphStore.effectivePayload?.edges.length ?? 0
)
const unresolvedCount = computed(() => stats.value?.unresolvedCount ?? unresolvedIssues.value)
const orphanCount = computed(() => stats.value?.orphanCount ?? orphanIssues.value)
/** 悬停才给的次要信息：扫描了多少文件、花了多久 */
const statsTitle = computed(() => {
  const current = stats.value
  if (!current) return ''
  const parts = [`已扫描 ${current.filesScanned} 个文件`]
  if (current.elapsedMs > 0) parts.push(`用时 ${Math.round(current.elapsedMs)} ms`)
  if (current.truncated) parts.push('已达文件上限，结果不完整')
  return parts.join(' · ')
})
</script>

<template>
  <aside class="graph-rail">
    <!-- 概况：四个读数（也是质量问题的入口），顶条不再重复 -->
    <section
      v-if="showStats"
      class="graph-rail__section"
    >
      <h2 class="graph-rail__title">
        概况
        <span
          v-if="stats?.truncated"
          class="graph-rail__truncated"
          title="已扫描至上限，结果不完整"
        >已截断</span>
      </h2>
      <ul
        class="graph-rail__list graph-rail__stats"
        :title="statsTitle"
      >
        <li>
          <div
            class="graph-rail__row graph-rail__row--stat"
            data-stat="nodes"
          >
            <span class="graph-rail__name">节点</span>
            <span class="graph-rail__num">{{ nodeCount }}</span>
          </div>
        </li>
        <li>
          <div
            class="graph-rail__row graph-rail__row--stat"
            data-stat="edges"
          >
            <span class="graph-rail__name">链接</span>
            <span class="graph-rail__num">{{ edgeCount }}</span>
          </div>
        </li>
        <li>
          <button
            class="graph-rail__row graph-rail__row--issue"
            :class="{ 'is-warn': unresolvedCount > 0 }"
            :title="`${unresolvedCount} 个链接指向不存在的文件`"
            data-issue="unresolved"
            @click="emit('open-issues', 'unresolved')"
          >
            <span class="graph-rail__name">断链</span>
            <span class="graph-rail__num">{{ unresolvedCount }}</span>
            <span class="graph-rail__go">›</span>
          </button>
        </li>
        <li>
          <button
            class="graph-rail__row graph-rail__row--issue"
            :class="{ 'is-warn': orphanCount > 0 }"
            :title="`${orphanCount} 篇笔记既没有出链也没有入链`"
            data-issue="orphans"
            @click="emit('open-issues', 'orphans')"
          >
            <span class="graph-rail__name">孤儿</span>
            <span class="graph-rail__num">{{ orphanCount }}</span>
            <span class="graph-rail__go">›</span>
          </button>
        </li>
      </ul>
    </section>

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
              class="graph-rail__dot"
              :style="{ backgroundColor: row.fill }"
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

    <footer class="graph-rail__footer">
      <button
        v-if="graphStore.isFiltered"
        class="graph-rail__reset"
        @click="graphStore.resetFilters()"
      >
        重置筛选
      </button>
      <p class="graph-rail__hint">
        颜色＝目录 · 形状＝格式 · 大小＝入链数 · 虚线＝断链
      </p>
    </footer>
  </aside>
</template>

<style scoped>
.graph-rail {
  width: 204px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 14px 12px 12px;
  gap: 15px;
  border-right: 1px solid var(--color-border);
  /* 比画布「退后一档」：深色下压到 --color-bg 显得凹进去，浅色下略灰。
     官网的知识图谱面板是同一个关系（侧栏 surface-1、画布 surface-2）。 */
  background-color: var(--color-bg);
  font-size: calc(var(--ui-font-size) - 0.5px);
  /* 侧栏自己滚动：目录可能很长，窗口也可能很矮，两级都不该被裁掉 */
  overflow-y: auto;
}

/* 分组之间只有留白，没有分隔线：一栏里四组是同一件事的四个面，
   画上横线会把它们切成四块互不相干的表 */
.graph-rail__section {
  display: flex;
  flex-direction: column;
  gap: 2px;
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
  margin: 0 0 4px;
  padding: 0 6px;
  font-size: calc(var(--ui-font-size) - 2.5px);
  font-weight: 500;
  letter-spacing: 0.09em;
  color: var(--color-text-tertiary);
}

.graph-rail__badge-num {
  margin-left: auto;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
}

.graph-rail__segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--color-bg-primary);
}

.graph-rail__segment {
  flex: 1;
  padding: 3px 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: inherit;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

/* 当前段＝实心强调底（官网同一做法）：两段之间只靠留白与底色区分，
   不给按钮加边框，否则一栏里会同时出现三种「按钮」 */
.graph-rail__segment.active {
  background: var(--color-primary-light);
  color: var(--color-text);
  font-weight: 600;
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
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border: none;
  border-radius: 5px;
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

/* 命中行是实心浅蓝块，不是「描个边框」：一行里既有色标又有计数，
   再加框线会和色标抢注意力 */
.graph-rail__row.active {
  background: var(--color-primary-light);
  color: var(--color-text);
}

/* 目录色标：与画布上那颗点是同一个颜色、同一个尺寸（8px 圆点），
   侧栏与画布之间不需要用户做任何换算 */
.graph-rail__dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
}

.graph-rail__shape {
  width: 9px;
  height: 9px;
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
  border-radius: 1px;
}

/* CSS 画三角只能靠边框：左右各 4.5px 透明、底边 9px 实色 */
.graph-rail__shape--triangle {
  width: 0;
  height: 0;
  background: transparent;
  border-left: 4.5px solid transparent;
  border-right: 4.5px solid transparent;
  border-bottom: 9px solid currentColor;
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

/* 计数走等宽：右缘对齐成一列，扫一眼就能比大小 */
.graph-rail__num {
  flex-shrink: 0;
  margin-left: auto;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: calc(var(--ui-font-size) - 2.5px);
  color: var(--color-text-tertiary);
}

.graph-rail__row.active .graph-rail__num {
  color: inherit;
  opacity: 0.72;
}

/* 有问题的分组整行转成告警色，而不只是数字发红：
   「断链 2」这行本身就是入口，颜色得先落在入口上 */
.graph-rail__row.is-warn,
.graph-rail__row.is-warn .graph-rail__num {
  color: var(--color-danger, #d9534f);
}

.graph-rail__row.is-warn:hover {
  background: color-mix(in srgb, var(--color-danger, #d9534f) 12%, transparent);
  color: var(--color-danger, #d9534f);
}

.graph-rail__go {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
}

/* 概况的两条纯读数不是按钮（点了没反应，就别给按钮的手型与悬停底色） */
.graph-rail__row--stat {
  cursor: default;
}

.graph-rail__row--stat:hover {
  background: transparent;
  color: var(--color-text-secondary);
}

/* 「已截断」是给读数打的注脚，不是第四个计数：贴右、比标题更弱 */
.graph-rail__truncated {
  margin-left: auto;
  padding: 0 5px;
  border: 1px solid color-mix(in srgb, #b8860b 55%, var(--color-border));
  border-radius: 999px;
  color: #b8860b;
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 600;
  letter-spacing: 0;
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
