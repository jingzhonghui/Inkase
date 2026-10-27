/**
 * `mxfile` 压缩页编解码（仅主进程可用，依赖 `node:zlib`）。
 *
 * draw.io 的压缩格式：`base64(deflateRaw(encodeURIComponent(xml)))`。
 * 为什么是 `encodeURIComponent`：让中文等非 ASCII 字符先转成 `%XX`，
 * 避免不同平台的编码差异；解回来必须按同样的顺序反向处理。
 *
 * 用途：
 * - 打开/落盘时把压缩页展开，方便 AI 只读、全文搜索、以及「页内容 diff」；
 * - 需要写回压缩页时（例如生成的图表）再压回去。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { isCompressedDiagramPayload } from '../../shared/diagram/document'

/** 解压一个页的载荷；失败时抛出可读错误（调用方决定是回退还是报错）。 */
export function decodeDiagramPayload(payload: string): string {
  const cleaned = payload.replace(/\s/g, '')
  if (cleaned.length === 0) return ''
  let inflated: Buffer
  try {
    inflated = inflateRawSync(Buffer.from(cleaned, 'base64'))
  } catch (error) {
    throw new Error(`图表页解压失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const text = inflated.toString('utf-8')
  try {
    return decodeURIComponent(text)
  } catch {
    // 少数工具写的是未做 URI 编码的 XML（历史格式），原样返回更友好
    return text
  }
}

/** 把一段 XML 压成 draw.io 的压缩载荷。 */
export function encodeDiagramPayload(xml: string): string {
  const encoded = encodeURIComponent(xml)
  return deflateRawSync(Buffer.from(encoded, 'utf-8')).toString('base64')
}

/**
 * 把 mxfile 里所有压缩页展开为明文 XML（保持 `<mxfile>` 外壳与页属性不变）。
 *
 * 只在读取侧使用：写回磁盘时保留原样，避免无谓的体积膨胀。
 */
export function decompressMxfile(xml: string): string {
  if (typeof xml !== 'string' || !xml.includes('<diagram')) return xml
  return xml.replace(
    /<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g,
    (whole, attrs: string, body: string) => {
      const payload = body.trim()
      if (!isCompressedDiagramPayload(payload)) return whole
      try {
        return `<diagram${attrs}>${decodeDiagramPayload(payload)}</diagram>`
      } catch {
        // 单页损坏不该让整份文件读不出来
        return whole
      }
    }
  )
}

/** 是否为「压缩过的整份文件」（裸载荷，没有 mxfile 外壳）。 */
export function decodeWholeFile(payload: string): string {
  return isCompressedDiagramPayload(payload) ? decodeDiagramPayload(payload) : payload
}
