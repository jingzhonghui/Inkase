/**
 * SVG → PNG 栅格化
 *
 * 为什么把 PNG 和 SVG 分开成两个文件：
 * SVG 是「可解释的矢量数据」，任何环境都能生成、也能直接断言内容；
 * PNG 依赖 canvas 与 `<img>` 解码，属于平台能力。分开之后，
 * 前者在 jsdom 里也能完整测试，后者只需要很薄的一层封装。
 *
 * 放大倍数默认 2x：导出的图十有八九会被贴进文档或聊天窗口，
 * 1x 的文字在缩放后发虚；2x 兼顾清晰度与文件体积（一张千级节点的图约 2~4MB）。
 */

/** 单张 PNG 的像素上限，避免超大导图把内存吃穿 */
const MAX_PIXELS = 40_000_000

/** 默认解码超时：超时按失败处理，绝不让「导出中」永远转圈 */
const DEFAULT_DECODE_TIMEOUT = 20_000

export interface RasterizeOptions {
  /** 放大倍数，默认 2；会被像素上限自动下调 */
  scale?: number
  /** 解码超时（ms），默认 20s */
  decodeTimeoutMs?: number
}

/** 把 SVG 文本包成 `<img>` 能加载的 data URL（`#` 等字符必须转义） */
export function toSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function loadSvgImage(svg: string, timeoutMs: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false
    // 有环境（例如缺图像解码能力的测试环境）对 data URL 既不 load 也不 error，
    // 少了这道超时，调用方就会一直停在「导出中」
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('SVG 图像解码超时，导出失败'))
    }, timeoutMs)
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    image.onload = () => settle(() => resolve(image))
    image.onerror = () => settle(() => reject(new Error('SVG 图像无法解析，导出失败')))
    image.src = toSvgDataUrl(svg)
  })
}

/**
 * 把 SVG 栅格化成 PNG。
 *
 * @param svg buildMindMapSvg 的输出
 * @param width / height SVG 的 CSS 尺寸（不是像素尺寸）
 */
export async function rasterizeSvgToPng(
  svg: string,
  width: number,
  height: number,
  options: RasterizeOptions = {}
): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('当前环境不支持图片导出')

  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const requested = Number.isFinite(options.scale) ? Math.max(1, options.scale as number) : 2
  // 大图自动降倍数：宁可 1.5x 也别直接抛内存错误
  const affordable = Math.sqrt(MAX_PIXELS / (safeWidth * safeHeight))
  const scale = Math.max(1, Math.min(requested, affordable))

  const image = await loadSvgImage(svg, options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(safeWidth * scale)
  canvas.height = Math.round(safeHeight * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前环境不支持画布导出')

  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('PNG 编码失败'))
    }, 'image/png')
  })
}
