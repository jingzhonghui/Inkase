import { describe, expect, it } from 'vitest'
import {
  ALL_LAYERS,
  DEFAULT_LAYERS,
  defaultGraphFilters,
  filterGraph,
  type Graph,
  type GraphEdge,
  type GraphNode
} from '../graph'

function node(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    kind: 'md',
    label: partial.id,
    folder: '',
    degree: 0,
    isolated: false,
    ...partial
  }
}

function edge(from: string, to: string, layer: GraphEdge['layer'] = 'link'): GraphEdge {
  return { from, to, layer }
}

/**
 * 一个够用的样本：
 *   notes/a.md --[[link]]--> notes/b.md
 *   notes/a.md --#topic--> (#topic)
 *   loose/c.md 孤立
 *   folder:notes --> notes/a.md（目录边）
 */
function sample(): Graph {
  const nodes = [
    node({ id: 'notes/a.md', label: 'A', folder: 'notes', degree: 2 }),
    node({ id: 'notes/b.md', label: 'B', folder: 'notes', degree: 1 }),
    node({ id: 'loose/c.md', label: 'C', folder: 'loose', isolated: true }),
    node({ id: '#topic', kind: 'tag', label: '#topic', degree: 1 }),
    node({ id: 'folder:notes', kind: 'folder', label: 'notes', folder: 'notes', degree: 1 })
  ]
  const edges = [
    edge('notes/a.md', 'notes/b.md'),
    edge('notes/a.md', '#topic', 'tag'),
    edge('folder:notes', 'notes/a.md', 'folder')
  ]
  return {
    nodes,
    edges,
    isolated: ['loose/c.md'],
    components: [['#topic', 'notes/a.md', 'notes/b.md'], ['loose/c.md']],
    aggregated: false,
    hiddenCount: 0
  }
}

describe('defaultGraphFilters', () => {
  it('starts wide open with the five default layers', () => {
    const filters = defaultGraphFilters()
    expect(filters.layers).toEqual(DEFAULT_LAYERS)
    expect(filters.folders).toBeNull()
    expect(filters.tags).toBeNull()
    expect(filters.orphans).toBe('all')
    expect(filters.filesOnly).toBe(false)
  })

  it('keeps the six layers available for the folder toggle', () => {
    expect(ALL_LAYERS).toEqual([...DEFAULT_LAYERS, 'folder'])
  })
})

describe('filterGraph', () => {
  it('returns everything by default (folder edges excluded)', () => {
    const filtered = filterGraph(sample(), defaultGraphFilters())

    expect(filtered.nodes).toHaveLength(5)
    expect(filtered.edges.map((item) => item.layer)).toEqual(['link', 'tag'])
    expect(filtered.isolated).toEqual(['loose/c.md'])
  })

  it('drops a whole edge layer and recomputes what is visible', () => {
    const filtered = filterGraph(sample(), { ...defaultGraphFilters(), layers: ['link'] })

    expect(filtered.edges).toHaveLength(1)
    expect(filtered.nodes.map((item) => item.id)).toContain('#topic')
    // 标签节点失去唯一一条边后成为「看不到连接」的节点，但它是结构节点，不算孤立
    expect(filtered.isolated).toEqual(['loose/c.md'])
    expect(filtered.nodes.find((item) => item.id === '#topic')?.degree).toBe(0)
  })

  it('filters by top-level folder', () => {
    const filtered = filterGraph(sample(), { ...defaultGraphFilters(), folders: ['notes'] })

    expect(filtered.nodes.map((item) => item.id).sort()).toEqual([
      '#topic',
      'folder:notes',
      'notes/a.md',
      'notes/b.md'
    ])
    expect(filtered.nodes.some((item) => item.id === 'loose/c.md')).toBe(false)
  })

  it('treats an empty folder whitelist as "show nothing"', () => {
    const filtered = filterGraph(sample(), { ...defaultGraphFilters(), folders: [] })

    expect(filtered.nodes.every((item) => item.kind === 'tag')).toBe(true)
  })

  it('filters tag nodes by id', () => {
    const onlyTopic = filterGraph(sample(), { ...defaultGraphFilters(), tags: ['#topic'] })
    expect(onlyTopic.nodes.map((item) => item.id)).toContain('#topic')

    const noTags = filterGraph(sample(), { ...defaultGraphFilters(), tags: [] })
    expect(noTags.nodes.some((item) => item.kind === 'tag')).toBe(false)
    expect(noTags.edges.some((item) => item.layer === 'tag')).toBe(false)
  })

  it('supports only-orphans and hide-orphans', () => {
    const only = filterGraph(sample(), { ...defaultGraphFilters(), orphans: 'only' })
    expect(only.nodes.map((item) => item.id)).toEqual(['loose/c.md'])
    expect(only.edges).toEqual([])
    expect(only.isolated).toEqual(['loose/c.md'])

    const hidden = filterGraph(sample(), { ...defaultGraphFilters(), orphans: 'hide' })
    expect(hidden.nodes.some((item) => item.id === 'loose/c.md')).toBe(false)
    expect(hidden.isolated).toEqual([])
  })

  it('keeps only file nodes when asked', () => {
    const filtered = filterGraph(sample(), { ...defaultGraphFilters(), filesOnly: true })

    expect(filtered.nodes.map((item) => item.id).sort()).toEqual([
      'loose/c.md',
      'notes/a.md',
      'notes/b.md'
    ])
    expect(filtered.edges.map((item) => item.layer)).toEqual(['link'])
  })

  it('shows folder edges when the folder layer is switched on', () => {
    const filtered = filterGraph(sample(), { ...defaultGraphFilters(), layers: ALL_LAYERS })

    expect(filtered.edges.map((item) => item.layer)).toContain('folder')
  })

  it('never leaves an edge pointing at a hidden node', () => {
    const filtered = filterGraph(sample(), {
      ...defaultGraphFilters(),
      folders: ['notes'],
      filesOnly: true
    })
    const ids = new Set(filtered.nodes.map((item) => item.id))
    for (const item of filtered.edges) {
      expect(ids.has(item.from)).toBe(true)
      expect(ids.has(item.to)).toBe(true)
    }
  })

  it('preserves the guardrail bookkeeping', () => {
    const aggregated: Graph = { ...sample(), aggregated: true, hiddenCount: 42 }
    const filtered = filterGraph(aggregated, { ...defaultGraphFilters(), filesOnly: true })

    expect(filtered.aggregated).toBe(true)
    expect(filtered.hiddenCount).toBe(42)
  })

  it('does not mutate the source graph', () => {
    const source = sample()
    filterGraph(source, { ...defaultGraphFilters(), layers: ['mention'], orphans: 'hide' })

    expect(source.nodes).toHaveLength(5)
    expect(source.nodes.find((item) => item.id === 'notes/a.md')?.degree).toBe(2)
    expect(source.edges).toHaveLength(3)
  })
})
