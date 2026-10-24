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
}

export interface AiConfigView extends Omit<AiConfigInput, 'apiKey'> {
  hasApiKey: boolean
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

export type LocalFileType = 'pdf' | 'markdown' | 'mdx' | 'text'

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

export type ApprovalTier = 'auto' | 'confirm' | 'batch'

export interface ToolPolicy {
  effect: 'read' | 'network' | 'write' | 'external-action' | 'dangerous'
  approval: 'never' | 'always' | 'policy' | 'batch'
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  supportsRememberDecision: boolean
}

export interface AiDocumentSnapshot {
  id: string
  title: string
  path: string | null
  format: 'markdown' | 'mdx'
  content: string
  revision: number
  contentHash: string
  modified: boolean
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
      format: 'markdown' | 'mdx'
      reason: string
    }

export interface BatchApprovalFile {
  /** 工作区相对路径；批量操作不跨库 */
  path: string
  /** 该文件的变更摘要，例如「替换 3 处链接」 */
  summary: string
  additions?: number
  deletions?: number
  /** 可展开的 unified diff；大文件可以省略，仅保留摘要 */
  diff?: string
}

export type ApprovalPreview =
  | { type: 'markdown-diff'; title: string; before: string; after: string }
  | { type: 'document'; title: string; content: string }
  | {
      type: 'batch'
      title: string
      description?: string
      files: BatchApprovalFile[]
      totalChanges?: number
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
  | { status: 'approved'; scope: 'session'; toolName: string }
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
  /** 审批档位；旧请求缺省时按逐次处理 */
  approvalTier?: ApprovalTier
  /** 是否允许「本次会话自动批准此类」 */
  supportsRememberDecision?: boolean
  preview: ApprovalPreview
  execution: { location: 'main' } | { location: 'renderer'; operation: ApprovedDocumentOperation }
  createdAt: number
  expiresAt: number
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
  /** 审批档位；旧会话缺省时按逐次处理 */
  approvalTier?: ApprovalTier
  /** 是否允许「本次会话自动批准此类」 */
  supportsRememberDecision?: boolean
  preview: ApprovalPreview
  createdAt: number
  /** 未判定时缺省，表示仍在等待用户操作 */
  decision?: ApprovalDecision
  decidedAt?: number
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
