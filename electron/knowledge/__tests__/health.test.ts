import { describe, expect, it } from 'vitest'
import type {
  FileEntry,
  KnowledgeIndex,
  LinkRef,
  MentionItem,
  NodeKind
} from '../../../shared/knowledge/types'
import {
  HEALTH_DUPLICATE_LIMIT,
  HEALTH_LIST_LIMIT,
  buildHealth,
  emptyHealth
} from '../health'

function entry(kind: NodeKind = 'md', props?: Record<string, string>): FileEntry {
  return { mtime: 0, size: 0, hash: '', kind, ...(props ? { props } : {}) }
}

function resolved(from: string, to: string): LinkRef {
  return { from, to, raw: `[[${to}]]`, kind: 'link', line: 1, column: 1, status: 'resolved' }
}

function makeIndex(partial: Partial<KnowledgeIndex> = {}): KnowledgeIndex {
  return {
    meta: { version: 1, root: '/vault', builtAt: 0, fileCount: 0, parserVersion: 4 },
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

function missing(overrides: Partial<LinkRef> = {}): LinkRef {
  return {
    from: 'a.md',
    raw: '[[gone]]',
    kind: 'link',
    line: 1,
    column: 1,
    status: 'missing',
    ...overrides
  }
}

function mention(overrides: Partial<MentionItem> = {}): MentionItem {
  return {
    targetPath: 'notes/a.md',
    line: 2,
    column: 4,
    raw: 'Alpha',
    text: '这里提到 Alpha',
    ...overrides
  }
}

describe('buildHealth', () => {
  it('reports isolated notes, broken links and unlinked mentions with counts', () => {
    const index = makeIndex({
      files: {
        'notes/a.md': entry('md', { title: 'Alpha' }),
        'notes/b.md': entry('md', { title: 'Beta' }),
        'lonely.md': entry('md'),
        'asset.pdf': entry('pdf')
      },
      outgoing: { 'notes/a.md': [resolved('notes/a.md', 'notes/b.md')] },
      unresolved: [missing()],
      mentions: { 'notes/b.md': [mention()] }
    })

    const health = buildHealth(index)

    expect(health.counts).toEqual({
      isolated: 1,
      broken: 1,
      duplicateTitles: 0,
      unlinkedMentions: 1
    })
    expect(health.isolated).toEqual(['lonely.md'])
    expect(health.broken).toHaveLength(1)
    expect(health.unlinked[0]).toMatchObject({
      from: 'notes/b.md',
      targetPath: 'notes/a.md',
      line: 2,
      column: 4
    })
  })

  it('groups duplicate titles by frontmatter title or file name, case-insensitively', () => {
    const index = makeIndex({
      files: {
        'a.md': entry('md', { title: 'Project' }),
        'dir/a.md': entry('md', { title: 'project' }),
        'x/b.md': entry('md'),
        'y/B.md': entry('md')
      }
    })

    const health = buildHealth(index)

    expect(health.counts.duplicateTitles).toBe(2)
    expect(health.duplicates).toEqual([
      { title: 'b', paths: ['x/b.md', 'y/B.md'] },
      { title: 'Project', paths: ['a.md', 'dir/a.md'] }
    ])
  })

  it('caps long lists while keeping full counts and marking truncation', () => {
    const unresolved = Array.from({ length: HEALTH_LIST_LIMIT + 1 }, (_, index) =>
      missing({ from: `n${index}.md` })
    )
    const health = buildHealth(makeIndex({ unresolved }))

    expect(health.counts.broken).toBe(HEALTH_LIST_LIMIT + 1)
    expect(health.broken).toHaveLength(HEALTH_LIST_LIMIT)
    expect(health.truncated).toBe(true)
  })

  it('returns an empty report for an empty index', () => {
    expect(buildHealth(makeIndex())).toEqual(emptyHealth())
  })

  it('keeps duplicate groups under their own tighter limit', () => {
    const files: Record<string, FileEntry> = {}
    for (let index = 0; index < HEALTH_DUPLICATE_LIMIT + 1; index += 1) {
      const title = `Dup ${index}`
      files[`a/dup-${index}.md`] = entry('md', { title })
      files[`b/dup-${index}.md`] = entry('md', { title })
    }

    const health = buildHealth(makeIndex({ files }))

    expect(health.counts.duplicateTitles).toBe(HEALTH_DUPLICATE_LIMIT + 1)
    expect(health.duplicates).toHaveLength(HEALTH_DUPLICATE_LIMIT)
    expect(health.truncated).toBe(true)
  })
})
