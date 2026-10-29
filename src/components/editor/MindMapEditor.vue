<script setup lang="ts">
/**
 * 思维导图编辑器
 *
 * 职责：
 * - 把 `fileStore.fileContent`（`.inkmind` 的 JSON 文本）解析为模型并渲染；
 * - 把渲染层的操作（增删改、拖拽、折叠）防抖序列化回 store；
 * - 跟随 Inkase 明暗主题；
 * - 解析失败或渲染抛错时给出可修复的入口，而不是让用户面对一片空白。
 *
 * 交互对齐 XMind：
 * - Tab 新建子主题、Enter 新建同级主题、Ctrl+Enter 新建父主题、F2 改名、Delete 删除；
 * - **拖动主题改变位置/归属**：本组件自己实现（见下）；
 * - **按住根主题拖动 = 平移画布**，与 XMind 一致；
 * - 方向键在主题间移动，Ctrl+滚轮 / 控制条缩放，滚轮滚动画布；
 * - 右键菜单作用于「被右键的那个主题」，并按节点能力禁用不适用项；
 * - 彩虹分支（可切换为单色）+ 为单个分支指定颜色。
 *
 * 四个刻意为之的决定：
 * 1. 关闭渲染库自带的右键菜单。它是 `position: fixed`、覆盖整个视口的遮罩层
 *    （`.context-menu`，z-index 99）并挂在画布内部，在编辑器面板里会吃掉所有点击，
 *    文案也是英文默认值。这里改为面板内的自有菜单。
 * 2. 关闭渲染库自带的工具栏。它把缩放/居中/方向按钮画在画布内且样式不受控，
 *    这里换成右下角的自有控制条（缩放百分比、适应、居中、折叠、彩虹、结构方向）。
 * 3. `overflowHidden` 必须保持默认值（不裁剪）。渲染库的构造逻辑是
 *    `overflowHidden ? container.style.overflow='hidden' : disposable.push(jn(this))`，
 *    而 `jn` 正是整套指针交互层（选中、拖动、平移、双击改名、右键）。
 * 4. **画布是一张「纸」**（`.mind-map-canvas`，最小 2000×2000，内容更大时按内容
 *    自动扩张，见 `resizePageToContent`），滚动画布交给浏览器原生滚动，
 *    而不是靠渲染库的 `transform` 平移假装滚动。原生滚动的好处是滑块范围/惯性/
 *    触控板手势全部由浏览器保证，不需要自己维护一套坐标换算；纸面必须随内容长大，
 *    否则渲染库那层 `overflow:hidden` 会把超出的主题直接裁掉、滚也滚不到。
 *
 * 为什么拖拽要自己写：渲染库内建的节点拖拽在 Electron 里没有生效，而它的实现埋在
 * 压缩代码里、依赖内部状态机，出问题无法定位也无法兜底。这里改为在画布捕获阶段
 * 接管主题上的 pointerdown，自己做浮层/落点判定，最后调用渲染库的
 * `moveNodeIn / moveNodeBefore / moveNodeAfter` 落地，数据一致性仍由渲染库负责。
 *
 * 注意：`Ctrl + ←/→` 仍由 AppHeader 的捕获阶段监听用于切换标签，
 * 因此渲染库自带的 `initLeft/initRight` 快捷键在本应用中不可用。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import MindElixir from 'mind-elixir'
import type { MindElixirInstance } from 'mind-elixir'
import 'mind-elixir/style.css'
import { useFileStore } from '../../stores/file'
import { useThemeStore } from '../../stores/theme'
import {
  MINDMAP_FILE_SCHEMA,
  MINDMAP_VERSION,
  type MindMapAttachment,
  type MindMapDocument,
  type MindMapIcon,
  type MindMapLayoutDirection
} from '../../types/mindmap'
import { parseMindMap, serializeMindMap } from '../../utils/mindmap/schema'
import {
  fromElixirData,
  iconsFromElixir,
  MINDMAP_ATTACHMENTS_META_KEY,
  MINDMAP_IMAGE_META_KEY,
  toElixirData,
  writeIconsToElixir
} from '../../utils/mindmap/adapter'
import { resolveMindMapImageSrc } from '../../utils/mindmap/image-src'
import { createMindMapAutosave, type MindMapAutosave } from '../../utils/mindmap/autosave'
import {
  createMindMapTheme,
  getMindMapMonoColor,
  getMindMapPalette
} from '../../utils/mindmap/theme'
import {
  paintBranchTopics,
  readSelectionInfo,
  resolveBranchColor,
  type MindMapBranchColorOptions,
  type MindMapSelectionInfo
} from '../../utils/mindmap/branch-color'
import {
  DRAG_THRESHOLD,
  containsNodeId,
  ghostLabel,
  resolveInsertType,
  type DropInsertType
} from '../../utils/mindmap/drag'
import {
  nextPageSize,
  nextZoomScale,
  MINDMAP_PAGE_MIN,
  MINDMAP_ZOOM_MAX,
  MINDMAP_ZOOM_MIN
} from '../../utils/mindmap/viewport'
import {
  areAllChildrenCollapsed,
  buildMindMapMenu,
  isRootTopic,
  resolveTopicFromEvent,
  type MindMapMenuAction,
  type MindMapMenuChoice,
  type MindMapMenuItem,
  type MindMapTopicElement
} from '../../utils/mindmap/context-menu'
import { buildMindMapSvg, MINDMAP_EXPORT_MARGIN } from '../../utils/mindmap/svg-export'
import { rasterizeSvgToPng } from '../../utils/mindmap/png-export'
import { collectMatches, nextMatchIndex, type MindMapMatch } from '../../utils/mindmap/search'
import {
  MAX_ATTACHMENTS,
  MINDMAP_PRIORITIES,
  normalizeAttachments,
  normalizeLink,
  normalizeTags
} from '../../utils/mindmap/rich-content'
import { requestDialog } from '../../utils/dialog'
import { themedCursor } from '../../utils/cursor'
import {
  registerMindMapImageBuilder,
  type MindMapImageFile,
  type MindMapImageFormat
} from '../../utils/mindmap/export-bridge'
import MindMapControlBar from './MindMapControlBar.vue'
import MindMapInspector from './MindMapInspector.vue'
import FindReplacePanel from './FindReplacePanel.vue'

const fileStore = useFileStore()
const themeStore = useThemeStore()

/** 渲染库方法的主题参数类型，避免依赖它的深层类型路径 */
type TopicArg = NonNullable<Parameters<MindElixirInstance['addChild']>[0]>

/**
 * 画布「纸」的边长（px）。
 * 尺寸不是固定的：渲染库的 `.map-container` 是 `100%×100%` 且 `overflow:hidden`，
 * 内容比纸面大就会被裁掉、滚也滚不到，所以每次布局后按内容实际占位扩张（见
 * `resizePageToContent`）。最小值仍是一张 2000×2000 的纸，小图观感不变。
 */
const pageSize = ref(MINDMAP_PAGE_MIN)

const containerRef = ref<HTMLDivElement | null>(null)
/**
 * 交给渲染库的那个元素。
 * 必须是独立的子元素：渲染库构造时会 `el.style.position = 'relative'` 并清空 innerHTML，
 * 如果直接把滚动容器传进去，内联 relative 会顶掉滚动容器的 absolute/inset，
 * 容器高度随之塌成内容高度，滚动条就永远不会出现（内容也会被外层裁掉）。
 */
const canvasRef = ref<HTMLDivElement | null>(null)
const viewportRef = ref<HTMLDivElement | null>(null)
/**
 * 画布列（左侧）。同时是右键菜单的定位容器：
 * 菜单是 `position: absolute`，只有相对这个 `position: relative` 的祖先算坐标，
 * 弹出的位置才会正好在光标处（否则会被顶部提示条的高度整体推偏）。
 */
const mainRef = ref<HTMLDivElement | null>(null)
/** 属性栏外壳，用于判断点击是否落在属性栏里 */
const inspectorRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLDivElement | null>(null)
/** 附件卡片小菜单的根元素（用于判断点击是否落在菜单内） */
const cardMenuRef = ref<HTMLDivElement | null>(null)
const isReady = ref(false)
const errorMessage = ref('')
const errorTitle = ref('思维导图内容待修复')
/** 解析失败时进入 JSON 修复模式 */
const showFallback = ref(false)
const fallbackText = ref('')
/**
 * 解析时被自动修复的问题。
 * 宽容解析是刻意的（宁可修好能打开，也不要白屏），但修了什么必须让用户知道：
 * 例如「重复节点 id 已重新生成」会静默改文件内容，不说就等于偷偷改用户数据。
 */
const repairNotes = ref<string[]>([])

const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuItems = ref<MindMapMenuItem[]>([])
/** 右键命中的主题是否允许改分支颜色（根主题没有独立分支，不给） */
const menuSupportsColor = ref(false)

/**
 * 画布上附件卡片的小菜单（打开 / 另存为 / 移除）。
 *
 * 卡片是注入到主题元素里的独立 DOM，不参与主题菜单的选中逻辑，
 * 所以单独存一份状态：里面记着坐标和「这张卡片属于哪个主题的哪个附件」。
 */
const cardMenu = ref<{ visible: boolean; x: number; y: number }>({
  visible: false,
  x: 0,
  y: 0
})
let cardMenuTopic: MindMapTopicElement | null = null
let cardMenuFile: MindMapAttachment | null = null

/** 备注编辑面板（作用于右键命中的那个主题） */
const noteVisible = ref(false)
const noteText = ref('')
const noteInputRef = ref<HTMLTextAreaElement | null>(null)
let noteTopic: MindMapTopicElement | null = null

/**
 * 标签 / 链接的输入面板。
 * 与备注面板同构，只是输入更短：标签用逗号分隔多个，链接只接受 http(s)。
 * 不用 `window.prompt`：Electron 渲染进程里它不可用，而且样式无法跟主题走。
 */
const richVisible = ref(false)
const richMode = ref<'tag' | 'link' | 'attachment'>('tag')
const richValue = ref('')
const richError = ref('')
const richInputRef = ref<HTMLInputElement | null>(null)
let richTopic: MindMapTopicElement | null = null

/** 画布视图状态 */
const zoom = ref(1)
const rainbow = ref(true)
const layoutDirection = ref<MindMapLayoutDirection>('side')

/* ------------------------------ 画布内查找 ------------------------------ */

/**
 * 命中标记的 class。
 * 与拖拽态、`has-note` 同一套做法：直接写在渲染库生成的 `me-tpc` 上，
 * 样式由组件里的 `:deep()` 规则提供。渲染库每次重绘都会丢弃这些 class，
 * 因此 `scheduleMeasure()` 里要补一次重绘（见 `paintSearchMatches`）。
 */
const SEARCH_MATCH_CLASS = 'is-search-match'
const SEARCH_MATCH_CURRENT_CLASS = 'is-search-match-current'

/**
 * 新插入图片的默认显示尺寸。
 * 渲染库的画布会按这个尺寸布局，先给一个能看清又不至于撑爆画布的框；
 * 用户在属性栏改尺寸的能力留到后续版本（文件里已经存了 width/height）。
 */
const DEFAULT_NODE_IMAGE_WIDTH = 200
const DEFAULT_NODE_IMAGE_HEIGHT = 140

const searchOpen = ref(false)
const searchQuery = ref('')
const searchCaseSensitive = ref(false)
/** 命中列表：id + 文字 + 祖先链，跳转所需的全部信息都在这里 */
const searchMatches = shallowRef<MindMapMatch[]>([])
/** 当前命中下标，-1 表示没有当前项 */
const searchIndex = ref(-1)

/** 拖拽浮层（坐标相对 `.mind-map-viewport`） */
const ghost = ref({ visible: false, x: 0, y: 0, text: '' })

let mind: MindElixirInstance | null = null
let autosave: MindMapAutosave | null = null
/** 当前右键命中的主题（不能放进 ref，否则会被 Vue 深层代理，破坏渲染库对 DOM 的引用） */
let menuTopic: MindMapTopicElement | null = null
/** 右键时的选中数量：关系线要求恰好两个端点 */
let menuSelectionCount = 1
/** 正在把外部内容写进渲染层，避免与自身的序列化互相触发 */
let isApplyingExternal = false
/** 合并到下一帧的测量，避免连续事件每帧多次强制布局 */
let layoutFrame = 0

/* --------------------------- 拖拽手势状态 --------------------------- */
type PointerPhase = 'idle' | 'press' | 'drag' | 'pan'

let phase: PointerPhase = 'idle'
let gesturePointerId: number | null = null
let pressX = 0
let pressY = 0
let lastX = 0
let lastY = 0
let pressTopic: MindMapTopicElement | null = null
let pressIsRoot = false
let dropTopic: MindMapTopicElement | null = null
let dropType: DropInsertType | null = null

/**
 * 挂载时的 tab id。
 * 必须钉住：切标签时本组件在「激活标签已切换」之后才卸载，
 * 此时若写 `updateContent`（面向当前激活标签）会把本文档内容写进另一个标签。
 * 因此一律走按 id 定向写入，标签已关闭时该调用会自动忽略。
 */
const boundTabId = fileStore.activeTabId

/**
 * 本组件的文档路径。
 * 节点图片存的是相对路径，只有知道导图在哪才能拼出可加载的 URL；
 * 未保存的新文件没有路径，图片会加载不出来，但不影响其余编辑。
 *
 * 按 `boundTabId` 找而不是用 `activeTab`：切标签时本组件还没卸载，
 * 用当前激活标签会拿到别人的路径。
 */
const documentPath = computed(() => {
  const tab = fileStore.tabs.find((item) => item.id === boundTabId)
  return tab?.fileInfo?.path ?? null
})

