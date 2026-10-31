<script setup lang="ts">
import { computed } from 'vue'
import { ROOT_FOLDER_LABEL, folderColor } from '../../../shared/graph/colors'
import type { GraphNodeFormat } from '../../../shared/graph/types'
import { useGraphStore } from '../../stores/graph'
import { useThemeStore } from '../../stores/theme'
import { SHAPE_GROUPS } from '../../utils/graph/shape'

/**
 * 图谱左侧栏：就是一本目录索引。
 *
 * 版式照官网 §知识图谱 那块面板的 `.grf__rail`：204px 宽、三组（视图 / 目录 / 类型）、
 * 每个分组只有一行小标签，下面是索引行——「样本 + 名字 + 右对齐计数」。
 *
 * 三条自我约束，都是为了让这一栏不像块拼装出来的面板：
 * - **没有图例块**：目录行的色点、类型行的形状就是图例本身，
 *   画布上用的是同一支笔，再在底下写一行「颜色＝目录 · 形状＝格式」是重复解释；
 * - **没有概况块**：节点/链接/断链/孤儿四个读数在顶条那一行里，同一份数据不各出现一次；
 * - **没有分隔线**：分组之间只有留白。一栏里画三条横线，读起来就是三张互不相干的表。
 *
 * 筛选过的行整行变淡（`is-off`），而不是加一个「全部目录」行：
 * 取消筛选的出口是底部的「重置筛选」，那个按钮只在真的筛过之后出现。
 */

const graphStore = useGraphStore()
const themeStore = useThemeStore()

const theme = computed(() => (themeStore.isDark ? 'dark' : 'light'))

const isLocal = computed(() => graphStore.mode === 'local')

/** 视图分组标题右侧的注脚：全库，或「深度 N」 */
const modeNote = computed(() => (isLocal.value ? `深度 ${graphStore.depth}` : '全库'))

const centerLabel = computed(() => {
  const id = graphStore.centerId
  if (!id) return '（选中一个节点）'
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
  const allOn = graphStore.filters.folders.length === 0
  return graphStore.allFolders
    .map((folder) => ({
      folder,
      label: folder || ROOT_FOLDER_LABEL,
      count: counts.get(folder) ?? 0,
      // 与画布上的点同一个值：侧栏色标不是「图例里的示意色」，而是那个点本身
      fill: folderColor(folder, theme.value).fill,
      active: allOn || graphStore.filters.folders.includes(folder)
    }))
    // 没有可见文档的目录不该占一行：筛选之后它只会让人以为点错了
    .filter((row) => row.count > 0)
})

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

// ===== 深度 =====
const DEPTHS = [1, 2, 3] as const
</script>

<template>
  <aside class="graph-rail">
    <div class="graph-rail__scroll">
      <div class="graph-rail__group">
        <div class="graph-rail__label">
          视图 <span class="graph-rail__note">{{ modeNote }}</span>
        </div>
        <div class="graph-rail__modes">
          <button
            class="graph-rail__row"
            :class="{ 'is-on': !isLocal }"
            title="整库"
            @click="graphStore.setMode('global')"
          >
            <span class="graph-rail__name">全库</span>
          </button>
          <button
            class="graph-rail__row"
            :class="{ 'is-on': isLocal }"
            title="只看当前文件的邻居"
            @click="graphStore.setMode('local')"
          >
            <span class="graph-rail__name">局部 · {{ graphStore.depth }} 跳</span>
          </button>
        </div>

        <div
          v-if="isLocal"
          class="graph-rail__center"
        >
          <span class="graph-rail__center-dot" />
          <span
            class="graph-rail__center-name"
            :title="centerLabel"
          >{{ centerLabel }}</span>
          <button
            class="graph-rail__center-x"
            title="取消局部图"
            @click="graphStore.setMode('global')"
          >
            ×
          </button>
        </div>

        <div
          v-if="isLocal"
          class="graph-rail__depth"
        >
          <span>深度</span>
          <div class="graph-rail__depth-track">
            <button
              v-for="step in DEPTHS"
              :key="step"
              :class="{ 'is-on': graphStore.depth === step }"
              @click="graphStore.setDepth(step)"
            >
              {{ step }}
            </button>
          </div>
        </div>
      </div>

      <div class="graph-rail__group">
        <div class="graph-rail__label">
          目录
        </div>
        <ul class="graph-rail__list">
          <li
            v-for="row in folderRows"
            :key="row.folder || '__root__'"
          >
            <button
              class="graph-rail__row"
              :class="{ 'is-off': !row.active }"
              :title="`${row.label} · ${row.count} 篇`"
              @click="graphStore.toggleFolder(row.folder)"
            >
              <span
                class="graph-rail__dot"
                :style="{ backgroundColor: row.fill }"
              />
              <span class="graph-rail__name">{{ row.label }}</span>
              <span class="graph-rail__n">{{ row.count }}</span>
            </button>
          </li>
        </ul>
      </div>

      <div class="graph-rail__group">
        <div class="graph-rail__label">
          类型
        </div>
        <ul class="graph-rail__list">
          <li
            v-for="row in typeRows"
            :key="row.id"
          >
            <button
              class="graph-rail__row"
              :class="{ 'is-off': !row.active }"
              :aria-pressed="row.active"
              :title="`开关 ${row.title} ${row.extensions}`"
              @click="toggleType(row.formats)"
            >
              <span
                class="graph-rail__shape"
                :class="`graph-rail__shape--${row.shape}`"
              />
              <span class="graph-rail__name">{{ row.title }}</span>
              <span class="graph-rail__n">{{ row.count }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div
      v-if="graphStore.isFiltered"
      class="graph-rail__foot"
    >
      <button
        class="graph-rail__reset"
        @click="graphStore.resetFilters()"
      >
        重置筛选
      </button>
    </div>
  </aside>
</template>

<style scoped>
.graph-rail {
  width: 204px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--color-border);
  /* 比画布「退后一档」：深色下压到 --color-bg 显得凹进去，浅色下略灰。
     官网的知识图谱面板是同一个关系（侧栏 surface-1、画布 surface-2）。 */
  background-color: var(--color-bg);
}

