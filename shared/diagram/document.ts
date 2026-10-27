/**
 * `.drawio` 图表文档的共享定义（主进程与渲染层共用同一份常量与解析逻辑）。
 *
 * 为什么单独抽一层：
 * - 主进程打开/保存文件、渲染层判断格式、AI 只读解析、搜索索引，都要认同一个扩展名；
 * - `mxfile` 的页结构（`<diagram>` + 可选压缩载荷）是纯字符串问题，不需要 Electron；
 * - 压缩/解压要用 `node:zlib`，只在主进程可用，单独放在
 *   `electron/diagram/mxfile-codec.ts`，这一层保持零依赖、可单测。
 */

/** 文件格式标识（与 `src/types/mdx.ts` 的 DocumentFormat 对齐） */
export const DIAGRAM_FORMAT = 'diagram' as const

/** 唯一支持的扩展名：官方 draw.io 原生格式，保证与外部工具互通 */
export const DIAGRAM_EXTENSION = '.drawio'

/** 文件对话框里的显示名 */
export const DIAGRAM_FILE_FILTER_NAME = 'draw.io 图表'

/** 压缩页使用的 `<mxfile>` 版本号（与 draw.io 自己写出的保持一致） */
export const DIAGRAM_MXFILE_VERSION = '24.7.17'

/** 判断路径是否为图表文件（忽略大小写）。 */
export function isDiagramPath(target?: string | null): boolean {
  if (typeof target !== 'string') return false
  return target.trim().toLowerCase().endsWith(DIAGRAM_EXTENSION)
}

/**
 * 判断某个 `<diagram>` 的载荷是否为压缩形态。
 *
 * draw.io 的压缩页是 `base64(deflateRaw(encodeURIComponent(xml)))`，
 * 因此「不以 `<` 开头」即可判定为压缩；明文页一定是 XML。
 */
export function isCompressedDiagramPayload(payload: string): boolean {
  const trimmed = payload.trim()
  if (trimmed.length === 0) return false
  return !trimmed.startsWith('<')
}

export interface DiagramPage {
  /** `<diagram id="...">`，draw.io 用它做页面标识；缺失时回退为序号 */
  id: string
  /** 页名，draw.io 界面上的标签 */
  name: string
  /** 载荷是否压缩 */
  compressed: boolean
  /** 载荷长度（字符数，未解压） */
  payloadLength: number
}

const DIAGRAM_TAG_RE = /<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g
const ATTR_RE = (name: string): RegExp => new RegExp(`${name}\\s*=\\s*"([^"]*)"`)

/**
 * 解析出 mxfile 里所有页的元信息（不解压）。
 *
 * 容错：属性顺序、单双引号、自闭合空页都能处理；解析不到时返回空数组，
 * 由调用方决定是「当作单页」还是报错。
 */
export function parseDiagramPages(xml: string): DiagramPage[] {
  if (typeof xml !== 'string' || xml.length === 0) return []
  const pages: DiagramPage[] = []
  const re = new RegExp(DIAGRAM_TAG_RE.source, 'g')
  let match: RegExpExecArray | null
  let index = 0
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1] ?? ''
    const body = (match[2] ?? '').trim()
    const idMatch = ATTR_RE('id').exec(attrs)
    const nameMatch = ATTR_RE('name').exec(attrs)
    pages.push({
      id: idMatch?.[1] ?? `page-${index + 1}`,
      name: nameMatch?.[1] ?? `第 ${index + 1} 页`,
      compressed: isCompressedDiagramPayload(body),
      payloadLength: body.length
    })
    index += 1
  }
  return pages
}

/**
 * 判断一段文本是否是可交给 draw.io 渲染的图表数据。
 *
 * 三种合法输入：
 * 1. 完整 `<mxfile>`（多页容器）
 * 2. 裸 `<mxGraphModel>`（单页）
 * 3. 裸压缩载荷（有人把单页内容单独存过）
 */
export function isDiagramPayload(text: string): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith('<')) {
    return /<mxfile[\s>]/i.test(trimmed) || /<mxGraphModel[\s>]/i.test(trimmed)
  }
  return /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.replace(/\s/g, '').length >= 16
}

/**
 * 统计图元数量。
 *
 * 只数 `<mxCell>`：`<UserObject>` 里必然还裹着一个 `<mxCell>`，
 * 两个都算会得双倍。每页固定的 `id="0"`（根）与 `id="1"`（默认父）要减掉，
 * 这样结果才接近「用户画了几个东西」。
 */
export function countDiagramCells(xml: string): number {
  if (typeof xml !== 'string') return 0
  const cells = xml.match(/<mxCell[\s/>]/g)?.length ?? 0
  if (cells === 0) return 0
  return Math.max(0, cells - 2 * Math.max(1, parseDiagramPages(xml).length))
}

/** 空图表的 mxfile：一页、无图元，schema 与 draw.io 新建时一致。 */
export function createEmptyDiagramXml(pageName = '第 1 页'): string {
  return [
    `<mxfile host="Inkase" version="${DIAGRAM_MXFILE_VERSION}">`,
    `  <diagram id="page-1" name="${escapeXmlAttribute(pageName)}">`,
    '    <mxGraphModel dx="1000" dy="700" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">',
    '      <root>',
    '        <mxCell id="0" />',
    '        <mxCell id="1" parent="0" />',
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
    ''
  ].join('\n')
}

/** 写盘前的规整：去掉 BOM、统一换行、保证结尾一个换行（与 .md 的处理一致）。 */
export function normalizeDiagramXml(text: string): string {
  const withoutBom = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  const normalized = withoutBom.replace(/\r\n/g, '\n').trimEnd()
  return normalized.length > 0 ? `${normalized}\n` : ''
}

/** 供 XML 属性内联使用的最小转义（页名里可能出现 `&`、`"` 等）。 */
export function escapeXmlAttribute(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
