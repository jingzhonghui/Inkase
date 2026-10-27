/**
 * 分支配色（彩虹分支的自有实现）
 *
 * 为什么要自己着色：
 * 渲染库的分支色只落在**连线和一级主题的边框**上（`generateMainBranch` 那段逻辑：
 * 一级分支取 `节点分支色 || 调色板[第几个一级分支 % 长度]`，子枝按「最近的有分支色的
 * 祖先」继承）。于是开彩虹后画布上出现一个割裂的观感——连线是彩色的，
 * 主题本体（尤其是二级以下）却还是单色，看起来像「彩虹分支没生效」。
 *
 * 这里把**颜色的计算规则**集中到一处，画布着色与右侧属性栏都调用它：
 * 两边各算一次就会出现「属性栏色块高亮的是蓝色、画布上却是绿色」这种不一致。
 *
 * 两条约定：
 * 1. 一律以 DOM 为准，而不是自己按 `nodeObj.parent` 复算。一级分支的序号由渲染库按
 *    `me-main > me-wrapper` 的 DOM 顺序决定（左右两侧各是一个 `me-main`），
 *    只有读 DOM 才能和连线颜色严格对上。
 * 2. 派生出来的颜色**只写 DOM 内联样式**，绝不写回 `branchColor`：
 *    `branchColor` 会被序列化进文件的 `color` 字段，写进派生色等于把七彩写死进文件。
 */

import { isRootTopic, type MindMapTopicElement } from './context-menu'
import { withAlpha } from './theme'

const WRAPPER = 'me-wrapper'
const BRANCH_SELECTOR = 'me-main > me-wrapper'

/**
 * 主题的底色。
 *
 * 渲染库给每个主题的 `background-color` 都是这个不透明的值，底纹只能**叠**在它上面。
 * 早期实现直接把 `background-color` 换成了半透明色，结果主题底色被掏空，
 * 本来被盖住的连线就从主题内部透了出来，看起来像「连线画在文字上」。
 * 所以底色一律保留不透明，底纹改走 `background-image`（画在底色之上、文字之下）。
 */
const SURFACE = 'var(--main-bgcolor, transparent)'

/** 主题当前生效的分支色 */
export interface MindMapBranchColor {
  /** `#rrggbb` */
  color: string
  /** true = 用户显式指定过（`branchColor`）；false = 按一级分支序号自动分配 */
  explicit: boolean
}

/** 计算分支色所需的外部状态 */
export interface MindMapBranchColorOptions {
  /** 当前主题模式下的调色板（彩虹分支的候选色） */
  palette: string[]
  /** 单色模式下所有分支的统一颜色 */
  mono: string
  /** 是否开启彩虹分支 */
  rainbow: boolean
}

/** 一级主题（分支根部）比深层主题更醒目：边框更粗、底纹更实 */
const HEAD_BORDER_WIDTH = '2px'
const HEAD_BACKGROUND_ALPHA = 0.16
const SUB_BORDER_WIDTH = '1px'
const SUB_BORDER_ALPHA = 0.5
const SUB_BACKGROUND_ALPHA = 0.08

/**
 * wrapper 自己对应的主题元素（`me-parent` 下的第一个 `me-tpc`）。
 * 必须用「第一个」而不是任意一个：`me-wrapper` 里同时还嵌着整棵子树的
 * `me-parent`，而文档顺序上自己的主题永远排在最前。
 */
export function headTopicOf(wrapper: Element | null): MindMapTopicElement | null {
  if (!(wrapper instanceof Element)) return null
  return wrapper.querySelector<MindMapTopicElement>('me-parent > me-tpc')
}

/** 主题所属的一级分支（`me-main > me-wrapper`）；根主题没有分支，返回 null */
export function topBranchOf(topic: Element | null): HTMLElement | null {
  if (!(topic instanceof Element)) return null
  return topic.closest<HTMLElement>(BRANCH_SELECTOR)
}

/**
 * 一级分支的序号（渲染库正是按这个序号取调色板）。
 * 序号按整棵树里所有 `me-main > me-wrapper` 的文档顺序计，左右两个 `me-main`
 * 各自贡献自己那几支，和渲染库画连线时的顺序完全一致。
 */
export function branchIndexOf(topBranch: Element | null): number {
  if (!(topBranch instanceof Element)) return -1
  const scope = topBranch.parentElement?.parentElement
  if (!scope) return -1
  return Array.from(scope.querySelectorAll(BRANCH_SELECTOR)).indexOf(topBranch)
}

/** 按 DOM 顺序取出一级分支（左右两侧的 `me-main` 都算在内） */
function branchesOf(scope: Element | null): HTMLElement[] {
  if (!(scope instanceof Element)) return []
  return Array.from(scope.querySelectorAll<HTMLElement>(BRANCH_SELECTOR))
}

