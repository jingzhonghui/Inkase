import type { AiApprovalMode, ToolPolicy } from '../../shared/ai/types'

/**
 * 这个工具是否需要用户逐次批准。
 *
 * 「完全控制」（auto）模式下一律不需要：这是用户显式选择的模式，
 * 不是工具策略的默认。危险操作的痕迹仍会通过审批记录留在会话里。
 */
export function evaluateToolPolicy(
  policy: ToolPolicy,
  mode: AiApprovalMode = 'ask'
): boolean {
  if (mode === 'auto') return false
  return policy.approval !== 'never'
}