/**
 * 容器内的资源映射：包内路径 → 解压后的绝对路径。
 *
 * 同一份理由按 `boundTabId` 取——切标签时本组件还在，用 activeTab 会拿到别人的表。
 */
const assetMap = computed<Record<string, string>>(() => {
  const tab = fileStore.tabs.find((item) => item.id === boundTabId)
  return tab?.mindMapAssets ?? {}
})

/** 适配器要求的图片路径解析器（渲染层唯一一处知道协议细节的地方） */
function resolveImage(src: string): string {
  return resolveMindMapImageSrc(src, assetMap.value)
}

const isDark = computed(() => themeStore.isDark)
/**
 * 拖动主题时的光标：原生 `grabbing` 是白色手形位图，浅色主题的画布上几乎看不见。
 * 换成按主题配色的自绘四向箭头（`utils/cursor.ts`），兜底是黑白双色的系统 `move`。
 */
const dragCursor = computed(() => themedCursor(themeStore.isDark, 'move', true))
const sourceText = computed(() => fileStore.fileContent)
const menuStyle = computed(() => ({ left: `${menuX.value}px`, top: `${menuY.value}px` }))
const branchPalette = computed(() => getMindMapPalette(isDark.value ? 'dark' : 'light'))
const showCanvasUi = computed(() => isReady.value && !showFallback.value)
const ghostStyle = computed(() => ({ left: `${ghost.value.x}px`, top: `${ghost.value.y}px` }))

/** 主题元素 → 渲染库方法入参 */
function asTopic(el: MindMapTopicElement): TopicArg {
  return el as unknown as TopicArg
}

/** 事件目标是否落在「正在编辑主题文字」的输入框里 */
function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('#input-box, textarea, input'))
}

/* --------------------------- 序列化与同步 --------------------------- */

/** 渲染层数据 + 视图设置 → 自有文档（彩虹开关不在渲染层数据里，必须合并） */
function currentDocument(): MindMapDocument | null {
  if (!mind) return null
  return fromElixirData(mind.getData(), { rainbowBranches: rainbow.value })
}

/** 渲染层当前应落盘的文本 */
function currentText(): string {
  const document = currentDocument()
  return document ? serializeMindMap(document) : ''
}

/** 创建同步器：渲染层就绪后才有意义 */
function ensureAutosave(): MindMapAutosave {
  if (!autosave) {
    autosave = createMindMapAutosave({
      getData: () => mind?.getData() ?? null,
      serialize: (data) =>
        serializeMindMap(fromElixirData(data, { rainbowBranches: rainbow.value })),
      commit: (text) => {
        if (boundTabId) {
          fileStore.updateTabContent(boundTabId, text)
        } else {
          fileStore.updateContent(text)
        }
      }
    })
  }
  return autosave
}

/** 合并短时间内的多次操作，再统一提交 */
function scheduleCommit(): void {
  if (isApplyingExternal) return
  ensureAutosave().schedule()
}

/** 渲染层的任何异常都要转成可见的错误提示，绝不留下空白面板 */
function reportRuntimeError(scope: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  errorTitle.value = '思维导图遇到问题'
  errorMessage.value = `${scope}：${detail}`
  fallbackText.value = sourceText.value
  showFallback.value = true
  hideMenu()
  cancelLayoutFrame()
}

/**
 * 给带备注的主题加一个小标记。
 * 备注默认不可见（只有右键菜单里能看出来），没有任何视觉提示时用户会忘记自己写过；
 * 标记本身由 CSS 画在主题右下角，不参与布局，因此不会影响渲染库的位置计算。
 */
function decorateNoteMarkers(): void {
  const map = containerRef.value?.querySelector<HTMLElement>('.map-container')
  if (!map) return
  for (const topic of Array.from(map.querySelectorAll<MindMapTopicElement>('me-tpc'))) {
    const note = topic.nodeObj?.note
    topic.classList.toggle('has-note', typeof note === 'string' && note.length > 0)
  }
}

/* ------------------------------ 附件卡片 ------------------------------ */

/** 卡片容器的 class，同时用于「每次重绘先清旧卡片」 */
const ATTACHMENT_CARDS_CLASS = 'inkase-attach-cards'

/**
 * 附件按 MIME 给一个小字形。
 *
 * 不用图片图标：卡片是注入的裸 DOM，引外部图片会让打包路径多一层依赖；
 * 字形在图、文两个字色下都能看清，也省掉一套图标资源。
 */
function attachmentGlyph(file: MindMapAttachment): string {
  const mime = file.mime.toLowerCase()
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (mime.startsWith('image/')) return '🖼'
  if (mime === 'application/pdf' || ext === 'pdf') return '📕'
  if (mime.includes('word') || ext === 'doc' || ext === 'docx') return '📘'
  if (mime.includes('sheet') || mime.includes('excel') || ext === 'xls' || ext === 'xlsx') {
    return '📗'
  }
  if (mime.includes('presentation') || mime.includes('powerpoint')) return '📙'
  if (mime.includes('zip') || mime.includes('compressed')) return '🗜'
  if (mime.startsWith('text/') || mime.includes('json')) return '📃'
  if (mime.startsWith('audio/')) return '🎵'
  if (mime.startsWith('video/')) return '🎬'
  return '📎'
}

/**
 * 把附件画成节点下方的卡片。
 *
 * 渲染库没有「附件」这个概念，卡片只能事后注入；而它每次重绘都会重建主题元素，
 * 外面的 DOM 会被丢掉，所以这个函数必须挂在 `scheduleMeasure()` 里，每次都重来一遍。
 * 幂等：先按 class 清掉上一轮的卡片，再按当前数据重建。
 *
 * 卡片是 `me-tpc` 里的块级元素，参与节点自身的高度——节点随之变高，
 * 整张图由渲染库自己的 flex 布局自然重排，不需要我们算位置。
 */
function paintAttachmentCards(): void {
  const map = containerRef.value?.querySelector<HTMLElement>('.map-container')
  if (!map) return

  for (const stale of Array.from(map.querySelectorAll<HTMLElement>(`.${ATTACHMENT_CARDS_CLASS}`))) {
    stale.remove()
  }

  for (const topic of Array.from(map.querySelectorAll<MindMapTopicElement>('me-tpc'))) {
    const files = readNodeAttachments(topic.nodeObj)
    if (files.length === 0) continue

    const box = document.createElement('div')
    box.className = ATTACHMENT_CARDS_CLASS
    for (const file of files) box.appendChild(createAttachmentCard(topic, file))
    topic.appendChild(box)
  }
}

/** 单张卡片：字形 + 文件名 + 大小；左键打开、右键出菜单 */
function createAttachmentCard(
  topic: MindMapTopicElement,
  file: MindMapAttachment
): HTMLDivElement {
  const card = document.createElement('div')
  card.className = 'inkase-attach-card'
  card.dataset.attachmentId = file.id
  card.title = `${file.name}（打开）`

  const glyph = document.createElement('span')
  glyph.className = 'inkase-attach-glyph'
  glyph.setAttribute('aria-hidden', 'true')
  glyph.textContent = attachmentGlyph(file)

  const name = document.createElement('span')
  name.className = 'inkase-attach-name'
  // 文件名来自用户文件，属于不可信输入：只走 textContent，绝不拼 HTML
  name.textContent = file.name

  card.append(glyph, name)

  const size = formatFileSize(file.size)
  if (size !== '') {
    const sizeEl = document.createElement('span')
    sizeEl.className = 'inkase-attach-size'
    sizeEl.textContent = size
    card.append(sizeEl)
  }

  // 卡片自己的交互不该冒泡给画布：否则会顺带选中/拖动主题、甚至进入改名
  const stop = (event: Event): void => event.stopPropagation()
  card.addEventListener('pointerdown', stop)
  card.addEventListener('dblclick', stop)
  card.addEventListener('click', (event) => {
    event.stopPropagation()
    void openAttachment(file)
  })
  card.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()
    openCardMenu(event, topic, file)
  })

  return card
}

/** 打开卡片菜单（坐标相对编辑器根元素，与主题菜单同一套算法） */
function openCardMenu(
  event: MouseEvent,
  topic: MindMapTopicElement,
  file: MindMapAttachment
): void {
  const anchor = mainRef.value?.getBoundingClientRect()
  if (!anchor) return
  cardMenuTopic = topic
  cardMenuFile = file
  cardMenu.value = {
    visible: true,
    x: Math.max(4, Math.min(event.clientX - anchor.left, anchor.width - 168)),
    y: Math.max(4, Math.min(event.clientY - anchor.top, anchor.height - 24))
  }
  hideMenu()
}

function hideCardMenu(): void {
  cardMenu.value = { visible: false, x: 0, y: 0 }
  cardMenuTopic = null
  cardMenuFile = null
}

type CardMenuAction = 'open' | 'save-as' | 'remove'

/** 卡片菜单的三个动作，全部复用附件面板里已有的实现 */
function runCardMenuAction(action: CardMenuAction): void {
  const topic = cardMenuTopic
  const file = cardMenuFile
  hideCardMenu()
  if (!topic || !file) return
  if (action === 'open') {
    void openAttachment(file)
    return
  }
  if (action === 'save-as') {
    void saveAttachmentAs(file)
    return
  }
  // 移除后卡片要跟着消失：数据变了就重画一次，不必等渲染库重绘
  removeAttachment(file.id, topic)
  paintAttachmentCards()
  scheduleMeasure()
}

/* ------------------------------ 画布内查找 ------------------------------ */

/** 按 id 取画布上的主题元素；渲染库未挂载或节点未渲染时返回 null */
function findTopicElement(id: string): MindMapTopicElement | null {
  if (!mind) return null
  try {
    return (mind.findEle(id) as MindMapTopicElement | null) ?? null
  } catch {
    // 库在个别状态（未 init、已 destroy）下会抛错，这里按「找不到」处理
    return null
  }
}

/** 下一个可用的动画帧（jsdom 里可能没有 rAF） */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      resolve()
      return
    }
    requestAnimationFrame(() => resolve())
  })
}

/** 清掉画布上所有查找标记 */
function clearSearchMarks(): void {
  const map = containerRef.value?.querySelector('.map-container')
  if (!map) return
  const marked = map.querySelectorAll<HTMLElement>(
    `.${SEARCH_MATCH_CLASS}, .${SEARCH_MATCH_CURRENT_CLASS}`
  )
  for (const el of Array.from(marked)) {
    el.classList.remove(SEARCH_MATCH_CLASS, SEARCH_MATCH_CURRENT_CLASS)
  }
}

/**
 * 按当前命中列表给画布打标记。
 *
 * 幂等：每次都先清旧标记再重打，因此可以安全地在「任何可能重绘的时机」调用。
 * 渲染库每次布局都会重建主题元素、丢掉外部加的 class，所以这个函数必须挂到
 * `scheduleMeasure()` 里（与分支配色、备注角标同一处），否则标记会在编辑后消失。
 */
function paintSearchMatches(): void {
  if (!containerRef.value) return
  clearSearchMarks()
  if (!searchOpen.value || searchMatches.value.length === 0) return

  const currentId = searchMatches.value[searchIndex.value]?.id ?? ''
  for (const match of searchMatches.value) {
    const el = findTopicElement(match.id)
    if (!el) continue
    el.classList.add(SEARCH_MATCH_CLASS)
    if (match.id === currentId) el.classList.add(SEARCH_MATCH_CURRENT_CLASS)
  }
}

/**
 * 逐级展开命中节点的祖先。
 *
 * 根节点必须跳过：渲染库里根主题的 DOM 结构是 `me-root > me-tpc`，
 * 没有父级容器，对根调用 `expandNode` 会直接抛错（组件别处已有同样处理）。
 */
function expandAncestors(ancestorIds: string[]): void {
  if (!mind) return
  for (const id of ancestorIds) {
    const el = findTopicElement(id)
    if (!el || isRootTopic(el)) continue
    try {
      mind.expandNode(asTopic(el), true)
    } catch {
      // 已经是展开状态、或该节点不可折叠：跳过即可，不影响后续跳转
    }
  }
}

/**
 * 跳到第 index 个命中。
 *
 * 顺序很重要：先展开（否则元素根本不在 DOM 里）→ 等布局稳定 → 居中 → 选中。
 * 展开会触发渲染库的 `expandNode` 事件并落盘，这是「查找会自动展开折叠分支」
 * 的既定行为（用户已确认）。
 */
async function jumpTo(index: number): Promise<void> {
  const match = searchMatches.value[index]
  if (!match || !mind) return

  searchIndex.value = index
  // 当前标记要立刻切过去：计数是同步更新的，标记如果拖到滚动之后才变，
  // 面板上明明写着「2/2」、画布却还停在上一处，看起来就像按了没反应
  paintSearchMatches()
  expandAncestors(match.ancestorIds)
  await nextTick()
  // 展开后渲染库还要重排一次，等一帧再量位置，否则会滚到旧坐标
  await nextFrame()

  const el = findTopicElement(match.id)
  if (!el) {
    // 节点仍未渲染（极端情况下祖先没展开成功）：保留高亮，不做滚动
    paintSearchMatches()
    return
  }

  try {
    mind.scrollIntoView(asTopic(el), true)
    mind.selectNode(asTopic(el))
  } catch {
    // 滚动/选中失败不影响搜索结果本身，忽略即可，不把画布换成兜底面板
  }
  paintSearchMatches()
}

/**
 * 重新计算命中。
 *
 * 数据源与落盘走同一条路径（渲染层 → 自有模型），避免出现「文件里有一份、
 * 画布上是另一份」的偏差。
 *
 * @param jumpFirst 命中后是否自动跳到第一处（用户输入时需要，外部内容变化时不需要）
 */
