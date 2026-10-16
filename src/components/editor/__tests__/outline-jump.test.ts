// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { EditorView } from 'prosemirror-view'
import IrEditor from '../IrEditor.vue'
import SourceEditor from '../SourceEditor.vue'
import { useFileStore } from '../../../stores/file'
import { useOutlineStore } from '../../../stores/outline'
import { createMdxDocument } from '../../../types/mdx'
import { collectOutlineHeadings } from '../../../utils/prosemirror/outline'

const content = '# 第一章\n\n正文\n\n## 第二节'

function stubGlobals(): void {
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
  Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList)
  Range.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({})
  }))
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    await nextTick()
  }
}

describe('IrEditor 大纲发布与跳转', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

  it('publishes top-level headings to the outline store', async () => {
    stubGlobals()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
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
        setCachedImage: vi.fn()
      }
    })
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')

    const wrapper = mount(IrEditor, { attachTo: document.body })
    await settle()

    const outline = useOutlineStore()
    expect(outline.headings).toEqual([
      { level: 1, text: '第一章' },
      { level: 2, text: '第二节' }
    ])
    wrapper.unmount()
  })

  it('jumps to the heading matching the event index', async () => {
    stubGlobals()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
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
        setCachedImage: vi.fn()
      }
    })
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')
    const wrapper = mount(IrEditor, { attachTo: document.body })
    await settle()

    const view = (wrapper.vm as unknown as { getView: () => EditorView | null }).getView()!
    const headings = collectOutlineHeadings(view.state.doc)

    window.dispatchEvent(new CustomEvent('inkase:outline-jump', { detail: { index: 1 } }))
    await nextTick()

    expect(view.state.selection.from).toBe(headings[1].pos + 1)
    wrapper.unmount()
  })
})

describe('SourceEditor 大纲发布与跳转', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

  it('publishes headings and jumps to the matching line', async () => {
    stubGlobals()
    Object.defineProperty(window, 'electronAPI', { value: {}, configurable: true })
    const store = useFileStore()
    store.createGeneratedDocument('Doc', content, 'markdown')

    const wrapper = mount(SourceEditor, { global: { stubs: { EditorContextMenu: true } } })
    await nextTick()

    const outline = useOutlineStore()
    expect(outline.headings).toEqual([
      { level: 1, text: '第一章' },
      { level: 2, text: '第二节' }
    ])

    const view = (wrapper.vm as unknown as { getView: () => EditorView | null }).getView()!
    window.dispatchEvent(new CustomEvent('inkase:outline-jump', { detail: { index: 1 } }))
    await nextTick()

    const line = view.state.doc.line(5)
    expect(view.state.selection.main.anchor).toBe(line.from)
    wrapper.unmount()
  })
})
