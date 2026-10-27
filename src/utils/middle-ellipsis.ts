/**
 * 中间省略：在限定宽度内保留文本首尾字符，用「…」连接。
 *
 * 使用外部传入的 measure 计算文字宽度，便于在浏览器里用 canvas 精确测量，
 * 也便于纯函数单测（不依赖 DOM）。
 */

export interface MiddleEllipsisOptions {
  /** 首部保留字符占可见字符总数的比例，默认 0.45（尾部略多，便于保留扩展名） */
  headRatio?: number
  /** 省略符，默认「…」 */
  ellipsis?: string
}

/**
 * @param text 完整文本
 * @param maxWidth 可用宽度（px），<=0 时返回空串
 * @param measure 文本宽度测量函数
 */
export function fitMiddleEllipsis(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
  options: MiddleEllipsisOptions = {}
): string {
  if (!text) return text
  if (maxWidth <= 0) return ''

  // 完整文本放得下时保持原样
  if (measure(text) <= maxWidth) return text

  const chars = Array.from(text)
  if (chars.length <= 1) return options.ellipsis ?? '…'

  const headRatio = Math.min(1, Math.max(0, options.headRatio ?? 0.45))
  const ellipsis = options.ellipsis ?? '…'

  const build = (visible: number): string => {
    const headCount = Math.ceil(visible * headRatio)
    const tailCount = visible - headCount
    const head = chars.slice(0, headCount).join('')
    const tail = tailCount > 0 ? chars.slice(chars.length - tailCount).join('') : ''
    return `${head}${ellipsis}${tail}`
  }

  // 可见字符数从 0 到 length-1 单调递增地放宽，二分出仍能放下的最大值
  let low = 0
  let high = chars.length - 1
  let best = ellipsis

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = build(mid)
    if (measure(candidate) <= maxWidth) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return best
}
