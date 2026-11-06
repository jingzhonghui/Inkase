// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SourceEditor from '../SourceEditor.vue'
import { useFileStore } from '../../../stores/file'

const longContent = Array.from({ length: 80 }, (_, i) => `第 ${i} 行内容，用来撑出可滚动的高度。`).join('\n')

function mockScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  let top = 0
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value }
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    // 等一个动画帧，让按帧合并的滚动保存真正执行
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await nextTick()
  }
}

describe('SourceEditor 切换编辑模式保持阅读位置', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    Object.defineProperty(window, 'electronAPI', { value: {}, configurable: true })
    Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList)
    Range.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
      toJSON: () => ({})
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('卸载时记录滚动比例，重新挂载后恢复（模拟切换编辑模式）', async () => {
    const store = useFileStore()
    const tab = store.createGeneratedDocument('One', longContent, 'markdown')!
    const wrapper = mount(SourceEditor, {
      attachTo: document.body,
      global: { stubs: { EditorContextMenu: true } }
    })

    const view = wrapper.vm.getView()!
    mockScrollMetrics(view.scrollDOM, 5000, 800)

    // 阅读到文档中段
    view.scrollDOM.scrollTop = 2100
    view.scrollDOM.dispatchEvent(new Event('scroll'))
    await settle()

    expect(tab.savedEditorPosition?.scrollRatio).toBeCloseTo(0.5, 5)

    // 模拟切换模式：组件整体卸载后重建
    wrapper.unmount()
    await nextTick()

    const second = mount(SourceEditor, {
      attachTo: document.body,
      global: { stubs: { EditorContextMenu: true } }
    })
    const view2 = second.vm.getView()!
    mockScrollMetrics(view2.scrollDOM, 5000, 800)
    await settle()

    // 同一模式下用像素精确恢复
    expect(view2.scrollDOM.scrollTop).toBe(2100)
    second.unmount()
  })

  it('从其它模式切回时按比例恢复（布局高度不同）', async () => {
    const store = useFileStore()
    const tab = store.createGeneratedDocument('One', longContent, 'markdown')!
    // 当前处于源码模式，但上次位置记录来自即时渲染模式：像素不可通用，只能按比例
    store.setEditorMode('source')
    tab.savedEditorPosition = { scrollTop: 3000, scrollRatio: 0.5, mode: 'ir', from: 0, to: 0 }

    const wrapper = mount(SourceEditor, {
      attachTo: document.body,
      global: { stubs: { EditorContextMenu: true } }
    })
    const view = wrapper.vm.getView()!
    mockScrollMetrics(view.scrollDOM, 5000, 800)
    await settle()

    expect(view.scrollDOM.scrollTop).toBe(2100)
    wrapper.unmount()
  })
})
