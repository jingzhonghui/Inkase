<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GraphNode } from '../../../shared/graph/types'
import { buildRelatedBullet, planRelatedLinkInsertion } from '../../../shared/graph/link-insert'
import { encodeLinkTarget } from '../../../shared/graph/link-resolve'
import { GRAPH_FORMAT_LABELS } from '../../../shared/graph/types'
import { useFileStore } from '../../stores/file'
import { useGraphStore } from '../../stores/graph'
import { useWorkspaceStore } from '../../stores/workspace'
import { nodeShape } from '../../utils/graph/shape'
import GraphCanvas from './GraphCanvas.vue'
import GraphIssues from './GraphIssues.vue'
import GraphSidebar from './GraphSidebar.vue'

/**
 * 知识图谱容器：页头 + 侧栏 + 画布 + 问题抽屉 + 图上编辑。
 *
 * 只在需要时才懒加载（`EditorPanel` 用 `defineAsyncComponent`），
 * 因此仿真与渲染代码不进首屏包——和思维导图、图表编辑器的处理一致。
 *
 * 布局分三层，各管一件事：
 * - 页头：搜索、状态（节点/链接/截断）、刷新 —— 「做事」的地方；
 * - 侧栏：视图 / 目录 / 类型 / 质量 —— 「看什么」的地方，图例与过滤器合并；
 * - 画布：只画面，不放控件。
 */

const graphStore = useGraphStore()
const fileStore = useFileStore()
const workspaceStore = useWorkspaceStore()

/**
 * 嵌进工作台时：
 * - `embedded` 交出自己的页头（搜索 / 统计 / 刷新），由工作台顶条统一提供，
 *   否则顶部会叠出两条横条；
 * - `railVisible` 由工作台控制，用来实现「收起侧栏，画布占满」。
 */
const props = withDefaults(defineProps<{ embedded?: boolean; railVisible?: boolean }>(), {
  embedded: false,
  railVisible: true
})

const canvasRef = ref<InstanceType<typeof GraphCanvas> | null>(null)
const issuesOpen = ref(false)
const issuesSection = ref<'unresolved' | 'orphans'>('unresolved')
/** 侧栏可收起：窄窗口下 236px 全给画布更划算 */
const railOpen = ref(true)

const showRail = computed(() => !props.embedded || (props.railVisible && railOpen.value))

// ===== 空态 / 加载态 =====
const hasFolder = computed(() => Boolean(fileStore.openedFolderPath))
const loading = computed(() => graphStore.loading)
const errorText = computed(() => graphStore.error)
const progressText = computed(() => {
  const progress = graphStore.progress
  if (!progress) return '正在扫描工作区…'
  return `已扫描 ${progress.scanned} / ${progress.total}`
})
const emptyWorkspace = computed(
  () => !loading.value && !errorText.value && hasFolder.value && !graphStore.hasGraph
)
/** 有图但被筛空了：给出口，而不是留一块白板 */
const filteredEmpty = computed(
  () => !loading.value && !errorText.value && graphStore.hasGraph && graphStore.visibleNodes.length === 0
)

// ===== 计数（页头） =====
const stats = computed(() => graphStore.stats)
/** 悬停才给的次要信息：扫描了多少文件、花了多久 */
const statsTitle = computed(() => {
  const current = stats.value
  if (!current) return ''
  const parts = [`已扫描 ${current.filesScanned} 个文件`]
  if (current.elapsedMs > 0) parts.push(`用时 ${Math.round(current.elapsedMs)} ms`)
  if (current.truncated) parts.push('已达文件上限，结果不完整')
  return parts.join(' · ')
})

// ===== 局部图 =====
const isLocal = computed(() => graphStore.mode === 'local')
const hiddenNeighbors = computed(() => graphStore.hiddenNeighborCount)

// ===== 搜索 =====
const searchInput = ref('')

watch(
  () => graphStore.filters.query,
  (query) => {
    if (query !== searchInput.value) searchInput.value = query
  }
)

