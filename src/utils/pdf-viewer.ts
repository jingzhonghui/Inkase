/** PDF 查看器缩放与滚动定位的纯逻辑（便于单元测试） */

export const MIN_SCALE = 0.25
export const MAX_SCALE = 5
export const ZOOM_STEP = 0.25
/** 页面区域的上下内边距（与组件 CSS 保持一致） */
export const PAGE_GAP = 16

/** 页面在滚动容器中的布局快照 */
export interface PageLayout {
  top: number
  height: number
}

/**
 * 钳制缩放比例到合法范围，并四舍五入到两位小数避免浮点漂移
 */
export function clampScale(value: number): number {
  const rounded = Math.round(value * 100) / 100
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, rounded))
}

/**
 * 适应宽度缩放比例：容器可用宽度 / 页面宽度
 */
export function fitWidthScale(containerWidth: number, pageWidth: number, padding: number): number {
  const available = Math.max(1, containerWidth - padding)
  return clampScale(available / Math.max(1, pageWidth))
}

/**
 * 按缩放比例计算页面占位尺寸（用于渲染前的 DOM 占位，保证布局测量准确）
 */
export function scaledPageSize(base: { width: number; height: number }, scale: number): { width: number; height: number } {
  const safeScale = Math.max(MIN_SCALE, scale)
  return {
    width: Math.max(1, Math.round(base.width * safeScale)),
    height: Math.max(1, Math.round(base.height * safeScale))
  }
}

/**
 * 根据滚动位置计算当前页码（从 1 开始）。
 * 语义：滚动容器可视区中线越过某页顶部，即视为当前页。
 * 中线落在页间间隙时取上一页，避免页码跳动。
 */
export function pageAtScroll(layouts: PageLayout[], scrollTop: number, viewportHeight: number): number {
  if (layouts.length === 0) return 1
  const focus = scrollTop + viewportHeight / 2
  let current = 1
  for (let i = 0; i < layouts.length; i++) {
    if (focus >= layouts[i].top) current = i + 1
  }
  return current
}

/**
 * 计算滚动到指定页（从 1 开始）所需的 scrollTop
 */
export function scrollOffsetsForPage(layouts: PageLayout[], page: number): number {
  const index = page - 1
  if (index < 0 || index >= layouts.length) return 0
  return layouts[index].top
}

/**
 * 计算侧栏大纲中应高亮的目录项索引（“当前章节”）：
 * 页码 ≤ 当前页的最后一项。无可定位项时返回 -1。
 */
export function activeOutlineIndex(items: Array<{ page: number | null }>, currentPage: number): number {
  let active = -1
  for (let i = 0; i < items.length; i++) {
    const page = items[i].page
    if (page !== null && page <= currentPage) active = i
  }
  return active
}

/** 目录项 title 最大长度，超出截断 */
const OUTLINE_TITLE_MAX = 80

/** 扁平化后的目录节点（depth 从 0 开始，title 已截断） */
export interface OutlineFlatNode {
  title: string
  depth: number
  /** 跳转页码（从 1 开始）；dest 解析失败时为 null */
  page: number | null
}

/** 目录树节点最小结构（兼容 pdfjs OutlineNode 与宽松测试输入） */
export interface OutlineNode {
  title?: string
  /** pdfjs 目标：数组（页引用等）或命名目标字符串；无则 null */
  dest?: string | unknown[] | null
  items?: OutlineNode[] | null
}

/** 目录节点 → 页码（从 1 开始）的解析函数；失败返回 null。可同步或异步 */
export type OutlinePageResolver = (node: OutlineNode) => number | null | Promise<number | null>

function truncateTitle(title: string): string {
  if (title.length <= OUTLINE_TITLE_MAX) return title
  return `${title.slice(0, OUTLINE_TITLE_MAX - 1)}…`
}

/**
 * 将 PDF 目录树按前序（父节点 → 子孙 → 兄弟）扁平化为带 depth 的列表。
 * 无 title 的节点被跳过；children 为 null/空时视为叶节点。
 * 传入 resolvePage 时，为每个节点解析跳转页码并写入 page（解析失败为 null）。
 */
export async function flattenOutline(
  nodes: OutlineNode[],
  resolvePage?: OutlinePageResolver
): Promise<OutlineFlatNode[]> {
  const result: OutlineFlatNode[] = []
  const walk = async (list: OutlineNode[], depth: number): Promise<void> => {
    for (const node of list) {
      if (!node.title) continue
      const flat: OutlineFlatNode = { title: truncateTitle(node.title), depth, page: null }
      if (resolvePage) {
        const page = await resolvePage(node)
        flat.page = page ?? null
      }
      result.push(flat)
      if (node.items && node.items.length > 0) await walk(node.items, depth + 1)
    }
  }
  await walk(nodes, 0)
  return result
}
