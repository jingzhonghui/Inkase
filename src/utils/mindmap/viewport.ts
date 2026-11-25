/**
 * 画布尺寸与缩放的纯函数层
 *
 * 滚动交给浏览器原生滚动（画布是一张「纸」，右上最小 2000×2000，内容更大时
 * 由 `nextPageSize` 算出应有边长），这里只保留尺寸/缩放相关的取值逻辑，便于单测。
 */

/** 缩放下限：再小就看不清文字了 */
export const MINDMAP_ZOOM_MIN = 0.2
/** 缩放上限：导图放大到 300% 已经够用，再大只会让人迷路 */
export const MINDMAP_ZOOM_MAX = 3

/**
 * 注：缩放的**步进与格式化**不在这里。
 *
 * 导图、图片、PDF 与正文的缩放读数统一在底部状态栏显示，步进策略也因此收在
 * `stores/zoom.ts`（`stepZoom` / `formatZoomPercent`）一处，避免同一套逻辑
 * 「按钮走乘法、状态栏走减法」这种两处各说各话。这里只保留画布尺寸相关的纯函数。
 */

/** 画布「纸」的最小边长（px） */
export const MINDMAP_PAGE_MIN = 2000
/** 纸面在内容之外额外留出的空白（px），保证最外侧主题周围还能拖动/滚动 */
export const MINDMAP_PAGE_PADDING = 480

/**
 * 计算画布「纸」应有的边长。
 *
 * 渲染库的 `.map-container` 是 `100% × 100%` 且 `overflow:hidden`：内容一旦比
 * 纸面大就被直接裁掉，滚动条也滚不到。纸面必须跟着内容长。
 *
 * 只增不减：缩小纸面会让滚动位置突然跳动，而留一块更大的空白没有任何副作用。
 * 传入的是**屏幕上量到的**内容尺寸，所以要除以缩放比还原成布局尺寸。
 */
export function nextPageSize(
  contentWidth: number,
  contentHeight: number,
  scale: number,
  current: number,
  options: { min?: number; padding?: number } = {}
): number {
  const min = options.min ?? MINDMAP_PAGE_MIN
  const padding = options.padding ?? MINDMAP_PAGE_PADDING
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  const safeCurrent = Number.isFinite(current) && current > 0 ? current : min
  if (!Number.isFinite(contentWidth) || !Number.isFinite(contentHeight)) return safeCurrent
  if (contentWidth <= 0 || contentHeight <= 0) return safeCurrent
  const needed = Math.max(
    min,
    Math.ceil(contentWidth / safeScale) + padding,
    Math.ceil(contentHeight / safeScale) + padding
  )
  return needed > safeCurrent ? needed : safeCurrent
}