/** 比较颜色时忽略大小写与空格，避免「同一个颜色被当成两个」 */
function normalizeColor(color: string): string {
  return color.trim().toLowerCase()
}

/**
 * 从调色板里挑一个**尚未被占用**的颜色。
 *
 * 从本分支的序号开始往后找，保证「分支顺序」和颜色的视觉顺序一致；
 * 一圈都被占了（分支数多于调色板）才退回按序号取色。
 */
function pickFreeColor(palette: string[], start: number, used: Set<string>): string {
  for (let step = 0; step < palette.length; step += 1) {
    const candidate = palette[(start + step) % palette.length]
    if (!used.has(normalizeColor(candidate))) return candidate
  }
  return palette[start % palette.length]
}

/**
 * 算出所有一级分支各自应得的颜色（按传入顺序）。
 *
 * 关键规则：**自动分配的色不能和前面任何分支撞色**，包括用户手动指定过的分支。
 * 只按序号取 `palette[序号 % 长度]` 是不够的——举例：分支 A 被手动设成调色板
 * 第 2 色（绿），紧接着的分支 B 是「自动」，序号正好取到第 2 色，两支就撞成
 * 一模一样的绿。这里用一个「已占用」集合逐支顺延，相邻分支必然不同色。
 */
export function assignBranchColors(
  branches: Element[],
  options: MindMapBranchColorOptions
): string[] {
  const { palette, mono, rainbow } = options
  const used = new Set<string>()

  return branches.map((branch, index) => {
    const own = headTopicOf(branch)?.nodeObj?.branchColor
    if (own) {
      used.add(normalizeColor(own))
      return own
    }
    if (!rainbow || palette.length === 0) return mono
    const color = pickFreeColor(palette, index, used)
    used.add(normalizeColor(color))
    return color
  })
}

/**
 * 沿祖先主题向上找最近的显式分支色。
 *
 * 这是渲染库的继承规则：子枝用「最近的写了 `branchColor` 的祖先」的颜色。
 * 从主题自己的 wrapper 开始，逐层往上（wrapper → 父级 me-children → 父 wrapper）。
 */
export function explicitBranchColor(topic: Element | null): string | undefined {
  let wrapper = topic?.closest<HTMLElement>(WRAPPER) ?? null
  while (wrapper) {
    const own = headTopicOf(wrapper)?.nodeObj?.branchColor
    if (own) return own
    wrapper = wrapper.parentElement?.closest<HTMLElement>(WRAPPER) ?? null
  }
  return undefined
}

/** 按渲染库的规则算出主题当前生效的分支色 */
export function resolveBranchColor(
  topic: Element | null,
  options: MindMapBranchColorOptions
): MindMapBranchColor {
  const explicit = explicitBranchColor(topic)
  if (explicit) return { color: explicit, explicit: true }

  const { mono, rainbow, palette } = options
  if (!rainbow || palette.length === 0) return { color: mono, explicit: false }

  const top = topBranchOf(topic)
  const index = branchIndexOf(top)
  if (!top || index < 0) return { color: mono, explicit: false }

  // 必须用和画布完全相同的分配算法：否则属性栏高亮的色块会和画布上的边框不一致
  const colors = assignBranchColors(branchesOf(top.parentElement?.parentElement ?? null), options)
  return { color: colors[index] ?? mono, explicit: false }
}

/**
 * 给单个主题上色；`level` 为 1 表示一级主题（分支根部）。
 *
 * 单色模式也要显式写边框色：`changeTheme(..., false)` 不会重建 DOM，
 * 从彩虹切回单色时旧的彩色边框还在内联样式里，不覆盖就会「关了彩虹还是彩色」。
 */
function paintTopic(topic: HTMLElement, color: string, level: number, rainbow: boolean): void {
  // 不染文字：调色板里有黄色/橙色这类浅色，染了文字在浅底上读不清。
  // 分支的识别度由连线 + 边框 + 底纹给足，文字保持主题色最稳。
  topic.style.removeProperty('color')
  if (!rainbow) {
    topic.style.borderColor = color
    topic.style.borderWidth = SUB_BORDER_WIDTH
    topic.style.removeProperty('background-color')
    topic.style.removeProperty('background-image')
    return
  }
  const head = level <= 1
  const tint = head
    ? withAlpha(color, HEAD_BACKGROUND_ALPHA, 'transparent')
    : withAlpha(color, SUB_BACKGROUND_ALPHA, 'transparent')
  topic.style.borderColor = head ? color : withAlpha(color, SUB_BORDER_ALPHA, color)
  topic.style.borderWidth = head ? HEAD_BORDER_WIDTH : SUB_BORDER_WIDTH
  // 底色保持不透明（连线和别的图层因此不可能透到文字上），底纹叠在底色之上
  topic.style.backgroundColor = SURFACE
  topic.style.backgroundImage = `linear-gradient(${tint}, ${tint})`
}

