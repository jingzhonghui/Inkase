// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import GlobalGraphView from '../GlobalGraphView.vue'
import { useKnowledgeStore } from '../../../stores/knowledge'
import { useFileStore } from '../../../stores/file'
import type { Graph } from '../../../../shared/knowledge/graph'

/** jsdom 没有 ResizeObserver，这里立刻回报一个固定视口 */
class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ target, contentRect: { width: 900, height: 600 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver
    )
  }
  unobserve(): void {}
  disconnect(): void {}
}

function sampleGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    nodes: [
      { id: 'a.md', kind: 'md', label: 'A', folder: 'notes', degree: 1, isolated: false },
      { id: 'b.md', kind: 'md', label: 'B', folder: 'notes', degree: 1, isolated: false },
      { id: 'c.md', kind: 'md', label: 'C', folder: '', degree: 0, isolated: true }
    ],
    edges: [{ from: 'a.md', to: 'b.md', layer: 'link' }],
    isolated: ['c.md'],
    components: [['a.md', 'b.md'], ['c.md']],
    aggregated: false,
    hiddenCount: 0,
    ...overrides
  }
}

/** 记录绘制调用的假 2D 上下文 */
function fakeContext(): { context: CanvasRenderingContext2D; arc: ReturnType<typeof vi.fn> } {
  const arc = vi.fn()
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc,
    fill: vi.fn(),
    rect: vi.fn(),
    closePath: vi.fn(),
    setLineDash: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 24 })),
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: ''
  }
  return { context: context as unknown as CanvasRenderingContext2D, arc }
}

function openVault(): void {
  useFileStore().openedFolderPath = 'C:/ws'
}

/** 等 rAF 里的布局与绘制跑完（并行跑测试时 rAF 可能被推迟，用轮询而不是固定睡眠） */
async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 40))
  await nextTick()
}

describe('GlobalGraphView', () => {
  let arc: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const fake = fakeContext()
    arc = fake.arc
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fake.context as unknown as RenderingContext
    )
  })

  it('asks for a folder before trying to draw anything', async () => {
    const wrapper = mount(GlobalGraphView)
    await nextTick()

    expect(wrapper.get('[data-testid="graph-empty"]').text()).toContain('先打开一个文件夹')
    expect(wrapper.find('[data-testid="graph-stats"]').exists()).toBe(false)
  })

  it('reports the aggregate counts for the current vault', async () => {
    openVault()
    useKnowledgeStore().graph = sampleGraph()

    const wrapper = mount(GlobalGraphView)
    await settle()

    expect(wrapper.get('[data-testid="graph-stats"]').text()).toBe('3 节点 · 1 连线 · 1 孤立')
    expect(wrapper.find('[data-testid="graph-canvas"]').exists()).toBe(true)
    // 布局跑完后节点被真正画出来（3 个节点 + 可能的孤立环）
    await vi.waitFor(() => expect(arc.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 3000
    })
  })

  it('freezes the layout once it settles', async () => {
    openVault()
    useKnowledgeStore().graph = sampleGraph()

    const wrapper = mount(GlobalGraphView)
    await settle()

    await vi.waitFor(
      () => expect(wrapper.find('[data-testid="graph-frozen"]').exists()).toBe(true),
      { timeout: 3000 }
    )
    const before = wrapper.get('[data-testid="graph-frozen"]').text()
    expect(before).toContain('布局已冻结')
    expect(before).toMatch(/布局已冻结 · \d+ms/)
  })

  it('tells the user when the guardrail already aggregated the vault', async () => {
    openVault()
    useKnowledgeStore().graph = sampleGraph({ aggregated: true, hiddenCount: 42 })

    const wrapper = mount(GlobalGraphView)
    await settle()

    expect(wrapper.get('[data-testid="graph-aggregated"]').text()).toContain('42')
  })

  it('degrades instead of throwing when the index is unavailable', async () => {
    openVault()
    useKnowledgeStore().status = {
      state: 'degraded',
      progress: { phase: 'idle', done: 0, total: 0 },
      fileCount: 0
    }

    const wrapper = mount(GlobalGraphView)
    await nextTick()

    expect(wrapper.get('[data-testid="graph-empty"]').text()).toContain('索引不可用')
  })

  it('offers a fit button and a relayout button', async () => {
    openVault()
    useKnowledgeStore().graph = sampleGraph()

    const wrapper = mount(GlobalGraphView)
    await settle()

    expect(wrapper.find('[data-testid="graph-fit"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="graph-relayout"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="graph-search"]').exists()).toBe(true)
  })
})
