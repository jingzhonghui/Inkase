// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TabBar from '../TabBar.vue'
import EditorPanel from '../EditorPanel.vue'
import { useAiStore } from '../../../stores/ai'
import { useFileStore } from '../../../stores/file'
import { useKnowledgeStore } from '../../../stores/knowledge'

class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ target, contentRect: { width: 800, height: 500 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver
    )
  }
  unobserve(): void {}
  disconnect(): void {}
}

function stubGlobals(): void {
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn()
  })
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
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
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as RenderingContext
  )
}

describe('global graph tab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubGlobals()
  })

  it('is absent until opened, then shows as an active tab', async () => {
    const wrapper = mount(TabBar)
    const knowledge = useKnowledgeStore()

    expect(wrapper.find('[data-testid="graph-tab"]').exists()).toBe(false)

    knowledge.openGraphTab()
    await nextTick()

    expect(wrapper.get('[data-testid="graph-tab"]').text()).toContain('全局图谱')
    expect(wrapper.get('[data-testid="graph-tab"]').classes()).toContain('active')
  })

  it('closes from its close button and from a middle click', async () => {
    const wrapper = mount(TabBar)
    const knowledge = useKnowledgeStore()
    knowledge.openGraphTab()
    await nextTick()

    await wrapper.get('[data-testid="graph-tab-close"]').trigger('click')
    expect(knowledge.graphTabOpen).toBe(false)

    knowledge.openGraphTab()
    await nextTick()
    await wrapper.get('[data-testid="graph-tab"]').trigger('mousedown', { button: 1 })
    expect(knowledge.graphTabOpen).toBe(false)
  })

  it('yields the content area to a file tab and takes it back', async () => {
    const wrapper = mount(TabBar)
    const knowledge = useKnowledgeStore()
    const fileStore = useFileStore()
    const tab = fileStore.createGeneratedDocument('文档', 'content', 'markdown')
    knowledge.openGraphTab()
    await nextTick()

    await wrapper.get(`[data-tab-id="${tab.id}"]`).trigger('click')
    expect(knowledge.graphTabActive).toBe(false)
    expect(knowledge.graphTabOpen).toBe(true)
    expect(wrapper.get(`[data-tab-id="${tab.id}"]`).classes()).toContain('active')

    await wrapper.get('[data-testid="graph-tab"]').trigger('click')
    expect(knowledge.graphTabActive).toBe(true)
    expect(wrapper.get(`[data-tab-id="${tab.id}"]`).classes()).not.toContain('active')
  })

  it('keeps the AI tab and the graph tab mutually exclusive', async () => {
    const wrapper = mount(TabBar)
    const knowledge = useKnowledgeStore()
    const aiStore = useAiStore()
    const fileStore = useFileStore()
    fileStore.createGeneratedDocument('文档', 'content', 'markdown')
    aiStore.openPanel()
    knowledge.openGraphTab()
    await nextTick()

    await wrapper.get('[data-testid="ai-tab"]').trigger('click')
    expect(aiStore.panelActive).toBe(true)
    expect(knowledge.graphTabActive).toBe(false)
    expect(wrapper.get('[data-testid="graph-tab"]').classes()).not.toContain('active')

    await wrapper.get('[data-testid="graph-tab"]').trigger('click')
    expect(aiStore.panelActive).toBe(false)
    expect(knowledge.graphTabActive).toBe(true)
  })
})

describe('global graph in the editor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubGlobals()
  })

  it('replaces the document area while active and restores it on close', async () => {
    const knowledge = useKnowledgeStore()
    useFileStore().createGeneratedDocument('文档', 'content', 'markdown')
    knowledge.openGraphTab()

    const wrapper = mount(EditorPanel, {
      global: {
        stubs: {
          TabBar: true,
          IrEditor: { template: '<div data-testid="document-editor" />' },
          SourceEditor: { template: '<div data-testid="document-editor" />' },
          PreviewPanel: true
        }
      }
    })
    await nextTick()

    expect(wrapper.find('[data-testid="global-graph"]').exists()).toBe(true)
    // 注意：jsdom 的 getComputedStyle 会缓存首次计算结果，v-show 反复切换后
    // isVisible() 可能读到旧值，这里直接看内联样式更可靠
    expect(wrapper.get('.document-view').attributes('style')).toContain('display: none')

    knowledge.closeGraphTab()
    await nextTick()

    expect(wrapper.find('[data-testid="global-graph"]').exists()).toBe(false)
    expect(wrapper.get('.document-view').attributes('style') ?? '').not.toContain('display: none')
  })

  it('falls back to the welcome page after closing with no files', async () => {
    const knowledge = useKnowledgeStore()
    const wrapper = mount(EditorPanel, {
      global: { stubs: { TabBar: true } }
    })
    knowledge.openGraphTab()
    await nextTick()
    expect(wrapper.find('[data-testid="global-graph"]').exists()).toBe(true)
    expect(wrapper.get('.welcome-page').attributes('style')).toContain('display: none')

    knowledge.closeGraphTab()
    await nextTick()
    expect(wrapper.get('.welcome-page').attributes('style') ?? '').not.toContain('display: none')
  })
})
