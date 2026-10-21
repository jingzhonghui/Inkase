import { describe, expect, it } from 'vitest'
import { parseLinks, parseWikiLinks } from '../link-parser'

describe('parseLinks', () => {
  it('parses plain, aliased, anchored and embedded wikilinks plus markdown links', () => {
    const text = 'A [[笔记B]] B [[笔记C|别名]] C [[笔记D#标题]] D ![[图.png]] E [文本](sub/其他.md)'
    const refs = parseLinks(text, 'a.md')

    expect(refs.map((r) => r.raw)).toEqual([
      '[[笔记B]]',
      '[[笔记C|别名]]',
      '[[笔记D#标题]]',
      '![[图.png]]',
      '[文本](sub/其他.md)'
    ])
    expect(refs[0]).toMatchObject({ from: 'a.md', kind: 'link', line: 1, target: '笔记B' })
    expect(refs[1].target).toBe('笔记C')
    expect(refs[1].raw).toContain('别名')
    expect(refs[2]).toMatchObject({ target: '笔记D', anchor: '标题' })
    expect(refs[3].kind).toBe('embed')
    expect(refs[4].target).toBe('sub/其他.md')
  })

  it('reports 1-based line and column', () => {
    const refs = parseLinks('line1\nxx [[T]]', 'a.md')

    expect(refs[0]).toMatchObject({ line: 2, column: 4 })
  })

  it('keeps document order across both link kinds', () => {
    const refs = parseLinks('[文本](a.md) 然后 [[B]]', 'a.md')

    expect(refs.map((r) => r.raw)).toEqual(['[文本](a.md)', '[[B]]'])
  })

  it('ignores wikilinks inside fenced code blocks and inline code', () => {
    const text = ['```', '[[不解析]]', '```', '', '行内 `[[也不解析]]` 但 [[解析这个]]'].join('\n')

    expect(parseLinks(text, 'a.md').map((r) => r.raw)).toEqual(['[[解析这个]]'])
  })

  it('ignores tilde fences too', () => {
    const text = ['~~~', '[[不解析]]', '~~~', '[[解析]]'].join('\n')

    expect(parseLinks(text, 'a.md').map((r) => r.raw)).toEqual(['[[解析]]'])
  })

  it('ignores external markdown links', () => {
    expect(parseLinks('[x](https://example.com)', 'a.md')).toEqual([])
    expect(parseLinks('[x](mailto:a@b.c)', 'a.md')).toEqual([])
    expect(parseLinks('[x](#anchor)', 'a.md')).toEqual([])
    expect(parseLinks('[x](/abs/path.md)', 'a.md')).toEqual([])
  })

  it('parses an embed with a pdf page anchor', () => {
    const refs = parseLinks('![[文件.pdf#page=3]]', 'a.md')

    expect(refs[0]).toMatchObject({ kind: 'embed', target: '文件.pdf', anchor: 'page=3' })
  })

  it('handles a same-file heading link', () => {
    const refs = parseLinks('[[#标题]]', 'a.md')

    expect(refs[0]).toMatchObject({ target: '', anchor: '标题' })
  })

  it('ignores a markdown link title and keeps the path', () => {
    expect(parseLinks('[x](a.md "标题")', 'a.md')[0].target).toBe('a.md')
  })
})

describe('parseWikiLinks', () => {
  it('exposes alias, anchor and character range for the rewriter', () => {
    expect(parseWikiLinks('[[笔记|别名]]')).toEqual([
      { raw: '[[笔记|别名]]', start: 0, end: 9, target: '笔记', alias: '别名', anchor: undefined, embed: false }
    ])
  })

  it('reports absolute offsets across lines', () => {
    const text = 'aa\n[[B]]'
    const [token] = parseWikiLinks(text)

    expect(text.slice(token.start, token.end)).toBe('[[B]]')
    expect(token.start).toBe(3)
  })

  it('leaves code blocks untouched', () => {
    expect(parseWikiLinks('```\n[[old]]\n```')).toEqual([])
  })
})
