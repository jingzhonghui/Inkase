import { describe, expect, it } from 'vitest'
import type { FileEntry, KnowledgeIndex, LinkRef, NodeKind } from '../../../shared/knowledge/types'
import {
  DEFAULT_LAYERS,
  GUARDRAIL_LIMIT,
  applyGuardrail,
  buildGraph,
  focusSubgraph
} from '../graph-service'

/** 构造单文件条目 */
function entry(kind: NodeKind = 'md', props?: Record<string, string>): FileEntry {
  return props === undefined
    ? { mtime: 0, size: 0, hash: '', kind }
    : { mtime: 0, size: 0, hash: '', kind, props }
}

/** 构造一条已解析的出链 */
function resolved(from: string, to: string, kind: 'link' | 'embed' = 'link'): LinkRef {
  return { from, to, raw: `[[${to}]]`, kind, line: 1, column: 1, status: 'resolved' }
}

/** 构造一个空索引 */
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

function nodeOf(graph: ReturnType<typeof buildGraph>, id: string) {
  return graph.nodes.find((node) => node.id === id)
}

describe('buildGraph · L1 显式引用', () => {
  it('turns resolved wiki links into directed link edges', () => {
    const index = makeIndex({
      files: { 'a.md': entry(), 'b.md': entry() },
      outgoing: { 'a.md': [resolved('a.md', 'b.md')] }
    })

    const graph = buildGraph(index)

    expect(graph.edges).toEqual([{ from: 'a.md', to: 'b.md', layer: 'link' }])
    expect(graph.nodes.map((node) => node.id)).toEqual(['a.md', 'b.md'])
    expect(nodeOf(graph, 'a.md')?.degree).toBe(1)
    expect(nodeOf(graph, 'b.md')?.degree).toBe(1)
  })

  it('ignores links that never resolved', () => {
    const index = makeIndex({
      files: { 'a.md': entry() },
      outgoing: {
        'a.md': [{ from: 'a.md', raw: '[[没有]]', kind: 'link', line: 1, column: 1, status: 'missing' }]
      }
    })

    expect(buildGraph(index).edges).toEqual([])
  })

  it('keeps embeddings distinguishable from plain links', () => {
    const index = makeIndex({
      files: { 'a.md': entry(), 'b.md': entry() },
      outgoing: { 'a.md': [resolved('a.md', 'b.md', 'embed')] }
    })

    expect(buildGraph(index).edges[0]).toEqual({
      from: 'a.md',
      to: 'b.md',
      layer: 'link',
      embed: true
    })
  })
})

describe('buildGraph · L2 资源引用', () => {
  it('routes links to non-note files into the resource layer', () => {
    const index = makeIndex({
      files: { 'n.md': entry('md'), 'p.png': entry('image'), 'd.pdf': entry('pdf') },
      outgoing: { 'n.md': [resolved('n.md', 'p.png'), resolved('n.md', 'd.pdf')] }
    })

    const layers = buildGraph(index).edges.map((edge) => edge.layer)

    expect(layers).toEqual(['resource', 'resource'])
  })

  it('keeps note-to-note links in the link layer only', () => {
    const index = makeIndex({
      files: { 'a.mdx': entry('mdx'), 'b.md': entry('md') },
      outgoing: { 'a.mdx': [resolved('a.mdx', 'b.md')] }
    })

    expect(buildGraph(index).edges.map((edge) => edge.layer)).toEqual(['link'])
  })
})

describe('buildGraph · L3 标签', () => {
  it('creates tag nodes and bipartite edges', () => {
    const index = makeIndex({
      files: { 'a.md': entry() },
      tags: { x: ['a.md'] },
      tagUses: { 'a.md': [{ tag: 'x', source: 'inline' }] }
    })

    const graph = buildGraph(index)

    expect(nodeOf(graph, '#x')).toMatchObject({ kind: 'tag', label: '#x' })
    expect(graph.edges).toEqual([{ from: 'a.md', to: '#x', layer: 'tag' }])
    expect(nodeOf(graph, 'a.md')?.degree).toBe(1)
  })

  it('collapses duplicate tag uses of the same tag', () => {
    const index = makeIndex({
      files: { 'a.md': entry() },
      tagUses: {
        'a.md': [
          { tag: 'x', source: 'inline' },
          { tag: 'x', source: 'frontmatter' }
        ]
      }
    })

    expect(buildGraph(index).edges).toHaveLength(1)
  })
})

