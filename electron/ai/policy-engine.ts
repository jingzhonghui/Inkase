import { DEFAULT_AI_PERMISSION_MODE } from '../../shared/ai/permission'
import type { AiPermissionMode, ToolPolicy } from '../../shared/ai/types'

/** 一次工具调用在放行前的处置方式。 */
export type ToolPolicyDecision = 'allow' | 'ask' | 'deny'

/**
 * 判断一个工具在当前权限模式下该如何处理。
 *
 * - `allow`：直接执行（读类工具；以及完全控制下的所有工具）
 * - `ask`：先请求用户批准
 * - `deny`：直接拒绝，连批准的机会都不给（只读模式下的修改类工具）
 *
 * 只读挡的是「会改东西」的 effect（`write` / `dangerous`）。网络读取
 * （`read_web_url`）与本地文件读取（`read_local_file`）本身不改磁盘，
 * 仍按各自的策略走审批——只读不等于不许看外部资料。
 */
export function evaluateToolPolicy(
  policy: ToolPolicy,
  mode: AiPermissionMode = DEFAULT_AI_PERMISSION_MODE
): ToolPolicyDecision {
  if (mode === 'auto') return 'allow'
  if (mode === 'readonly' && (policy.effect === 'write' || policy.effect === 'dangerous')) {
    return 'deny'
  }
  return policy.approval === 'never' ? 'allow' : 'ask'
}