function applySearch(): void {
  graphStore.setQuery(searchInput.value)
}

function onSearchEnter(): void {
  applySearch()
  const matches = graphStore.searchMatches
  if (!matches || matches.size === 0) return
  // 选中并居中最靠前的命中，让用户马上看到结果在哪
  const first = graphStore.visibleNodes.find((node) => matches.has(node.id))
  if (!first) return
  graphStore.selectNode(first.id)
  canvasRef.value?.centerOnNode(first.id)
}

function clearSearch(): void {
  searchInput.value = ''
  applySearch()
}

// ===== 选中的节点信息卡 =====
const selectedNode = computed(() => graphStore.selectedNode)
const selectedKindLabel = computed(() => {
  const node = selectedNode.value
  if (!node) return ''
  // 幽灵节点下面那行已经写了「未解析的链接目标」，这里只点明它是什么
  return node.unresolved ? '断链节点' : GRAPH_FORMAT_LABELS[node.format]
})
const selectedShape = computed(() =>
  selectedNode.value?.unresolved ? 'circle' : nodeShape(selectedNode.value?.format ?? 'markdown')
)

function openSelected(): void {
  const node = selectedNode.value
  if (!node?.path) return
  void fileStore.openFile(graphStore.joinRoot(node.path))
}

async function copyPath(node: GraphNode): Promise<void> {
  if (!node.path) return
  try {
    await navigator.clipboard.writeText(node.path)
  } catch {
    // 剪贴板不可用时静默失败，不值得弹错
  }
}

// ===== 右键菜单 =====
interface MenuItemDef {
  label: string
  action: () => void | Promise<void>
  disabled?: boolean
}

const menu = ref<{ visible: boolean; x: number; y: number; items: MenuItemDef[] }>({
  visible: false,
  x: 0,
  y: 0,
  items: []
})

function closeMenu(): void {
  menu.value.visible = false
}

function onNodeContext(nodeId: string, position: { x: number; y: number }): void {
  const node = graphStore.effectivePayload?.nodes.find((item) => item.id === nodeId)
  if (!node) return
  graphStore.selectNode(nodeId)

  menu.value = {
    visible: true,
    x: position.x,
    y: position.y,
    items: [
      {
        label: '打开',
        action: () => {
          // node.path 已被上面的空值判断收窄，这里再判一次是为了让闭包内也拿到 string
          if (!node.path) return
          void fileStore.openFile(graphStore.joinRoot(node.path))
        }
      },
      {
        label: '链接到…',
        action: () => openPicker(node),
        disabled: !node.path
      },
      {
        label: '复制路径',
        action: () => copyPath(node),
        disabled: !node.path
      },
      {
        label: '以此为局部图中心',
        action: () => graphStore.setCenter(nodeId),
        disabled: !node.path
      }
    ]
  }
}

function onCanvasContext(position: { x: number; y: number }): void {
  menu.value = {
    visible: true,
    x: position.x,
    y: position.y,
    items: [
      { label: '新建笔记', action: openCreateDialog, disabled: !hasFolder.value },
      { label: '适应内容', action: () => canvasRef.value?.fitContent() },
      { label: '刷新索引', action: () => graphStore.refresh() }
    ]
  }
}

async function runMenuAction(item: MenuItemDef): Promise<void> {
  closeMenu()
  await item.action()
}

// ===== 新建笔记 =====
const createDialogOpen = ref(false)
const createName = ref('')
const createError = ref('')
const creating = ref(false)

function openCreateDialog(): void {
  createName.value = ''
  createError.value = ''
  createDialogOpen.value = true
}

async function confirmCreate(): Promise<void> {
  const root = fileStore.openedFolderPath
  if (!root) return
  const raw = createName.value.trim()
  if (!raw) {
    createError.value = '请输入文件名'
    return
  }
  const fileName = /\.(mdx|md)$/i.test(raw) ? raw : `${raw}.mdx`

  creating.value = true
  try {
    const ok = await fileStore.createFile(root, fileName)
    if (!ok) {
      createError.value = fileStore.error || '创建失败'
      return
    }
    createDialogOpen.value = false
    await fileStore.openFile(graphStore.joinRoot(fileName))
    await graphStore.refresh()
  } finally {
    creating.value = false
  }
}