describe('buildGraph · L4 关系字段', () => {
  it('resolves up / related / source into typed relation edges', () => {
    const index = makeIndex({
      files: {
        'a.md': entry('md', { up: 'b', related: 'c,d' }),
        'b.md': entry(),
        'c.md': entry(),
        'd.md': entry()
      }
    })

    const edges = buildGraph(index).edges

    expect(edges).toContainEqual({ from: 'a.md', to: 'b.md', layer: 'relation', relation: 'up' })
    expect(edges).toContainEqual({ from: 'a.md', to: 'c.md', layer: 'relation', relation: 'related' })
    expect(edges).toContainEqual({ from: 'a.md', to: 'd.md', layer: 'relation', relation: 'related' })
    expect(edges).toHaveLength(3)
  })

  it('skips relation values that do not resolve', () => {
    const index = makeIndex({
      files: { 'a.md': entry('md', { up: '不存在' }), 'b.md': entry() }
    })

    expect(buildGraph(index).edges).toEqual([])
  })

  it('ignores unrelated frontmatter fields', () => {
    const index = makeIndex({
      files: { 'a.md': entry('md', { status: 'draft', tagline: 'b' }), 'b.md': entry() }
    })

    expect(buildGraph(index).edges).toEqual([])
  })
})

describe('buildGraph · L5 未链接提及', () => {
  it('turns mentions into directed mention edges', () => {
    const index = makeIndex({
      files: { 'a.md': entry(), 'b.md': entry() },
      mentions: { 'a.md': [{ targetPath: 'b.md', line: 3, column: 1, raw: 'b', text: 'b 是提及' }] }
    })

    expect(buildGraph(index).edges).toEqual([{ from: 'a.md', to: 'b.md', layer: 'mention' }])
  })

  it('collapses repeated mentions of the same target in one file', () => {
    const index = makeIndex({
      files: { 'a.md': entry(), 'b.md': entry() },
      mentions: {
        'a.md': [
          { targetPath: 'b.md', line: 1, column: 1, raw: 'b', text: 'b' },
          { targetPath: 'b.md', line: 5, column: 1, raw: 'b', text: 'b' }
        ]
      }
    })

    expect(buildGraph(index).edges).toHaveLength(1)
  })
})

describe('buildGraph · L6 目录层级', () => {
  it('is off by default: no folder nodes and no folder edges', () => {
    const index = makeIndex({
      files: { 'docs/a.md': entry(), 'docs/sub/b.md': entry() }
    })

    const graph = buildGraph(index)

    expect(graph.edges).toEqual([])
    expect(graph.nodes.some((node) => node.kind === 'folder')).toBe(false)
  })

  it('adds a folder tree when enabled, without changing note degrees', () => {
    const index = makeIndex({
      files: { 'docs/a.md': entry(), 'docs/sub/b.md': entry(), 'b.md': entry() },
      outgoing: { 'docs/a.md': [resolved('docs/a.md', 'b.md')] }
    })

    const before = buildGraph(index)
    const after = buildGraph(index, { layers: [...DEFAULT_LAYERS, 'folder'] })

    expect(after.nodes.some((node) => node.kind === 'folder')).toBe(true)
    expect(after.edges.some((edge) => edge.layer === 'folder')).toBe(true)
    // L6 不参与度数（设计文档 §5.6）
    expect(nodeOf(after, 'docs/a.md')?.degree).toBe(nodeOf(before, 'docs/a.md')?.degree)
    expect(nodeOf(after, 'b.md')?.degree).toBe(nodeOf(before, 'b.md')?.degree)
  })

  it('links nested folders to their parent folder', () => {
    const index = makeIndex({ files: { 'docs/sub/b.md': entry() } })

    const edges = buildGraph(index, { layers: ['folder'] }).edges

    expect(edges).toContainEqual({ from: 'folder:docs', to: 'folder:docs/sub', layer: 'folder' })
    expect(edges).toContainEqual({ from: 'folder:docs/sub', to: 'docs/sub/b.md', layer: 'folder' })
  })
})

