// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import GraphFilters from '../GraphFilters.vue'
import { useKnowledgeStore } from '../../../stores/knowledge'
import {
  DEFAULT_LAYERS,
  defaultGraphFilters,
  type Graph
} from '../../../../shared/knowledge/graph'

function sampleGraph(): Graph {
  return {
    nodes: [
      { id: 'notes/a.md', kind: 'md', label: 'A', folder: 'notes', degree: 2, isolated: false },
      { id: 'notes/b.md', kind: 'md', label: 'B', folder: 'notes', degree: 1, isolated: false },
      { id: 'loose/c.md', kind: 'md', label: 'C', folder: 'loose', degree: 0, isolated: true },
      { id: '#topic', kind: 'tag', label: '#topic', folder: '', degree: 1, isolated: false }
    ],
    edges: [
      { from: 'notes/a.md', to: 'notes/b.md', layer: 'link' },
      { from: 'notes/a.md', to: '#topic', layer: 'tag' }
    ],
    isolated: ['loose/c.md'],
    components: [['#topic', 'notes/a.md', 'notes/b.md'], ['loose/c.md']],
    aggregated: false,
    hiddenCount: 0
  }
}

function mountPanel() {
  return mount(GraphFilters)
}

/**
 * 装上假的知识库桥
 *
 * 注意不能用 `vi.spyOn(store, 'loadGraph')` 来观察「开关某一层是否重新拉图」：
 * setup store 里 `toggleGraphLayer` 调的是闭包内的 `loadGraph`，绕过 store 上的属性，
 * 于是 spy 永远数不到。真正可观测的副作用是 IPC 调用本身，所以断言桥。
 */
function installBridge() {
  const bridge = {
    onKnowledgeProgress: () => () => {},
    getKnowledgeGraph: vi.fn().mockResolvedValue({ success: true, data: sampleGraph() }),
    knowledgeStatus: vi.fn().mockResolvedValue({ success: true, data: null }),
    getKnowledgeTags: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getUnresolvedLinks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    listKnowledgeNotes: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getKnowledgeOverview: vi.fn().mockResolvedValue({
      success: true,
      data: { noteCount: 1, tagCount: 1, isolatedCount: 1, brokenCount: 0, recent: [] }
    }),
    getBacklinks: vi.fn().mockResolvedValue({ success: true, data: [] })
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = bridge
  return bridge
}

describe('GraphFilters', () => {
  const original = window.electronAPI

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    useKnowledgeStore().graph = sampleGraph()
  })

  afterEach(() => {
    window.electronAPI = original
  })

  it('reflects the default filters and the visible node count', async () => {
    const wrapper = mountPanel()
    await nextTick()

    expect(wrapper.get('[data-testid="filter-summary"]').text()).toBe('4 / 4')
    for (const layer of ['link', 'resource', 'tag', 'relation', 'mention'] as const) {
      expect((wrapper.get(`[data-testid="filter-layer-${layer}"]`).element as HTMLInputElement).checked).toBe(true)
    }
    // 目录层级默认关闭
    expect((wrapper.get('[data-testid="filter-layer-folder"]').element as HTMLInputElement).checked).toBe(false)
  })

  it('toggles an ordinary layer without reloading the graph', async () => {
    const knowledge = useKnowledgeStore()
    const bridge = installBridge()
    const wrapper = mountPanel()

    await wrapper.get('[data-testid="filter-layer-tag"]').trigger('change')

    expect(knowledge.graphFilters.layers).not.toContain('tag')
    expect(bridge.getKnowledgeGraph).not.toHaveBeenCalled()
  })

  it('reloads when the folder layer is switched on', async () => {
    const knowledge = useKnowledgeStore()
    const bridge = installBridge()
    const wrapper = mountPanel()

    await wrapper.get('[data-testid="filter-layer-folder"]').trigger('change')

    expect(knowledge.graphFilters.layers).toContain('folder')
    // 目录边由主进程按需生成，开关必须重新拉图
    expect(bridge.getKnowledgeGraph).toHaveBeenCalledWith(
      [...DEFAULT_LAYERS, 'folder'],
      { aggregated: true }
    )
  })

  it('switches the orphan mode and keeps the count in sync', async () => {
    const knowledge = useKnowledgeStore()
    const wrapper = mountPanel()

    await wrapper.get('[data-testid="filter-orphans-only"]').trigger('click')
    await nextTick()

    expect(knowledge.graphFilters.orphans).toBe('only')
    expect(knowledge.graphFilters.filesOnly).toBe(false)
    expect(wrapper.get('[data-testid="filter-summary"]').text()).toBe('1 / 4')
  })

  it('toggles the files-only switch', async () => {
    const knowledge = useKnowledgeStore()
    const wrapper = mountPanel()

    await wrapper.get('[data-testid="filter-files-only"]').trigger('change')

    expect(knowledge.graphFilters.filesOnly).toBe(true)
    // 只剩三个文件节点
    expect(wrapper.get('[data-testid="filter-summary"]').text()).toBe('3 / 4')
  })

  it('narrows by folder and returns to null when everything is selected again', async () => {
    const knowledge = useKnowledgeStore()
    const wrapper = mountPanel()

    await wrapper.get('[data-testid="filter-folder-loose"]').trigger('change')
    expect(knowledge.graphFilters.folders).toEqual(['notes'])

    await wrapper.get('[data-testid="filter-folder-loose"]').trigger('change')
    expect(knowledge.graphFilters.folders).toBeNull()
  })

  it('narrows by tag', async () => {
    const knowledge = useKnowledgeStore()
    const wrapper = mountPanel()

    await wrapper.get('[data-testid="filter-tag-#topic"]').trigger('change')

    expect(knowledge.graphFilters.tags).toEqual([])
  })

  it('resets every dimension', async () => {
    const knowledge = useKnowledgeStore()
    knowledge.updateGraphFilters({ orphans: 'hide', filesOnly: true, folders: ['notes'] })
    const wrapper = mountPanel()

    await wrapper.get('[data-testid="filter-reset"]').trigger('click')

    expect(knowledge.graphFilters).toEqual(defaultGraphFilters())
  })

  it('offers to release the guardrail and warns about the cost', async () => {
    const knowledge = useKnowledgeStore()
    knowledge.graph = { ...sampleGraph(), aggregated: true, hiddenCount: 120 }
    const expand = vi.spyOn(knowledge, 'expandGraph').mockResolvedValue()
    const wrapper = mountPanel()

    expect(wrapper.get('[data-testid="filter-aggregated-note"]').text()).toContain('120')

    await wrapper.get('[data-testid="filter-expand"]').trigger('click')
    expect(expand).toHaveBeenCalledTimes(1)
  })

  it('offers to restore aggregation once the guardrail is released', async () => {
    const knowledge = useKnowledgeStore()
    knowledge.graphExpanded = true
    const collapse = vi.spyOn(knowledge, 'collapseGraph').mockResolvedValue()
    const wrapper = mountPanel()

    expect(wrapper.get('[data-testid="filter-expanded-note"]').exists()).toBe(true)

    await wrapper.get('[data-testid="filter-collapse"]').trigger('click')
    expect(collapse).toHaveBeenCalledTimes(1)
  })

  it('hides the guardrail block when nothing was aggregated', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('[data-testid="filter-guardrail"]').exists()).toBe(false)
  })
})
