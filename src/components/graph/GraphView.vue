<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ROOT_FOLDER_LABEL, folderColor } from '../../../shared/graph/colors'
import type { GraphNode } from '../../../shared/graph/types'
import { buildRelatedBullet, planRelatedLinkInsertion } from '../../../shared/graph/link-insert'
import { encodeLinkTarget } from '../../../shared/graph/link-resolve'
import { GRAPH_FORMAT_LABELS } from '../../../shared/graph/types'
import { useFileStore } from '../../stores/file'
import { useGraphStore } from '../../stores/graph'
import { useThemeStore } from '../../stores/theme'
import { useWorkspaceStore } from '../../stores/workspace'
import { nodeShape } from '../../utils/graph/shape'
import GraphCanvas from './GraphCanvas.vue'
import GraphIssues from './GraphIssues.vue'
import GraphSidebar from './GraphSidebar.vue'

/**
 * 知识图谱容器：侧栏 + 画布 + 库健康抽屉 + 图上编辑。
 *
 * 只在需要时才懒加载（`EditorPanel` 用 `defineAsyncComponent`），
 * 因此仿真与渲染代码不进首屏包——和思维导图、图表编辑器的处理一致。
 *
 * 版式照官网 §知识图谱 面板：一条顶栏（分段 / 搜索 / 四个计数 / 刷新）由工作台
 * 统一提供，这里只有「索引栏 + 一整块画布」。画布上只允许浮两样东西：
 * 选中节点的卡片、库健康抽屉——它们是「你现在正看着什么」的注脚，
 * 不是控件。搜索、统计、刷新都在顶栏，「做事」的地方和「看什么」的地方分开。
 */

const graphStore = useGraphStore()
const fileStore = useFileStore()
const themeStore = useThemeStore()
const workspaceStore = useWorkspaceStore()

/**
 * `railVisible` 由工作台控制（顶条那个侧栏开关），用来实现「收起侧栏，画布占满」。
 */
const props = withDefaults(defineProps<{ railVisible?: boolean }>(), {
  railVisible: true
})

const canvasRef = ref<InstanceType<typeof GraphCanvas> | null>(null)

const showRail = computed(() => props.railVisible)

const theme = computed(() => (themeStore.isDark ? 'dark' : 'light'))

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

// ===== 局部图 =====
const isLocal = computed(() => graphStore.mode === 'local')
const hiddenNeighbors = computed(() => graphStore.hiddenNeighborCount)

// ===== 选中的节点信息卡 =====
const selectedNode = computed(() => graphStore.selectedNode)
const selectedKindLabel = computed(() => {
  const node = selectedNode.value
  if (!node) return ''
  // 幽灵节点下面那行已经写了「未解析的链接目标」，这里只点明它是什么
  return node.unresolved ? '断链目标' : GRAPH_FORMAT_LABELS[node.format]
})
const selectedShape = computed(() =>
  selectedNode.value?.unresolved ? 'circle' : nodeShape(selectedNode.value?.format ?? 'markdown')
)
/** 卡片里「格式 · 目录」那行：目录是颜色编码的语义，写出来才不用回头看侧栏 */
const selectedFolder = computed(() => {
  const node = selectedNode.value
  if (!node || node.unresolved) return ''
  return node.folder || ROOT_FOLDER_LABEL
})

const selectedFormatText = computed(() =>
  selectedFolder.value ? `${selectedKindLabel.value} · ${selectedFolder.value}` : selectedKindLabel.value
)

/**
 * 选中卡片的出入链清单。
 *
 * 只铺前四行、其余折成「还有 N 条」：卡片宽 224px，铺满会把它撑成一列清单，
 * 反而看不到「这个点在图上的哪」。要全量清单就去局部图。
 */
const CARD_LINK_LIMIT = 4

interface CardLink {
  id: string
  label: string
  dir: string
  fill: string
}

function toCardLink(node: GraphNode): CardLink {
  return {
    id: node.id,
    label: node.label,
    dir: node.unresolved ? '断链' : node.folder || ROOT_FOLDER_LABEL,
    fill: node.unresolved ? '' : folderColor(node.folder, theme.value).fill
  }
}