// ===== 链接到… =====
const pickerOpen = ref(false)
const pickerQuery = ref('')
const pickerSource = ref<GraphNode | null>(null)
const pickerBusy = ref(false)
const pickerError = ref('')

function openPicker(node: GraphNode): void {
  pickerSource.value = node
  pickerQuery.value = ''
  pickerError.value = ''
  pickerOpen.value = true
}

const pickerCandidates = computed(() => {
  const source = pickerSource.value
  const payload = graphStore.effectivePayload
  if (!source || !payload) return []
  const query = pickerQuery.value.trim().toLowerCase()
  return payload.nodes
    .filter((node) => node.path && !node.unresolved && node.id !== source.id)
    .filter((node) => (query ? node.label.toLowerCase().includes(query) || (node.path ?? '').toLowerCase().includes(query) : true))
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(0, 50)
})

/** 已打开在标签页里的目标文件走「只改缓冲区」分支 */
function findOpenTab(relativePath: string): { id: string; content: string } | null {
  const root = fileStore.openedFolderPath
  if (!root) return null
  const target = graphStore.joinRoot(relativePath)
  const tab = fileStore.tabs.find(
    (item) => item.fileInfo?.path && item.fileInfo.path.toLowerCase() === target.toLowerCase()
  )
  return tab ? { id: tab.id, content: tab.content } : null
}

async function linkTo(target: GraphNode): Promise<void> {
  const source = pickerSource.value
  if (!source?.path || !target.path) return

  pickerBusy.value = true
  pickerError.value = ''
  try {
    const bullet = buildRelatedBullet(
      target.label,
      encodeLinkTarget(source.path, target.path)
    )
    const openTab = findOpenTab(source.path)

    if (openTab) {
      // 绝不直接落盘：编辑器缓冲区才是真相，交给用户自己保存
      const plan = planRelatedLinkInsertion(openTab.content, bullet)
      if (plan.content === openTab.content) {
        pickerOpen.value = false
        return
      }
      fileStore.updateTabContent(openTab.id, plan.content)
      pickerOpen.value = false
      return
    }

    const result = await window.electronAPI.createGraphLink({
      root: fileStore.openedFolderPath ?? '',
      from: source.path,
      to: target.path,
      title: target.label
    })
    if (!result.success) {
      pickerError.value = result.error || '写入链接失败'
      return
    }
    pickerOpen.value = false
    // 只让索引里这个文件的出链重算，不必整库重建
    await graphStore.refresh()
  } catch (err) {
    pickerError.value = err instanceof Error ? err.message : '写入链接失败'
  } finally {
    pickerBusy.value = false
  }
}

// ===== 问题抽屉 =====
function openIssues(section: 'unresolved' | 'orphans'): void {
  issuesSection.value = section
  issuesOpen.value = true
}

onMounted(() => {
  void graphStore.build()
  document.addEventListener('click', closeMenu)
})

// 面板现在可以反复开关（v-if），文档级监听必须跟着卸载，
// 否则每次重开都多挂一个已销毁组件的 handler
onBeforeUnmount(() => {
  if (rebuildTimer !== null) clearTimeout(rebuildTimer)
  document.removeEventListener('click', closeMenu)
})

watch(
  () => graphStore.panelActive,
  (active) => {
    if (active) void graphStore.build()
  }
)

// 会话恢复是异步的：工作台首屏直接落在图谱时，onMounted 里的 build() 可能还没有
// 工作区，只能以「先打开一个文件夹」收场，之后不会自己再试一次。这里补上：
// root 一到就建一次（build 内部按 builtRoot 去重，不会重复扫描）。
// 用户中途换工作区也走这条路径，省掉手动点刷新。
watch(
  () => fileStore.openedFolderPath,
  (root, previous) => {
    if (!root || root === previous) return
    void graphStore.build()
  }
)

