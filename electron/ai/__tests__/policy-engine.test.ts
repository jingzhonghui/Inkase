import { describe, expect, it } from 'vitest'
import type { ToolPolicy } from '../../../shared/ai/types'
import { evaluateToolPolicy, resolveToolApprovalTier } from '../policy-engine'

function policy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    effect: 'read',
    approval: 'never',
    riskLevel: 'low',
    supportsRememberDecision: false,
    ...overrides
  }
}

describe('resolveToolApprovalTier', () => {
  it('auto-runs explicit never tools', () => {
    expect(resolveToolApprovalTier(policy())).toBe('auto')
    expect(evaluateToolPolicy(policy())).toBe(false)
  })

  it('asks for explicit always tools, including writes', () => {
    expect(resolveToolApprovalTier(policy({ effect: 'write', approval: 'always', riskLevel: 'high' }))).toBe('confirm')
    expect(evaluateToolPolicy(policy({ effect: 'write', approval: 'always' }))).toBe(true)
  })

  it('marks batch tools for the checklist preview', () => {
    expect(resolveToolApprovalTier(policy({ effect: 'write', approval: 'batch' }))).toBe('batch')
    expect(evaluateToolPolicy(policy({ effect: 'write', approval: 'batch' }))).toBe(true)
  })

  it('never auto-runs dangerous or critical tools even when declared never', () => {
    expect(resolveToolApprovalTier(policy({ effect: 'dangerous', approval: 'never' }))).toBe('confirm')
    expect(resolveToolApprovalTier(policy({ effect: 'external-action', approval: 'never' }))).toBe('confirm')
    expect(resolveToolApprovalTier(policy({ effect: 'write', approval: 'never', riskLevel: 'critical' }))).toBe('confirm')
    // 批量写即便风险最高，也应走清单预览，而不是退化成逐次确认
    expect(resolveToolApprovalTier(policy({ effect: 'write', approval: 'batch', riskLevel: 'critical' }))).toBe('batch')
  })

  it('derives policy-mode reads from effect and risk', () => {
    expect(resolveToolApprovalTier(policy({ approval: 'policy', effect: 'read', riskLevel: 'medium' }))).toBe('auto')
    expect(resolveToolApprovalTier(policy({ approval: 'policy', effect: 'read', riskLevel: 'critical' }))).toBe('confirm')
    expect(resolveToolApprovalTier(policy({ approval: 'policy', effect: 'network', riskLevel: 'low' }))).toBe('auto')
    expect(resolveToolApprovalTier(policy({ approval: 'policy', effect: 'network', riskLevel: 'high' }))).toBe('confirm')
    expect(resolveToolApprovalTier(policy({ approval: 'policy', effect: 'write', riskLevel: 'low' }))).toBe('confirm')
  })
})
