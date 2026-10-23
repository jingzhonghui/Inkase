// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import LocalGraphPanel from '../LocalGraphPanel.vue'
import type { Graph } from '../../../../shared/knowledge/graph'
import { useFileStore } from '../../../stores/file'
import { useKnowledgeStore } from '../../../stores/knowledge'
import type { TabInfo } from '../../../stores/file/types'

/** jsdom 没有 ResizeObserver，面板靠它测尺寸 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    nodes: [
      { id: 'a.md', kind: 'md', label: 'a', folder: '', degree: 1, isolated: false },
      { id: 'b.md', kind: 'md', label: 'b', folder: '', degree: 1, isolated: false }
    ],
    edges: [{ from: 'a.md', to: 'b.md', layer: 'link' }],
    isolated: [],
    components: [['a.md', 'b.md']],
    aggregated: false,
    hiddenCount: 0,
    ...overrides
  }
}

/** 把当前笔记设成库内的 `a.md` */
function openNoteAt(relPath: string): void {
  const fileStore = useFileStore()
  fileStore.openedFolderPath = 'C:/ws'
  fileStore.tabs = [
    {
      id: 'tab-1',
      fileInfo: { path: `C:/ws/${relPath}`, name: relPath, modified: false, format: 'markdown' },
      document: null,
      content: '',
      revision: 0
    } as unknown as TabInfo
  ]
  fileStore.activeTabId = 'tab-1'
}

describe('LocalGraphPanel', () => {
  const originalElectronAPI = window.electronAPI

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    // 没有知识库 bridge：store 整体降级，不会去调 IPC
    window.electronAPI = {} as unknown as typeof window.electronAPI
  })

  afterEach(() => {
    window.electronAPI = originalElectronAPI
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('没有当前笔记时给出提示而不画图', () => {
    const wrapper = mount(LocalGraphPanel)

    expect(wrapper.find('[data-testid="graph-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="graph-svg"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('打开一篇笔记')
  })

  it('有当前笔记与图谱时渲染节点', async () => {
    const knowledge = useKnowledgeStore()
    openNoteAt('a.md')
    knowledge.graph = makeGraph()

    const wrapper = mount(LocalGraphPanel)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="graph-svg"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-graph-node]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="graph-summary"]').text()).toContain('2 节点')
  })

  it('跳数默认 2，可切到 1/3', async () => {
    const knowledge = useKnowledgeStore()
    openNoteAt('a.md')
    knowledge.graph = makeGraph()

    const wrapper = mount(LocalGraphPanel)
    await wrapper.vm.$nextTick()

    const buttons = wrapper.findAll('.depth-button')
    expect(buttons).toHaveLength(3)
    expect(buttons[1].classes()).toContain('active')

    await buttons[2].trigger('click')
    expect(buttons[2].classes()).toContain('active')
    expect(buttons[1].classes()).not.toContain('active')
  })

  it('当前笔记不在索引里时说明原因', async () => {
    const knowledge = useKnowledgeStore()
    openNoteAt('ghost.md')
    knowledge.graph = makeGraph()

    const wrapper = mount(LocalGraphPanel)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="graph-empty"]').text()).toContain('尚未进入索引')
  })

  it('索引降级时提示不可用', async () => {
    const knowledge = useKnowledgeStore()
    openNoteAt('a.md')
    knowledge.status = {
      state: 'degraded',
      progress: { phase: 'idle', done: 0, total: 0 },
      fileCount: 0
    }

    const wrapper = mount(LocalGraphPanel)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="graph-empty"]').text()).toContain('索引不可用')
  })

  it('被护栏聚合时明确告知聚合了多少节点', async () => {
    const knowledge = useKnowledgeStore()
    openNoteAt('a.md')
    knowledge.graph = makeGraph({ aggregated: true, hiddenCount: 42 })

    const wrapper = mount(LocalGraphPanel)
    await wrapper.vm.$nextTick()

    const notice = wrapper.find('[data-testid="graph-aggregated"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('42')
  })
})