// 顶条搜索按回车 → 把命中项居中。请求发在 store 里，因为画布的 ref 在这一层
watch(
  () => graphStore.focusRequest,
  (request) => {
    if (request) canvasRef.value?.centerOnNode(request.id)
  }
)

// ===== 索引跟随磁盘 =====
/**
 * 保存、外部改动、文件树增删改名都会把 `libraryRevision` 推一格。
 *
 * 图谱是对磁盘的一次性快照：文档存盘后新增/删除的链接、新文件，不重建就看不到。
 * 三条约束：
 * - 防抖：连按 Ctrl+S 不该扫三遍；
 * - 静默：画布上有图时不要换成转圈，叫 `refresh(true)`；
 * - 不在后台白扫：图谱没在眼前时只记一个待办，等它再露面时补建。
 */
const GRAPH_REBUILD_DEBOUNCE_MS = 500
const pendingRebuild = ref(false)
let rebuildTimer: ReturnType<typeof setTimeout> | null = null

const isShowing = computed(() =>
  props.embedded ? workspaceStore.isGraph : graphStore.panelActive
)

function scheduleRebuild(): void {
  if (rebuildTimer !== null) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    if (!graphStore.hasGraph) return
    void graphStore.refresh(true)
  }, GRAPH_REBUILD_DEBOUNCE_MS)
}

watch(
  () => fileStore.libraryRevision,
  () => {
    if (!graphStore.panelOpen) return
    if (!isShowing.value) {
      pendingRebuild.value = true
      return
    }
    scheduleRebuild()
  }
)

watch(isShowing, (showing) => {
  if (!showing || !pendingRebuild.value) return
  pendingRebuild.value = false
  scheduleRebuild()
})
</script>

