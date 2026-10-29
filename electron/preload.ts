import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from './ipc/channels'
import type { MdxAttachmentAsset, MdxDocument } from './mdx/schema'
import type { UpdateInfoPayload } from './updater'
import type { LaunchTarget } from './launch-target'
import type {
  AiConfigInput,
  AiConfigView,
  AiConnectionTestResult,
  AiRunEvent,
  AiRunInput,
  ApprovalDecision,
  ConversationMeta,
  ConversationRecord,
  ToolExecutionResult
} from '../shared/ai/types'
import type {
  ConflictChoice,
  EnableSyncOptions,
  SyncConfig,
  SyncResult,
  SyncStatusView
} from './sync/types'
import type { XmindImportWarnings } from '../shared/mindmap/xmind'
import type { FileLinkRecord, GraphPayload } from '../shared/graph/types'

export type { UpdateInfoPayload }

export { IPC_CHANNELS }

// 文件夹条目类型
export interface FolderItem {
  name: string
  path: string
  isDirectory: boolean
}

// 最近文件列表项类型
export interface RecentItem {
  path: string
  type: 'file' | 'folder'
}

/** 图谱构建进度：主进程每处理一批文件推一次 */
export interface GraphProgressEvent {
  scanned: number
  total: number
}

/** 建立链接的入参：`from` / `to` 都是工作区相对 POSIX 路径 */
export interface GraphCreateLinkInput {
  root: string
  from: string
  to: string
  title?: string
}

// 图片压缩选项
export interface ImageCompressOptions {
  compress?: boolean
  quality?: number
  maxWidth?: number
  maxHeight?: number
}

// 图片资源信息
export interface ImageAssetInfo {
  id: string
  filename: string
  path: string
  mime_type: string
  size: number
  checksum: string
}

export interface MdxOpenResult {
  document: MdxDocument
  filePath?: string
  format?: 'mdx' | 'markdown' | 'image' | 'pdf' | 'mindmap'
  isNew?: boolean
  largeFileWarning?: boolean
  imageDataUrl?: string
  pdfBase64?: string
  /**
   * 思维导图容器（format='mindmap'）的资源映射：包内路径 → 解压后的绝对路径。
   * 渲染层据此把 `assets/images/x.png` 换成可加载的 URL。
   */
  assetMap?: Record<string, string>
}

/** 「另存为」时可显式告知的文档格式（用于尚未落盘的新文档） */
export type SaveAsFormat = 'mdx' | 'markdown' | 'mindmap' | 'diagram'

export interface PdfSource {
  filePath: string
  fileName: string
  title: string
  format: 'mdx' | 'markdown'
  content: string
  images: Record<string, string>
}

export interface PdfPrintResult {
  filePath: string
  size: number
}

export interface PdfSourceEntry {
  absolutePath: string
  relativePath: string
}

/** 导入（复制进目录）结果 */
export interface FolderImportResult {
  imported: Array<{ source: string; target: string }>
  failed: Array<{ source: string; error: string }>
  canceled: boolean
  needsResolution?: boolean
  sources?: string[]
  conflicts?: string[]
}

