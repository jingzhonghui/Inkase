export interface ApiResult<T = void> {
  success: boolean
  data?: T
  error?: string
}

export interface AiConfigInput {
  baseUrl: string
  model: string
  apiKey?: string
  temperature: number
  maxOutputTokens?: number
  contextWindow?: number
  maxSteps?: number
  /** 单次 read_workspace_file 返回的正文字节上限，默认 256 KiB */
  maxReadBytes?: number
  /**
   * 单次运行的空闲超时（毫秒）。
   *
   * 只在「模型没有输出、也没有工具在执行」时计时：工具执行与审批等待不计入，
   * 否则用户看一份 diff 的时间就能把整轮运行拖超时。
   */
  idleTimeoutMs?: number
  /** 审批模式，缺省为 ask（逐次请求批准） */
  approvalMode?: AiApprovalMode
}

export interface AiConfigView extends Omit<AiConfigInput, 'apiKey'> {
  hasApiKey: boolean
  /** 地址、模型与 API Key 齐备即为 true；能力探测只作为额外信息，不是前置条件 */
  ready: boolean
  capabilities?: AiConnectionTestResult
}

export interface AiRuntimeConfig extends AiConfigInput {
  apiKey: string
}

export type AiErrorCode =
  | 'CONFIG_MISSING'
  | 'AUTH_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'TOOLS_NOT_SUPPORTED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'REQUEST_TIMEOUT'
  | 'STREAM_INVALID'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_INPUT_INVALID'
  | 'TOOL_LIMIT_REACHED'
  | 'APPROVAL_EXPIRED'
  | 'DOCUMENT_CONFLICT'
  | 'SOURCE_NOT_AUTHORIZED'
  | 'SOURCE_AMBIGUOUS'
  | 'SOURCE_INVALID'
  | 'SOURCE_TOO_LARGE'
  | 'SOURCE_POLICY_BLOCKED'
  | 'RUN_CANCELLED'

export interface AiError {
  code: AiErrorCode
  message: string
}

export interface AiConnectionTestResult {
  textGeneration: boolean
  toolCalling: boolean
}

export interface AiConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCallId?: string
  toolName?: string
  createdAt?: number
}

export interface SourceChunk {
  index: number
  content: string
  startOffset: number
  endOffset: number
}

export interface WebSourceReadResult {
  url: string
  finalUrl: string
  title: string
  content: string
  contentType: string
  chunks: SourceChunk[]
  truncated: boolean
}

export type LocalFileType = 'pdf' | 'markdown' | 'mdx' | 'mindmap' | 'text'

export interface LocalFileInspection {
  requestedPath: string
  normalizedPath: string
  fileType: LocalFileType
  size?: number
}

export interface LocalFileReadResult extends LocalFileInspection {
  content: string
  chunks: SourceChunk[]
  truncated: boolean
}

export interface ToolPolicy {
  effect: 'read' | 'network' | 'write' | 'external-action' | 'dangerous'
  approval: 'never' | 'always' | 'policy'
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  supportsRememberDecision: boolean
}

/**
 * 审批模式。
 *
 * - `ask`：按工具策略逐次请求批准（默认）
 * - `auto`：完全控制——不再逐次询问，写操作与危险操作直接执行
 *
 * auto 下渲染进程类操作仍然会生成一条 `auto: true` 的审批记录：
 * 执行路径不变（认领 → 应用 → 回传结果），只是不需要人点，
 * 会话里也能翻到「AI 自己做了什么」。
 */
export type AiApprovalMode = 'ask' | 'auto'

export interface AiDocumentSnapshot {
  id: string
  title: string
  path: string | null
  /**
   * 文档真实格式。
   *
   * 早先只区分 markdown / mdx / mindmap，图表与图片、PDF 都被兜底成 mdx，
   * 模型会因此把 XML 或二进制当 Markdown 正文看待。这里如实标注，
   * 写工具再按格式判断能不能改。
   */
  format: 'markdown' | 'mdx' | 'mindmap' | 'diagram' | 'image' | 'pdf'
  content: string
  revision: number
  contentHash: string
  modified: boolean
}

/** 工作区文件按扩展名判定的可读格式，决定正文如何提取。 */
export type WorkspaceFileFormat = 'text' | 'markdown' | 'mdx' | 'mindmap' | 'diagram'

