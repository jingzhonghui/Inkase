import type { ApprovalPreview } from '../../../shared/ai/types'

export type ApprovalPreviewType = ApprovalPreview['type'] | 'unsupported'

/**
 * 校验来自主进程的审批预览。
 *
 * 预览要经过 IPC 与磁盘往返，不能假设它一定是合法形状；结构对不上时返回 null，
 * 由调用方按「不支持的预览」处理并禁用允许按钮（fail closed）。
 */
export function validApprovalPreview(preview: unknown): ApprovalPreview | null {
  if (!preview || typeof preview !== 'object') return null
  const value = preview as Record<string, unknown>
  if (value.type === 'markdown-diff'
    && typeof value.title === 'string'
    && typeof value.before === 'string'
    && typeof value.after === 'string') return preview as ApprovalPreview
  if (value.type === 'document'
    && typeof value.title === 'string'
    && typeof value.content === 'string') return preview as ApprovalPreview
  if (value.type === 'network-request'
    && typeof value.method === 'string'
    && typeof value.url === 'string'
    && typeof value.reason === 'string'
    && (value.bodySummary === undefined || typeof value.bodySummary === 'string')) return preview as ApprovalPreview
  if (value.type === 'local-file-read'
    && typeof value.requestedPath === 'string'
    && typeof value.normalizedPath === 'string'
    && (value.fileType === 'pdf' || value.fileType === 'markdown' || value.fileType === 'mdx' || value.fileType === 'text')
    && (value.size === undefined || (typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0))
    && typeof value.reason === 'string') return preview as ApprovalPreview
  return null
}

export function approvalPreviewType(preview: ApprovalPreview | null): ApprovalPreviewType {
  if (!preview) return 'unsupported'
  switch (preview.type) {
    case 'markdown-diff': return 'markdown-diff'
    case 'document': return 'document'
    case 'network-request': return 'network-request'
    case 'local-file-read': return 'local-file-read'
    default: {
      const exhaustive: never = preview
      void exhaustive
      return 'unsupported'
    }
  }
}
