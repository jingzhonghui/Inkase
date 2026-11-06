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
  /** 上次阅读位置（切换标签页/编辑模式时保存、切回时恢复；关闭标签即丢弃） */
  savedEditorPosition?: {
    /** 滚动容器纵向偏移 */
    scrollTop: number
    /**
     * 滚动进度比例（0..1）。
     * 只作为兜底：源码 / 即时渲染 / 分屏的布局高度不同，比例会随换行宽度漂移。
     */
    scrollRatio?: number
    /** 视口顶部所在的 Markdown 行号（1 基）。跨模式恢复用它定位内容 */
    anchorLine?: number
    /**
     * 锚点块顶部相对视口顶部的像素偏移（可为负）。
     * 锚点是「视口里最下面那个文本块」，恢复时把它的顶边放回同一屏幕位置：
     * 图片等块在不同模式下高度差异巨大，只按行号对齐会让文字大幅跳动。
     */
    anchorOffsetPx?: number
    /** 记录位置时所在的编辑模式；恢复时据此决定用像素还是比例 */
    mode?: EditorMode
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