<template>
  <div
    class="graph-view"
    @click="closeMenu"
  >
    <!-- 页头：做事的地方（搜索 / 状态 / 刷新） -->
    <header
      v-if="!props.embedded"
      class="graph-header"
    >
      <button
        class="graph-header__rail"
        :class="{ active: railOpen }"
        title="显示或隐藏侧栏"
        @click="railOpen = !railOpen"
      >
        ▤
      </button>
      <!-- 面板标签用 span 而不是 h1：视图名已经在标签页上，这里只是定位用的眉标 -->
      <span class="graph-header__title">知识图谱</span>

      <div class="graph-header__search">
        <input
          v-model="searchInput"
          type="search"
          placeholder="搜索笔记名…"
          @input="applySearch"
          @keydown.enter.prevent="onSearchEnter"
        >
        <button
          v-if="searchInput"
          class="graph-header__clear"
          title="清除"
          @click="clearSearch"
        >
          ×
        </button>
      </div>

      <!-- 只留「这张图有多大」两个数；断链与孤儿是质量指标，归侧栏 -->
      <div
        v-if="stats && !loading"
        class="graph-header__stats"
        :title="statsTitle"
      >
        <span class="graph-header__stat">节点 <b>{{ stats.nodeCount }}</b></span>
        <span class="graph-header__sep">·</span>
        <span class="graph-header__stat">链接 <b>{{ stats.edgeCount }}</b></span>
        <span
          v-if="stats.truncated"
          class="graph-header__stat truncated"
          title="已扫描至上限，结果不完整"
        >已截断</span>
      </div>

      <button
        class="graph-header__refresh"
        :disabled="loading"
        title="重新扫描工作区"
        @click="graphStore.refresh()"
      >
        ⟳
      </button>
    </header>

    <!-- 告警条 -->
    <div
      v-if="graphStore.warnings.length > 0"
      class="graph-warnings"
    >
      <span
        v-for="(warning, index) in graphStore.warnings.slice(0, 3)"
        :key="index"
      >{{ warning }}</span>
      <span v-if="graphStore.warnings.length > 3">…等 {{ graphStore.warnings.length }} 条</span>
    </div>

    <!-- 主体：侧栏 + 画布 + 问题抽屉 -->
    <div class="graph-body">
      <div
        v-if="!hasFolder"
        class="graph-state"
      >
        <h2>知识图谱以工作区为范围</h2>
        <p>先打开一个文件夹，才能看到文档之间的链接关系。</p>
        <button
          class="graph-state__btn primary"
          @click="fileStore.openFolder()"
        >
          打开文件夹
        </button>
      </div>

      <div
        v-else-if="loading"
        class="graph-state"
      >
        <div class="graph-state__spinner" />
        <p>{{ progressText }}</p>
      </div>

      <div
        v-else-if="errorText"
        class="graph-state"
      >
        <h2>构建失败</h2>
        <p>{{ errorText }}</p>
        <button
          class="graph-state__btn"
          @click="graphStore.refresh()"
        >
          重试
        </button>
      </div>

      <div
        v-else-if="emptyWorkspace"
        class="graph-state"
      >
        <h2>这个工作区里还没有可索引的文档</h2>
        <p>图谱会收录 .mdx / .md / .inkmind / .drawio，把它们之间的链接画出来。</p>
        <button
          class="graph-state__btn primary"
          @click="openCreateDialog"
        >
          新建笔记
        </button>
      </div>

      <template v-else>
        <GraphSidebar
          v-if="showRail"
          @open-issues="openIssues"
        />

        <div class="graph-stage">
          <!-- 画布始终挂载：卸载会连仿真坐标一起丢，筛选恢复后整张图会重新播种跳位，
               而「过滤只改渲染集合、不重排」是这块的核心保证。空态改成浮层盖在上面。 -->
          <GraphCanvas
            ref="canvasRef"
            @node-context="onNodeContext"
            @canvas-context="onCanvasContext"
          />

          <div
            v-if="filteredEmpty"
            class="graph-state graph-state--overlay"
          >
            <h2>当前筛选下没有可显示的节点</h2>
            <p>侧栏里的目录或类型被关掉了一些，放宽一下就回来了。</p>
            <button
              class="graph-state__btn primary"
              @click="graphStore.resetFilters()"
            >
              重置筛选
            </button>
          </div>

          <!-- 选中节点信息卡 -->
          <div
            v-if="selectedNode && !filteredEmpty"
            class="graph-info"
          >
            <div class="graph-info__kind">
              <span
                class="graph-info__shape"
                :class="`graph-info__shape--${selectedShape}`"
              />
              {{ selectedKindLabel }}
            </div>
            <div class="graph-info__title">
              {{ selectedNode.label }}
            </div>
            <div class="graph-info__path">
              {{ selectedNode.path ?? '（未解析的链接目标）' }}
            </div>
            <div class="graph-info__meta">
              <span>出链 {{ selectedNode.outDegree }}</span>
              <span>入链 {{ selectedNode.inDegree }}</span>
            </div>
            <p
              v-if="hiddenNeighbors > 0 && isLocal"
              class="graph-info__hidden"
            >
              还有 {{ hiddenNeighbors }} 个邻居未显示
              <button @click="graphStore.setMode('global')">
                扩展到全库
              </button>
            </p>
            <div class="graph-info__actions">
              <button
                v-if="selectedNode.path"
                class="graph-info__btn"
                @click="openSelected"
              >
                打开
              </button>
              <button
                v-if="selectedNode.path"
                class="graph-info__btn"
                @click="openPicker(selectedNode)"
              >
                链接到…
              </button>
              <button
                class="graph-info__btn"
                @click="graphStore.selectNode(null)"
              >
                关闭
              </button>
            </div>
          </div>

          <!-- 右键菜单：坐标是画布局部的，所以必须挂在这一层 -->
          <div
            v-if="menu.visible"
            class="graph-menu"
            :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
            @click.stop
          >
            <button
              v-for="(item, index) in menu.items"
              :key="index"
              :disabled="item.disabled"
              @click="runMenuAction(item)"
            >
              {{ item.label }}
            </button>
          </div>
        </div>

        <GraphIssues
          v-if="issuesOpen"
          v-model:section="issuesSection"
          @close="issuesOpen = false"
        />
      </template>
    </div>

    <!-- 新建笔记对话框 -->
    <div
      v-if="createDialogOpen"
      class="graph-modal"
      @click.self="createDialogOpen = false"
    >
      <div class="graph-modal__panel">
        <h3>新建笔记</h3>
        <input
          v-model="createName"
          type="text"
          placeholder="笔记名（默认 .mdx）"
          autofocus
          @keydown.enter.prevent="confirmCreate"
        >
        <p
          v-if="createError"
          class="graph-modal__error"
        >
          {{ createError }}
        </p>
        <div class="graph-modal__actions">
          <button @click="createDialogOpen = false">
            取消
          </button>
          <button
            class="primary"
            :disabled="creating"
            @click="confirmCreate"
          >
            创建
          </button>
        </div>
      </div>
    </div>

    <!-- 目标选择器 -->
    <div
      v-if="pickerOpen"
      class="graph-modal"
      @click.self="pickerOpen = false"
    >
      <div class="graph-modal__panel graph-modal__panel--picker">
        <h3>链接到…</h3>
        <p class="graph-modal__hint">
          会插入到「<code>{{ pickerSource?.label }}</code>」文末的「相关笔记」小节，已存在则跳过。
        </p>
        <input
          v-model="pickerQuery"
          type="search"
          placeholder="搜索目标笔记…"
          autofocus
        >
        <ul class="graph-picker">
          <li
            v-for="candidate in pickerCandidates"
            :key="candidate.id"
          >
            <button
              :disabled="pickerBusy"
              @click="linkTo(candidate)"
            >
              <span class="graph-picker__label">{{ candidate.label }}</span>
              <span class="graph-picker__path">{{ candidate.path }}</span>
            </button>
          </li>
          <li
            v-if="pickerCandidates.length === 0"
            class="graph-picker__empty"
          >
            没有匹配的笔记
          </li>
        </ul>
        <p
          v-if="pickerError"
          class="graph-modal__error"
        >
          {{ pickerError }}
        </p>
        <div class="graph-modal__actions">
          <button @click="pickerOpen = false">
            取消
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.graph-view {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--color-bg-primary);
}