function runSearch(jumpFirst = true): void {
  const document = currentDocument()
  searchMatches.value = document
    ? collectMatches(document.root, searchQuery.value, searchCaseSensitive.value)
    : []
  searchIndex.value = searchMatches.value.length > 0 ? 0 : -1

  if (jumpFirst && searchIndex.value >= 0) {
    // 先同步打标：跳转要等布局稳定（异步），标记不该跟着延后
    paintSearchMatches()
    void jumpTo(searchIndex.value)
    return
  }
  paintSearchMatches()
}

/** 打开查找面板（画布没挂载时不响应，否则会弹出一个永远搜不到东西的面板） */
function openSearch(): void {
  if (!isReady.value || showFallback.value) return
  hideMenu()
  searchOpen.value = true
  if (searchQuery.value.trim() !== '') {
    runSearch()
  } else {
    searchMatches.value = []
    searchIndex.value = -1
  }
  focusSearchInput()
}

/** 面板打开后把焦点交给输入框（等它渲染出来） */
function focusSearchInput(): void {
  void nextTick(() => {
    const input = mainRef.value?.querySelector<HTMLInputElement>('.find-replace-panel input')
    input?.focus()
    input?.select()
  })
}

/** 关闭查找并清除全部标记 */
function closeSearch(): void {
  searchOpen.value = false
  searchMatches.value = []
  searchIndex.value = -1
  searchQuery.value = ''
  clearSearchMarks()
  focusCanvas()
}

/** 面板输入变化 */
function onSearchInput(query: string, caseSensitive: boolean): void {
  searchQuery.value = query
  searchCaseSensitive.value = caseSensitive
  runSearch()
}

/** 在命中之间循环（面板的上下箭头 / Enter / Shift+Enter 都走这里） */
function stepSearch(step: 1 | -1): void {
  if (searchMatches.value.length === 0) return
  const next = nextMatchIndex(searchIndex.value, searchMatches.value.length, step)
  if (next < 0) return
  void jumpTo(next)
}

/**
 * `Ctrl+F` 是否该由本组件接管。
 *
 * 明面上要避开别的输入框：AI 对话、各类对话框里的输入框有自己的快捷键语义，
 * 抢走会让人莫名其妙。落在导图编辑器内的输入框（主题改名、查找框、备注）
 * 仍然接管——那里按 `Ctrl+F` 的意图就是「在这张图里找」。
 */
function shouldHandleFindShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true
  if (target.closest('.mind-map-editor')) return true
  return !target.closest('input, textarea, [contenteditable="true"]')
}

/* ------------------------------ 图片导出 ------------------------------ */

/** 注销「当前导图能出图」的登记（切换标签/卸载时必须调用，否则菜单会导出到旧 DOM） */
let releaseImageBuilder: (() => void) | null = null

/**
 * 把画布变成一张图片交给 store 去落盘。
 *
 * 刻意不在组件里弹保存对话框：导出属于文件操作，由 store 统一处理
 * （与「导出大纲」「导出 Markdown」同一条路径），组件只负责 DOM → 字节。
 *
 * 注意导出的是**实时 DOM**：彩虹分支的手选色、折叠状态、当前方向都会如实反映，
 * 与右侧属性栏、画布所见一致；与当前缩放比例无关（几何用的是布局坐标）。
 */
async function buildImageFile(format: MindMapImageFormat): Promise<MindMapImageFile> {
  const built = buildMindMapSvg(containerRef.value, { margin: MINDMAP_EXPORT_MARGIN })
  if (!built) throw new Error('画布还没有可导出的内容')
  if (format === 'svg') {
    return {
      format,
      width: built.width,
      height: built.height,
      bytes: new TextEncoder().encode(built.svg)
    }
  }
  const blob = await rasterizeSvgToPng(built.svg, built.width, built.height)
  return {
    format,
    width: built.width,
    height: built.height,
    bytes: new Uint8Array(await blob.arrayBuffer())
  }
}

/** 登记出图能力；重复调用只保留最后一次登记 */
function registerImageBuilder(): void {
  releaseImageBuilder?.()
  releaseImageBuilder = registerMindMapImageBuilder(buildImageFile)
}

/**
 * 控制条上的导出按钮。
 *
 * 真正写盘的是 store 的 `exportMindMapImage`（走主进程的保存对话框），
 * 这里只处理失败：导出失败不能像渲染异常那样把画布换成兜底面板，
 * 画布本身是好的，弹一个对话框说明原因即可。
 */
async function exportImage(format: MindMapImageFormat): Promise<void> {
  const ok = await fileStore.exportMindMapImage(format)
  if (ok || !fileStore.error) return
  await requestDialog({
    title: '导出失败',
    message: fileStore.error,
    buttons: [{ label: '确定', value: 0, primary: true }]
  })
}

/* ------------------------------ 视图同步 ------------------------------ */

/** 把渲染库当前的缩放同步到控制条 */
function updateZoom(): void {
  if (!mind) return
  zoom.value = mind.scaleVal
}

function cancelLayoutFrame(): void {
  if (layoutFrame) {
    cancelAnimationFrame(layoutFrame)
    layoutFrame = 0
  }
}

/** 合并到下一帧（缩放/布局的连续事件走这条路径） */
function scheduleMeasure(): void {
  if (layoutFrame) return
  if (typeof requestAnimationFrame !== 'function') {
    updateZoom()
    return
  }
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0
    updateZoom()
    decorateBranches()
    decorateNoteMarkers()
    // 渲染库重绘会丢掉外部加的 DOM 与 class，卡片和查找标记都要在这里补一次
    paintAttachmentCards()
    paintSearchMatches()
    resizePageToContent()
  })
}

/**
 * 让「纸」跟着内容长大。
 *
 * 渲染库把整张图画在 `.map-container`（100%×100% + overflow:hidden）里，
 * 内容超出纸面就被裁掉，滚动条也滚不到那些主题——节点一多就会「看不见但确实存在」。
 * 这里在布局结束后按内容实际占位重算边长，纸面始终比内容大一圈。
 *
 * 内容布局与纸面尺寸无关（节点位置只由节点自身尺寸决定），所以不会形成测量回环；
 * 纸面变大后内容在纸中依旧居中，因此把滚动位置同步偏移 `(增量 / 2)` 就能保持视野不动。
 */
function resizePageToContent(): void {
  if (!mind) return
  const content = mind.nodes.getBoundingClientRect()
  const previous = pageSize.value
  const next = nextPageSize(content.width, content.height, mind.scaleVal, previous)
  if (next === previous) return
  pageSize.value = next
  const canvas = containerRef.value
  if (!canvas) return
  // DOM 更新后滚动范围才会变大，这里等下一帧再补滚动，避免被旧范围截断
  const delta = next - previous
  void nextTick(() => {
    scrollViewBy(canvas, { left: delta / 2, top: delta / 2 }, false)
  })
}

/**
 * 给每个主分支上色（彩虹分支）。
 *
 * 渲染库只把分支色写在**连线和一级主题的边框**上，二级以下主题本体仍是单色，
 * 开彩虹后就成了「连线七彩、节点单色」的割裂观感——这正是「彩虹分支没生效」的原因。
 * 具体规则与上色逻辑在 `utils/mindmap/branch-color.ts`，属性栏读同一份计算结果，
 * 保证面板上显示的色块和画布上的连线颜色不会各说各话。
 */
function decorateBranches(): void {
  paintBranchTopics(containerRef.value?.querySelector('.map-container') ?? null, branchOptions())
}

/* ------------------------------ 渲染层 ------------------------------ */

function applyTheme(refresh = true): void {
  if (!mind) return
  mind.changeTheme(
    createMindMapTheme(isDark.value ? 'dark' : 'light', { rainbow: rainbow.value }),
    refresh
  )
  if (refresh) scheduleMeasure()
  else decorateBranches()
}

/**
 * 滚轮：Ctrl/⌘ + 滚轮缩放，其余情况交给浏览器的原生滚动。
 * 必须自定义，否则渲染库的默认实现会把滚轮变成 `transform` 平移并 preventDefault，
 * 原生滚动条就永远滚不动了。
 */
function onCanvasWheel(event: WheelEvent): void {
  if (!mind) return
  if (!(event.ctrlKey || event.metaKey)) return
  event.preventDefault()
  const next = nextZoomScale(mind.scaleVal, event.deltaY < 0 ? 'in' : 'out')
  if (next === mind.scaleVal) return
  try {
    mind.scale(next, { x: event.clientX, y: event.clientY })
  } catch (error) {
    reportRuntimeError('缩放失败', error)
    return
  }
  updateZoom()
  focusCanvas()
}

function createInstance(el: HTMLElement): MindElixirInstance {
  const instance = new MindElixir({
    el,
    direction: MindElixir.SIDE,
    editable: true,
    // 新主题文案对齐中文界面（库默认是英文 "New Node"）
    newTopicName: '新节点',
    // 自带菜单是覆盖整个视口的浮层，改用本组件内的菜单
    contextMenu: false,
    // 自带工具栏画在画布内且样式不可控，改用右下角控制条
    toolBar: false,
    keypress: true,
    allowUndo: true,
    scaleMin: MINDMAP_ZOOM_MIN,
    scaleMax: MINDMAP_ZOOM_MAX,
    // 滚轮改由 onCanvasWheel 接管（缩放走渲染库，滚动走原生）
    handleWheel: onCanvasWheel,
    // 见文件头注释第 3 点：必须保持不裁剪，否则指针交互层不会被安装
    overflowHidden: false,
    theme: createMindMapTheme(isDark.value ? 'dark' : 'light', { rainbow: rainbow.value })
  })

  // 会改变数据的事件 → 落盘
  for (const event of ['operation', 'expandNode', 'changeDirection'] as const) {
    instance.bus.addListener(event, scheduleCommit)
  }
  // 每次布局结束都会触发 linkDiv，用它统一刷新缩放读数与分支配色。
  // 注意这里必须**同步**补一次着色：渲染库每次重绘都会按自己的规则重设主题边框色
  // （`palette[第几支 % 长度]`），而 scheduleMeasure 的着色合并到下一帧执行，
  // 连续重绘时（切换彩虹、折叠、换向）最后一次重绘可能落在着色之后，
  // 颜色就会停在渲染库那一版——表现就是「开了彩虹，所有分支还是一个颜色」。
  instance.bus.addListener('linkDiv', () => {
    scheduleMeasure()
    decorateBranches()
  })
  instance.bus.addListener('scale', updateZoom)
  // 选中态是属性栏的唯一数据源：点选、框选、删除、撤销都会走到这两个事件
  instance.bus.addListener('selectNodes', syncInspector)
  instance.bus.addListener('unselectNodes', syncInspector)

  return instance
}

/** 首次挂载渲染层并把模型灌进去 */
function mountInstance(document: MindMapDocument): void {
  const el = canvasRef.value
  if (!el) return

  // 主题（含彩虹开关）必须在构造时确定，否则首帧会用错配色
  rainbow.value = document.rainbowBranches !== false
  layoutDirection.value =
    document.direction === 'left' || document.direction === 'right' ? document.direction : 'side'

  try {
    mind = createInstance(el)
    mind.init(toElixirData(document, { resolveImageSrc: resolveImage }))
  } catch (error) {
    mind = null
    isReady.value = false
    reportRuntimeError('思维导图渲染失败', error)
    return
  }
  ensureAutosave().markSynced(serializeMindMap(document))
  isReady.value = true
  errorMessage.value = ''
  showFallback.value = false
  // 画布就绪之后菜单栏才允许导出图片（没挂载时导出等于导空白）
  registerImageBuilder()
  // 首次渲染后把内容摆到纸的中央并滚动到可见处
  requestAnimationFrame(() => {
    if (!mind) return
    try {
      mind.toCenter()
    } catch {
      // 居中失败不影响使用，内容仍在纸内
    }
    updateZoom()
    decorateBranches()
    scrollToContentCenter(false)
  })
}

/** 用文本重建渲染层内容（外部变更、修复后重试时使用） */
function applyTextToView(text: string): void {
  if (!mind) return
  const parsed = parseMindMap(text)
  if (!parsed.ok) {
    errorTitle.value = '无法解析思维导图内容'
    errorMessage.value = parsed.error
    fallbackText.value = text
    showFallback.value = true
    repairNotes.value = []
    return
  }
  repairNotes.value = parsed.repaired.slice()
  errorMessage.value = ''
  showFallback.value = false
  isApplyingExternal = true
  try {
    // 视图设置可能与外部内容一起变了，先同步再重建
    const nextRainbow = parsed.document.rainbowBranches !== false
    if (nextRainbow !== rainbow.value) {
      rainbow.value = nextRainbow
      // 只换 CSS 变量，DOM 马上会被下面的 refresh 重建，不必二次渲染
      applyTheme(false)
    }
    syncLayoutDirection(parsed.document.direction)
    mind.refresh(toElixirData(parsed.document, { resolveImageSrc: resolveImage }))
    // refresh 会把历史栈接到旧数据上，清空可避免撤销回上一个文档
    mind.clearHistory?.()
    ensureAutosave().markSynced(serializeMindMap(parsed.document))
    scheduleMeasure()
  } catch (error) {
    reportRuntimeError('思维导图刷新失败', error)
  } finally {
    isApplyingExternal = false
  }
}

/** 文档里的方向值 → 控制条状态（down 不在控制条里，保持 'side' 显示） */
function syncLayoutDirection(value: MindMapDocument['direction']): void {
  if (value === 'left' || value === 'right' || value === 'side') {
    layoutDirection.value = value
  } else if (value === 'down') {
    layoutDirection.value = 'side'
  }
}