const cardLinks = computed<{ out: CardLink[]; inc: CardLink[] }>(() => {
  const node = selectedNode.value
  const base = graphStore.effectivePayload
  if (!node || !base) return { out: [], inc: [] }

  const byId = new Map(base.nodes.map((item) => [item.id, item]))
  const out: CardLink[] = []
  const inc: CardLink[] = []
  for (const edge of base.edges) {
    if (edge.source === node.id) {
      const target = byId.get(edge.target)
      if (target) out.push(toCardLink(target))
    }
    if (edge.target === node.id) {
      const source = byId.get(edge.source)
      if (source) inc.push(toCardLink(source))
    }
  }
  return { out, inc }
})

function openSelected(): void {
  const node = selectedNode.value
  if (!node?.path) return
  void fileStore.openFile(graphStore.joinRoot(node.path))
}

/** 从卡片跳到某个邻居：选中它，图上的高亮会跟着走 */
function gotoNode(id: string): void {
  graphStore.selectNode(id)
  canvasRef.value?.centerOnNode(id)
}

function viewLocal(node: GraphNode): void {
  graphStore.setCenter(node.id)
  graphStore.setDepth(1)
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

const isShowing = computed(() => workspaceStore.isGraph)

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
    <!-- 告警条：扫描截断、链接解析异常这类「结果还可用但不完整」的说明 -->
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

    <!-- 主体：侧栏 + 画布 + 库健康抽屉 -->
    <div class="graph-body">
      <div
        v-if="!hasFolder"
        class="graph-state"
      >
        <div class="graph-state__box">
          <div class="graph-state__k">
            WORKSPACE
          </div>
          <div class="graph-state__t">
            知识图谱以工作区为范围
          </div>
          <p class="graph-state__d">
            先打开一个文件夹，才能看到文档之间的链接关系。
          </p>
          <button
            class="graph-state__b"
            @click="fileStore.openFolder()"
          >
            打开文件夹
          </button>
        </div>
      </div>

      <div
        v-else-if="loading"
        class="graph-state"
      >
        <div class="graph-state__box">
          <div class="graph-state__k">
            SCAN
          </div>
          <div class="graph-state__t">
            {{ progressText }}
          </div>
          <div class="graph-state__progress">
            <i />
          </div>
        </div>
      </div>

      <div
        v-else-if="errorText"
        class="graph-state"
      >
        <div class="graph-state__box">
          <div class="graph-state__k">
            ERROR
          </div>
          <div class="graph-state__t">
            构建失败
          </div>
          <p class="graph-state__d">
            {{ errorText }}
          </p>
          <button
            class="graph-state__b"
            @click="graphStore.refresh()"
          >
            重试
          </button>
        </div>
      </div>

      <div
        v-else-if="emptyWorkspace"
        class="graph-state"
      >
        <div class="graph-state__box">
          <div class="graph-state__k">
            EMPTY
          </div>
          <div class="graph-state__t">
            这个工作区里还没有可索引的文档
          </div>
          <p class="graph-state__d">
            图谱会收录 .mdx / .md / .inkmind / .drawio，把它们之间的链接画出来。
          </p>
          <button
            class="graph-state__b"
            @click="openCreateDialog"
          >
            新建笔记
          </button>
        </div>
      </div>

      <template v-else>
        <GraphSidebar
          v-if="showRail"
          class="graph-body__rail"
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
            <div class="graph-state__box">
              <div class="graph-state__k">
                FILTERED
              </div>
              <div class="graph-state__t">
                当前筛选下没有可显示的节点
              </div>
              <p class="graph-state__d">
                目录或类型被关掉了一些，放宽一下就回来了。
              </p>
              <button
                class="graph-state__b"
                @click="graphStore.resetFilters()"
              >
                重置筛选
              </button>
            </div>
          </div>

          <!-- 选中卡片：只有名字、路径、出入链和几条可点的邻居。
               抽屉打开时让位——两块浮卡叠在一起会互相盖住边角 -->
          <aside
            v-if="selectedNode && !filteredEmpty && !graphStore.issuesOpen"
            class="graph-card"
          >
            <div class="graph-card__head">
              <span class="graph-card__k">选中</span>
              <button
                class="graph-card__x"
                title="关闭"
                @click="graphStore.selectNode(null)"
              >
                ×
              </button>
            </div>

            <div class="graph-card__body">
              <div class="graph-card__fmt">
                <span
                  class="graph-card__shape"
                  :class="`graph-card__shape--${selectedShape}${selectedNode.unresolved ? ' graph-card__shape--ghost' : ''}`"
                />
                {{ selectedFormatText }}
              </div>

              <h2 class="graph-card__title">
                {{ selectedNode.label }}
              </h2>
              <div class="graph-card__path">
                {{ selectedNode.path ?? '（未解析的链接目标）' }}
              </div>
              <div class="graph-card__meta">
                <span>入链 {{ selectedNode.inDegree }}</span>
                <span>出链 {{ selectedNode.outDegree }}</span>
              </div>

              <div class="graph-card__acts">
                <button
                  v-if="selectedNode.path"
                  class="graph-card__act"
                  @click="openSelected"
                >
                  打开
                </button>
                <button
                  class="graph-card__act"
                  @click="viewLocal(selectedNode)"
                >
                  看局部
                </button>
                <button
                  v-if="selectedNode.path"
                  class="graph-card__act"
                  @click="openPicker(selectedNode)"
                >
                  链接到…
                </button>
              </div>

              <div class="graph-card__links">
                <div class="graph-card__label">
                  引用 <span class="graph-card__n">{{ cardLinks.out.length }}</span>
                </div>
                <template v-if="cardLinks.out.length > 0">
                  <button
                    v-for="link in cardLinks.out.slice(0, CARD_LINK_LIMIT)"
                    :key="link.id"
                    class="graph-card__link"
                    @mouseenter="graphStore.setHovered(link.id)"
                    @mouseleave="graphStore.setHovered(null)"
                    @click="gotoNode(link.id)"
                  >
                    <span
                      class="graph-card__dot"
                      :style="{ backgroundColor: link.fill }"
                    />
                    <span class="graph-card__link-name">{{ link.label }}</span>
                    <span class="graph-card__dir">{{ link.dir }}</span>
                  </button>
                  <button
                    v-if="cardLinks.out.length > CARD_LINK_LIMIT"
                    class="graph-card__more"
                    @click="viewLocal(selectedNode)"
                  >
                    还有 {{ cardLinks.out.length - CARD_LINK_LIMIT }} 条 · 看局部图
                  </button>
                </template>
                <div
                  v-else
                  class="graph-card__empty"
                >
                  没有出链
                </div>
              </div>

              <div class="graph-card__links">
                <div class="graph-card__label">
                  被引用 <span class="graph-card__n">{{ cardLinks.inc.length }}</span>
                </div>
                <template v-if="cardLinks.inc.length > 0">
                  <button
                    v-for="link in cardLinks.inc.slice(0, CARD_LINK_LIMIT)"
                    :key="link.id"
                    class="graph-card__link"
                    @mouseenter="graphStore.setHovered(link.id)"
                    @mouseleave="graphStore.setHovered(null)"
                    @click="gotoNode(link.id)"
                  >
                    <span
                      class="graph-card__dot"
                      :style="{ backgroundColor: link.fill }"
                    />
                    <span class="graph-card__link-name">{{ link.label }}</span>
                    <span class="graph-card__dir">{{ link.dir }}</span>
                  </button>
                  <button
                    v-if="cardLinks.inc.length > CARD_LINK_LIMIT"
                    class="graph-card__more"
                    @click="viewLocal(selectedNode)"
                  >
                    还有 {{ cardLinks.inc.length - CARD_LINK_LIMIT }} 条 · 看局部图
                  </button>
                </template>
                <div
                  v-else
                  class="graph-card__empty"
                >
                  还没有文档链接到这里
                </div>
              </div>

              <p
                v-if="selectedNode.unresolved"
                class="graph-card__note"
              >
                指向的文件不在库里。改链接或新建同名文件，虚线就会连上。
              </p>
              <p
                v-else-if="isLocal && hiddenNeighbors > 0"
                class="graph-card__note"
              >
                还有 {{ hiddenNeighbors }} 个邻居未显示
                <button @click="graphStore.setMode('global')">
                  扩展到全库
                </button>
              </p>
            </div>
          </aside>

          <GraphIssues
            v-if="graphStore.issuesOpen"
            v-model:section="graphStore.issuesSection"
            @close="graphStore.closeIssues()"
          />

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

.graph-warnings {
  display: flex;
  gap: 14px;
  flex-shrink: 0;
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

.graph-body__rail {
  flex-shrink: 0;
}

.graph-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
  background-color: var(--color-bg-primary);
}

/* ===== 空态 / 加载（照官网的居中卡：一个拉丁文眉标 + 一句正文 + 一个出口） ===== */
.graph-state {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 32px;
  text-align: center;
  background-color: var(--color-bg-primary);
}

/* 盖在画布上而不是替掉画布：画布一旦卸载，仿真坐标就没了 */
.graph-state--overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
}

