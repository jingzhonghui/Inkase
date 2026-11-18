import { describe, expect, it } from 'vitest'
import { evaluateToolPolicy } from '../policy-engine'
import type { ToolPolicy } from '../../../shared/ai/types'

const writePolicy: ToolPolicy = {
  effect: 'write',
  approval: 'always',
  riskLevel: 'high',
  supportsRememberDecision: false
}

const readPolicy: ToolPolicy = {
  effect: 'read',
  approval: 'never',
  riskLevel: 'low',
  supportsRememberDecision: false
}

describe('evaluateToolPolicy', () => {
  it('requires approval for always-approval tools in ask mode', () => {
    expect(evaluateToolPolicy(writePolicy, 'ask')).toBe(true)
    expect(evaluateToolPolicy(writePolicy)).toBe(true)
  })

  it('never requires approval for read-only tools', () => {
    expect(evaluateToolPolicy(readPolicy, 'ask')).toBe(false)
  })

  /*
   * 完全控制模式下不再逐次询问：渲染进程类操作仍会走「请求 → 执行 → 回传」，
   * 只是带 auto 标记由前端自动放行，所以这里对写/危险操作也应返回 false。
   */
  it('skips approval entirely in auto mode', () => {
    expect(evaluateToolPolicy(writePolicy, 'auto')).toBe(false)
    expect(
      evaluateToolPolicy({ ...writePolicy, effect: 'dangerous', riskLevel: 'critical' }, 'auto')
    ).toBe(false)
  })
})