/**
 * JSON 修复模式下的重试：
 * 解析成功后先把规范化文本写回 store，再重建渲染层。
 * 放在这里而不是让用户切到源码模式——导图标签没有 Markdown 编辑模式，
 * 这是唯一能就地修好坏文件的地方。
 */
function retryParse(): void {
  const parsed = parseMindMap(fallbackText.value)
  if (!parsed.ok) {
    errorTitle.value = '无法解析思维导图内容'
    errorMessage.value = parsed.error
    return
  }

  const normalized = serializeMindMap(parsed.document)
  if (boundTabId) {
    fileStore.updateTabContent(boundTabId, normalized)
  } else {
    fileStore.updateContent(normalized)
  }

  if (mind) {
    applyTextToView(normalized)
  } else {
    mountInstance(parsed.document)
  }
  // 归一化后的文本本身已经没有问题，重解析不会再报，所以这里补回「改了什么」
  repairNotes.value = parsed.repaired.slice()
}

/** 修复模式里恢复成刚打开文件时的内容 */
function resetFallback(): void {
  fallbackText.value = sourceText.value
  const parsed = parseMindMap(fallbackText.value)
  if (!parsed.ok) errorTitle.value = '无法解析思维导图内容'
  errorMessage.value = parsed.ok ? '' : parsed.error
}

/** 关掉「已自动修复」提示（提示只是告知，不阻塞编辑） */
function dismissRepairNotes(): void {
  repairNotes.value = []
}

/* ------------------------------ 视图操作 ------------------------------ */

/**
 * 滚动容器位移。
 * jsdom（以及少数老内核）没有实现 `Element.scrollBy`，缺失时直接跳过：
 * 滚动只是让内容更靠中间，失败不值得让整个编辑器进错误态。
 */
function scrollViewBy(
  canvas: HTMLElement,
  delta: { left: number; top: number },
  smooth = true
): void {
  if (typeof canvas.scrollBy !== 'function') return
  canvas.scrollBy({ ...delta, behavior: smooth ? 'smooth' : 'auto' })
}

/** 把内容中心滚到视口中心（animate=false 用于首次挂载） */
function scrollToContentCenter(smooth = true): void {
  const canvas = containerRef.value
  if (!canvas || !mind) return
  const view = canvas.getBoundingClientRect()
  const content = mind.nodes.getBoundingClientRect()
  const left = content.left + content.width / 2 - (view.left + view.width / 2)
  const top = content.top + content.height / 2 - (view.top + view.height / 2)
  scrollViewBy(canvas, { left, top }, smooth)
}

function applyZoom(next: number): void {
  if (!mind) return
  const scale = Math.min(MINDMAP_ZOOM_MAX, Math.max(MINDMAP_ZOOM_MIN, next))
  try {
    mind.scale(scale)
  } catch (error) {
    reportRuntimeError('缩放失败', error)
    return
  }
  updateZoom()
  focusCanvas()
}

function zoomIn(): void {
  if (!mind) return
  applyZoom(nextZoomScale(mind.scaleVal, 'in'))
}

function zoomOut(): void {
  if (!mind) return
  applyZoom(nextZoomScale(mind.scaleVal, 'out'))
}

function zoomReset(): void {
  applyZoom(1)
}

/**
 * 适应画布：按「内容当前屏幕尺寸 / 视口尺寸」换算目标缩放。
 * 不能用渲染库的 `scaleFit()`——它是拿内容比 `map-container`，
 * 而 map-container 现在是 2000×2000 的纸，比出来永远是 1，等于没缩放。
 */
function fitToCanvas(): void {
  if (!mind || !containerRef.value) return
  const view = containerRef.value.getBoundingClientRect()
  const content = mind.nodes.getBoundingClientRect()
  if (content.width <= 0 || content.height <= 0) return
  const ratio = Math.min(view.width / content.width, view.height / content.height)
  applyZoom(mind.scaleVal * ratio)
  scrollToContentCenter()
}

function centerCanvas(): void {
  if (!mind) return
  scrollToContentCenter()
  focusCanvas()
}

/**
 * 折叠 / 展开全部。
 * 用渲染库的 `expandNodeAll` 递归改 `expanded` 再 refresh，
 * 但它会把根主题也置成折叠——根主题没有「折叠」语义，这里纠正回来。
 * 该操作不触发 `operation` 事件，所以落盘要自己通知一次。
 */
function setAllExpanded(expanded: boolean): void {
  if (!mind) return
  const rootTopic = mind.findEle(mind.nodeData.id)
  if (!rootTopic) return
  try {
    mind.expandNodeAll(rootTopic, expanded)
    // refresh 之后元素重建了，但 nodeObj 仍是同一份数据对象
    rootTopic.nodeObj.expanded = true
    mind.toCenter()
  } catch (error) {
    reportRuntimeError(expanded ? '展开全部失败' : '折叠全部失败', error)
    return
  }
  scheduleCommit()
  scheduleMeasure()
  scrollToContentCenter()
  focusCanvas()
}

function collapseAll(): void {
  setAllExpanded(false)
}

function expandAll(): void {
  setAllExpanded(true)
}

function toggleRainbow(): void {
  rainbow.value = !rainbow.value
  try {
    applyTheme()
  } catch (error) {
    reportRuntimeError('切换分支配色失败', error)
    return
  }
  scheduleCommit()
  focusCanvas()
}

function changeDirection(next: MindMapLayoutDirection): void {
  if (!mind) return
  try {
    if (next === 'left') mind.initLeft()
    else if (next === 'right') mind.initRight()
    else mind.initSide()
  } catch (error) {
    reportRuntimeError('切换结构失败', error)
    return
  }
  layoutDirection.value = next
  scheduleCommit()
  scheduleMeasure()
  scrollToContentCenter()
  focusCanvas()
}

/**
 * 把焦点交还画布。
 * 控制条上的按钮点完会拿走焦点，若不还回去，随后的 Tab/Enter/F2 快捷键
 * 就不会落到渲染库的 keydown 监听上——用户会以为快捷键失效了。
 */
function focusCanvas(): void {
  const panel = containerRef.value?.querySelector<HTMLElement>('.map-container')
  panel?.focus({ preventScroll: true })
}

/* ------------------------------ 画布拖拽 ------------------------------ */

function clearDropMarker(): void {
  if (dropTopic) {
    dropTopic.classList.remove('is-drop-in', 'is-drop-before', 'is-drop-after')
  }
  dropTopic = null
  dropType = null
}

function markDropTarget(topic: MindMapTopicElement | null, type: DropInsertType | null): void {
  if (dropTopic === topic && dropType === type) return
  clearDropMarker()
  if (!topic || !type) return
  dropTopic = topic
  dropType = type
  topic.classList.add(`is-drop-${type}`)
}

/** 找出光标下的落点；拖到自己的子孙里一律拒绝（会让数据成环） */
function resolveDropTarget(clientX: number, clientY: number): void {
  if (!pressTopic) return
  const element = document.elementFromPoint(clientX, clientY)
  const candidate = resolveTopicFromEvent(element)
  if (!candidate || candidate === pressTopic) {
    markDropTarget(null, null)
    return
  }
  const candidateId = candidate.nodeObj?.id
  if (!candidateId || containsNodeId(pressTopic.nodeObj as never, candidateId)) {
    markDropTarget(null, null)
    return
  }
  const rect = candidate.getBoundingClientRect()
  markDropTarget(candidate, resolveInsertType(rect, clientY))
}

function moveGhost(clientX: number, clientY: number): void {
  const view = viewportRef.value?.getBoundingClientRect()
  if (!view) return
  ghost.value = { ...ghost.value, x: clientX - view.left, y: clientY - view.top }
}

function startDrag(event: PointerEvent): void {
  if (!pressTopic) return
  phase = 'drag'
  ghost.value = {
    visible: true,
    x: 0,
    y: 0,
    text: ghostLabel(pressTopic.textContent ?? '')
  }
  moveGhost(event.clientX, event.clientY)
  pressTopic.classList.add('is-drag-source')
  try {
    pressTopic.setPointerCapture(event.pointerId)
  } catch {
    // 指针捕获失败不影响后续 window 上的监听
  }
}

function endDrag(): void {
  const from = pressTopic
  const to = dropTopic
  const type = dropType
  clearDropMarker()
  if (from) from.classList.remove('is-drag-source')
  ghost.value = { ...ghost.value, visible: false }
  if (!mind || !from || !to || !type) return
  try {
    if (type === 'in') void mind.moveNodeIn([asTopic(from)], asTopic(to))
    else if (type === 'before') void mind.moveNodeBefore([asTopic(from)], asTopic(to))
    else void mind.moveNodeAfter([asTopic(from)], asTopic(to))
  } catch (error) {
    reportRuntimeError('移动主题失败', error)
  }
}

function onCanvasPointerDown(event: PointerEvent): void {
  if (!mind || event.button !== 0 || event.pointerType === 'touch') return
  if (isEditingTarget(event.target)) return
  const topic = resolveTopicFromEvent(event.target)
  // 空白处不接管：留给渲染库的框选与平移
  if (!topic) return

  // 接管后必须阻断渲染库的同一套 pointerdown，否则两边会同时进入拖拽状态
  event.stopPropagation()
  phase = 'press'
  gesturePointerId = event.pointerId
  pressTopic = topic
  pressIsRoot = isRootTopic(topic)
  pressX = lastX = event.clientX
  pressY = lastY = event.clientY

  if (!topic.classList.contains('selected')) {
    try {
      mind.selectNode(asTopic(topic))
    } catch (error) {
      reportRuntimeError('选中主题失败', error)
    }
  }

  window.addEventListener('pointermove', onCanvasPointerMove)
  window.addEventListener('pointerup', onCanvasPointerUp)
  window.addEventListener('pointercancel', onCanvasPointerCancel)
}

function onCanvasPointerMove(event: PointerEvent): void {
  if (phase === 'idle' || event.pointerId !== gesturePointerId) return
  const dx = event.clientX - lastX
  const dy = event.clientY - lastY
  lastX = event.clientX
  lastY = event.clientY

  if (phase === 'press') {
    if (Math.hypot(event.clientX - pressX, event.clientY - pressY) < DRAG_THRESHOLD) return
    // 根主题没有父节点、无法被移动，按住它就是平移画布（与 XMind 一致）
    if (pressIsRoot) {
      phase = 'pan'
      pressTopic?.classList.add('is-drag-source')
    } else {
      startDrag(event)
    }
  }

  if (phase === 'pan') {
    const canvas = containerRef.value
    if (canvas) {
      canvas.scrollLeft -= dx
      canvas.scrollTop -= dy
    }
    return
  }

  if (phase === 'drag') {
    moveGhost(event.clientX, event.clientY)
    resolveDropTarget(event.clientX, event.clientY)
  }
}

function onCanvasPointerUp(event: PointerEvent): void {
  if (phase === 'idle' || event.pointerId !== gesturePointerId) return
  // 阻断渲染库的 pointerup，避免它的双击改名逻辑与我们的手势叠加
  event.stopPropagation()
  if (phase === 'drag') endDrag()
  finishGesture()
}

function onCanvasPointerCancel(): void {
  finishGesture()
}

function finishGesture(): void {
  if (phase === 'drag') {
    clearDropMarker()
    ghost.value = { ...ghost.value, visible: false }
  }
  pressTopic?.classList.remove('is-drag-source')
  pressTopic = null
  pressIsRoot = false
  gesturePointerId = null
  phase = 'idle'
  window.removeEventListener('pointermove', onCanvasPointerMove)
  window.removeEventListener('pointerup', onCanvasPointerUp)
  window.removeEventListener('pointercancel', onCanvasPointerCancel)
  focusCanvas()
}

/** 双击进入改名：pointerup 已被我们拦下，渲染库的双击逻辑不会再触发 */
function onCanvasDoubleClick(event: MouseEvent): void {
  if (!mind || isEditingTarget(event.target)) return
  const topic = resolveTopicFromEvent(event.target)
  if (!topic) return
  try {
    mind.beginEdit(asTopic(topic))
  } catch (error) {
    reportRuntimeError('编辑主题失败', error)
  }
}

/* ------------------------------ 属性栏 ------------------------------ */

/**
 * 属性栏展示的是「选中主题的纯数据快照」。
 * 元素本身不入响应式：渲染库的主题元素挂着 `nodeObj`（运行时还有 `parent`
 * 反向引用），被 Vue 代理后再交回去会破坏渲染库对它的判断。
 * 这里只存 id 派生的快照，需要元素时按 id 现取（`mind.findEle`）。
 */
const inspectorInfo = ref<MindMapSelectionInfo | null>(null)
/** 属性栏当前作用的主题（非响应式，理由同上） */
let inspectorTopic: MindMapTopicElement | null = null
/** 正在属性栏里操作：此时画布失焦是正常的，不能因此清空属性栏 */
let inspectorInteracting = false

/** 画布着色与属性栏共用的颜色上下文 */
function branchOptions(): MindMapBranchColorOptions {
  const mode = isDark.value ? 'dark' : 'light'
  return {
    palette: getMindMapPalette(mode),
    mono: getMindMapMonoColor(mode),
    rainbow: rainbow.value
  }
}

/** 把属性栏切到某个主题（null = 无选中） */
function applyInspectorTopic(topic: MindMapTopicElement | null): void {
  inspectorTopic = topic
  if (!topic) {
    inspectorInfo.value = null
    return
  }
  inspectorInfo.value = readSelectionInfo(topic, resolveBranchColor(topic, branchOptions()))
}

