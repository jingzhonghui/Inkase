import { describe, expect, it } from 'vitest'
import type { KnowledgeIndex } from '../../../shared/knowledge/types'
import { DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, matchIndexFilters } from '../search-service'

function makeIndex(): KnowledgeIndex {
  return {
    meta: { version: 1, root: '/ws', builtAt: 0, fileCount: 3, parserVersion: 2 },
    files: {
      'a.md': { mtime: 1, size: 1, hash: 'h', kind: 'md', props: { status: 'done', kind: 'note' } },
      'dir/b.md': { mtime: 1, size: 1, hash: 'h', kind: 'md', props: { status: 'todo' } },
      'c.mdx': { mtime: 1, size: 1, hash: 'h', kind: 'mdx' }
    },
    outgoing: {},
    unresolved: [],
    tags: { alpha: ['a.md', 'dir/b.md'], beta: ['a.md'] },
    tagUses: {},
    mentions: {},
    errors: []
  }
}

describe('matchIndexFilters', () => {
  it('returns null when no index filter is present', () => {
    expect(matchIndexFilters(makeIndex(), {})).toBeNull()
    expect(matchIndexFilters(makeIndex(), { text: 'x' })).toBeNull()
  })

  it('filters by a single tag', () => {
    expect([...matchIndexFilters(makeIndex(), { tags: ['beta'] })!]).toEqual(['a.md'])
  })

  it('intersects multiple tags (AND)', () => {
    expect([...matchIndexFilters(makeIndex(), { tags: ['alpha', 'beta'] })!]).toEqual(['a.md'])
    expect([...matchIndexFilters(makeIndex(), { tags: ['alpha', 'nope'] })!]).toEqual([])
  })

  it('matches paths case-insensitively by substring', () => {
    expect([...matchIndexFilters(makeIndex(), { paths: ['DIR/'] })!]).toEqual(['dir/b.md'])
  })

  it('matches frontmatter props by equality', () => {
    expect([...matchIndexFilters(makeIndex(), { props: { status: 'done' } })!]).toEqual(['a.md'])
    expect([...matchIndexFilters(makeIndex(), { props: { status: 'missing' } })!]).toEqual([])
  })

  it('skips files without props when filtering by prop', () => {
    expect([...matchIndexFilters(makeIndex(), { props: { status: 'todo' } })!]).toEqual(['dir/b.md'])
  })

  it('combines tags and props', () => {
    expect([
      ...matchIndexFilters(makeIndex(), { tags: ['alpha'], props: { status: 'done' } })!
    ]).toEqual(['a.md'])
  })
})

describe('query limits', () => {
  it('exposes a 200 default and a hard cap', () => {
    expect(DEFAULT_QUERY_LIMIT).toBe(200)
    expect(MAX_QUERY_LIMIT).toBeGreaterThanOrEqual(DEFAULT_QUERY_LIMIT)
  })
})
