/**
 * MDX 类型定义（前端共享）
 *
 * 这些类型与 electron/mdx/schema.ts 保持一致
 */

/** MDX 文件格式版本 */
export const MDX_VERSION = '1.0'

/** 支持的编码格式 */
export type Encoding = 'UTF-8'

/** 编辑器主题 */
export type EditorTheme = 'default' | 'dark' | 'light'

/** 预览样式 */
export type PreviewStyle = 'github' | 'gitlab' | 'minimal'

/** 资源类型 */
export type AssetType = 'image' | 'attachment'

/** 图片资源信息 */
export interface MdxImageAsset {
  id: string
  filename: string
  path: string
  mime_type: string
  size: number
  checksum: string
  width?: number
  height?: number
}

/** 附件资源信息 */
export interface MdxAttachmentAsset {
  id: string
  filename: string
  path: string
  mime_type: string
  size: number
  checksum: string
}

/** 资源集合 */
export interface MdxAssets {
  images: MdxImageAsset[]
  attachments?: MdxAttachmentAsset[]
}

/** 编辑器设置 */
export interface MdxSettings {
  editor_theme: EditorTheme
  preview_style: PreviewStyle
}

/** MDX 文件元数据 */
export interface MdxMetadata {
  version: string
  created_at: string // ISO 8601 格式
  modified_at: string // ISO 8601 格式
  author?: string
  title: string
  encoding: Encoding
  content_file: string
}

/** 完整的 mdx.json 结构 */
export interface MdxJson {
  version: string
  created_at: string
  modified_at: string
  author?: string
  title: string
  encoding: Encoding
  content_file: string
  assets: MdxAssets
  settings: MdxSettings
}

/** 内存中的 MDX 文档对象 */
export interface MdxDocument {
  metadata: MdxMetadata
  content: string
  assets: MdxAssets
  settings: MdxSettings
}

export type DocumentFormat = 'mdx' | 'markdown' | 'image' | 'pdf' | 'mindmap'

/** 只有 Markdown 文档格式支持编辑和保存；新增格式默认按只读处理。 */
export function isEditableMarkdownFormat(format?: DocumentFormat | null): boolean {
  return format === 'mdx' || format === 'markdown'
}

/**
 * 思维导图格式：同样是「可编辑文本」，但不走 Markdown 语义
 * （没有源码/即时渲染/分屏模式，内容是一段 JSON）。
 */
export function isMindMapFormat(format?: DocumentFormat | null): boolean {
  return format === 'mindmap'
}

/** 内容可编辑并可通过文本通道写盘的格式（Markdown + 思维导图） */
export function isEditableTextFormat(format?: DocumentFormat | null): boolean {
  return isEditableMarkdownFormat(format) || isMindMapFormat(format)
}

/** MDX 文件操作结果 */
export interface MdxResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/** 文件信息 */
export interface FileInfo {
  path: string
  name: string
  size: number
  modifiedAt: Date
}

/**
 * 创建默认的 MDX 设置
 */
export function createDefaultSettings(): MdxSettings {
  return {
    editor_theme: 'default',
    preview_style: 'github'
  }
}

/**
 * 创建默认的 MDX 资源集合
 */
export function createDefaultAssets(): MdxAssets {
  return {
    images: [],
    attachments: []
  }
}

/**
 * 创建新的 MDX 文档元数据
 */
export function createMetadata(title = '未命名文档'): MdxMetadata {
  const now = new Date().toISOString()
  return {
    version: MDX_VERSION,
    created_at: now,
    modified_at: now,
    title,
    encoding: 'UTF-8',
    content_file: 'content.md'
  }
}

/**
 * 创建新的 MDX 文档
 */
export function createMdxDocument(title = '未命名文档', content = ''): MdxDocument {
  return {
    metadata: createMetadata(title),
    content,
    assets: createDefaultAssets(),
    settings: createDefaultSettings()
  }
}
