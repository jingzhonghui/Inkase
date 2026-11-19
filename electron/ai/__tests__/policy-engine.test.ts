import { describe, expect, it } from 'vitest'
import { evaluateToolPolicy } from '../policy-engine'
import type { ToolPolicy } from '../../../shared/ai/types'

const writePolicy: ToolPolicy = {
  effect: 'write',
  approval: 'always',
  riskLevel: 'high',
  supportsRememberDecision: false
}

const dangerousPolicy: ToolPolicy = {
  effect: 'dangerous',
  approval: 'always',
  riskLevel: 'critical',
  supportsRememberDecision: false
}

const readPolicy: ToolPolicy = {
  effect: 'read',
  approval: 'never',
  riskLevel: 'low',
  supportsRememberDecision: false
}

/** 网页读取：不放行不拒绝，仍按自己的策略走审批。 */
const networkPolicy: ToolPolicy = {
  effect: 'network',
  approval: 'always',
  riskLevel: 'medium',
  supportsRememberDecision: false
}

describe('evaluateToolPolicy', () => {
  it('标准模式：读类直接放行，写类逐次请求批准', () => {
    expect(evaluateToolPolicy(readPolicy, 'standard')).toBe('allow')
    expect(evaluateToolPolicy(writePolicy, 'standard')).toBe('ask')
    expect(evaluateToolPolicy(dangerousPolicy, 'standard')).toBe('ask')
  })

  it('缺省模式是标准，不是旧的 ask 语义缺口', () => {
    expect(evaluateToolPolicy(writePolicy)).toBe('ask')
    expect(evaluateToolPolicy(readPolicy)).toBe('allow')
  })

  /*
   * 只读模式挡的是「会改东西」的 effect：write / dangerous 在进审批通道之前就被拒绝。
   * 不能退化成「先弹窗再允许」——权限模式的边界不该由一次点击突破。
   */
  it('只读模式：拒绝修改与危险操作，读类照常放行', () => {
    expect(evaluateToolPolicy(writePolicy, 'readonly')).toBe('deny')
    expect(evaluateToolPolicy(dangerousPolicy, 'readonly')).toBe('deny')
    expect(evaluateToolPolicy(readPolicy, 'readonly')).toBe('allow')
  })

  it('只读模式不拦截网络读取：只读不等于不许看外部资料', () => {
    expect(evaluateToolPolicy(networkPolicy, 'readonly')).toBe('ask')
  })

  /*
   * 完全控制：渲染进程类操作仍会走「请求 → 执行 → 回传」，只是带 auto 标记
   * 由前端自动放行，所以这里对写/危险操作也应返回 allow。
   */
  it('完全控制：一律放行，不再询问', () => {
    expect(evaluateToolPolicy(writePolicy, 'auto')).toBe('allow')
    expect(evaluateToolPolicy(dangerousPolicy, 'auto')).toBe('allow')
    expect(evaluateToolPolicy(readPolicy, 'auto')).toBe('allow')
    expect(evaluateToolPolicy(networkPolicy, 'auto')).toBe('allow')
  })
})
