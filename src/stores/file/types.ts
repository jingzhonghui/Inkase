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
  /**
   * 思维导图容器的资源映射：包内路径 → 解压后的绝对路径。
   *
   * `.inkmind` 是 ZIP，图片与附件躺在临时解压目录里；
   * 渲染层用这张表把 `assets/images/x.png` 换成能加载的 URL。
   * 只对 format='mindmap' 有意义，关闭标签即失效。
   */
  mindMapAssets?: Record<string, string>
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