/**
 * 以画布的选中态为准刷新属性栏。
 * `unselectNodes` 也会走到这里：框选、删除、撤销都能靠它把属性栏挂回正确的主题。
 */
function syncInspector(): void {
  if (inspectorInteracting) return
  const topics = mind?.currentNodes ?? []
  // 多选时不给单主题面板：属性栏的每个字段都只对一个主题有意义
  applyInspectorTopic(topics.length === 1 ? (topics[0] as unknown as MindMapTopicElement) : null)
}

/**
 * 属性栏的修改统一走这里：改数据 → 重绘 → 重新选中。
 *
 * `refresh()` 内部会 `clearSelection()`，选中态和 `currentNodes` 都会没掉；
 * 补一次 `selectNode` 才能让画布高亮和属性栏继续绑在同一个主题上，
 * 否则用户改完文字属性栏就空了。
 */
function commitInspector(
  mutate: (nodeObj: NonNullable<MindMapTopicElement['nodeObj']>) => void
): void {
  const nodeObj = inspectorTopic?.nodeObj
  if (!mind || !nodeObj?.id) return
  const id = nodeObj.id
  try {
    mutate(nodeObj)
    mind.refresh()
  } catch (error) {
    reportRuntimeError('更新主题属性失败', error)
    return
  }
  scheduleCommit()
  scheduleMeasure()
  restoreSelection(id)
}

/** 重绘后按 id 找回主题并恢复选中 */
function restoreSelection(id: string): void {
  if (!mind) return
  let element: MindMapTopicElement | null = null
  try {
    element = mind.findEle(id) as unknown as MindMapTopicElement | null
  } catch {
    // 主题被折叠或被删掉时找不到 DOM：只把属性栏收起，内容本身不受影响
    element = null
  }
  if (!element) {
    applyInspectorTopic(null)
    return
  }
  try {
    mind.selectNode(element as never)
  } catch {
    // 选中失败不影响内容，属性栏只是不再高亮该主题
  }
  applyInspectorTopic(element)
}

function updateSelectedText(text: string): void {
  const value = text.trim()
  if (!value) return
  commitInspector((nodeObj) => {
    nodeObj.topic = value
  })
  focusCanvas()
}

function updateSelectedNote(note: string): void {
  const value = note.trim()
  commitInspector((nodeObj) => {
    if (value) nodeObj.note = value
    else delete nodeObj.note
  })
}

/** 为选中的主题指定分支色（null = 恢复自动分配） */
function pickSelectedColor(color: string | null): void {
  commitInspector((nodeObj) => {
    if (color) nodeObj.branchColor = color
    else delete nodeObj.branchColor
  })
  focusCanvas()
}

/* ------------------------------ 右键菜单 ------------------------------ */

function hideMenu(): void {
  menuVisible.value = false
  menuTopic = null
  menuSupportsColor.value = false
}

function onContextMenu(event: MouseEvent): void {
  // 渲染库自身也会 preventDefault，这里再防一次，确保不出现系统菜单
  event.preventDefault()
  if (!mind) return

  // 主题处于编辑态时，渲染库会用一个 #input-box 顶替主题文字，此时事件目标
  // 不在 me-tpc 内部，退回「当前选中的主题」，右键菜单照常可用。
  const topic =
    resolveTopicFromEvent(event.target) ??
    (mind.currentNode as unknown as MindMapTopicElement | null)
  const host = containerRef.value
  if (!topic || !host) {
    hideMenu()
    return
  }

  // XMind 的行为：右键先选中该主题，菜单只对它生效
  try {
    if (!topic.classList.contains('selected')) mind.selectNode(asTopic(topic))
  } catch (error) {
    reportRuntimeError('选中主题失败', error)
    return
  }

  const rect = host.getBoundingClientRect()
  const anchor = mainRef.value?.getBoundingClientRect() ?? rect
  const isRoot = isRootTopic(topic)
  menuTopic = topic
  menuSelectionCount = mind.currentNodes?.length ?? 1
  menuItems.value = buildMindMapMenu(topic, isRoot, menuSelectionCount)
  menuSupportsColor.value = !isRoot
  menuX.value = Math.max(4, Math.min(event.clientX - anchor.left, anchor.width - 180))
  menuY.value = Math.max(4, Math.min(event.clientY - anchor.top, anchor.height - 24))
  menuVisible.value = true
  // 右键必然改变了选中态（上面已 selectNode），属性栏跟着切过去
  applyInspectorTopic(topic)
}

function runMenuAction(action: MindMapMenuAction): void {
  const topic = menuTopic
  hideMenu()
  if (!mind || !topic) return

  const target = asTopic(topic)
  try {
    switch (action) {
      case 'edit':
        mind.editTopic(target)
        break
      case 'edit-note':
        openNoteEditor(topic)
        break
      case 'add-tag':
        openRichEditor(topic, 'tag')
        break
      case 'add-link':
        openRichEditor(topic, 'link')
        break
      case 'pick-icons':
        // 图标走二级菜单，点开即选，不弹面板；这里只处理没有渲染出二级菜单的兜底
        break
      case 'clear-rich':
        clearRichContent(topic)
        break
      case 'add-arrow':
        createArrowFromSelection()
        break
      case 'add-summary':
        createSummaryForBranch(topic)
        break
      case 'add-image':
        void insertImage(topic)
        break
      case 'remove-image':
        removeImage(topic)
        break
      case 'add-attachment':
        void insertAttachment(topic)
        break
      case 'manage-attachments':
        openAttachmentManager(topic)
        break
      case 'add-child':
        void mind.addChild(target)
        break
      case 'add-sibling':
        void mind.insertSibling('after', target)
        break
      case 'add-parent':
        void mind.insertParent(target)
        break
      case 'move-up':
        void mind.moveUpNode(target)
        break
      case 'move-down':
        void mind.moveDownNode(target)
        break
      case 'toggle-collapse':
        /*
         * 根主题不能走库的 `expandNode`：它在 DOM 里是 `me-root > me-tpc`，
         * 没有 `me-parent`/`me-epd`，库内部写 `parentNode.children[1].expanded`
         * 会直接抛 "Cannot set properties of undefined"。
         * 根主题的折叠语义是「折叠整张导图」，交给批量逻辑（它会把根主题纠正回展开）。
         */
        if (isRootTopic(topic)) {
          setAllExpanded(areAllChildrenCollapsed(topic))
        } else {
          mind.expandNode(target, topic.nodeObj?.expanded === false)
        }
        break
      // 导出是画布级操作：不依赖被右键的主题，菜单里放一份只为方便
      case 'export-png':
        void exportImage('png')
        break
      case 'export-svg':
        void exportImage('svg')
        break
      case 'remove':
        void mind.removeNodes([target])
        break
    }
    scheduleMeasure()
  } catch (error) {
    reportRuntimeError('主题操作失败', error)
  }
}

/**
 * 打开备注编辑面板。
 * 备注落盘在节点的 `note` 上（渲染库也支持该字段），根主题同样可以有备注。
 * 面板由组件自己渲染，而不是塞进渲染库里：库内只有只读的提示气泡，无法编辑。
 */
function openNoteEditor(element: MindMapTopicElement): void {
  noteTopic = element
  noteText.value = element.nodeObj?.note ?? ''
  noteVisible.value = true
  void nextTick(() => noteInputRef.value?.focus())
}

/** 保存备注：清空即删除，避免文件里留下空字符串 */
function saveNote(): void {
  const nodeObj = noteTopic?.nodeObj
  // 先取值再关面板：closeNoteEditor 会清空 noteText
  const value = noteText.value.trim()
  closeNoteEditor()
  if (!mind || !nodeObj) return
  try {
    if (value) nodeObj.note = value
    else delete nodeObj.note
    mind.refresh()
  } catch (error) {
    reportRuntimeError('保存备注失败', error)
    return
  }
  scheduleCommit()
  scheduleMeasure()
}

/** 删除该主题的备注 */
function removeNote(): void {
  noteText.value = ''
  saveNote()
}

function closeNoteEditor(): void {
  noteVisible.value = false
  noteTopic = null
  noteText.value = ''
  focusCanvas()
}

/* ---------------------- 富内容（标签 / 链接 / 星标） ---------------------- */

/** 从渲染层节点上读出标签文字（渲染层可能把它们存成字符串或带样式的对象） */
function tagTextsOf(raw: unknown): string[] {
  return normalizeTags(raw).map((tag) => tag.text)
}

/**
 * 打开标签 / 链接输入面板。
 *
 * 优先级没有单独入口：`P1`/`P2`/`P3` 就是三个预设标签，
 * 保存时自动套上固定配色，菜单里因此不必再多出四项。
 */
function openRichEditor(topic: MindMapTopicElement, mode: 'tag' | 'link'): void {
  richTopic = topic
  richMode.value = mode
  richError.value = ''
  richValue.value =
    mode === 'tag' ? tagTextsOf(topic.nodeObj?.tags).join('，') : (topic.nodeObj?.hyperLink ?? '')
  richVisible.value = true
  void nextTick(() => {
    richInputRef.value?.focus()
    richInputRef.value?.select()
  })
}

/** 富内容改动后统一收口：重绘 → 落盘 → 重新量尺寸 */
function commitRichChange(): void {
  if (!mind) return
  try {
    mind.refresh()
  } catch (error) {
    reportRuntimeError('更新节点内容失败', error)
    return
  }
  scheduleCommit()
  scheduleMeasure()
}

/**
 * 保存标签或链接。清空即删除，避免文件里留下空数组或空字符串。
 * 链接格式不对时不关闭面板，就地提示——关掉再让用户右键一遍太折腾。
 */
function saveRich(): void {
  const nodeObj = richTopic?.nodeObj
  if (!mind || !nodeObj) {
    closeRichEditor()
    return
  }

  if (richMode.value === 'tag') {
    const parts = richValue.value.split(/[,，;；\s]+/).filter((part) => part !== '')
    const tags = normalizeTags(parts).map((tag) => {
      const preset = MINDMAP_PRIORITIES.find(
        (item) => item.text.toLowerCase() === tag.text.toLowerCase()
      )
      return preset ? { text: preset.text, color: preset.color } : tag
    })
    if (tags.length > 0) {
      nodeObj.tags = tags.map((tag) =>
        tag.color
          ? {
              text: tag.text,
              style: { backgroundColor: tag.color, color: '#ffffff', borderColor: tag.color }
            }
          : tag.text
      )
    } else {
      delete nodeObj.tags
    }
  } else {
    const value = richValue.value.trim()
    if (value === '') {
      delete nodeObj.hyperLink
    } else {
      const href = normalizeLink(value)
      if (!href) {
        richError.value = '只支持 http:// 或 https:// 开头的链接'
        return
      }
      nodeObj.hyperLink = href
    }
  }

  const topic = richTopic
  closeRichEditor()
  commitRichChange()
  if (topic) applyInspectorTopic(topic)
}

function closeRichEditor(): void {
  richVisible.value = false
  richTopic = null
  richValue.value = ''
  richError.value = ''
  focusCanvas()
}

/** 面板里展示的附件列表，同样跟着当前主题走 */
const richAttachments = computed<MindMapAttachment[]>(() =>
  readNodeAttachments(richTopic?.nodeObj)
)

/** 打开附件管理面板（列表 + 打开/另存为/移除） */
function openAttachmentManager(topic: MindMapTopicElement): void {
  richTopic = topic
  richMode.value = 'attachment'
  richError.value = ''
  richValue.value = ''
  richVisible.value = true
}

/**
 * 从节点上移除一个附件（容器里留下的文件会在保存时自然消失）。
 *
 * `topic` 默认是富内容面板正在编辑的主题；画布卡片从右键菜单进来时显式传自己的主题——
 * 卡片和面板可能指向不同节点，混用会把附件从错误的主题上删掉。
 */
function removeAttachment(id: string, topic: MindMapTopicElement | null = richTopic): void {
  const nodeObj = topic?.nodeObj
  if (!nodeObj) return
  const next = readNodeAttachments(nodeObj).filter((item) => item.id !== id)
  writeNodeAttachments(nodeObj, next)
  commitRichChange()
}

/** 附件在容器里的绝对路径（打开/另存为都靠它） */
function attachmentAbsolutePath(file: MindMapAttachment): string {
  return assetMap.value[file.src] ?? ''
}

/** 用系统默认程序打开附件 */
function openAttachment(file: MindMapAttachment): void {
  const absolute = attachmentAbsolutePath(file)
  if (!absolute) {
    void requestDialog({
      title: '无法打开附件',
      message: '附件文件不在当前导图里，可能已被移除。',
      buttons: [{ label: '知道了', value: 0, primary: true }]
    })
    return
  }
  void window.electronAPI.openMindMapAsset(absolute)
}

/** 把附件另存到用户选的位置 */
async function saveAttachmentAs(file: MindMapAttachment): Promise<void> {
  const absolute = attachmentAbsolutePath(file)
  if (!absolute) {
    void requestDialog({
      title: '无法另存附件',
      message: '附件文件不在当前导图里，可能已被移除。',
      buttons: [{ label: '知道了', value: 0, primary: true }]
    })
    return
  }
  try {
    const result = await window.electronAPI.saveMindMapAssetAs(absolute, file.name)
    if (!result.success && result.error !== '用户取消') {
      await requestDialog({
        title: '另存附件失败',
        message: result.error ?? '未知错误',
        buttons: [{ label: '知道了', value: 0, primary: true }]
      })
    }
  } catch (error) {
    reportRuntimeError('另存附件失败', error)
  }
}