/**
 * 一次范围读取的结果。
 *
 * offset / length 都以**可读正文的字节**为基准：普通文本文件等于磁盘字节，
 * `.mdx` / `.inkmind` 这类容器等于解包后正文的字节。模型据此拼接多次读取。
 */
export interface WorkspaceFileSlice {
  /** 工作区内相对路径，统一 `/` 分隔 */
  path: string
  format: WorkspaceFileFormat
  /** 磁盘上原始文件字节数 */
  fileSize: number
  /** 可读正文总字节数 */
  totalSize: number
  /** 本次返回正文的起始字节（已对齐 UTF-8 字符边界） */
  offset: number
  /** 本次返回的字节数 */
  length: number
  content: string
  /** 是否已读到正文末尾 */
  eof: boolean
  /** 是否被单次读取上限截断 */
  truncated: boolean
  /** 继续读取时应传入的 offset；已到末尾为 null */
  nextOffset: number | null
  encoding: 'utf-8'
}

/** 只读元信息：让模型先判断「一次读还是分多次读」。 */
export interface WorkspaceFileStat {
  path: string
  format: WorkspaceFileFormat
  fileSize: number
  totalSize: number
  readable: boolean
  /** readable 为 false 时的原因，例如二进制内容或容器解包失败 */
  reason?: string
  modifiedAt?: number
}

export interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface AiSelectionSnapshot {
  text: string
  from: number
  to: number
  cursor: number
}

export interface AiExecutionSnapshot {
  runId?: string
  conversationId: string
  activeDocument: AiDocumentSnapshot | null
  selection: AiSelectionSnapshot | null
  cursor: number | null
  /** 当前获授权的工作区根目录（由主进程维护），未打开工作区时为 null */
  workspaceRoot: string | null
}

export type ApprovedDocumentOperation =
  | {
      type: 'replace-document'
      target: AiDocumentSnapshot
      content: string
      reason: string
    }
  | {
      type: 'insert-document'
      target: AiDocumentSnapshot
      content: string
      position: 'selection' | 'cursor' | 'start' | 'end'
      selection: AiSelectionSnapshot | null
      cursor: number | null
      reason: string
    }
  | {
      type: 'create-document'
      title: string
      content: string
      format: 'markdown' | 'mdx' | 'mindmap'
      reason: string
    }
  | {
      /**
       * 删除工作区文件。
       *
       * 走渲染进程执行（而不是主进程直接 rm）：删除后文件树、已打开的标签和
       * 图谱索引都要一起更新，那三件事都活在渲染层。
       */
      type: 'delete-workspace-file'
      relativePath: string
      absolutePath: string
      fileSize: number
      reason: string
    }
  | {
      /** 移动/改名工作区条目（文件或目录）。目标目录必须已存在。 */
      type: 'move-workspace-entry'
      fromRelative: string
      fromAbsolute: string
      toRelative: string
      toAbsolute: string
      reason: string
    }
  | {
      /** 新建目录。父目录必须已存在（一次只建一层，模型可连续调用）。 */
      type: 'create-workspace-directory'
      relativePath: string
      absolutePath: string
      reason: string
    }
  | {
      /**
       * 按路径写入文本正文。
       *
       * 只覆盖纯文本类格式（Markdown / 文本）；`.mdx`、`.inkmind` 是容器、
       * `.drawio` 有画布实例，直接写会丢资源或让画布与磁盘打架，一律拒绝。
       */
      type: 'write-workspace-file'
      relativePath: string
      absolutePath: string
      content: string
      format: 'markdown' | 'text'
      /** 目标文件已在编辑器中打开时的冲突基线 */
      target: AiDocumentSnapshot | null
      reason: string
    }

export type ApprovalPreview =
  | { type: 'markdown-diff'; title: string; before: string; after: string }
  | { type: 'document'; title: string; content: string }
  | {
      type: 'file-operation'
      operation: 'move' | 'create-directory'
      title: string
      from?: string
      to: string
      reason?: string
    }
  | {
      type: 'file-delete'
      title: string
      relativePath: string
      fileSize: number
      format: WorkspaceFileFormat
    }
  | {
      type: 'network-request'
      method: string
      url: string
      reason?: string
      bodySummary?: string
    }
  | {
      type: 'local-file-read'
      requestedPath: string
      normalizedPath: string
      fileType: LocalFileType
      size?: number
      reason: string
    }

export type ApprovalDecision =
  | { status: 'approved'; scope: 'once' }
  | { status: 'rejected'; reason?: string }
  | { status: 'cancelled' }
  | { status: 'expired' }