/* 只有这一层滚动：目录可能很长，窗口也可能很矮，两种都不该被裁掉，
   而底部的「重置筛选」要一直看得见 */
.graph-rail__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 10px;
}

/* 分组之间只有留白，没有分隔线 */
.graph-rail__group {
  display: flex;
  flex-direction: column;
}

/* 分组标题：小号 + 字距。中文没有大小写可用，层级只能靠字重与字距建立 */
.graph-rail__label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 6px;
  font-size: calc(var(--ui-font-size) - 2.5px);
  letter-spacing: 0.09em;
  color: var(--color-text-tertiary);
}

.graph-rail__note {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 2.5px);
  letter-spacing: 0;
}

.graph-rail__list,
.graph-rail__modes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* 索引行：样本 + 名字 + 右对齐数字，行内没有引导点 */
.graph-rail__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 0.5px);
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.graph-rail__row:hover {
  background: var(--color-bg-primary);
  color: var(--color-text);
}

/* 被关掉的组整行变淡，而不是消失：位置固定，用户下一次才摸得到 */
.graph-rail__row.is-off {
  opacity: 0.38;
}

.graph-rail__row.is-off:hover {
  opacity: 0.6;
}

/* 视图的当前项是浅蓝胶囊（与顶条分段同一套语言） */
.graph-rail__modes .is-on {
  background: var(--color-primary-light);
  color: var(--color-on-primary-light);
}

.graph-rail__modes .is-on:hover {
  background: var(--color-primary-light);
  color: var(--color-on-primary-light);
}

/* 局部图的中心：一颗小圆点 + 等宽文件名，右侧一个 × */
.graph-rail__center {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 4px 6px 4px 8px;
  border-radius: 5px;
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1.5px);
}

.graph-rail__center-dot {
  width: 5px;
  height: 5px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--color-primary);
}

.graph-rail__center-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 2px);
}

.graph-rail__center-x {
  margin-left: auto;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--color-text-tertiary);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.graph-rail__center-x:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.graph-rail__depth {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1.5px);
}

.graph-rail__depth-track {
  display: flex;
  gap: 2px;
  margin-left: auto;
}

.graph-rail__depth-track button {
  width: 20px;
  padding: 1px 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 2.5px);
  cursor: pointer;
}

.graph-rail__depth-track button.is-on {
  background: var(--color-primary-light);
  border-color: transparent;
  color: var(--color-on-primary-light);
}

/* 目录色标：与画布上那颗点是同一个颜色、同一个尺寸，侧栏与画布之间不需要换算 */
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
  background: var(--color-text-secondary);
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

/* 三角用 clip-path 而不是三条边框：9px 下边框会吃掉一半，形状糊成一块 */
.graph-rail__shape--triangle {
  clip-path: polygon(50% 0, 100% 100%, 0 100%);
}

.graph-rail__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 计数走等宽：右缘对齐成一列，扫一眼就能比大小 */
.graph-rail__n {
  flex-shrink: 0;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* 底部：只有筛过之后才有内容，不给一个常驻的图例说明 */
.graph-rail__foot {
  flex-shrink: 0;
  padding: 10px;
  border-top: 1px solid var(--color-border);
}

.graph-rail__reset {
  width: 100%;
  padding: 5px;
  border: 1px solid var(--color-border-hover);
  border-radius: 5px;
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
  cursor: pointer;
}

.graph-rail__reset:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}
</style>