.graph-state__box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  max-width: 280px;
  padding: 22px 26px;
}

/* 眉标用等宽大写：它是「这是什么状态」的系统标签，不是标题 */
.graph-state__k {
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 3.5px);
  letter-spacing: 0.14em;
  color: var(--color-text-tertiary);
}

.graph-state__t {
  font-size: var(--ui-font-size);
  color: var(--color-text);
}

.graph-state__d {
  margin: 0;
  font-size: calc(var(--ui-font-size) - 1.5px);
  line-height: 1.7;
  color: var(--color-text-tertiary);
}

.graph-state__b {
  margin-top: 4px;
  padding: 4px 12px;
  border: 1px solid var(--color-border-hover);
  border-radius: 5px;
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
  cursor: pointer;
}

.graph-state__b:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

/* 扫描进度：一条 2px 的扫描线，比转圈更贴近「正在读文件」这件事 */
.graph-state__progress {
  width: 128px;
  height: 2px;
  margin-top: 6px;
  border-radius: 1px;
  background: var(--color-border);
  overflow: hidden;
}

.graph-state__progress i {
  display: block;
  width: 40%;
  height: 100%;
  background: var(--color-primary);
  animation: graph-scan 1.1s ease-in-out infinite;
}

@keyframes graph-scan {
  0% {
    transform: translateX(-100%);
  }

  100% {
    transform: translateX(250%);
  }
}

