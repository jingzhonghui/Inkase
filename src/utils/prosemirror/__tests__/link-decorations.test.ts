import { describe, expect, it } from 'vitest'
import type { LinkResolution } from '../../../../shared/knowledge/types'
import { collectLinkDecorations } from '../link-decorations'

/** 按目标名决定解析结果的测试解析器 */
function resolver(target: string): LinkResolution {
  if (target === 'ok') return { status: 'resolved', targetPath: 'ok.md' }
  if (target === 'dup') return { status: 'ambiguous', candidates: ['a.md', 'b.md'] }
  return { status: 'missing' }
}

describe('collectLinkDecorations', () => {
  it('marks resolved, ambiguous and missing links differently', () => {
    const decos = collectLinkDecorations('[[ok]] [[dup]] [[gone]]', resolver)

    expect(decos.map((d) => d.kind)).toEqual(['resolved', 'ambiguous', 'missing'])
    expect(decos.map((d) => d.target)).toEqual(['ok', 'dup', 'gone'])
  })

  it('ignores links inside code', () => {
    expect(collectLinkDecorations('`[[x]]`', () => ({ status: 'missing' }))).toEqual([])
  })

  it('ignores links inside fenced code blocks', () => {
    const text = '[[ok]]\n\n```\n[[gone]]\n```\n\n[[ok]]\n'

    expect(collectLinkDecorations(text, resolver).map((d) => d.target)).toEqual(['ok', 'ok'])
  })

  it('ignores links inside tilde fences', () => {
    expect(collectLinkDecorations('~~~\n[[gone]]\n~~~', resolver)).toEqual([])
  })

  it('resumes parsing after a fence closes', () => {
    const text = '```\n[[gone]]\n```\n[[dup]]\n'

    expect(collectLinkDecorations(text, resolver).map((d) => d.target)).toEqual(['dup'])
  })

  it('reports offsets that select the whole token', () => {
    const text = '前 [[ok]] 后'
    const [deco] = collectLinkDecorations(text, resolver)

    expect(text.slice(deco.from, deco.to)).toBe('[[ok]]')
  })

  it('reports offsets correctly on later lines', () => {
    const text = 'line1\n[[ok]]\n'
    const [deco] = collectLinkDecorations(text, resolver)

    expect(deco.from).toBe('line1\n'.length)
    expect(text.slice(deco.from, deco.to)).toBe('[[ok]]')
  })

  it('strips aliases and anchors when resolving', () => {
    const seen: string[] = []
    collectLinkDecorations('[[笔记|别名]] [[笔记#标题]]', (target) => {
      seen.push(target)
      return { status: 'resolved', targetPath: 'x.md' }
    })

    expect(seen).toEqual(['笔记', '笔记'])
  })

  it('flags embeds and includes the bang in the range', () => {
    const text = '![[ok]]'
    const [deco] = collectLinkDecorations(text, resolver)

    expect(deco.embed).toBe(true)
    expect(text.slice(deco.from, deco.to)).toBe('![[ok]]')
  })

  it('does not flag a plain link as an embed', () => {
    expect(collectLinkDecorations('[[ok]]', resolver)[0].embed).toBe(false)
  })

  it('treats an empty target as missing without calling the resolver', () => {
    let called = false
    const decos = collectLinkDecorations('[[]]', () => {
      called = true
      return { status: 'resolved', targetPath: 'x.md' }
    })

    expect(called).toBe(false)
    expect(decos.map((d) => d.kind)).toEqual(['missing'])
  })

  it('stops at an unclosed link on the same line', () => {
    expect(collectLinkDecorations('[[ok]] [[broken', resolver).map((d) => d.target)).toEqual(['ok'])
  })

  it('returns nothing for text without links', () => {
    expect(collectLinkDecorations('普通文本', resolver)).toEqual([])
  })

  it('finds several links on one line', () => {
    expect(collectLinkDecorations('[[ok]][[dup]][[ok]]', resolver)).toHaveLength(3)
  })

  it('treats an unclosed inline backtick as plain text', () => {
    expect(collectLinkDecorations('` [[ok]]', resolver).map((d) => d.target)).toEqual(['ok'])
  })
})