describe('buildGraph · 孤立与连通分量', () => {
  it('marks notes without any L1–L5 edge as isolated', () => {
    const index = makeIndex({
      files: { 'a.md': entry(), 'b.md': entry(), 'lonely.md': entry() },
      outgoing: { 'a.md': [resolved('a.md', 'b.md')] }
    })

    const graph = buildGraph(index)

    expect(graph.isolated).toEqual(['lonely.md'])
    expect(nodeOf(graph, 'lonely.md')).toMatchObject({ isolated: true, degree: 0 })
    expect(nodeOf(graph, 'a.md')?.isolated).toBe(false)
  })

  it('does not treat a tag-only note as isolated', () => {
    const index = makeIndex({
      files: { 'a.md': entry() },
      tagUses: { 'a.md': [{ tag: 'x', source: 'inline' }] }
    })

    expect(buildGraph(index).isolated).toEqual([])
  })

  it('reports connected components over non-folder edges only', () => {
    const index = makeIndex({
      files: { 'a.md': entry(), 'b.md': entry(), 'c.md': entry(), 'd.md': entry() },
      outgoing: { 'a.md': [resolved('a.md', 'b.md')], 'c.md': [resolved('c.md', 'd.md')] }
    })

    const graph = buildGraph(index)

    expect(graph.components).toEqual([
      ['a.md', 'b.md'],
      ['c.md', 'd.md']
    ])
  })

  it('sorts components by size then first id', () => {
    const index = makeIndex({
      files: { 'a.md': entry(), 'b.md': entry(), 'c.md': entry(), 'z.md': entry() },
      outgoing: { 'z.md': [resolved('z.md', 'a.md'), resolved('z.md', 'b.md')] }
    })

    expect(buildGraph(index).components[0]).toEqual(['a.md', 'b.md', 'z.md'])
  })
})

describe('buildGraph · 节点属性与选项', () => {
  it('labels notes by path without extension and keeps the top folder', () => {
    const index = makeIndex({ files: { 'docs/sub/笔记.md': entry() } })

    expect(nodeOf(buildGraph(index), 'docs/sub/笔记.md')).toMatchObject({
      label: '笔记',
      folder: 'docs',
      kind: 'md'
    })
  })

  it('drops tag edges and tag nodes when the tag layer is disabled', () => {
    const index = makeIndex({
      files: { 'a.md': entry(), 'b.md': entry() },
      outgoing: { 'a.md': [resolved('a.md', 'b.md')] },
      tagUses: { 'a.md': [{ tag: 'x', source: 'inline' }] }
    })

    const graph = buildGraph(index, { layers: ['link'] })

    expect(graph.edges.map((edge) => edge.layer)).toEqual(['link'])
    expect(graph.nodes.some((node) => node.kind === 'tag')).toBe(false)
  })

  it('is deterministic across repeated builds', () => {
    const index = makeIndex({
      files: { 'a.md': entry(), 'b.md': entry(), 'c.md': entry() },
      outgoing: { 'a.md': [resolved('a.md', 'b.md')], 'c.md': [resolved('c.md', 'a.md')] },
      tagUses: { 'a.md': [{ tag: 'x', source: 'inline' }] }
    })

    expect(JSON.stringify(buildGraph(index))).toBe(JSON.stringify(buildGraph(index)))
  })

  it('handles an empty index', () => {
    expect(buildGraph(makeIndex())).toEqual({
      nodes: [],
      edges: [],
      isolated: [],
      components: [],
      aggregated: false,
      hiddenCount: 0
    })
  })
})

describe('focusSubgraph', () => {
  /** a → b → c → d 的链 */
  function chain() {
    return buildGraph(
      makeIndex({
        files: { 'a.md': entry(), 'b.md': entry(), 'c.md': entry(), 'd.md': entry() },
        outgoing: {
          'a.md': [resolved('a.md', 'b.md')],
          'b.md': [resolved('b.md', 'c.md')],
          'c.md': [resolved('c.md', 'd.md')]
        }
      })
    )
  }

  it('walks one hop', () => {
    expect(focusSubgraph(chain(), 'a.md', 1).nodes.map((node) => node.id)).toEqual(['a.md', 'b.md'])
  })

  it('walks two hops', () => {
    expect(focusSubgraph(chain(), 'a.md', 2).nodes.map((node) => node.id)).toEqual([
      'a.md',
      'b.md',
      'c.md'
    ])
  })

  it('walks three hops', () => {
    expect(focusSubgraph(chain(), 'a.md', 3).nodes.map((node) => node.id)).toEqual([
      'a.md',
      'b.md',
      'c.md',
      'd.md'
    ])
  })

  it('reaches neighbours on both sides from the middle', () => {
    expect(focusSubgraph(chain(), 'b.md', 1).nodes.map((node) => node.id)).toEqual([
      'a.md',
      'b.md',
      'c.md'
    ])
  })

  it('clamps depth into 1..3', () => {
    expect(focusSubgraph(chain(), 'a.md', 0).nodes).toHaveLength(2)
    expect(focusSubgraph(chain(), 'a.md', 99).nodes).toHaveLength(4)
  })

  it('follows edges in both directions', () => {
    const graph = focusSubgraph(chain(), 'd.md', 1)

    expect(graph.nodes.map((node) => node.id)).toEqual(['c.md', 'd.md'])
    expect(graph.edges).toEqual([{ from: 'c.md', to: 'd.md', layer: 'link' }])
  })

  it('recomputes degree inside the subgraph', () => {
    expect(nodeOf(focusSubgraph(chain(), 'a.md', 1), 'a.md')?.degree).toBe(1)
  })

  it('returns an empty graph for an unknown seed', () => {
    expect(focusSubgraph(chain(), 'nope.md', 2).nodes).toEqual([])
  })

  it('keeps only edges whose both ends are inside', () => {
    const graph = focusSubgraph(chain(), 'b.md', 1)

    expect(graph.edges).toEqual([
      { from: 'a.md', to: 'b.md', layer: 'link' },
      { from: 'b.md', to: 'c.md', layer: 'link' }
    ])
  })

  it('does not traverse folder edges', () => {
    const index = makeIndex({ files: { 'docs/a.md': entry(), 'docs/b.md': entry() } })
    const graph = buildGraph(index, { layers: [...DEFAULT_LAYERS, 'folder'] })

    expect(focusSubgraph(graph, 'docs/a.md', 1).nodes.map((node) => node.id)).toEqual(['docs/a.md'])
  })
})

