// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useKnowledgeStore } from '../knowledge'
import {
  DEFAULT_LAYERS,
  defaultGraphFilters,
  emptyGraph,
  type Graph
} from '../../../shared/knowledge/graph'

/** 两点一线的最小图谱 */
function sampleGraph(): Graph {
  return {
    nodes: [
      { id: 'a.md', kind: 'md', label: 'A', folder: '', degree: 1, isolated: false },
      { id: 'b.md', kind: 'md', label: 'B', folder: '', degree: 1, isolated: false }
    ],
    edges: [{ from: 'a.md', to: 'b.md', layer: 'link' }],
    isolated: [],
    components: [['a.md', 'b.md']],
    aggregated: false,
    hiddenCount: 0
  }
}

interface GraphBridge {
  onKnowledgeProgress: () => () => void
  getKnowledgeGraph: ReturnType<typeof vi.fn>
  knowledgeStatus: ReturnType<typeof vi.fn>
  getKnowledgeTags: ReturnType<typeof vi.fn>
  getUnresolvedLinks: ReturnType<typeof vi.fn>
  listKnowledgeNotes: ReturnType<typeof vi.fn>
  getBacklinks: ReturnType<typeof vi.fn>
}

function installBridge(graph = sampleGraph()): GraphBridge {
  const bridge: GraphBridge = {
    onKnowledgeProgress: () => () => {},
    getKnowledgeGraph: vi.fn().mockResolvedValue({ success: true, data: graph }),
    knowledgeStatus: vi
      .fn()
      .mockResolvedValue({ success: true, data: { state: 'ready', progress: { phase: 'idle', done: 0, total: 0 }, fileCount: 2 } }),
    getKnowledgeTags: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getUnresolvedLinks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    listKnowledgeNotes: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getBacklinks: vi.fn().mockResolvedValue({ success: true, data: [] })
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = bridge
  return bridge
}

describe('knowledge graph tab', () => {
  const original = window.electronAPI

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    window.electronAPI = original
  })

  it('opens active, yields the content area without losing the tab', () => {
    const store = useKnowledgeStore()

    store.openGraphTab()
    expect(store.graphTabOpen).toBe(true)
    expect(store.graphTabActive).toBe(true)

    // 切到笔记：页签留着，内容区让出去
    store.deactivateGraphTab()
    expect(store.graphTabOpen).toBe(true)
    expect(store.graphTabActive).toBe(false)

    store.activateGraphTab()
    expect(store.graphTabActive).toBe(true)
  })

  it('ignores activation while the tab is closed and resets on close', () => {
    const store = useKnowledgeStore()

    store.activateGraphTab()
    expect(store.graphTabActive).toBe(false)

    store.openGraphTab()
    store.closeGraphTab()
    expect(store.graphTabOpen).toBe(false)
    expect(store.graphTabActive).toBe(false)
  })

  it('clears the tab together with the workspace', () => {
    const store = useKnowledgeStore()
    store.openGraphTab()

    store.clear()

    expect(store.graphTabOpen).toBe(false)
    expect(store.graphTabActive).toBe(false)
    expect(store.graphVersion).toBe(0)
    expect(store.graph.nodes).toEqual(emptyGraph().nodes)
  })
})

describe('knowledge graph loading', () => {
  const original = window.electronAPI

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    window.electronAPI = original
  })

  it('stores the payload and bumps the version so views re-layout once', async () => {
    const bridge = installBridge()
    const store = useKnowledgeStore()

    await store.loadGraph()
    await store.loadGraph()

    expect(store.graph.nodes.map((node) => node.id)).toEqual(['a.md', 'b.md'])
    expect(store.graphLoaded).toBe(true)
    expect(store.graphVersion).toBe(2)
    expect(bridge.getKnowledgeGraph).toHaveBeenCalledTimes(2)
  })

  it('forwards the requested layers', async () => {
    const bridge = installBridge()
    const store = useKnowledgeStore()

    await store.loadGraph(['link'])

    // 第二个参数是护栏开关，默认按聚合拉取
    expect(bridge.getKnowledgeGraph).toHaveBeenCalledWith(['link'], { aggregated: true })
  })

  it('falls back to an empty graph when the call fails', async () => {
    const bridge = installBridge()
    bridge.getKnowledgeGraph.mockResolvedValueOnce({ success: false, error: 'boom' })
    const store = useKnowledgeStore()

    await store.loadGraph()

    expect(store.graph.nodes).toEqual([])
    expect(store.graphLoaded).toBe(true)
  })

  it('refreshes the graph on refreshAll only after it has been loaded once', async () => {
    const bridge = installBridge()
    const store = useKnowledgeStore()

    await store.refreshAll()
    expect(bridge.getKnowledgeGraph).not.toHaveBeenCalled()

    store.openGraphTab()
    await store.loadGraph()
    await store.refreshAll()
    expect(bridge.getKnowledgeGraph).toHaveBeenCalledTimes(2)
  })
})