/** 字节数转成人读的大小（卡片与面板共用一个格式） */
function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 从二级菜单里切换一个图标。
 *
 * 点完即收起菜单，与其余菜单项保持一致：图标虽然可以叠加多个，
 * 但「选完就关」才是用户对菜单的预期；要再加一个，重新右键即可，
 * 二级菜单里已选的项会带着勾选态，再点一次就是取消。
 */
function applyIconChoice(choice: MindMapMenuChoice): void {
  const topic = menuTopic
  if (!topic || !mind) return
  // 先取 id 再关菜单：hideMenu 会把 menuTopic 清空
  const id = topic.nodeObj?.id
  hideMenu()
  toggleIcon(topic, choice.value)
  /*
   * `refresh()` 会清掉选中态：按 id 选回来，用户关掉菜单后主题仍然是选中的，
   * 属性栏也不会跳回「未选中主题」。
   */
  if (id) restoreSelection(id)
  focusCanvas()
}

/**
 * 切换单个图标（选中/取消），立即生效。
 *
 * 画布上存的是字形、文件里存名字，所以增删都要经过 `iconsFromElixir` /
 * `writeIconsToElixir` 这一对转换——直接往 `icons` 里 push 名字，
 * 画布上就会多出一个单词「star」，而且再也删不掉。
 */
function toggleIcon(topic: MindMapTopicElement | null, name: MindMapIcon): void {
  const nodeObj = topic?.nodeObj
  if (!nodeObj) return
  const icons = [...iconsFromElixir(nodeObj)]
  const index = icons.indexOf(name)
  if (index >= 0) icons.splice(index, 1)
  else icons.push(name)
  writeIconsToElixir(nodeObj, icons)
  commitRichChange()
}

/** 清空该节点的标签、链接与图标 */
function clearRichContent(topic: MindMapTopicElement): void {
  const nodeObj = topic.nodeObj
  if (!nodeObj) return
  delete nodeObj.tags
  delete nodeObj.hyperLink
  delete nodeObj.icons
  commitRichChange()
  applyInspectorTopic(topic)
}

/**
 * 在选中的两个主题之间连线。
 *
 * 渲染库的 `createArrowFrom` 自带落盘事件（`operation: createArrow`），
 * 会走我们统一的防抖提交，所以这里不必再手动序列化。
 */
function createArrowFromSelection(): void {
  if (!mind) return
  const selected = (mind.currentNodes ?? []) as unknown as MindMapTopicElement[]
  if (selected.length !== 2) {
    reportRuntimeError('添加关系线失败', new Error('请先按住 Ctrl 选中两个主题'))
    return
  }
  const from = selected[0].nodeObj?.id
  const to = selected[1].nodeObj?.id
  if (!from || !to || from === to) {
    reportRuntimeError('添加关系线失败', new Error('两个端点必须是不同的主题'))
    return
  }
  try {
    mind.createArrowFrom({ from, to, label: '' })
  } catch (error) {
    reportRuntimeError('添加关系线失败', error)
    return
  }
  scheduleCommit()
  scheduleMeasure()
}

/**
 * 给该主题下的全部子主题加概要。
 *
 * 标签留空由用户双击补写：渲染库对概要标签自带就地编辑，
 * 我们额外弹一个输入框反而会与它的编辑态打架。
 */
function createSummaryForBranch(topic: MindMapTopicElement): void {
  if (!mind) return
  const nodeObj = topic.nodeObj
  const parent = nodeObj?.id
  const count = Array.isArray(nodeObj?.children) ? nodeObj.children.length : 0
  if (!parent || count === 0) return
  try {
    mind.createSummaryFrom({ parent, start: 0, end: count - 1, label: '' })
  } catch (error) {
    reportRuntimeError('添加概要失败', error)
    return
  }
  scheduleCommit()
  scheduleMeasure()
}

/**
 * 插入节点图片。
 *
 * 选图与落盘都在主进程（`mindmap:addAsset`），文件被拷进容器的临时解压目录，
 * 保存时随 `map.json` 一起打包。渲染层只做两件事：
 * 把包内路径存进 `metadata`（回读时靠它还原，避免被渲染用的 URL 覆盖），
 * 把解析后的 URL 塞给渲染层显示。
 */
async function insertImage(topic: MindMapTopicElement): Promise<void> {
  const nodeObj = topic.nodeObj
  const target = documentPath.value
  if (!nodeObj) return
  if (!target) {
    await requestDialog({
      title: '无法插入图片',
      message: '请先保存导图，图片会被打包进 .inkmind 文件本身。',
      buttons: [{ label: '知道了', value: 0, primary: true }]
    })
    return
  }

  const picked = await pickAsset(target, 'image', '插入图片失败')
  if (!picked) return

  // image 上直接用解析后的 URL 显示；包内路径单独存一份，序列化时以它为准
  nodeObj.image = {
    url: resolveMindMapImageSrc(picked.src, assetMap.value),
    width: DEFAULT_NODE_IMAGE_WIDTH,
    height: DEFAULT_NODE_IMAGE_HEIGHT
  }
  nodeObj.metadata = { ...(nodeObj.metadata ?? {}), [MINDMAP_IMAGE_META_KEY]: picked.src }
  commitRichChange()
  applyInspectorTopic(topic)
}

/**
 * 插入节点附件。
 *
 * 附件不占画布面积，只在节点下方显示一张卡片；打开/另存为都在主进程完成，
 * 因为资源躺在容器的临时解压目录里，渲染层拿不到可用的文件系统句柄。
 */
async function insertAttachment(topic: MindMapTopicElement): Promise<void> {
  const nodeObj = topic.nodeObj
  const target = documentPath.value
  if (!nodeObj) return
  if (!target) {
    await requestDialog({
      title: '无法添加附件',
      message: '请先保存导图，附件会被打包进 .inkmind 文件本身。',
      buttons: [{ label: '知道了', value: 0, primary: true }]
    })
    return
  }

  const nodeAttachments = readNodeAttachments(nodeObj)
  if (nodeAttachments.length >= MAX_ATTACHMENTS) {
    await requestDialog({
      title: '附件已达上限',
      message: `单个节点最多挂 ${MAX_ATTACHMENTS} 个附件。`,
      buttons: [{ label: '知道了', value: 0, primary: true }]
    })
    return
  }

  const picked = await pickAsset(target, 'file', '添加附件失败')
  if (!picked) return

  const next: MindMapAttachment[] = [
    ...nodeAttachments,
    {
      id: `att_${picked.src.split('/').pop() ?? Date.now()}`,
      name: picked.name,
      src: picked.src,
      mime: picked.mime,
      size: picked.size
    }
  ]
  writeNodeAttachments(nodeObj, next)
  commitRichChange()
  applyInspectorTopic(topic)
}

/** 弹选择框并落盘到容器临时目录；用户取消或失败时返回 null */
async function pickAsset(
  documentPathValue: string,
  kind: 'image' | 'file',
  failureTitle: string
): Promise<{ src: string; absolutePath: string; name: string; size: number; mime: string } | null> {
  try {
    const result = await window.electronAPI.addMindMapAsset(documentPathValue, kind)
    if (!result.success || !result.data) {
      // 用户取消不算错误，静默返回
      if (result.error === '用户取消') return null
      await requestDialog({
        title: failureTitle,
        message: result.error ?? '未知错误',
        buttons: [{ label: '知道了', value: 0, primary: true }]
      })
      return null
    }
    const asset = result.data
    /*
     * 新插入的文件还没打包进容器，打开时给出的 `assetMap` 里没有它。
     * 不补登记的话，紧接着解析出的 URL 就是空串——图片画不出来、附件也打不开。
     */
    if (boundTabId) {
      fileStore.registerMindMapAsset(boundTabId, asset.src, asset.absolutePath)
    }
    return asset
  } catch (error) {
    reportRuntimeError(failureTitle, error)
    return null
  }
}

/** 从渲染库节点里读出附件列表（渲染库不认识这个字段，存在 metadata 里） */
function readNodeAttachments(nodeObj: MindMapTopicElement['nodeObj'] | undefined): MindMapAttachment[] {
  const raw = nodeObj?.metadata?.[MINDMAP_ATTACHMENTS_META_KEY]
  if (!Array.isArray(raw)) return []
  return normalizeAttachments(raw)
}

/** 把附件列表写回渲染库节点（空数组时连键一起删掉，保持文件干净） */
function writeNodeAttachments(
  nodeObj: NonNullable<MindMapTopicElement['nodeObj']>,
  attachments: MindMapAttachment[]
): void {
  const meta = { ...(nodeObj.metadata ?? {}) }
  if (attachments.length > 0) meta[MINDMAP_ATTACHMENTS_META_KEY] = attachments
  else delete meta[MINDMAP_ATTACHMENTS_META_KEY]
  if (Object.keys(meta).length > 0) nodeObj.metadata = meta
  else delete nodeObj.metadata
}

/** 移除节点图片（连同 metadata 里的原始路径） */
function removeImage(topic: MindMapTopicElement): void {
  const nodeObj = topic.nodeObj
  if (!nodeObj) return
  delete nodeObj.image
  if (nodeObj.metadata && typeof nodeObj.metadata === 'object') {
    const meta = { ...(nodeObj.metadata as Record<string, unknown>) }
    delete meta[MINDMAP_IMAGE_META_KEY]
    if (Object.keys(meta).length > 0) nodeObj.metadata = meta
    else delete nodeObj.metadata
  }
  commitRichChange()
  applyInspectorTopic(topic)
}
function pickBranchColor(color: string | null): void {
  const topic = menuTopic
  hideMenu()
  if (!mind || !topic) return
  const nodeObj = topic.nodeObj
  if (!nodeObj) return

  try {
    if (color) nodeObj.branchColor = color
    else delete nodeObj.branchColor
    mind.refresh()
  } catch (error) {
    reportRuntimeError('修改分支颜色失败', error)
    return
  }
  scheduleCommit()
  scheduleMeasure()
  focusCanvas()
}

/**
 * 点击菜单外 / 按 Esc / 滚轮缩放时关闭菜单。
 * 同时记录「这次按下是否发生在属性栏里」：属性栏的输入框会让画布失焦，
 * 但画布失焦不该把属性栏的内容清空，否则一输入就变回「未选中主题」。
 */
function onDocumentPointerDown(event: PointerEvent): void {
  inspectorInteracting =
    inspectorRef.value !== null &&
    event.target instanceof Node &&
    inspectorRef.value.contains(event.target)

  // 卡片菜单：点在菜单外就收起（卡片本身已 stopPropagation，不会误关又重开）
  if (cardMenu.value.visible) {
    const menu = cardMenuRef.value
    if (!(menu && event.target instanceof Node && menu.contains(event.target))) hideCardMenu()
  }

  if (!menuVisible.value) return
  const menu = menuRef.value
  if (menu && event.target instanceof Node && menu.contains(event.target)) return
  hideMenu()
}

/**
 * 文档级按键。
 *
 * 这里只处理「不管焦点在哪都该生效」的两件事：`Ctrl+F` 打开查找、`Esc` 关掉浮层。
 * 注意监听是捕获阶段：面板输入框自己的 `Esc` 处理在目标阶段，晚于这里，
 * 因此「正在输入」时必须跳过，否则会把焦点所在的查找框关掉。
 */
function onDocumentKeyDown(event: KeyboardEvent): void {
  const isFindShortcut =
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'f'
  if (isFindShortcut) {
    if (!shouldHandleFindShortcut(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    openSearch()
    return
  }

  if (event.key !== 'Escape') return

  // 焦点在输入框里（查找框、备注、主题改名）时，让输入框自己处理 Esc
  if (searchOpen.value && !isEditingTarget(event.target)) {
    event.stopPropagation()
    closeSearch()
    return
  }
  if (menuVisible.value) {
    event.stopPropagation()
    hideMenu()
  }
  if (cardMenu.value.visible) {
    event.stopPropagation()
    hideCardMenu()
  }
}

/**
 * 菜单栏「编辑 › 撤销 / 重做」的入口。
 * 渲染库自己处理画布内的 Ctrl+Z，但不认识应用菜单栏派发的事件，
 * 这里显式转成库的历史操作，避免菜单项看起来能点、实际毫无反应。
 */
function onUndoEvent(): void {
  if (!mind) return
  try {
    mind.undo()
    scheduleCommit()
  } catch (error) {
    reportRuntimeError('撤销失败', error)
  }
}

function onRedoEvent(): void {
  if (!mind) return
  try {
    mind.redo()
    scheduleCommit()
  } catch (error) {
    reportRuntimeError('重做失败', error)
  }
}

/** 菜单栏「编辑 › 查找」的入口（AppHeader 派发 editor:find） */
function onFindEvent(): void {
  openSearch()
}

/**
 * 根主题的键盘保护。
 * 渲染库的键盘插件对 Delete/Enter 不做根节点判断：根主题没有同级主题，
 * 删除根主题更会让整张图失去锚点。这里在捕获阶段拦下并改成合理行为。
 * 监听挂在编辑器容器（父级）上，确保先于画布上的库监听执行。
 */
function onKeydownCapture(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  const target = event.target
  if (target instanceof HTMLElement) {
    // 正在编辑主题文字或修复 JSON 时不拦截
    if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      return
    }
  }
  const current = mind?.currentNode
  if (!current || !mind) return
  if (!isRootTopic(current as unknown as MindMapTopicElement)) return

  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  // Enter 在根主题上等同「新建子主题」，与 XMind 一致
  if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault()
    event.stopPropagation()
    try {
      void mind.addChild(current)
    } catch (error) {
      reportRuntimeError('新建子主题失败', error)
    }
  }
}

