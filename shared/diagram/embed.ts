/**
 * draw.io embed 协议的共享定义（主进程与渲染层共用）。
 *
 * 协议本身是 draw.io 的公开约定：宿主用 `?embed=1&proto=json` 打开 webapp，
 * 之后双方只收发 JSON 字符串 postMessage。
 *
 * 这份文件只放「常量 + 消息类型 + URL 拼装」，不放任何窗口逻辑，
 * 这样渲染层、主进程、单测都能引用同一份事实。
 */

/** 托管 webapp 的自定义协议（必须在 app ready 前注册为 privileged） */
export const DIAGRAM_SCHEME = 'inkase-drawio'

/** 协议里的固定 host，路径才是真实文件路径 */
export const DIAGRAM_HOST = 'app'

/** webapp 入口页面 */
export const DIAGRAM_ENTRY_PATH = 'index.html'

/**
 * webapp 响应头里注入的 CSP。
 *
 * 实测（见 `docs/superpowers/spikes/2026-10-27-drawio-a0/RESULTS.md`）：
 * draw.io 的 embed 模式**不需要** `unsafe-eval`，这条策略下启动、装载、
 * 编辑、导出、Mermaid 全部正常且零 console 错误。
 * `style-src 'unsafe-inline'` 是 draw.io 内联样式所必需，无法收紧。
 */
export const DIAGRAM_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'"
].join('; ')

export interface DiagramEmbedOptions {
  /** 深色主题（决定 draw.io 自己的配色） */
  dark?: boolean
  /** 界面语言，默认中文 */
  lang?: string
  /** 允许调用的额外能力；`libraries=1` 打开形状库 */
  libraries?: boolean
  /** 界面精简程度：min 时只留最小工具栏 */
  ui?: 'min' | 'kennedy' | 'atlas' | 'dark'
  /** 协议基址，默认走自定义协议 */
  baseUrl?: string
}

/**
 * 拼出 iframe 的地址。
 *
 * 关键参数：
 * - `embed=1&proto=json`：进 embed 模式并改用 JSON 消息（否则是纯文本 XML）
 * - `spin=1`：加载期显示进度圈
 * - `noExitBtn=1`：去掉「退出」按钮（否则会跳回 draw.io 首页）
 * - `modified=0`：不让 draw.io 自己弹未保存提示，脏标记由 Inkase 管
 * - `saveAndExit=0`、`noSaveBtn=1`：保存入口由我们自己的工具栏负责
 */
export function buildDiagramEmbedUrl(options: DiagramEmbedOptions = {}): string {
  const base = options.baseUrl ?? `${DIAGRAM_SCHEME}://${DIAGRAM_HOST}/`
  const url = new URL(DIAGRAM_ENTRY_PATH, base.endsWith('/') ? base : `${base}/`)
  const params = url.searchParams
  params.set('embed', '1')
  params.set('proto', 'json')
  params.set('spin', '1')
  params.set('modified', '0')
  params.set('noExitBtn', '1')
  params.set('noSaveBtn', '1')
  params.set('saveAndExit', '0')
  params.set('lang', options.lang ?? 'zh')
  if (options.libraries !== false) params.set('libraries', '1')
  params.set('ui', options.ui ?? 'min')
  params.set('dark', options.dark ? '1' : '0')
  return url.toString()
}

/** 宿主 → 编辑器 */
export type DiagramHostAction =
  | 'load'
  | 'export'
  | 'save'
  | 'fit'
  | 'status'
  | 'spinner'
  | 'dialog'
  | 'prompt'

export interface DiagramLoadMessage {
  action: 'load'
  xml?: string
  descriptor?: { format: string; data: string; wrap?: boolean }
  autosave: 1 | 0
  title?: string
}

export interface DiagramExportMessage {
  action: 'export'
  format: 'xml' | 'xmlpng' | 'svg' | 'png'
  border?: number
  spinKey?: string
}

export interface DiagramFitMessage {
  action: 'fit'
}

/** 编辑器 → 宿主 */
export interface DiagramInitEvent {
  event: 'init'
  proto?: string
  origin?: string
}

export interface DiagramLoadEvent {
  event: 'load'
  xml?: string
}

export interface DiagramAutosaveEvent {
  event: 'autosave'
  xml?: string
  patch?: unknown
  checksum?: string
}

export interface DiagramSaveEvent {
  event: 'save'
  xml?: string
}

export interface DiagramExportEvent {
  event: 'export'
  format: string
  data?: string
  /** `format: 'xml'` 时载荷在这里，不在 data 上（实测量到的坑） */
  xml?: string
  message?: unknown
}

export interface DiagramExitEvent {
  event: 'exit'
  modified?: boolean
}

export interface DiagramResizeEvent {
  event: 'resize'
  rect?: { x: number; y: number; width: number; height: number }
}

export type DiagramEditorEvent =
  | DiagramInitEvent
  | DiagramLoadEvent
  | DiagramAutosaveEvent
  | DiagramSaveEvent
  | DiagramExportEvent
  | DiagramExitEvent
  | DiagramResizeEvent

/** 取出事件里的 XML：`export` 走 `xml` 字段，其余走 `xml`；再兜底 `data`。 */
export function pickEventXml(event: { xml?: string; data?: string } | null | undefined): string {
  if (!event) return ''
  if (typeof event.xml === 'string' && event.xml.length > 0) return event.xml
  if (typeof event.data === 'string' && event.data.startsWith('<')) return event.data
  return ''
}

/** 把 `data:image/...;base64,...` 解成字节；不是 data URL 时按原文编码。 */
export function decodeDiagramDataUrl(dataUrl: string): { bytes: Uint8Array; text: string } | null {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) return null
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) {
    const bytes = new TextEncoder().encode(dataUrl)
    return { bytes, text: dataUrl }
  }
  const base64 = match[2]
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return { bytes, text: new TextDecoder().decode(bytes) }
}
