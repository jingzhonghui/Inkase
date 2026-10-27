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
/** 每档缩放倍率 */
export const MINDMAP_ZOOM_STEP = 1.2

/**
 * 计算下一档缩放。
 * 以倍率递增而不是加减固定值，缩放感受在 20%~300% 区间内保持一致。
 */
export function nextZoomScale(
  current: number,
  direction: 'in' | 'out',
  options: { step?: number; min?: number; max?: number } = {}
): number {
  const step = options.step ?? MINDMAP_ZOOM_STEP
  const min = options.min ?? MINDMAP_ZOOM_MIN
  const max = options.max ?? MINDMAP_ZOOM_MAX
  const safeCurrent = Number.isFinite(current) && current > 0 ? current : 1
  const raw = direction === 'in' ? safeCurrent * step : safeCurrent / step
  // 四舍五入到 1%，避免连续缩放累积出一串浮点噪声（显示成 128.00000001%）
  return Math.min(max, Math.max(min, Math.round(raw * 100) / 100))
}

/** 缩放值 → 展示用的百分比文本 */
export function formatZoomPercent(scale: number): string {
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1
  return `${Math.round(safe * 100)}%`
}

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
