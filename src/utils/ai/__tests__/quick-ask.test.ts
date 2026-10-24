import { describe, expect, it } from 'vitest'
import { applyQuickAskAction, buildQuickAskPrompt } from '../quick-ask'

describe('applyQuickAskAction', () => {
  const content = '第一段\n第二段'
  const target = { from: 4, to: 7, text: '第二段' }

  it('replaces only the selected range', () => {
    const result = applyQuickAskAction(content, target, 'replace', '新的段落')
    expect(result).toEqual({ ok: true, content: '第一段\n新的段落' })
  })

  it('inserts after the selection instead of overwriting it', () => {
    const result = applyQuickAskAction(content, target, 'insert', '补充')
    expect(result).toEqual({ ok: true, content: '第一段\n第二段补充' })
  })

  it('appends with a paragraph separator when needed', () => {
    expect(applyQuickAskAction('正文', { from: 0, to: 0, text: '' }, 'append', '补充')).toEqual({
      ok: true,
      content: '正文\n\n补充'
    })
    expect(applyQuickAskAction('正文\n', { from: 0, to: 0, text: '' }, 'append', '补充')).toEqual({
      ok: true,
      content: '正文\n\n补充'
    })
    expect(applyQuickAskAction('正文\n\n', { from: 0, to: 0, text: '' }, 'append', '补充')).toEqual({
      ok: true,
      content: '正文\n\n补充'
    })
  })

  it('appends to an empty document without a leading separator', () => {
    expect(applyQuickAskAction('', { from: 0, to: 0, text: '' }, 'append', '补充')).toEqual({
      ok: true,
      content: '补充'
    })
  })

  it('refuses to write when the source text has changed', () => {
    const result = applyQuickAskAction('第一段\n已被改动', target, 'replace', '答案')
    expect(result).toEqual({ ok: false, reason: '原文已变化，请重新选择文本' })
  })

  it('refuses an invalid selection range', () => {
    expect(
      applyQuickAskAction(content, { from: 8, to: 2, text: '' }, 'replace', '答案')
    ).toEqual({ ok: false, reason: '选区已失效，请重新选择文本' })
  })

  it('refuses an empty answer', () => {
    expect(applyQuickAskAction(content, target, 'replace', '   ')).toEqual({
      ok: false,
      reason: 'AI 还没有返回可用内容'
    })
  })
})

describe('buildQuickAskPrompt', () => {
  it('contains the selected text and the question', () => {
    const prompt = buildQuickAskPrompt('改成更正式的语气', '今天天气不错。')
    expect(prompt).toContain('今天天气不错。')
    expect(prompt).toContain('改成更正式的语气')
    expect(prompt).toContain('不要调用工具')
  })

  it('truncates very long selections', () => {
    const prompt = buildQuickAskPrompt('总结', 'a'.repeat(6001))
    expect(prompt).toContain('…（原文过长，已截断）')
    expect(prompt).not.toContain('a'.repeat(6001))
  })
})
