import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_PARSER_VERSION,
  type BacklinkItem,
  type IndexStatus,
  type KnowledgeIndex,
  type LinkRef,
  type LinkResolution
} from '../types'

describe('knowledge shared types', () => {
  it('exposes a parser version used to invalidate the index', () => {
    expect(KNOWLEDGE_PARSER_VERSION).toBeGreaterThan(0)
  })

  it('allows constructing an empty index', () => {
    const index: KnowledgeIndex = {
      meta: {
        version: 1,
        root: '/ws',
        builtAt: 0,
        fileCount: 0,
        parserVersion: KNOWLEDGE_PARSER_VERSION
      },
      files: {},
      outgoing: {},
      unresolved: [],
      tags: {},
      mentions: {},
      errors: []
    }

    expect(index.meta.version).toBe(1)
    expect(index.meta.parserVersion).toBe(KNOWLEDGE_PARSER_VERSION)
  })

  it('carries position information on a link ref', () => {
    const ref: LinkRef = {
      from: 'a.md',
      to: 'b.md',
      raw: '[[b]]',
      kind: 'link',
      line: 3,
      column: 5
    }

    expect(ref.kind).toBe('link')
    expect(ref.line).toBe(3)
  })

  it('distinguishes ambiguous resolutions from missing ones', () => {
    const ambiguous: LinkResolution = { status: 'ambiguous', candidates: ['a.md', 'b.md'] }
    const missing: LinkResolution = { status: 'missing' }
    const resolved: LinkResolution = { status: 'resolved', targetPath: 'a.md', anchor: '标题' }

    expect(ambiguous.status).toBe('ambiguous')
    expect(missing.status).toBe('missing')
    expect(resolved.status === 'resolved' && resolved.anchor).toBe('标题')
  })

  it('separates linked and unlinked backlinks', () => {
    const linked: BacklinkItem = { path: 'a.md', line: 1, text: '…', kind: 'linked' }
    const unlinked: BacklinkItem = { path: 'b.md', line: 2, text: '…', kind: 'unlinked' }

    expect(linked.kind).not.toBe(unlinked.kind)
  })

  it('models a degraded index status', () => {
    const status: IndexStatus = {
      state: 'degraded',
      progress: { phase: 'idle', done: 0, total: 0 },
      fileCount: 0
    }

    expect(status.state).toBe('degraded')
  })
})
