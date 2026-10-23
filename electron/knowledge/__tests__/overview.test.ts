import { describe, expect, it } from 'vitest'
import type { FileEntry, KnowledgeIndex, LinkRef, NodeKind } from '../../../shared/knowledge/types'
import { OVERVIEW_RECENT_LIMIT, buildOverview, emptyOverview } from '../overview'

function entry(kind: NodeKind = 'md', mtime = 0): FileEntry {
  return { mtime, size: 0, hash: '', kind }
}

function resolved(from: string, to: string): LinkRef {
  return { from, to, raw: `[[${to}]]`, kind: 'link', line: 1, column: 1, status: 'resolved' }
}

function makeIndex(partial: Partial<KnowledgeIndex> = {}): KnowledgeIndex {
  return {
    meta: { version: 1, root: '/vault', builtAt: 0, fileCount: 0, parserVersion: 3 },
    files: {},
    outgoing: {},
    unresolved: [],
    tags: {},
    tagUses: {},
    mentions: {},
    errors: [],
    ...partial
  }
}

describe('buildOverview', () => {
  it('counts only Markdown/MDX as notes and reports recent ones by mtime', () => {
    const index = makeIndex({
      files: {
        'a.md': entry('md', 100),
        'b.mdx': entry('mdx', 300),
        'c.pdf': entry('pdf', 500),
        'd.md': entry('md', 200)
      },
      outgoing: { 'a.md': [resolved('a.md', 'b.mdx')] }
    })

    const overview = buildOverview(index)

    expect(overview.noteCount).toBe(3)
    expect(overview.recent.map((note) => note.path)).toEqual(['b.mdx', 'd.md', 'a.md'])
    expect(overview.recent[0].mtime).toBe(300)
  })

  it('counts tags, unresolved links and note-only isolated nodes', () => {
    const index = makeIndex({
      files: {
        'a.md': entry('md', 1),
        'b.md': entry('md', 2),
        'lonely.md': entry('md', 3),
        'asset.pdf': entry('pdf', 4)
      },
      outgoing: { 'a.md': [resolved('a.md', 'b.md')] },
      tags: { idea: ['a.md'], todo: ['b.md'] },
      unresolved: [
        { from: 'a.md', raw: '[[gone]]', kind: 'link', line: 1, column: 1, status: 'missing' }
      ]
    })

    const overview = buildOverview(index)

    expect(overview.tagCount).toBe(2)
    expect(overview.brokenCount).toBe(1)
    // PDF 没有任何边，但它不是笔记，不该计入「孤立笔记」
    expect(overview.isolatedCount).toBe(1)
  })

  it('caps the recent list at the requested limit', () => {
    const files: Record<string, FileEntry> = {}
    for (let i = 0; i < 10; i += 1) files[`n${i}.md`] = entry('md', i)

    expect(buildOverview(makeIndex({ files })).recent).toHaveLength(OVERVIEW_RECENT_LIMIT)
    expect(buildOverview(makeIndex({ files }), 2).recent.map((note) => note.path)).toEqual([
      'n9.md',
      'n8.md'
    ])
    expect(buildOverview(makeIndex({ files }), 0).recent).toEqual([])
  })

  it('returns an empty overview for an empty index', () => {
    expect(buildOverview(makeIndex())).toEqual(emptyOverview())
  })
})