/**
 * 把一级连线的颜色对齐到我们分配的分支色。
 *
 * 渲染库按「调色板[序号 % 长度]」给连线取色，而自动分配会跳过已被占用的颜色，
 * 两者可能算出不同的颜色——不同步就会出现「主题边框是蓝的、连线却是绿的」。
 * 结构上一级分支各有一条 `<path>`（`.lines` 的直接子节点），顺序与分支顺序一致；
 * 数量对不上就整体放弃，宁可留渲染库自己的颜色，也不要错位染色。
 */
function paintConnectors(map: Element, colors: string[]): void {
  const lines = map.querySelector('.lines')
  if (!lines) return
  const paths = Array.from(lines.querySelectorAll(':scope > path'))
  if (paths.length !== colors.length) return
  paths.forEach((path, index) => {
    path.setAttribute('stroke', colors[index])
  })
}

function paintSubtree(wrapper: Element, inherited: string, level: number, rainbow: boolean): void {
  const head = headTopicOf(wrapper)
  const own = head?.nodeObj?.branchColor
  const color = own || inherited
  if (head) paintTopic(head, color, level, rainbow)

  for (const child of Array.from(wrapper.children)) {
    if (child.tagName.toLowerCase() !== 'me-children') continue
    for (const grandChild of Array.from(child.children)) {
      if (grandChild.tagName.toLowerCase() !== WRAPPER) continue
      paintSubtree(grandChild, color, level + 1, rainbow)
    }
  }
}

/**
 * 给画布上每个主题着上所属分支的颜色。
 *
 * 入口是 `.map-container`（渲染库的根元素）。只处理 `me-main > me-wrapper` 下的
 * 分支；根主题（`me-root`）保持主题强调色不动——它不属于任何分支。
 *
 * 单色模式下也要把每个主题重刷一遍（换成单色、去掉底纹）：
 * `mind.changeTheme(..., false)` 不重建 DOM，从彩虹切回单色时旧的内联色还在，
 * 不覆盖就会留下「关了彩虹还是彩色」。
 */
export function paintBranchTopics(map: Element | null, options: MindMapBranchColorOptions): void {
  if (!map) return
  const { mono, rainbow } = options
  const branches = branchesOf(map)
  if (branches.length === 0) return

  const colors = assignBranchColors(branches, options)
  branches.forEach((wrapper, index) => {
    paintSubtree(wrapper, colors[index] ?? mono, 1, rainbow)
  })
  // 连线跟着同一套颜色走，画布上「一支一色」才是完整的
  paintConnectors(map, colors)
}

/** 右侧属性栏要展示的主题信息（全部是可序列化的纯数据） */
export interface MindMapSelectionInfo {
  id: string
  text: string
  note: string
  /** 当前生效的分支色（与画布上这条分支的连线同色） */
  color: string
  /** 该颜色是否由用户显式指定；false 表示跟着调色板自动分配 */
  explicitColor: boolean
  /** 根主题没有所属分支，属性栏不提供分支颜色 */
  isRoot: boolean
  /** 层级：根主题 0，一级主题 1…… */
  depth: number
  childCount: number
  collapsed: boolean
}

/**
 * 读出一个主题的属性栏数据。
 *
 * 刻意只返回纯数据、不返回 DOM 元素：属性栏的数据要进 Vue 的响应式系统，
 * 而渲染库的主题元素带着 `nodeObj`（运行时还挂着 `parent` 反向引用），
 * 被 Vue 代理后再交回渲染库就会出问题。元素由调用方按 id 现取现用。
 */
export function readSelectionInfo(
  topic: MindMapTopicElement,
  branch: MindMapBranchColor
): MindMapSelectionInfo | null {
  const nodeObj = topic.nodeObj
  if (!nodeObj?.id) return null

  // depth：往上数几层 wrapper。根主题在 me-root 里，没有 wrapper，因此是 0
  let depth = 0
  let wrapper = topic.closest<HTMLElement>(WRAPPER)
  while (wrapper) {
    depth += 1
    wrapper = wrapper.parentElement?.closest<HTMLElement>(WRAPPER) ?? null
  }
  const isRoot = isRootTopic(topic)
  if (isRoot) depth = 0

  const childCount = nodeObj.children?.length ?? 0
  return {
    id: nodeObj.id,
    text: nodeObj.topic ?? '',
    note: nodeObj.note ?? '',
    color: branch.color,
    explicitColor: branch.explicit,
    isRoot,
    depth,
    childCount,
    collapsed: nodeObj.expanded === false
  }
}