describe('graph guardrail release', () => {
  const original = window.electronAPI

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    window.electronAPI = original
  })

  it('asks for the unaggregated graph on expand and goes back on collapse', async () => {
    const bridge = installBridge()
    const store = useKnowledgeStore()

    await store.loadGraph()
    expect(bridge.getKnowledgeGraph).toHaveBeenLastCalledWith(DEFAULT_LAYERS, { aggregated: true })

    await store.expandGraph()
    expect(store.graphExpanded).toBe(true)
    expect(bridge.getKnowledgeGraph).toHaveBeenLastCalledWith(DEFAULT_LAYERS, { aggregated: false })

    // 幂等：已经在展开态时不要再打一次 IPC
    await store.expandGraph()
    expect(bridge.getKnowledgeGraph).toHaveBeenCalledTimes(2)

    await store.collapseGraph()
    expect(store.graphExpanded).toBe(false)
    expect(bridge.getKnowledgeGraph).toHaveBeenLastCalledWith(DEFAULT_LAYERS, { aggregated: true })
    expect(bridge.getKnowledgeGraph).toHaveBeenCalledTimes(3)
  })

  it('keeps the expanded mode across refreshAll', async () => {
    const bridge = installBridge()
    const store = useKnowledgeStore()

    await store.expandGraph()
    await store.refreshAll()

    for (const call of bridge.getKnowledgeGraph.mock.calls) {
      expect(call[1]).toEqual({ aggregated: false })
    }
  })
})

describe('graph filters', () => {
  const original = window.electronAPI

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    window.electronAPI = original
  })

  it('starts wide open and can be patched and reset', () => {
    const store = useKnowledgeStore()

    expect(store.graphFilters).toEqual(defaultGraphFilters())

    store.updateGraphFilters({ orphans: 'only', filesOnly: true })
    expect(store.graphFilters.orphans).toBe('only')
    expect(store.graphFilters.filesOnly).toBe(true)
    // 未提到的字段保持不变
    expect(store.graphFilters.layers).toEqual(DEFAULT_LAYERS)

    store.resetGraphFilters()
    expect(store.graphFilters).toEqual(defaultGraphFilters())
  })

  it('toggles ordinary layers without a round trip', async () => {
    const bridge = installBridge()
    const store = useKnowledgeStore()

    await store.toggleGraphLayer('tag')
    expect(store.graphFilters.layers).not.toContain('tag')
    expect(bridge.getKnowledgeGraph).not.toHaveBeenCalled()

    await store.toggleGraphLayer('tag')
    expect(store.graphFilters.layers).toContain('tag')
    expect(bridge.getKnowledgeGraph).not.toHaveBeenCalled()
  })

  it('reloads the graph when the folder layer changes', async () => {
    const bridge = installBridge()
    const store = useKnowledgeStore()

    await store.toggleGraphLayer('folder')
    expect(store.graphFilters.layers).toContain('folder')
    expect(bridge.getKnowledgeGraph).toHaveBeenLastCalledWith(
      [...DEFAULT_LAYERS, 'folder'],
      { aggregated: true }
    )

    await store.toggleGraphLayer('folder')
    expect(store.graphFilters.layers).not.toContain('folder')
    expect(bridge.getKnowledgeGraph).toHaveBeenLastCalledWith(DEFAULT_LAYERS, { aggregated: true })
  })

  it('remembers the requested layers when expanding', async () => {
    const bridge = installBridge()
    const store = useKnowledgeStore()

    await store.toggleGraphLayer('folder')
    await store.expandGraph()

    expect(bridge.getKnowledgeGraph).toHaveBeenLastCalledWith(
      [...DEFAULT_LAYERS, 'folder'],
      { aggregated: false }
    )
  })

  it('resets filters, layers and guardrail state with the workspace', async () => {
    const store = useKnowledgeStore()
    installBridge()

    store.openGraphTab()
    store.updateGraphFilters({ folders: ['notes'], orphans: 'hide' })
    await store.toggleGraphLayer('folder')
    await store.expandGraph()

    store.clear()

    expect(store.graphFilters).toEqual(defaultGraphFilters())
    expect(store.graphLayers).toEqual(DEFAULT_LAYERS)
    expect(store.graphExpanded).toBe(false)
  })
})
