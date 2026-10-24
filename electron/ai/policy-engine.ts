import type { ApprovalTier, ToolPolicy } from '../../shared/ai/types'

/**
 * 审批分级
 *
 * - 自动：读类工具，不打断
 * - 逐次：写当前文档，逐次确认（可记住）
 * - 批量：跨文件批量写，走清单预览一次批准
 *
 * `approval` 是显式声明；`policy` 模式再按 effect / riskLevel 推导。
 * 危险/外部动作与最高风险无论声明如何都必须确认，避免误标 never 后静默执行。
 */
export function resolveToolApprovalTier(policy: ToolPolicy): ApprovalTier {
  // 无论 approval 怎么声明，危险/外部动作与最高风险都必须确认
  if (policy.effect === 'dangerous' || policy.effect === 'external-action') return 'confirm'
  if (policy.riskLevel === 'critical' && policy.approval !== 'batch') return 'confirm'

  switch (policy.approval) {
    case 'never':
      return 'auto'
    case 'batch':
      return 'batch'
    case 'always':
      return 'confirm'
    case 'policy':
      if (policy.effect === 'read') {
        return 'auto'
      }
      if (policy.effect === 'network' && policy.riskLevel === 'low') {
        return 'auto'
      }
      return 'confirm'
  }
}

export function evaluateToolPolicy(policy: ToolPolicy): boolean {
  return resolveToolApprovalTier(policy) !== 'auto'
}