/* ===== 页头 ===== */
.graph-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-bg-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.graph-header__rail {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.graph-header__rail:hover {
  background: var(--color-bg-primary);
  color: var(--color-text);
}

.graph-header__rail.active {
  color: var(--color-primary);
}

/* 标题用小号 + 字距而不是大字：这是工作台里的一个面板，不是落地页 */
.graph-header__title {
  flex-shrink: 0;
  font-size: calc(var(--ui-font-size) - 2px);
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--color-text-tertiary);
}

.graph-header__search {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  max-width: 280px;
}

.graph-header__search input {
  width: 100%;
  padding: 3px 22px 3px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text);
  font-size: inherit;
  outline: none;
}

.graph-header__search input:focus {
  border-color: var(--color-primary);
}

.graph-header__clear {
  position: absolute;
  right: 2px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  padding: 0 4px;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.graph-header__stats {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.graph-header__stat b {
  font-weight: 600;
  color: var(--color-text);
}

.graph-header__sep {
  opacity: 0.5;
}

.graph-header__stat.truncated {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--color-warning, #b8860b) 55%, var(--color-border));
  color: var(--color-warning, #b8860b);
  font-weight: 600;
}

.graph-header__refresh {
  flex-shrink: 0;
  width: 24px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.graph-header__refresh:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.graph-header__refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

.graph-warnings {
  display: flex;
  gap: 14px;
  padding: 4px 12px;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-warning, #b8860b);
  background: color-mix(in srgb, var(--color-warning, #b8860b) 10%, transparent);
  border-bottom: 1px solid var(--color-border);
}

/* ===== 主体 ===== */
.graph-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.graph-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.graph-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px;
  text-align: center;
  color: var(--color-text-secondary);
}

/* 盖在画布上而不是替掉画布：画布一旦卸载，仿真坐标就没了 */
.graph-state--overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  background-color: var(--color-bg-primary);
}

.graph-state h2 {
  margin: 0;
  font-size: calc(var(--ui-font-size) + 3px);
  font-weight: 600;
  color: var(--color-text);
}

.graph-state p {
  margin: 0;
  max-width: 420px;
  line-height: 1.6;
  font-size: var(--ui-font-size);
}

.graph-state__btn {
  padding: 6px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-primary);
  color: var(--color-text);
  cursor: pointer;
  font-size: var(--ui-font-size);
}

.graph-state__btn.primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.graph-state__spinner {
  width: 26px;
  height: 26px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: graph-spin 0.9s linear infinite;
}

@keyframes graph-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ===== 选中信息卡 ===== */
.graph-info {
  position: absolute;
  left: 12px;
  bottom: 12px;
  width: 252px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-bg-primary) 92%, transparent);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(8px);
}

.graph-info__kind {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 4px;
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--color-text-tertiary);
}

