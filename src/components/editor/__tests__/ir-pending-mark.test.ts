// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  vi.stubGlobal('navigator', {
    userAgent: 'Windows',
    clipboard: { writeText: vi.fn(), readText: vi.fn(async () => '') }
  })
  // @ts-expect-error 测试环境最小 DOM
  window.requestAnimationFrame ??= (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16)
  // @ts-expect-error 测试环境最小 DOM
  window.cancelAnimationFrame ??= (id: number) => clearTimeout(id)
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await wait(40)
    await nextTick()
  }
}

function getView(wrapper: ReturnType<typeof mount>): EditorView {
  const view = (wrapper.vm as unknown as { getView: () => EditorView | null }).getView()
  if (!view) throw new Error('editor view is null')
  return view
}

/** 把光标放到指定文本之后（该文本必须唯一）。 */
function placeCaretAfter(view: EditorView, marker: string): void {
  let target = -1
  view.state.doc.descendants((node, pos) => {
    if (target >= 0 || !node.isText) return
    if (node.text === marker) target = pos + 1
  })
  if (target < 0) throw new Error(`没找到文本 ${marker}`)
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, target))
  view.dispatch(tr)
}

async function openEditor(content: string): Promise<ReturnType<typeof mount>> {
  stubElectronAPI(content)
  const store = useFileStore()
  await store.openFile('C:/ws/a.md')
  const wrapper = mount(IrEditor, { attachTo: document.body })
  await settle()
  return wrapper
}

describe('IR 空选区的行内格式符号预览', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('空段落里点加粗会在光标两侧画出 **', async () => {
    const wrapper = await openEditor('正文段落\n')
    const view = getView(wrapper)
    placeCaretAfter(view, '正文段落')
    await settle()

    window.dispatchEvent(new CustomEvent('editor:format', { detail: 'bold' }))
    await settle()

    const markers = Array.from(
      document.querySelectorAll<HTMLElement>('.ProseMirror .ir-pending-mark')
    ).map((node) => node.textContent)
    expect(markers).toEqual(['**', '**'])
    wrapper.unmount()
  })

  it('空段落里点行内代码会在光标两侧画出反引号', async () => {
    const wrapper = await openEditor('正文段落\n')
    const view = getView(wrapper)
    placeCaretAfter(view, '正文段落')
    await settle()

    window.dispatchEvent(new CustomEvent('editor:format', { detail: 'code' }))
    await settle()

    const markers = Array.from(
      document.querySelectorAll<HTMLElement>('.ProseMirror .ir-pending-mark')
    ).map((node) => node.textContent)
    expect(markers).toEqual(['`', '`'])
    wrapper.unmount()
  })

  it('打完字后待生效符号消失，正文只留下文字', async () => {
    const wrapper = await openEditor('正文段落\n')
    const view = getView(wrapper)
    placeCaretAfter(view, '正文段落')
    await settle()

    window.dispatchEvent(new CustomEvent('editor:format', { detail: 'bold' }))
    await settle()
    expect(document.querySelectorAll('.ir-pending-mark')).toHaveLength(2)

    view.dispatch(view.state.tr.insertText('重点'))
    await settle()

    expect(document.querySelectorAll('.ir-pending-mark')).toHaveLength(0)
    expect(view.state.doc.textContent).toContain('重点')
    // 打的字要真的带上加粗，而不只是「符号消失了」
    let boldText = ''
    view.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'bold')) {
        boldText += node.text
      }
    })
    expect(boldText).toBe('重点')
    wrapper.unmount()
  })

  it('再点一次加粗会撤掉预览符号', async () => {
    const wrapper = await openEditor('正文段落\n')
    const view = getView(wrapper)
    placeCaretAfter(view, '正文段落')
    await settle()

    window.dispatchEvent(new CustomEvent('editor:format', { detail: 'bold' }))
    await settle()
    expect(document.querySelectorAll('.ir-pending-mark')).toHaveLength(2)

    window.dispatchEvent(new CustomEvent('editor:format', { detail: 'bold' }))
    await settle()

    expect(document.querySelectorAll('.ir-pending-mark')).toHaveLength(0)
    wrapper.unmount()
  })

  it('光标已在加粗文本内部时不再叠加一轮星号', async () => {
    const wrapper = await openEditor('前文 **加粗** 后文\n')
    const view = getView(wrapper)
    placeCaretAfter(view, '加粗')
    await settle()

    const before = document.querySelectorAll('.ir-pending-mark').length
    expect(before).toBe(0)
    // 真标记已经把 ** 画出来了
    expect(document.querySelectorAll('[data-mark="bold"]')).toHaveLength(1)
    wrapper.unmount()
  })
})