/* ===== 选中卡片（224px，贴右上角） ===== */
.graph-card {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 10;
  width: 224px;
  max-height: calc(100% - 28px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border-hover);
  border-radius: var(--radius-lg);
  background: var(--color-bg-primary);
  box-shadow: 0 10px 24px rgba(16, 24, 40, 0.1);
  overflow: hidden;
}

.graph-card__head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 0;
}

.graph-card__k {
  font-size: calc(var(--ui-font-size) - 3px);
  letter-spacing: 0.1em;
  color: var(--color-text-tertiary);
}

.graph-card__x {
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

.graph-card__x:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.graph-card__body {
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 7px 10px 10px;
}

.graph-card__fmt {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
}

/* 卡片里的样本与画布上的点同构：实心色块 / 圆 / 菱 / 方 / 三角 */
.graph-card__shape {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
  background: currentColor;
}

.graph-card__shape--circle {
  border-radius: 50%;
}

.graph-card__shape--diamond {
  transform: rotate(45deg);
}

.graph-card__shape--square {
  border-radius: 1px;
}

.graph-card__shape--triangle {
  clip-path: polygon(50% 0, 100% 100%, 0 100%);
}

/* 断链目标：空心红虚线圆，和画布上的幽灵节点同一个读法 */
.graph-card__shape--ghost {
  background: none;
  border: 1.2px dashed var(--color-danger, #b91c1c);
  border-radius: 50%;
}

.graph-card__title {
  margin: 0;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 1px);
  font-weight: 600;
  line-height: 1.5;
  color: var(--color-text);
  word-break: break-word;
}

.graph-card__path {
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1.55;
  color: var(--color-text-tertiary);
  word-break: break-all;
}

.graph-card__meta {
  display: flex;
  gap: 12px;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-text-tertiary);
}

.graph-card__acts {
  display: flex;
  gap: 4px;
}

.graph-card__act {
  flex: 1;
  padding: 3px 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 2px);
  cursor: pointer;
}

.graph-card__act:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.graph-card__links {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.graph-card__label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 3px;
  font-size: calc(var(--ui-font-size) - 3.5px);
  letter-spacing: 0.08em;
  color: var(--color-text-tertiary);
}

.graph-card__n {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 3.5px);
  letter-spacing: 0;
}

.graph-card__link {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 2px);
  text-align: left;
  cursor: pointer;
}

.graph-card__link:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.graph-card__dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
}

.graph-card__link-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-card__dir {
  flex-shrink: 0;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 3.5px);
  color: var(--color-text-tertiary);
}

.graph-card__empty {
  padding: 1px 0 2px;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
}

.graph-card__more {
  padding: 2px 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2.5px);
  text-align: left;
  cursor: pointer;
}

.graph-card__more:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.graph-card__note {
  margin: 0;
  padding-top: 6px;
  border-top: 1px solid var(--color-border);
  font-size: calc(var(--ui-font-size) - 2.5px);
  line-height: 1.65;
  color: var(--color-text-tertiary);
}

.graph-card__note button {
  border: none;
  background: transparent;
  color: var(--color-primary);
  padding: 0;
  font-size: inherit;
  cursor: pointer;
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