onMounted(() => {
  const el = containerRef.value
  if (!el) return

  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onDocumentKeyDown, true)
  window.addEventListener('editor:undo', onUndoEvent)
  window.addEventListener('editor:redo', onRedoEvent)
  window.addEventListener('editor:find', onFindEvent)
  el.addEventListener('keydown', onKeydownCapture, true)
  // 捕获阶段接管主题上的指针手势（空白处不拦）
  el.addEventListener('pointerdown', onCanvasPointerDown, true)
  el.addEventListener('wheel', hideMenu, { passive: true })
  el.addEventListener('wheel', hideCardMenu, { passive: true })

  const parsed = parseMindMap(sourceText.value)
  if (!parsed.ok) {
    errorTitle.value = '无法解析思维导图内容'
    errorMessage.value = parsed.error
    fallbackText.value = sourceText.value
    showFallback.value = true
    return
  }
  mountInstance(parsed.document)
  // 打开就修复过（空文件、重复 id、非法颜色…）时提示一次，别静默改用户文件
  repairNotes.value = parsed.repaired.slice()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onDocumentKeyDown, true)
  window.removeEventListener('editor:undo', onUndoEvent)
  window.removeEventListener('editor:redo', onRedoEvent)
  window.removeEventListener('editor:find', onFindEvent)
  const el = containerRef.value
  el?.removeEventListener('keydown', onKeydownCapture, true)
  el?.removeEventListener('pointerdown', onCanvasPointerDown, true)
  el?.removeEventListener('wheel', hideMenu)
  el?.removeEventListener('wheel', hideCardMenu)
  finishGesture()
  cancelLayoutFrame()
  // 画布即将销毁，标记没有必要留着；同时把查找状态清空，避免下次挂载残留
  clearSearchMarks()
  searchMatches.value = []
  searchIndex.value = -1

  // 卸载前必须冲刷未提交的改动，否则快速切标签会丢最后一次编辑
  autosave?.flush()
  autosave?.cancel()
  // 先撤掉出图能力再销毁实例：否则菜单栏可能在这一瞬间拿到已失效的 mind
  releaseImageBuilder?.()
  releaseImageBuilder = null
  try {
    mind?.destroy()
  } catch {
    // 渲染库在部分状态下销毁会抛错，忽略即可
  }
  mind = null
  autosave = null
  menuTopic = null
  menuVisible.value = false
  isReady.value = false
})

// 外部内容变化（磁盘重载、AI 改写、崩溃恢复）→ 重建视图
watch(sourceText, (next) => {
  if (!isReady.value || !mind) return
  // 忽略自身回写产生的变更
  if (next === currentText()) return
  applyTextToView(next)
  // 内容换了，命中也要跟着换；不自动跳转，避免把用户的视野拽走
  if (searchOpen.value) runSearch(false)
})

// 明暗切换需要显式换肤：渲染库不监听 prefers-color-scheme
watch(isDark, () => {
  if (!mind) return
  try {
    applyTheme()
  } catch (error) {
    reportRuntimeError('切换主题失败', error)
  }
})

/** 修复模式里用于占位提示的最小可解析示例 */
const fallbackPlaceholder = `{
  "schema": "${MINDMAP_FILE_SCHEMA}",
  "version": ${MINDMAP_VERSION},
  "root": { "id": "n_root", "text": "中心主题", "children": [] }
}`
</script>

<template>
  <div class="mind-map-editor">
    <div
      v-if="errorMessage || showFallback"
      class="mind-map-error"
      role="alert"
    >
      <p class="mind-map-error-title">
        {{ errorMessage ? errorTitle : '思维导图内容待修复' }}
      </p>
      <p
        v-if="errorMessage"
        class="mind-map-error-detail"
      >
        {{ errorMessage }}
      </p>
      <label
        class="mind-map-fallback-label"
        for="mind-map-fallback"
      >
        原始 JSON（可直接修正后重新解析，文件内容不会被丢弃）
      </label>
      <textarea
        id="mind-map-fallback"
        v-model="fallbackText"
        class="mind-map-fallback"
        spellcheck="false"
        :placeholder="fallbackPlaceholder"
      />
      <div class="mind-map-fallback-actions">
        <button
          type="button"
          class="mind-map-action mind-map-action-primary"
          @click="retryParse"
        >
          重新解析
        </button>
        <button
          type="button"
          class="mind-map-action"
          @click="resetFallback"
        >
          还原为文件内容
        </button>
      </div>
    </div>
    <!-- 左右分栏：左边画布，右边属性栏（对齐 XMind 的面板布局） -->
    <div class="mind-map-body">
      <div
        ref="mainRef"
        class="mind-map-main"
      >
        <div
          v-if="repairNotes.length > 0"
          class="mind-map-repair"
          role="status"
        >
          <div class="mind-map-repair-body">
            <p class="mind-map-repair-title">
              已自动修复文件中的问题
            </p>
            <ul class="mind-map-repair-list">
              <li
                v-for="note in repairNotes"
                :key="note"
              >
                {{ note }}
              </li>
            </ul>
          </div>
          <button
            type="button"
            class="mind-map-action mind-map-repair-close"
            @click="dismissRepairNotes"
          >
            知道了
          </button>
        </div>
        <!-- 查找面板：浮在画布列右上角，不做替换（导图没有正文，只查节点文字） -->
        <FindReplacePanel
          v-if="showCanvasUi"
          :open="searchOpen"
          :replace-mode="false"
          :show-replace="false"
          :match-count="searchMatches.length"
          :current-index="searchIndex"
          :initial-query="searchQuery"
          @close="closeSearch"
          @search="onSearchInput"
          @next="stepSearch(1)"
          @prev="stepSearch(-1)"
        />
        <div
          ref="viewportRef"
          class="mind-map-viewport"
        >
          <div
            ref="containerRef"
            class="mind-map-scroll"
            @contextmenu.prevent="onContextMenu"
          >
            <div
              ref="canvasRef"
              class="mind-map-canvas"
              :style="{
                width: `${pageSize}px`,
                height: `${pageSize}px`,
                '--pan-cursor': dragCursor
              }"
              @dblclick="onCanvasDoubleClick"
            />
          </div>
          <div
            v-if="ghost.visible"
            class="mind-map-drag-ghost"
            :style="ghostStyle"
            aria-hidden="true"
          >
            {{ ghost.text }}
          </div>
          <div
            v-if="richVisible"
            class="mind-map-note"
            role="dialog"
            aria-label="节点内容"
          >
            <p class="mind-map-note-title">
              {{
                richMode === 'tag'
                  ? '标签（逗号分隔，P1/P2/P3 为优先级）'
                  : richMode === 'link'
                    ? '链接'
                    : `附件（${richAttachments.length}）`
              }}
            </p>
            <div
              v-if="richMode === 'attachment'"
              class="mind-map-attachment-list"
            >
              <div
                v-for="file in richAttachments"
                :key="file.id"
                class="mind-map-attachment-item"
              >
                <span
                  class="mind-map-attachment-name"
                  :title="file.name"
                >{{ file.name }}</span>
                <span class="mind-map-attachment-size">{{ formatFileSize(file.size) }}</span>
                <button
                  type="button"
                  class="mind-map-attachment-action"
                  @click="openAttachment(file)"
                >
                  打开
                </button>
                <button
                  type="button"
                  class="mind-map-attachment-action"
                  @click="saveAttachmentAs(file)"
                >
                  另存为
                </button>
                <button
                  type="button"
                  class="mind-map-attachment-action is-danger"
                  @click="removeAttachment(file.id)"
                >
                  移除
                </button>
              </div>
            </div>
            <input
              v-if="richMode !== 'attachment'"
              ref="richInputRef"
              v-model="richValue"
              class="mind-map-note-input mind-map-rich-input"
              type="text"
              spellcheck="false"
              :placeholder="richMode === 'tag' ? '例如：P1，待确认' : 'https://example.com'"
              @keydown.esc.stop="closeRichEditor"
              @keydown.enter.prevent="saveRich"
            >
            <p
              v-if="richError"
              class="mind-map-rich-error"
            >
              {{ richError }}
            </p>
            <div class="mind-map-note-actions">
              <button
                v-if="richMode === 'tag' || richMode === 'link'"
                type="button"
                class="mind-map-action mind-map-action-primary"
                @click="saveRich"
              >
                保存
              </button>
              <button
                type="button"
                class="mind-map-action"
                @click="closeRichEditor"
              >
                取消
              </button>
            </div>
          </div>
          <div
            v-if="noteVisible"
            class="mind-map-note"
            role="dialog"
            aria-label="主题备注"
          >
            <p class="mind-map-note-title">
              主题备注
            </p>
            <textarea
              ref="noteInputRef"
              v-model="noteText"
              class="mind-map-note-input"
              spellcheck="false"
              placeholder="补充说明、待办、链接…（清空并保存即删除备注）"
              @keydown.esc.stop="closeNoteEditor"
              @keydown.ctrl.enter.prevent="saveNote"
            />
            <div class="mind-map-note-actions">
              <button
                type="button"
                class="mind-map-action mind-map-action-primary"
                @click="saveNote"
              >
                保存
              </button>
              <button
                type="button"
                class="mind-map-action"
                @click="removeNote"
              >
                删除备注
              </button>
              <button
                type="button"
                class="mind-map-action"
                @click="closeNoteEditor"
              >
                取消
              </button>
            </div>
          </div>
        </div>
        <div
          v-if="menuVisible"
          ref="menuRef"
          class="mind-map-menu"
          role="menu"
          :style="menuStyle"
          @pointerdown.stop
          @contextmenu.prevent
          @mousedown.prevent
        >
          <template
            v-for="item in menuItems"
            :key="item.action"
          >
            <div
              v-if="item.dividerBefore"
              class="mind-map-menu-separator"
              role="separator"
            />
            <div
              v-if="item.children"
              class="mind-map-menu-submenu-host"
            >
              <button
                type="button"
                role="menuitem"
                class="mind-map-menu-item has-submenu"
                :class="{ 'is-disabled': item.disabled }"
                :disabled="item.disabled"
              >
                <span class="mind-map-menu-label">{{ item.label }}</span>
                <span
                  class="mind-map-menu-arrow"
                  aria-hidden="true"
                >›</span>
              </button>
              <div
                class="mind-map-submenu"
                role="menu"
              >
                <button
                  v-for="choice in item.children"
                  :key="choice.value"
                  type="button"
                  role="menuitemcheckbox"
                  class="mind-map-menu-item"
                  :class="{ 'is-active': choice.checked }"
                  :aria-checked="choice.checked"
                  @click="applyIconChoice(choice)"
                >
                  <span
                    class="mind-map-submenu-glyph"
                    aria-hidden="true"
                  >{{ choice.glyph }}</span>
                  <span class="mind-map-menu-label">{{ choice.label }}</span>
                  <span
                    v-if="choice.checked"
                    class="mind-map-menu-check"
                    aria-hidden="true"
                  >✓</span>
                </button>
              </div>
            </div>
            <button
              v-else
              type="button"
              role="menuitem"
              class="mind-map-menu-item"
              :class="{ 'is-disabled': item.disabled }"
              :disabled="item.disabled"
              @click="runMenuAction(item.action)"
            >
              <span
                v-if="item.checked"
                class="mind-map-menu-check"
                aria-hidden="true"
              >✓</span>
              <span class="mind-map-menu-label">{{ item.label }}</span>
              <span
                v-if="item.hint"
                class="mind-map-menu-hint"
              >{{ item.hint }}</span>
            </button>
          </template>
          <template v-if="menuSupportsColor">
            <div
              class="mind-map-menu-separator"
              role="separator"
            />
            <div class="mind-map-menu-section-label">
              分支颜色
            </div>
            <div class="mind-map-menu-colors">
              <button
                v-for="color in branchPalette"
                :key="color"
                type="button"
                class="mind-map-menu-color"
                :style="{ backgroundColor: color }"
                :title="color"
                :aria-label="color"
                @click="pickBranchColor(color)"
              />
              <button
                type="button"
                class="mind-map-menu-color is-auto"
                title="跟随主题（恢复自动分配）"
                aria-label="跟随主题"
                @click="pickBranchColor(null)"
              >
                自动
              </button>
            </div>
          </template>
        </div>
        <div
          v-if="cardMenu.visible"
          ref="cardMenuRef"
          class="mind-map-menu mind-map-card-menu"
          role="menu"
          :style="{ left: `${cardMenu.x}px`, top: `${cardMenu.y}px` }"
          @pointerdown.stop
          @contextmenu.prevent
          @mousedown.prevent
        >
          <button
            type="button"
            role="menuitem"
            class="mind-map-menu-item"
            @click="runCardMenuAction('open')"
          >
            <span class="mind-map-menu-label">打开</span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="mind-map-menu-item"
            @click="runCardMenuAction('save-as')"
          >
            <span class="mind-map-menu-label">另存为</span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="mind-map-menu-item is-danger"
            @click="runCardMenuAction('remove')"
          >
            <span class="mind-map-menu-label">移除</span>
          </button>
        </div>
      </div>
      <aside
        v-if="showCanvasUi"
        ref="inspectorRef"
        class="mind-map-inspector-host"
        aria-label="主题属性"
      >
        <MindMapInspector
          :info="inspectorInfo"
          :palette="branchPalette"
          :rainbow="rainbow"
          @update-text="updateSelectedText"
          @update-note="updateSelectedNote"
          @pick-color="pickSelectedColor"
        >
          <!-- 视图控制放在属性栏的「画布」标签页里，不再浮在画布右下角挡内容 -->
          <template #controls>
            <MindMapControlBar
              :zoom="zoom"
              :rainbow="rainbow"
              :direction="layoutDirection"
              variant="panel"
              @zoom-in="zoomIn"
              @zoom-out="zoomOut"
              @zoom-reset="zoomReset"
              @fit="fitToCanvas"
              @center="centerCanvas"
              @collapse-all="collapseAll"
              @expand-all="expandAll"
              @toggle-rainbow="toggleRainbow"
              @change-direction="changeDirection"
              @export-image="exportImage"
            />
          </template>
        </MindMapInspector>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.mind-map-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  /* 画布与属性栏都是「浮」在这层底板上的卡片，留白处露出的就是它 */
  background-color: var(--color-bg);
}