describe('applyGuardrail', () => {
  /** n 个互不相连的根目录笔记 */
  function manyNotes(count: number): KnowledgeIndex {
    const files: Record<string, FileEntry> = {}
    for (let i = 0; i < count; i++) files[`n${i}.md`] = entry()
    return makeIndex({ files })
  }

  it('leaves a small graph untouched', () => {
    const graph = buildGraph(manyNotes(3))
    const guarded = applyGuardrail(graph)

    expect(guarded).toEqual(graph)
    expect(guarded.aggregated).toBe(false)
    expect(guarded.hiddenCount).toBe(0)
  })

  it('aggregates once the node count exceeds the limit', () => {
    const graph = buildGraph(manyNotes(10))
    const guarded = applyGuardrail(graph, 4)

    expect(guarded.aggregated).toBe(true)
    expect(guarded.hiddenCount).toBe(6)
    expect(guarded.nodes).toHaveLength(5) // 4 保留 + 1 个根目录团块
    expect(guarded.nodes.some((node) => node.kind === 'cluster')).toBe(true)
  })

  it('keeps the highest-degree nodes and never keeps isolated ones first', () => {
    const index = makeIndex({
      files: { 'hub.md': entry(), 'mid.md': entry(), 'lonely.md': entry(), 'x.md': entry() },
      outgoing: { 'hub.md': [resolved('hub.md', 'mid.md'), resolved('hub.md', 'x.md')] }
    })

    const guarded = applyGuardrail(buildGraph(index), 2)

    expect(guarded.nodes.map((node) => node.id)).toContain('hub.md')
    expect(guarded.nodes.some((node) => node.id === 'lonely.md')).toBe(false)
  })

  it('groups the remainder by top-level folder', () => {
    const files: Record<string, FileEntry> = {}
    for (let i = 0; i < 6; i++) files[`docs/n${i}.md`] = entry()
    for (let i = 0; i < 6; i++) files[`notes/n${i}.md`] = entry()

    const guarded = applyGuardrail(buildGraph(makeIndex({ files })), 4)
    const clusters = guarded.nodes.filter((node) => node.kind === 'cluster')

    expect(clusters.map((node) => node.id).sort()).toEqual(['cluster:docs', 'cluster:notes'])
    expect(clusters.every((node) => node.folder === node.id.replace('cluster:', ''))).toBe(true)
  })

  it('never leaves a dangling edge', () => {
    const files: Record<string, FileEntry> = {}
    for (let i = 0; i < 8; i++) files[`docs/n${i}.md`] = entry()
    const outgoing: Record<string, LinkRef[]> = {}
    for (let i = 0; i < 7; i++) {
      outgoing[`docs/n${i}.md`] = [resolved(`docs/n${i}.md`, `docs/n${i + 1}.md`)]
    }

    const guarded = applyGuardrail(buildGraph(makeIndex({ files, outgoing })), 3)
    const ids = new Set(guarded.nodes.map((node) => node.id))

    for (const edge of guarded.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
      expect(edge.from).not.toBe(edge.to)
    }
  })

  it('falls back to the default limit for a non-positive limit', () => {
    const graph = buildGraph(manyNotes(5))

    expect(applyGuardrail(graph, 0).aggregated).toBe(false)
    expect(applyGuardrail(graph, -1).aggregated).toBe(false)
    expect(applyGuardrail(graph, Number.NaN).aggregated).toBe(false)
  })

  it('exposes a guardrail default of 1500 nodes', () => {
    expect(GUARDRAIL_LIMIT).toBe(1500)
  })
})