export type ToolExecutionResult<T = unknown> =
  | { status: 'completed' | 'applied'; data?: T }
  | { status: 'rejected' | 'conflict' | 'failed' | 'cancelled'; message: string }

export interface ToolApprovalRequest {
  id: string
  runId: string
  toolCallId: string
  toolName: string
  title: string
  description: string
  reason?: string
  effect: ToolPolicy['effect']
  riskLevel: ToolPolicy['riskLevel']
  preview: ApprovalPreview
  execution: { location: 'main' } | { location: 'renderer'; operation: ApprovedDocumentOperation }
  createdAt: number
  expiresAt: number
  /** 完全控制模式下自动放行，无需用户点击；会话里仍留档 */
  auto?: boolean
}

export interface AiRunInput {
  conversationId: string
  message: string
  history: AiConversationMessage[]
  snapshot: AiExecutionSnapshot
}

export type AiRunEvent =
  | { type: 'run-started'; runId: string }
  | { type: 'text-delta'; runId: string; text: string }
  | { type: 'tool-call-started'; runId: string; toolCallId: string; toolName: string }
  | {
      type: 'tool-call-completed'
      runId: string
      toolCallId: string
      result: ToolExecutionResult
    }
  | { type: 'approval-required'; runId: string; approval: ToolApprovalRequest }
  | { type: 'run-completed'; runId: string }
  | { type: 'run-failed'; runId: string; error: AiError }
  | { type: 'run-cancelled'; runId: string }

export interface ConversationToolSummary {
  toolCallId: string
  toolName: string
  status: string
  messageId?: string
}

/**
 * 会话内的审批记录：一次「请求批准」及其判定结果。
 *
 * 与 ToolApprovalRequest 的区别是不含 execution —— 那是主进程/渲染进程之间
 * 传递待执行操作的载体，落盘时既无用也过大；会话里需要留存的只是
 * 「当时问了什么、预览长什么样、用户怎么答的」。
 */
export interface ConversationApprovalRecord {
  id: string
  runId: string
  toolCallId: string
  toolName: string
  title: string
  description: string
  reason?: string
  effect: ToolPolicy['effect']
  riskLevel: ToolPolicy['riskLevel']
  preview: ApprovalPreview
  createdAt: number
  /** 未判定时缺省，表示仍在等待用户操作 */
  decision?: ApprovalDecision
  decidedAt?: number
  /** 完全控制模式下由程序自动放行 */
  auto?: boolean
  /** 渲染进程执行结果的状态（applied / conflict / failed），仅写入类操作有 */
  outcome?: ToolExecutionResult['status']
  /** 承载该工具调用的助手消息 id，用于在会话流中定位卡片 */
  messageId?: string
}

export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface ConversationRecord extends ConversationMeta {
  version: 1
  messages: AiConversationMessage[]
  toolSummaries: ConversationToolSummary[]
  /** 旧会话文件没有这一项，读取时按空数组兜底 */
  approvals?: ConversationApprovalRecord[]
}

export type SearchTruncationReason =
  | 'timeout'
  | 'result-limit'
  | 'output-limit'
  | 'mdx-byte-limit'

export interface SearchWorkspaceInput {
  query: string
  mode: 'filename' | 'content'
  match?: 'literal' | 'regex'
  /** 工作区内的相对目录，默认 "."；拒绝绝对路径、.. 逃逸与符号链接逃逸 */
  scope?: string
  /** 扩展名白名单（不带点，字母数字），如 ["md","mdx","ts"]，最多 20 项 */
  extensions?: string[]
  caseSensitive?: boolean
  contextLines?: number
  maxResults?: number
}

export interface FilenameSearchMatch {
  type: 'filename'
  path: string
  extension: string
}

export interface ContentSearchMatch {
  type: 'content'
  path: string
  source: 'text' | 'mdx'
  line: number
  column: number
  preview: string
}

export type WorkspaceSearchMatch = FilenameSearchMatch | ContentSearchMatch

export interface SearchWorkspaceResult {
  status: 'completed'
  mode: 'filename' | 'content'
  query: string
  matches: WorkspaceSearchMatch[]
  truncated: boolean
  truncationReason?: SearchTruncationReason
  elapsedMs: number
  warnings?: string[]
}

export interface WorkspaceDirectoryResult {
  path: string
  files: DirectoryEntry[]
  subDirectories: string[]
  totalFiles: number
  isEmpty: boolean
}
