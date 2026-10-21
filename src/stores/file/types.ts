import type { DocumentFormat, MdxDocument } from '../../types/mdx'

export type EditorMode = 'split' | 'source' | 'ir' | 'plain'

export interface FileInfo {
  path: string
  name: string
  modified: boolean
  format: DocumentFormat
}

export interface FolderItem {
  name: string
  path: string
  isDirectory: boolean
}

/** 最近文件列表项 */
export interface RecentItem {
  path: string
  type: 'file' | 'folder'
}

/** 文件树节点 */
export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  isExpanded: boolean
  isLoading: boolean
  children: FileTreeNode[]
}

export interface TabInfo {
  id: string
  /** 新建文件不加入最近打开列表 */
  excludeFromRecent?: boolean
  /** 单击打开的临时预览标签；编辑或显式固定后变为 false */
  isPreview?: boolean
  fileInfo: FileInfo | null
  document: MdxDocument | null
  content: string
  revision: number
  /** 图片文件（format='image'）的 Data URL，用于只读查看 */
  imageDataUrl?: string
  /** PDF 文件（format='pdf'）的 base64 内容，用于只读查看 */
  pdfBase64?: string
  /** 上次阅读位置（切换标签页时保存、切回时恢复；关闭标签即丢弃） */
  savedEditorPosition?: {
    /** 滚动容器纵向偏移 */
    scrollTop: number
    /** 选区起点（文档偏移） */
    from: number
    /** 选区终点（文档偏移） */
    to: number
  }
}

/**
 * 归一化的编辑器选区快照（Markdown 偏移）。
 * 由 SourceEditor（CodeMirror 直接偏移）与 IrEditor（ProseMirror 映射后校验）发布。
 */
export interface EditorSelectionSnapshot {
  tabId: string
  from: number
  to: number
  cursor: number
  text: string
}

/**
 * 编辑器定位请求
 *
 * 反链 / 标签 / 断链面板点击后，先打开文件再请求定位；
 * 由该文件对应的编辑器消费（`token` 自增用于去重，同一请求只生效一次）。
 */
export interface RevealRequest {
  /** 目标文件绝对路径 */
  path: string
  /** 1-based 行号 */
  line: number
  /** 1-based 列号 */
  column: number
  /** 自增令牌 */
  token: number
}