/* 图例标记与画布上的节点同构：空心 + 细描边，而不是一颗实心色块。
   两边长得一样，用户才不用在「卡片里的方块」和「图上的点」之间做翻译。 */
.graph-info__shape {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  box-sizing: border-box;
  border: 1.5px solid var(--color-text-secondary);
  background: transparent;
}

.graph-info__shape--circle {
  border-radius: 50%;
}

.graph-info__shape--diamond {
  transform: rotate(45deg);
}

.graph-info__shape--square {
  border-radius: 1px;
}

.graph-info__shape--triangle {
  width: 0;
  height: 0;
  border: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-bottom: 7px solid var(--color-text-secondary);
}

.graph-info__title {
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-info__path {
  margin-top: 2px;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
  word-break: break-all;
}

.graph-info__meta {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.graph-info__hidden {
  margin: 8px 0 0;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
}

.graph-info__hidden button {
  border: none;
  background: transparent;
  color: var(--color-primary);
  cursor: pointer;
  padding: 0;
  font-size: inherit;
}

.graph-info__actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}

.graph-info__btn {
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: calc(var(--ui-font-size) - 1px);
}

.graph-info__btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

/* ===== 右键菜单 / 对话框 ===== */
.graph-menu {
  position: absolute;
  z-index: 30;
  min-width: 150px;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}

.graph-menu button {
  display: block;
  width: 100%;
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  text-align: left;
  font-size: var(--ui-font-size);
  cursor: pointer;
}

.graph-menu button:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
}

.graph-menu button:disabled {
  color: var(--color-text-tertiary);
  cursor: default;
}

.graph-modal {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.28);
}

.graph-modal__panel {
  width: 360px;
  max-width: 90%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-radius: var(--radius-md);
  background: var(--color-bg-primary);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.24);
}

.graph-modal__panel--picker {
  width: 440px;
}

.graph-modal__panel h3 {
  margin: 0;
  font-size: calc(var(--ui-font-size) + 1px);
  color: var(--color-text);
}

.graph-modal__hint {
  margin: 0;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
  line-height: 1.5;
}

.graph-modal__panel input {
  padding: 6px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text);
  font-size: var(--ui-font-size);
  outline: none;
}

.graph-modal__panel input:focus {
  border-color: var(--color-primary);
}

.graph-modal__error {
  margin: 0;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-danger, #d9534f);
}

.graph-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.graph-modal__actions button {
  padding: 5px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text);
  cursor: pointer;
  font-size: var(--ui-font-size);
}

.graph-modal__actions button.primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.graph-picker {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.graph-picker li + li {
  border-top: 1px solid var(--color-border);
}

.graph-picker button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  padding: 6px 9px;
  border: none;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
  font-size: var(--ui-font-size);
}

.graph-picker button:hover {
  background: var(--color-bg-tertiary);
}

.graph-picker__path {
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
}

.graph-picker__empty {
  padding: 12px;
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
}
</style>