// API 类型定义
export interface ElectronAPI {
  // 文件操作
  newFile: () => Promise<{ success: boolean; data?: MdxOpenResult; error?: string }>
  openFile: (
    filePath?: string,
    addToRecent?: boolean
  ) => Promise<{ success: boolean; data?: MdxOpenResult; error?: string }>
  saveFile: (
    content?: string,
    title?: string,
    filePath?: string,
    addToRecent?: boolean
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>
  saveAsFile: (
    content: string,
    title?: string,
    filePath?: string,
    addToRecent?: boolean,
    /**
     * 当前文档格式。
     * 新建但尚未落盘的思维导图没有路径可推断扩展名，必须显式告知主进程，
     * 否则会按 Markdown 处理、把导图存成 `.mdx`（ZIP）。
     */
    format?: SaveAsFormat
  ) => Promise<{
    success: boolean
    data?: string
    error?: string
    /**
     * 思维导图另存为后新容器的资源映射（包内路径 → 解压后的绝对路径）。
     * 新容器的图片/附件都在这里，渲染层据此刷新标签的资源表。
     */
    assetMap?: Record<string, string>
  }>
  closeFile: (filePath?: string) => Promise<{ success: boolean; error?: string }>
  /**
   * 导出图片（思维导图 PNG / SVG）。
   *
   * 与 `saveAsFile` 的区别：写的是二进制、且不登记最近文件——
   * 图片是一次性产物，不该挤进「最近文件」。
   */
  exportMindMapImage: (
    title: string | undefined,
    format: 'png' | 'svg',
    data: Uint8Array
  ) => Promise<{ success: boolean; data?: string; error?: string }>
  /**
   * 图表编辑器依赖的 draw.io webapp 是否就位。
   *
   * 打包后它在 `process.resourcesPath/drawio`，渲染层自己拼不出这个路径，
   * 所以由主进程回答；缺失时渲染层给出「运行 pnpm run fetch:drawio」的提示。
   */
  getDiagramSupport: () => Promise<{
    success: boolean
    data?: { available: boolean; root: string; scheme: string; host: string }
    error?: string
  }>
  getRecentFiles: () => Promise<{ success: boolean; data?: RecentItem[]; error?: string }>
  addRecentFile: (
    filePath: string,
    type?: 'file' | 'folder'
  ) => Promise<{ success: boolean; error?: string }>
  removeRecentFile: (filePath: string) => Promise<{ success: boolean; error?: string }>
  clearRecentFiles: () => Promise<{ success: boolean; error?: string }>

  // 剪贴板
  clipboardReadText: () => Promise<string>
  clipboardWriteText: (text: string) => Promise<void>
  clipboardWriteTable: (data: { text: string; html: string }) => Promise<void>

  // 拖放文件路径
  getPathForFile: (file: File) => string

  // MDX 操作
  readMdx: (filePath: string) => Promise<{ success: boolean; data?: unknown; error?: string }>
  writeMdx: (filePath: string, data: unknown) => Promise<{ success: boolean; error?: string }>
  importMd: (
    filePath?: string,
    targetPath?: string
  ) => Promise<{ success: boolean; data?: MdxOpenResult; error?: string }>
  importDocx: (
    docxFilePath?: string,
    targetPath?: string
  ) => Promise<{ success: boolean; data?: MdxOpenResult; error?: string }>
  importFolder: (
    sourceFolder?: string,
    targetFolder?: string
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>
  exportMd: (
    filePath: string,
    outputDir?: string
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>
  /** 导入 XMind：转成本地 `.inkmind` 并返回路径（不覆盖同名文件） */
  importXmind: (
    filePath?: string,
    targetFolder?: string
  ) => Promise<{
    success: boolean
    data?: { filePath: string; warnings: XmindImportWarnings; warningsSummary: string[] }
    error?: string
  }>
  /** 导出 XMind：`content` 是当前导图的 `.inkmind` 文本 */
  exportXmind: (
    title: string,
    content: string
  ) => Promise<{ success: boolean; data?: string; error?: string }>
  /**
   * 插入节点资源（图片或附件）。
   *
   * 文件被写进导图容器的临时解压目录：`src` 是落盘进 `map.json` 的包内路径，
   * `absolutePath` 供渲染层立刻显示，`mime` 决定附件卡片图标。
   */
  addMindMapAsset: (
    documentPath: string,
    kind: 'image' | 'file',
    sourcePath?: string
  ) => Promise<{
    success: boolean
    data?: { src: string; absolutePath: string; name: string; size: number; mime: string }
    error?: string
  }>
  /** 用系统默认程序打开容器内的附件 */
  openMindMapAsset: (
    absolutePath: string
  ) => Promise<{ success: boolean; error?: string }>
  /** 把容器内的附件另存到用户选的位置 */
  saveMindMapAssetAs: (
    absolutePath: string,
    suggestedName?: string
  ) => Promise<{ success: boolean; data?: string; error?: string }>
  addImage: (
    filename: string,
    mimeType: string,
    data: ArrayBuffer,
    options?: ImageCompressOptions,
    filePath?: string
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>
  getImage: (
    imagePath: string,
    filePath?: string
  ) => Promise<{
    success: boolean
    data?: { buffer: Uint8Array | number[] | { type: string; data: number[] }; mimeType: string }
    error?: string
  }>
  removeAsset: (assetId: string, filePath?: string) => Promise<{ success: boolean; error?: string }>
  listAssets: (filePath?: string) => Promise<{
    success: boolean
    data?: { images: ImageAssetInfo[]; attachments: MdxAttachmentAsset[]; all: unknown[] }
    error?: string
  }>
  addAttachment: (
    filename: string,
    mimeType: string,
    data: ArrayBuffer,
    filePath?: string
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>
  getAttachment: (
    attachmentPath: string,
    filePath?: string
  ) => Promise<{
    success: boolean
    data?: { buffer: Uint8Array | number[] | { type: string; data: number[] }; mimeType: string }
    error?: string
  }>
  restoreRecoveryAssets: (
    filePath: string,
    document: unknown,
    assetData: Record<string, string>
  ) => Promise<{ success: boolean; error?: string }>

  // PDF 导出
  readPdfSource: (
    filePath: string
  ) => Promise<{ success: boolean; data?: PdfSource; error?: string }>
  listPdfSources: (
    folderPath: string
  ) => Promise<{ success: boolean; data?: PdfSourceEntry[]; error?: string }>
  printPdf: (
    suggestedFileName: string,
    outputDir?: string,
    relativeSubdir?: string
  ) => Promise<{ success: boolean; data?: PdfPrintResult; error?: string }>

  // 文件夹操作
  readFolder: (
    dirPath: string
  ) => Promise<{ success: boolean; data?: FolderItem[]; error?: string }>
  searchFiles: (
    dirPath: string,
    limit?: number
  ) => Promise<{ success: boolean; data?: Array<{ name: string; path: string }>; error?: string }>
  createFile: (
    dirPath: string,
    name: string
  ) => Promise<{ success: boolean; data?: { path: string }; error?: string }>
  createFolder: (
    parentPath: string,
    name: string
  ) => Promise<{ success: boolean; data?: { path: string }; error?: string }>
  renameFile: (
    oldPath: string,
    newName: string
  ) => Promise<{ success: boolean; data?: { path: string }; error?: string }>
  moveFile: (
    sourcePath: string,
    targetDir: string
  ) => Promise<{ success: boolean; data?: { path: string }; error?: string }>
  deleteFile: (targetPath: string) => Promise<{ success: boolean; error?: string }>
  importFilesIntoFolder: (
    targetDir: string,
    sourcePaths?: string[],
    conflictAction?: 'skip' | 'overwrite' | 'keep'
  ) => Promise<{ success: boolean; data?: FolderImportResult; error?: string }>
  importDirectoryIntoFolder: (
    targetDir: string,
    sourcePath?: string,
    conflictAction?: 'skip' | 'overwrite' | 'keep'
  ) => Promise<{ success: boolean; data?: FolderImportResult; error?: string }>
  readClipboardFilePaths: () => Promise<{ success: boolean; data?: string[]; error?: string }>
  writeClipboardFilePaths: (
    paths: string[],
    mode: 'copy' | 'cut'
  ) => Promise<{ success: boolean; error?: string }>
  copyIntoFolder: (
    sources: string[],
    targetDir: string,
    mode: 'copy' | 'cut',
    conflictAction?: 'skip' | 'overwrite' | 'keep'
  ) => Promise<{
    success: boolean
    data?: {
      items: Array<{ source: string; target: string }>
      failed: Array<{ source: string; error: string }>
      needsResolution?: boolean
      sources?: string[]
      conflicts?: string[]
    }
    error?: string
  }>

  // 应用信息
  ping: () => Promise<string>
  getVersion: () => Promise<string>
  getPlatform: () => Promise<string>
  getUserGuidePath: () => Promise<{ success: boolean; data?: string; error?: string }>

  // 对话框
  showOpenDialog: (
    options?: unknown
  ) => Promise<{ success: boolean; data?: string[]; error?: string }>
  showSaveDialog: (
    options?: unknown
  ) => Promise<{ success: boolean; data?: string; error?: string }>
  showMessageBox: (
    options?: unknown
  ) => Promise<{ success: boolean; data?: number; error?: string }>

  // 事件监听
  onConfirmClose: (callback: () => void) => () => void
  closeConfirmed: () => void

  // 崩溃恢复
  recoveryStatus: () => Promise<{ success: boolean; data?: { available: boolean }; error?: string }>
  readRecovery: () => Promise<{ success: boolean; data?: unknown; error?: string }>
  writeRecovery: (snapshot: unknown) => Promise<{ success: boolean; error?: string }>
  clearRecovery: () => Promise<{ success: boolean; error?: string }>
  getOpenTargets: () => Promise<LaunchTarget[]>
  onOpenTargets: (callback: (targets: LaunchTarget[]) => void) => () => void
  /**
   * 主进程转发的快捷键（保存 / 另存为）。
   *
   * 图表画布在跨域 iframe 里，页面收不到那里的 keydown，所以保存快捷键
   * 由主进程统一拦截后转过来；返回值是取消订阅函数。
   */
  onAppShortcut: (callback: (shortcut: 'save' | 'save-as' | 'close-tab') => void) => () => void

  // 文件系统
  revealInExplorer: (filePath: string) => Promise<{ success: boolean; error?: string }>

  // 窗口控制
  windowMinimize: () => Promise<void>
  windowMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  onWindowMaximized: (callback: () => void) => () => void
  onWindowUnmaximized: (callback: () => void) => () => void

  // 同步
  syncAttachFolder: (
    workspacePath: string
  ) => Promise<{ success: boolean; data?: SyncStatusView; error?: string }>
  syncDetachFolder: () => Promise<{ success: boolean; error?: string }>
  getSyncStatus: () => Promise<{ success: boolean; data?: SyncStatusView; error?: string }>
  syncPull: () => Promise<{ success: boolean; data?: SyncResult; error?: string }>
  syncPush: () => Promise<{ success: boolean; data?: SyncResult; error?: string }>
  syncContinueRebase: () => Promise<{ success: boolean; data?: SyncResult; error?: string }>
  syncAbortRebase: () => Promise<{ success: boolean; data?: SyncResult; error?: string }>
  syncResolveConflicts: (
    choices: ConflictChoice[]
  ) => Promise<{ success: boolean; data?: SyncResult; error?: string }>
  enableSync: (
    workspacePath: string,
    options: EnableSyncOptions
  ) => Promise<{ success: boolean; data?: SyncResult; error?: string }>
  disableSync: () => Promise<{ success: boolean; error?: string }>
  getSyncConfig: () => Promise<{ success: boolean; data?: SyncConfig | null; error?: string }>
  setSyncConfig: (
    patch: Partial<Omit<SyncConfig, 'version' | 'provider'>>
  ) => Promise<{ success: boolean; data?: SyncConfig; error?: string }>
  onSyncEvent: (callback: (view: SyncStatusView) => void) => () => void
  onSyncFileChanged: (callback: (files: string[]) => void) => () => void

  // 外部变更监视
  watchExternalChanges: (
    root: string | null,
    extraFiles: string[]
  ) => Promise<{ success: boolean; error?: string }>
  onExternalFileChanged: (callback: (files: string[]) => void) => () => void

  // 链接操作
  openLink: (
    linkHref: string,
    currentFilePath?: string,
    openedFolderPath?: string
  ) => Promise<{ success: boolean; data?: string; error?: string }>

  // 知识图谱
  buildGraph: (
    root: string
  ) => Promise<{ success: boolean; data?: GraphPayload; error?: string }>
  onGraphProgress: (callback: (progress: GraphProgressEvent) => void) => () => void
  refreshGraphFile: (
    root: string,
    relativePath: string
  ) => Promise<{ success: boolean; data?: FileLinkRecord; error?: string }>
  createGraphLink: (input: GraphCreateLinkInput) => Promise<{
    success: boolean
    data?: { line: number; skipped: boolean }
    error?: string
  }>

  // 自动更新
  checkForUpdates: () => Promise<{ success: boolean; error?: string }>
  openReleasesPage: () => Promise<{ success: boolean; error?: string }>
  onUpdateAvailable: (callback: (info: UpdateInfoPayload) => void) => () => void
  onUpdateNotAvailable: (callback: (info: UpdateInfoPayload) => void) => () => void
  onUpdateError: (callback: (error: { message: string }) => void) => () => void

  // AI 助手
  getAiConfig: () => Promise<{ success: boolean; data?: AiConfigView; error?: string }>
  setAiConfig: (
    config: AiConfigInput
  ) => Promise<{ success: boolean; data?: AiConfigView; error?: string }>
  testAiConfig: (
    config: AiConfigInput
  ) => Promise<{ success: boolean; data?: AiConnectionTestResult; error?: string }>
  startAiRun: (
    input: AiRunInput
  ) => Promise<{ success: boolean; data?: { runId: string }; error?: string }>
  cancelAiRun: (runId: string) => Promise<{ success: boolean; error?: string }>
  claimAiApproval: (approvalId: string) => Promise<{ success: boolean; error?: string }>
  resolveAiApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    executionResult?: ToolExecutionResult
  ) => Promise<{ success: boolean; error?: string }>
  onAiRunEvent: (callback: (event: AiRunEvent) => void) => () => void
  listAiConversations: (
    root: string | null
  ) => Promise<{ success: boolean; data?: ConversationMeta[]; error?: string }>
  loadAiConversation: (
    root: string | null,
    id: string
  ) => Promise<{ success: boolean; data?: ConversationRecord; error?: string }>
  saveAiConversation: (
    root: string | null,
    record: ConversationRecord
  ) => Promise<{ success: boolean; error?: string }>
  deleteAiConversation: (
    root: string | null,
    id: string
  ) => Promise<{ success: boolean; error?: string }>
  summarizeAiConversation: (
    text: string
  ) => Promise<{ success: boolean; data?: { title: string }; error?: string }>
  authorizeWorkspaceRoot: (root: string | null) => Promise<{ success: boolean; error?: string }>
}

// 通过 contextBridge 暴露安全的 API
const api: ElectronAPI = {
  // 文件操作
  newFile: () => ipcRenderer.invoke(IPC_CHANNELS.FILE.NEW),
  openFile: (filePath?, addToRecent?) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.OPEN, filePath, addToRecent),
  saveFile: (content?, title?, filePath?, addToRecent?) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.SAVE, content, title, filePath, addToRecent),
  saveAsFile: (content?, title?, filePath?, addToRecent?, format?) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.SAVE_AS, content, title, filePath, addToRecent, format),
  closeFile: (filePath?) => ipcRenderer.invoke(IPC_CHANNELS.FILE.CLOSE, filePath),
  exportMindMapImage: (title, format, data) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.EXPORT_IMAGE, title, format, data),
  getDiagramSupport: () => ipcRenderer.invoke(IPC_CHANNELS.DIAGRAM.INFO),
  getRecentFiles: () => ipcRenderer.invoke(IPC_CHANNELS.FILE.RECENT),
  addRecentFile: (filePath, type) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.RECENT_ADD, filePath, type),
  removeRecentFile: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.FILE.RECENT_REMOVE, filePath),
  clearRecentFiles: () => ipcRenderer.invoke(IPC_CHANNELS.FILE.RECENT_CLEAR),

  // 剪贴板
  clipboardReadText: async () => clipboard.readText(),
  clipboardWriteText: async (text) => clipboard.writeText(text),
  clipboardWriteTable: async (data) => clipboard.write(data),

  // 拖放文件路径
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // MDX 操作
  readMdx: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.MDX.READ, filePath),
  writeMdx: (filePath, data) => ipcRenderer.invoke(IPC_CHANNELS.MDX.WRITE, filePath, data),
  importMd: (filePath?, targetPath?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MDX.IMPORT_MD, filePath, targetPath),
  importDocx: (docxFilePath?, targetPath?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MDX.IMPORT_DOCX, docxFilePath, targetPath),
  importFolder: (sourceFolder?, targetFolder?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MDX.IMPORT_FOLDER, sourceFolder, targetFolder),
  exportMd: (filePath, outputDir?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MDX.EXPORT_MD, filePath, outputDir),
  importXmind: (filePath?, targetFolder?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MINDMAP.IMPORT_XMIND, filePath, targetFolder),
  exportXmind: (title, content) =>
    ipcRenderer.invoke(IPC_CHANNELS.MINDMAP.EXPORT_XMIND, title, content),
  addMindMapAsset: (documentPath, kind, sourcePath?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MINDMAP.ADD_ASSET, documentPath, kind, sourcePath),
  openMindMapAsset: (absolutePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.MINDMAP.OPEN_ASSET, absolutePath),
  saveMindMapAssetAs: (absolutePath, suggestedName?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MINDMAP.SAVE_ASSET_AS, absolutePath, suggestedName),
  addImage: (filename, mimeType, data, options?, filePath?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MDX.ADD_IMAGE, filename, mimeType, data, options, filePath),
  getImage: (imagePath, filePath?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MDX.GET_IMAGE, imagePath, filePath),
  removeAsset: (assetId, filePath?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MDX.REMOVE_ASSET, assetId, filePath),
  listAssets: (filePath?) => ipcRenderer.invoke(IPC_CHANNELS.MDX.LIST_ASSETS, filePath),
  addAttachment: (filename, mimeType, data, filePath?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MDX.ADD_ATTACHMENT, filename, mimeType, data, filePath),
  getAttachment: (attachmentPath, filePath?) =>
    ipcRenderer.invoke(IPC_CHANNELS.MDX.GET_ATTACHMENT, attachmentPath, filePath),
  restoreRecoveryAssets: (filePath, document, assetData) =>
    ipcRenderer.invoke(IPC_CHANNELS.MDX.RESTORE_RECOVERY_ASSETS, filePath, document, assetData),

  // PDF 导出
  readPdfSource: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.PDF.READ_SOURCE, filePath),
  listPdfSources: (folderPath) => ipcRenderer.invoke(IPC_CHANNELS.PDF.LIST_FOLDER, folderPath),
  printPdf: (suggestedFileName, outputDir?, relativeSubdir?) =>
    ipcRenderer.invoke(IPC_CHANNELS.PDF.PRINT, suggestedFileName, outputDir, relativeSubdir),

  // 文件夹操作
  readFolder: (dirPath) => ipcRenderer.invoke(IPC_CHANNELS.FOLDER.READ, dirPath),
  searchFiles: (dirPath, limit?) => ipcRenderer.invoke(IPC_CHANNELS.FILE.SEARCH, dirPath, limit),
  createFile: (dirPath, name) => ipcRenderer.invoke(IPC_CHANNELS.FILE.CREATE, { dirPath, name }),
  createFolder: (parentPath, name) =>
    ipcRenderer.invoke(IPC_CHANNELS.FOLDER.CREATE, { parentPath, name }),
  renameFile: (oldPath, newName) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.RENAME, { oldPath, newName }),
  moveFile: (sourcePath, targetDir) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.MOVE, { sourcePath, targetDir }),
  deleteFile: (targetPath) => ipcRenderer.invoke(IPC_CHANNELS.FILE.DELETE, { targetPath }),
  importFilesIntoFolder: (targetDir, sourcePaths, conflictAction) =>
    ipcRenderer.invoke(IPC_CHANNELS.FOLDER.IMPORT_FILES, targetDir, sourcePaths, conflictAction),
  importDirectoryIntoFolder: (targetDir, sourcePath, conflictAction) =>
    ipcRenderer.invoke(IPC_CHANNELS.FOLDER.IMPORT_DIRECTORY, targetDir, sourcePath, conflictAction),
  readClipboardFilePaths: () => ipcRenderer.invoke(IPC_CHANNELS.FILE.CLIPBOARD_READ_FILES),
  writeClipboardFilePaths: (paths, mode) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.CLIPBOARD_WRITE_FILES, { paths, mode }),
  copyIntoFolder: (sources, targetDir, mode, conflictAction) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.COPY_INTO, { sources, targetDir, mode, conflictAction }),

  // 应用信息
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.APP.PING),
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP.GET_VERSION),
  getPlatform: () => ipcRenderer.invoke(IPC_CHANNELS.APP.GET_PLATFORM),
  getUserGuidePath: () => ipcRenderer.invoke(IPC_CHANNELS.APP.GET_USER_GUIDE_PATH),

  // 对话框
  showOpenDialog: (options) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG.SHOW_OPEN, options),
  showSaveDialog: (options) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG.SHOW_SAVE, options),
  showMessageBox: (options) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG.SHOW_MESSAGE, options),

  // 事件监听
  onConfirmClose: (callback) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.APP.CONFIRM_CLOSE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP.CONFIRM_CLOSE, handler)
  },
  closeConfirmed: () => ipcRenderer.invoke(IPC_CHANNELS.APP.CLOSE_CONFIRMED),
  recoveryStatus: () => ipcRenderer.invoke(IPC_CHANNELS.APP.RECOVERY_STATUS),
  readRecovery: () => ipcRenderer.invoke(IPC_CHANNELS.APP.RECOVERY_READ),
  writeRecovery: (snapshot) => ipcRenderer.invoke(IPC_CHANNELS.APP.RECOVERY_WRITE, snapshot),
  clearRecovery: () => ipcRenderer.invoke(IPC_CHANNELS.APP.RECOVERY_CLEAR),
  getOpenTargets: () => ipcRenderer.invoke(IPC_CHANNELS.APP.OPEN_TARGETS),
  onOpenTargets: (callback) => {
    const handler = (_event: unknown, targets: LaunchTarget[]): void => callback(targets)
    ipcRenderer.on(IPC_CHANNELS.APP.OPEN_TARGETS, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP.OPEN_TARGETS, handler)
  },
  onAppShortcut: (callback) => {
    const handler = (_event: unknown, shortcut: 'save' | 'save-as'): void => callback(shortcut)
    ipcRenderer.on(IPC_CHANNELS.APP.SHORTCUT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP.SHORTCUT, handler)
  },

  // 文件系统
  revealInExplorer: (filePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.REVEAL_IN_EXPLORER, filePath),

  // 窗口控制
  windowMinimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.MINIMIZE),
  windowMaximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.MAXIMIZE),
  windowClose: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.CLOSE),
  windowIsMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.IS_MAXIMIZED),
  onWindowMaximized: (callback) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.WINDOW.MAXIMIZED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW.MAXIMIZED, handler)
  },
  onWindowUnmaximized: (callback) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.WINDOW.UNMAXIMIZED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW.UNMAXIMIZED, handler)
  },

  // 同步
  syncAttachFolder: (workspacePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYNC.ATTACH_FOLDER, workspacePath),
  syncDetachFolder: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC.DETACH_FOLDER),
  getSyncStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC.STATUS),
  syncPull: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC.PULL),
  syncPush: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC.PUSH),
  syncContinueRebase: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC.CONTINUE_REBASE),
  syncAbortRebase: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC.ABORT_REBASE),
  syncResolveConflicts: (choices) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYNC.RESOLVE_CONFLICTS, choices),
  enableSync: (workspacePath, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYNC.ENABLE, workspacePath, options),
  disableSync: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC.DISABLE),
  getSyncConfig: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC.CONFIG.GET),
  setSyncConfig: (patch) => ipcRenderer.invoke(IPC_CHANNELS.SYNC.CONFIG.SET, patch),
  onSyncEvent: (callback) => {
    const handler = (_event: unknown, view: SyncStatusView): void => callback(view)
    ipcRenderer.on(IPC_CHANNELS.SYNC.EVENT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SYNC.EVENT, handler)
  },
  onSyncFileChanged: (callback) => {
    const handler = (_event: unknown, files: string[]): void => callback(files)
    ipcRenderer.on(IPC_CHANNELS.SYNC.FILE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SYNC.FILE_CHANGED, handler)
  },

  // 外部变更监视
  watchExternalChanges: (root, extraFiles) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXTERNAL_WATCH.START, root, extraFiles),
  onExternalFileChanged: (callback) => {
    const handler = (_event: unknown, files: string[]): void => callback(files)
    ipcRenderer.on(IPC_CHANNELS.EXTERNAL_WATCH.CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.EXTERNAL_WATCH.CHANGED, handler)
  },

  // 链接操作
  openLink: (linkHref, currentFilePath?, openedFolderPath?) =>
    ipcRenderer.invoke(IPC_CHANNELS.LINK.OPEN, { linkHref, currentFilePath, openedFolderPath }),

  // 知识图谱
  buildGraph: (root) => ipcRenderer.invoke(IPC_CHANNELS.GRAPH.BUILD, root),
  onGraphProgress: (callback) => {
    const handler = (_event: unknown, progress: GraphProgressEvent): void => callback(progress)
    ipcRenderer.on(IPC_CHANNELS.GRAPH.PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.GRAPH.PROGRESS, handler)
  },
  refreshGraphFile: (root, relativePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.GRAPH.REFRESH_FILE, root, relativePath),
  createGraphLink: (input) => ipcRenderer.invoke(IPC_CHANNELS.GRAPH.CREATE_LINK, input),

  // 自动更新
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE.CHECK),
  openReleasesPage: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE.OPEN_RELEASES),
  onUpdateAvailable: (callback) => {
    const handler = (_event: unknown, info: UpdateInfoPayload): void => callback(info)
    ipcRenderer.on(IPC_CHANNELS.UPDATE.AVAILABLE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE.AVAILABLE, handler)
  },
  onUpdateNotAvailable: (callback) => {
    const handler = (_event: unknown, info: UpdateInfoPayload): void => callback(info)
    ipcRenderer.on(IPC_CHANNELS.UPDATE.NOT_AVAILABLE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE.NOT_AVAILABLE, handler)
  },
  onUpdateError: (callback) => {
    const handler = (_event: unknown, error: { message: string }): void => callback(error)
    ipcRenderer.on(IPC_CHANNELS.UPDATE.ERROR, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE.ERROR, handler)
  },

  // AI 助手
  getAiConfig: () => ipcRenderer.invoke(IPC_CHANNELS.AI.CONFIG.GET),
  setAiConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.AI.CONFIG.SET, config),
  testAiConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.AI.CONFIG.TEST, config),
  startAiRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.AI.RUN.START, input),
  cancelAiRun: (runId) => ipcRenderer.invoke(IPC_CHANNELS.AI.RUN.CANCEL, runId),
  claimAiApproval: (approvalId) => ipcRenderer.invoke(IPC_CHANNELS.AI.APPROVAL.CLAIM, approvalId),
  resolveAiApproval: (approvalId, decision, executionResult) =>
    ipcRenderer.invoke(IPC_CHANNELS.AI.APPROVAL.RESOLVE, approvalId, decision, executionResult),
  listAiConversations: (root) => ipcRenderer.invoke(IPC_CHANNELS.AI.CONVERSATION.LIST, root),
  loadAiConversation: (root, id) => ipcRenderer.invoke(IPC_CHANNELS.AI.CONVERSATION.LOAD, root, id),
  saveAiConversation: (root, record) =>
    ipcRenderer.invoke(IPC_CHANNELS.AI.CONVERSATION.SAVE, root, record),
  deleteAiConversation: (root, id) =>
    ipcRenderer.invoke(IPC_CHANNELS.AI.CONVERSATION.DELETE, root, id),
  summarizeAiConversation: (text) =>
    ipcRenderer.invoke(IPC_CHANNELS.AI.CONVERSATION.SUMMARIZE, text),
  authorizeWorkspaceRoot: (root) => ipcRenderer.invoke(IPC_CHANNELS.AI.WORKSPACE.AUTHORIZE, root),
  onAiRunEvent: (callback) => {
    const handler = (_event: unknown, payload: AiRunEvent): void => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.AI.EVENT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AI.EVENT, handler)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)

// 类型声明扩展
declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
