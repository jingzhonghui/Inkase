import { describe, expect, it } from 'vitest'
import { parseQuery } from '../knowledge-query'

describe('parseQuery', () => {
  it('treats bare words as a literal text query', () => {
    expect(parseQuery('知识 图谱')).toEqual({ query: { text: '知识 图谱' }, hint: null })
  })

  it('collects tags as an AND list', () => {
    expect(parseQuery('tag:a tag:b 正文')).toEqual({
      query: { tags: ['a', 'b'], text: '正文' },
      hint: null
    })
  })

  it('collects path filters', () => {
    expect(parseQuery('path:notes/ tag:x')).toEqual({
      query: { tags: ['x'], paths: ['notes/'] },
      hint: null
    })
  })

  it('parses prop equality filters', () => {
    expect(parseQuery('prop:status=done')).toEqual({
      query: { props: { status: 'done' } },
      hint: null
    })
  })

  it('parses a slash-wrapped regex instead of literal text', () => {
    expect(parseQuery('/foo.*bar/')).toEqual({ query: { regex: 'foo.*bar' }, hint: null })
  })

  it('keeps a lone slash as literal text', () => {
    expect(parseQuery('/')).toEqual({ query: { text: '/' }, hint: null })
  })

  it('reports a hint when nothing usable was entered', () => {
    expect(parseQuery('   ').hint).not.toBeNull()
    expect(parseQuery('   ').query).toEqual({})
  })

  it('keeps unparseable filter tokens as literal keywords instead of dropping them', () => {
    expect(parseQuery('prop:=x')).toEqual({ query: { text: 'prop:=x' }, hint: null })
    expect(parseQuery('tag:')).toEqual({ query: { text: 'tag:' }, hint: null })
    expect(parseQuery('path:')).toEqual({ query: { text: 'path:' }, hint: null })
    expect(parseQuery('prop:novalue')).toEqual({ query: { text: 'prop:novalue' }, hint: null })
  })
})
