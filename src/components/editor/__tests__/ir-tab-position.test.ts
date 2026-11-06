// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import IrEditor from '../IrEditor.vue'
import { useFileStore } from '../../../stores/file'
import { createMdxDocument } from '../../../types/mdx'

function stubElectronAPI(content: string): void {
  const api = {
    openFile: vi.fn().mockResolvedValue({
      success: true,
      data: {
        document: createMdxDocument('doc', content),
        filePath: 'C:/ws/a.md',
        format: 'markdown',
        isNew: false,
        largeFileWarning: false
      }
    }),
    getImage: vi.fn(async () => ({ success: true })),
    setCachedImage: vi.fn(),
    getRecentFiles: vi.fn(async () => ({ success: true, data: [] })),
    clearRecovery: vi.fn(async () => ({ success: true })),
    writeRecovery: vi.fn(async () => ({ success: true })),
    readRecovery: vi.fn(async () => ({ success: true, data: null })),
    recoveryStatus: vi.fn(async () => ({ success: true, data: { available: false } })),
    addRecentFile: vi.fn(async () => ({ success: true }))
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn()
  })
  vi.stubGlobal('navigator', { userAgent: 'Windows', clipboard: { writeText: vi.fn(), readText: vi.fn(async () => '') } })
  // @ts-expect-error 测试环境最小 DOM
  window.requestAnimationFrame ??= (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16)
  // @ts-expect-error 测试环境最小 DOM
  window.cancelAnimationFrame ??= (id: number) => clearTimeout(id)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    await nextTick()
  }
}

function getView(wrapper: ReturnType<typeof mount>): EditorView {
  const view = (wrapper.vm as unknown as { getView: () => EditorView | null }).getView()
  if (!view) throw new Error('editor view is null')
  return view
}

const longContent = Array.from({ length: 60 }, (_, i) => `这是第 ${i} 段内容，用于撑起文档长度。`).join('\n\n')

describe('IrEditor 标签页切换保持阅读位置', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('卸载时保存光标位置，重新挂载后恢复', async () => {
    stubElectronAPI(longContent)
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')
    const tabId = store.activeTabId!
    const docSize = store.fileContent.length

    const first = mount(IrEditor, { attachTo: document.body })
    await settle()

    // 把光标移到文档中段
    const target = Math.floor(docSize / 2)
    const view = getView(first)
    view.dispatch(view.state.tr.setSelection(TextSelection.between(
      view.state.doc.resolve(Math.min(target, view.state.doc.content.size)),
      view.state.doc.resolve(Math.min(target, view.state.doc.content.size))
    )))
    await nextTick()

    // 模拟切走标签：组件被卸载
    first.unmount()
    await nextTick()

    const tab = store.tabs.find((t) => t.id === tabId)
    expect(tab?.savedEditorPosition).toBeDefined()
    expect(tab!.savedEditorPosition!.from).toBeGreaterThan(0)
    expect(tab!.savedEditorPosition!.from).toBeLessThanOrEqual(view.state.doc.content.size)

    // 模拟切回标签：重新挂载组件，应恢复光标
    const saved = tab!.savedEditorPosition!
    const second = mount(IrEditor, { attachTo: document.body })
    await settle()
    const view2 = getView(second)
    expect(view2.state.selection.from).toBe(saved.from)
    expect(view2.state.selection.to).toBe(saved.to)

    second.unmount()
  })

  it('无保存位置时从文档开头开始（首次打开）', async () => {
    stubElectronAPI(longContent)
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')

    const wrapper = mount(IrEditor, { attachTo: document.body })
    await settle()

    expect(getView(wrapper).state.selection.from).toBeLessThan(10)
    wrapper.unmount()
  })

  it('IR 光标移动后同步状态栏行列', async () => {
    const content = 'first\n\nsecond line'
    stubElectronAPI(content)
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')

    const wrapper = mount(IrEditor, { attachTo: document.body })
    await settle()
    const view = getView(wrapper)
    const secondLineStart = view.state.doc.child(0).nodeSize + 1
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, secondLineStart)))
    await nextTick()

    expect(store.cursorLine).toBe(3)
    expect(store.cursorColumn).toBe(1)
    wrapper.unmount()
  })

  it('卸载保存滚动位置，重新挂载后恢复到原滚动位置', async () => {
    stubElectronAPI(longContent)
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')
    const tabId = store.activeTabId!

    const first = mount(IrEditor, { attachTo: document.body })
    await settle()

    // jsdom 不参与布局，这里用可控属性模拟一个有滚动空间的容器
    const container = first.find('.ir-container').element
    let scrollTop = 0
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => 5000 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => 800 })
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => { scrollTop = v }
    })

    // 模拟用户阅读到文档中段（向下滚动到 3000px，并触发真实滚动事件，
    // 让编辑器在滚动时实时保存阅读位置）
    container.scrollTop = 3000
    container.dispatchEvent(new Event('scroll'))
    await settle()

    first.unmount()
    await nextTick()

    const saved = store.tabs.find((t) => t.id === tabId)?.savedEditorPosition
    expect(saved?.scrollTop).toBe(3000)

    // 重新挂载（模拟切回该标签），应恢复滚动位置
    const second = mount(IrEditor, { attachTo: document.body })
    const container2 = second.find('.ir-container').element
    let scrollTop2 = 0
    Object.defineProperty(container2, 'scrollHeight', { configurable: true, get: () => 5000 })
    Object.defineProperty(container2, 'clientHeight', { configurable: true, get: () => 800 })
    Object.defineProperty(container2, 'scrollTop', {
      configurable: true,
      get: () => scrollTop2,
      set: (v: number) => { scrollTop2 = v }
    })
    await settle()

    expect(container2.scrollTop).toBe(3000)
    second.unmount()
  })

  it('从源码模式切回时按滚动比例恢复（布局高度不同）', async () => {
    stubElectronAPI(longContent)
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')
    // 当前处于即时渲染模式，上次记录来自源码模式
    store.setEditorMode('ir')
    const tab = store.activeTab!
    tab.savedEditorPosition = { scrollTop: 3000, scrollRatio: 0.5, mode: 'source', from: 0, to: 0 }

    const wrapper = mount(IrEditor, { attachTo: document.body })
    const container = wrapper.find('.ir-container').element
    let scrollTop = 0
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => 5000 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => 800 })
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => { scrollTop = v }
    })
    await settle()

    // 像素 3000 属于源码编辑器，跨模式只能按比例：0.5 × (5000 - 800) = 2100
    expect(container.scrollTop).toBe(2100)
    wrapper.unmount()
  })
})

describe('IrEditor 滚动保存不丢锚点偏移', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('选区变化触发位置写回时，anchorLine / anchorOffsetPx 应原样保留', async () => {
    stubElectronAPI(longContent)
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')
    const tab = store.activeTab!
    // 模拟上一次滚动记下的锚点（jsdom 没有布局，updateAnchorLine 会跳过）
    tab.savedEditorPosition = {
      scrollTop: 1200,
      scrollRatio: 0.3,
      anchorLine: 7,
      anchorOffsetPx: 640,
      mode: 'ir',
      from: 0,
      to: 0
    }

    const wrapper = mount(IrEditor, { attachTo: document.body })
    await settle()
    const view = getView(wrapper)

    // 触发一次 dispatch（dispatchTransaction 内会调用 updateSavedPosition）
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)))
    await nextTick()

    const saved = store.activeTab!.savedEditorPosition!
    expect(saved.anchorLine).toBe(7)
    expect(saved.anchorOffsetPx).toBe(640)
    wrapper.unmount()
  })
})