/*
 * 左右分栏的外壳：左边画布、右边属性栏。
 * 用 flex 而不是 grid：属性栏宽度固定、画布吃掉剩余空间，
 * 面板整体变窄时画布先让位（`min-width: 0` 是关键，否则画布会把属性栏挤出可视区）。
 *
 * `padding` + `gap` 给三块之间留出同样的呼吸缝：左侧文件视图 ↔ 画布、
 * 画布 ↔ 属性栏、内容 ↔ 面板边框。留白放在这里而不是 `.mind-map-main` 上，
 * 因为 `.mind-map-main` 是右键菜单的坐标原点，加内边距会让菜单偏移。
 */
.mind-map-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: row;
  gap: 8px;
  padding: 8px;
}

/* 画布列：同时是右键菜单的定位容器（菜单与画布必须共享同一个坐标原点） */
.mind-map-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

/*
 * 属性栏外壳。
 * `flex: 0 0 264px` + `max-width: 45%`：常规宽度下是 264px 的固定栏，
 * 面板被拖窄时先按比例收缩，不会把画布压到看不见。
 * 做成独立圆角卡片（而不是贴边的整条竖栏），和左侧画布卡片对称。
 */
.mind-map-inspector-host {
  flex: 0 0 264px;
  width: 264px;
  max-width: 45%;
  min-width: 180px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-primary);
  overflow: hidden;
}

/*
 * 画布卡片。
 * 圆角裁掉滚动内容与滚动条的四角，视觉上是一张独立的纸；
 * 边界靠柔和的**外**阴影 + 底板色差来交代，不用 1px 描边：
 * 画布里的内容是一张比视口大的白纸，1px 内描边会被白纸盖掉，
 * 只从右侧/底部那条透明的滚动条凹槽里漏出来，看着就像「边上多了一条
 * 和滚动条同色的线」。外阴影不受这个问题影响，也不会改变
 * `getBoundingClientRect()`，拖拽浮层、右键菜单的坐标换算照旧。
 */
.mind-map-viewport {
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-primary);
  box-shadow: 0 1px 2px rgb(15 23 42 / 0.06);
}

/*
 * 画布的滚动容器。
 * 里面是一张固定尺寸的「纸」（.mind-map-canvas），所以这里是真正的滚动区域：
 * 原生滚动条、原生惯性与触控板手势都可用。
 */
.mind-map-scroll {
  position: absolute;
  inset: 0;
  overflow: auto;
  overscroll-behavior: contain;
  /* 预留滚动条槽位，滚动条随缩放出现/消失时纸张不会横向跳一下；
     槽位本身透明，看不出留白 */
  scrollbar-gutter: stable;
}

/*
 * 画布自己的滚动条：滑块往里缩 3px、圆角，不贴卡片边缘。
 * 「纸」最小 2000×2000，两条滚动条几乎常驻；用全局样式（8px、方角、贴边）
 * 时它们会紧贴卡片右下边，看上去就像边框上多出来的一条灰线。
 */
.mind-map-scroll::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

.mind-map-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.mind-map-scroll::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 999px;
  background-color: var(--color-bg-tertiary);
  background-clip: content-box;
}

.mind-map-scroll::-webkit-scrollbar-thumb:hover {
  background-color: var(--color-border-hover);
  background-clip: content-box;
}

.mind-map-scroll::-webkit-scrollbar-corner {
  background: transparent;
}

/*
 * 「纸」：尺寸用内联样式给（见模板），避免被渲染库写入的内联样式影响。
 * 渲染库会在 init 时把它的 innerHTML 清空并重新挂 .map-container。
 */
.mind-map-canvas {
  position: relative;
}

/* 拖拽浮层 */
.mind-map-drag-ghost {
  position: absolute;
  z-index: 18;
  max-width: 220px;
  padding: 4px 10px;
  transform: translate(-50%, -140%);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  color: var(--color-text);
  font-size: var(--ui-font-size);
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.18);
  opacity: 0.94;
  pointer-events: none;
}

/* 拖拽源与被拖过的主题降低存在感，让落点更清楚 */
.mind-map-canvas :deep(me-tpc.is-drag-source) {
  opacity: 0.45;
}

/*
 * 查找命中标记。
 * 用 box-shadow 而不是 outline：选中态已经占用了 outline
 * （库的 `.map-container .selected`），而「当前命中」恰好也是选中项，两套 outline 会打架。
 * 也不能用背景色：彩虹分支把填充色写在内联 style 上，class 里的背景色压不过它。
 */
.mind-map-canvas :deep(me-tpc.is-search-match) {
  box-shadow: 0 0 0 2px var(--color-warning);
}

.mind-map-canvas :deep(me-tpc.is-search-match-current) {
  box-shadow:
    0 0 0 3px var(--color-primary),
    0 0 12px rgb(59 130 246 / 0.45);
}

/*
 * 有备注的主题：右下角一个小圆点。
 * 用伪元素画，不参与布局，因此不会干扰渲染库的尺寸测量与连线计算。
 */
.mind-map-canvas :deep(me-tpc.has-note)::after {
  content: '';
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-bg-primary);
  pointer-events: none;
}

/*
 * 附件卡片：挂在主题文字下方的一列小卡片。
 *
 * 它是注入进 `me-tpc` 的块级元素，参与节点自身高度，整张图由渲染库原有的
 * flex 布局自然重排；渲染库给 `me-tpc>*` 统一 `pointer-events:none`，
 * 这里必须把卡片的点击拿回来，否则点上去等于点在主题上（会触发选中/改名）。
 */
.mind-map-canvas :deep(.inkase-attach-cards) {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  pointer-events: auto;
}

.mind-map-canvas :deep(.inkase-attach-card) {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 3px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background-color: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.mind-map-canvas :deep(.inkase-attach-card:hover) {
  border-color: var(--color-primary);
  background-color: var(--color-bg-hover, var(--color-bg-secondary));
}

.mind-map-canvas :deep(.inkase-attach-glyph) {
  flex: none;
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1;
}

.mind-map-canvas :deep(.inkase-attach-name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mind-map-canvas :deep(.inkase-attach-size) {
  flex: none;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 4px);
}

/* 卡片菜单比主题菜单窄，贴着鼠标出 */
.mind-map-card-menu {
  z-index: 26;
  min-width: 120px;
}

.mind-map-menu-item.is-danger .mind-map-menu-label {
  color: var(--color-danger, #dc2626);
}

/* 备注编辑面板：浮在画布上方居中，不改变画布布局 */.mind-map-note {
  position: absolute;
  z-index: 24;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  width: min(420px, calc(100% - 32px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
}

.mind-map-note-title {
  margin: 0;
  font-size: var(--ui-font-size);
  font-weight: 600;
  color: var(--color-text);
}

.mind-map-note-input {
  min-height: 96px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-secondary);
  color: var(--color-text);
  font-family: inherit;
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.6;
  resize: vertical;
}

.mind-map-note-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

/* 标签/链接是单行输入，不需要备注那样的高度 */
.mind-map-rich-input {
  min-height: 0;
  resize: none;
}

.mind-map-rich-error {
  margin: 0;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-warning);
}

/* 开关型菜单项（星标）的勾选标记；占位固定，避免勾选后文字左右跳动 */
.mind-map-menu-check {
  width: 14px;
  flex: none;
  color: var(--color-primary);
  font-size: calc(var(--ui-font-size) - 2px);
}

/* 落点提示：中间 = 成为子主题，上下边缘 = 插到前/后 */
.mind-map-canvas :deep(me-tpc.is-drop-in) {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.mind-map-canvas :deep(me-tpc.is-drop-before) {
  box-shadow: inset 0 2px 0 0 var(--color-primary);
}

.mind-map-canvas :deep(me-tpc.is-drop-after) {
  box-shadow: inset 0 -2px 0 0 var(--color-primary);
}

.mind-map-error {
  flex-shrink: 0;
  max-height: 60%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-bg-secondary);
  font-size: var(--ui-font-size);
}

.mind-map-error-title {
  margin: 0;
  font-weight: 600;
  color: var(--color-text);
}

/*
 * 「已自动修复」提示条。
 * 修复是宽容解析的结果，不是错误：用中性底色 + 次要文字，避免和红字报错混淆，
 * 但必须显式出现——重复 id、非法颜色这类修复会改动用户文件内容。
 */
.mind-map-repair {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-bg-secondary);
  font-size: var(--ui-font-size);
}

.mind-map-repair-body {
  flex: 1;
  min-width: 0;
}

.mind-map-repair-title {
  margin: 0;
  font-weight: 600;
  color: var(--color-text);
}

.mind-map-repair-list {
  margin: 2px 0 0;
  padding-left: 18px;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.6;
}

.mind-map-repair-close {
  flex-shrink: 0;
}

.mind-map-error-detail {
  margin: 0;
  color: var(--color-danger, #e5484d);
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 1px);
  word-break: break-word;
}

.mind-map-fallback-label {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.mind-map-fallback {
  min-height: 140px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.5;
  resize: vertical;
}

.mind-map-fallback-actions {
  display: flex;
  gap: 8px;
}

.mind-map-action {
  padding: 4px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  color: var(--color-text);
  font-size: calc(var(--ui-font-size) - 1px);
  cursor: pointer;
}

.mind-map-action-primary {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.mind-map-action:hover {
  border-color: var(--color-primary);
}

.mind-map-menu {
  position: absolute;
  z-index: 20;
  min-width: 176px;
  max-width: 240px;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
  font-size: var(--ui-font-size);
  user-select: none;
}

.mind-map-menu-separator {
  height: 1px;
  margin: 4px 6px;
  background-color: var(--color-border);
}

.mind-map-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: calc(var(--radius-md) - 2px);
  background-color: transparent;
  color: var(--color-text);
  font-size: inherit;
  text-align: left;
  cursor: pointer;
}

.mind-map-menu-item:hover:not(.is-disabled) {
  background-color: var(--color-bg-hover, var(--color-bg-secondary));
}

.mind-map-menu-item.is-disabled {
  color: var(--color-text-tertiary);
  cursor: default;
}

.mind-map-menu-hint {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}

/* 二级菜单：靠 hover 展开，不用额外的展开状态，指针从父项移到子菜单时宿主不变 */
.mind-map-menu-submenu-host {
  position: relative;
}

.mind-map-menu-item.has-submenu {
  cursor: default;
}

.mind-map-menu-arrow {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) + 2px);
  line-height: 1;
}

.mind-map-submenu {
  position: absolute;
  top: -5px;
  left: 100%;
  z-index: 30;
  display: none;
  min-width: 132px;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.mind-map-menu-submenu-host:hover .mind-map-submenu,
.mind-map-submenu:focus-within {
  display: block;
}

.mind-map-submenu .mind-map-menu-label {
  flex: 1;
}

.mind-map-submenu-glyph {
  width: 1.2em;
  font-size: calc(var(--ui-font-size) + 1px);
  line-height: 1;
  text-align: center;
}

.mind-map-menu-item.is-active {
  color: var(--color-primary);
}

.mind-map-menu-section-label {
  padding: 2px 8px 4px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.mind-map-menu-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 8px 6px;
}

.mind-map-menu-color {
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  cursor: pointer;
}

.mind-map-menu-color:hover {
  transform: scale(1.15);
}

.mind-map-menu-color.is-auto {
  width: auto;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background-color: transparent;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 2px);
}

/* ---------- 渲染库内部元素对齐 Inkase 主题 ---------- */

/*
 * 连线图层必须整体压在主题下面。
 *
 * 渲染库把连线 SVG（`.lines` / 每个分支的 `.subLines`）作为 `me-nodes` 的子节点，
 * 本身没有 z-index，靠 `me-parent` / `me-root` 的 `z-index: 10` 盖在它上面。
 * 这里把连线显式降到 0 层：万一主题的底色被主题/分支样式改薄（例如分支配色的底纹），
 * 连线也不会冒到文字上去。主题的底纹另见 branch-color.ts 里对底色与底纹的分层处理。
 */
.mind-map-canvas :deep(.lines),
.mind-map-canvas :deep(.subLines) {
  z-index: 0;
}

/* 框选矩形跟随主题 */
.mind-map-canvas :deep(.selection-area) {
  background-color: var(--color-selection);
  border-color: var(--color-primary);
}

/*
 * 拖动的手感：
 * - 悬停主题时用默认箭头而不是渲染库的 pointer（pointer 会让人以为点一下就跳转）；
 * - 按住主题时显示「抓取中」，明确告诉用户现在可以拖动。
 * 注意不要在 me-tpc 上加 hover 描边：选中态已有 outline，两套描边会打架。
 */
.mind-map-canvas :deep(me-parent) {
  cursor: default;
}

.mind-map-canvas :deep(me-tpc:active) {
  /* 自绘光标按主题取色；平台不认 SVG 光标时回退到系统 move（黑白双色） */
  cursor: var(--pan-cursor, move);
}

/* 正在编辑文字时恢复文本光标 */
.mind-map-canvas :deep(#input-box) {
  cursor: text;
}
</style>
