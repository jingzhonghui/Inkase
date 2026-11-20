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

/**
 * 回归：即时渲染模式下查找必须把匹配带进视野。
 *
 * 早先 `jumpToMatch` 只改选区、不滚，而查找时焦点在查找框上，
 * ProseMirror 的 `selectionToDOM` 因 `editorOwnsSelection` 为 false 整段跳过，
 * `scrollToSelection` 判定选区不在编辑器内、一步也不滚 —— 表现就是「点了查找，视图不动」。
 * 这里锁住修复后的可观测约定：查找词出来之后，当前匹配必须被选中。
 */

const CONTENT = '# 标题\n\n开头 words 结束\n\n中间段落\n\n结尾 words 结束\n'
const NEEDLE = 'words'

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

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    await nextTick()
  }
}

/** 文档里所有匹配的起始位置，顺序与查找面板的 1/2/3… 编号一致 */
function matchPositions(view: EditorView, needle: string): number[] {
  const positions: number[] = []
  view.state.doc.descendants((node, pos) => {
    if (!node.isText) return true
    const text = node.text ?? ''
    let idx = text.indexOf(needle)
    while (idx !== -1) {
      positions.push(pos + idx)
      idx = text.indexOf(needle, idx + needle.length)
    }
    return true
  })
  return positions
}

describe('IrEditor 查找定位', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('打开查找后落到第一个匹配并把它选中（视图跟随的前提）', async () => {
    stubElectronAPI(CONTENT)
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')

    const wrapper = mount(IrEditor, { attachTo: document.body })
    await settle()

    const view = (wrapper.vm as unknown as { getView: () => EditorView | null }).getView()
    expect(view).toBeTruthy()

    const positions = matchPositions(view as EditorView, NEEDLE)
    expect(positions).toHaveLength(2)

    // 用户先选中**最后一处**匹配再按 Ctrl+F：查找框以它预填，
    // 搜索后应跳回第一处 —— 这是「视图没跟随」时最容易观察到的差异
    const last = positions[1]
    ;(view as EditorView).dispatch(
      (view as EditorView).state.tr.setSelection(
        TextSelection.create((view as EditorView).state.doc, last, last + NEEDLE.length)
      )
    )
    await nextTick()

    window.dispatchEvent(new CustomEvent('editor:find'))
    await settle()

    const selection = (view as EditorView).state.selection
    expect(selection.from).toBe(positions[0])
    expect(selection.to).toBe(positions[0] + NEEDLE.length)
    wrapper.unmount()
  })

  it('点「下一个」后选中下一处匹配，且焦点仍留在查找框', async () => {
    stubElectronAPI(CONTENT)
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')

    const wrapper = mount(IrEditor, { attachTo: document.body })
    await settle()

    const view = (wrapper.vm as unknown as { getView: () => EditorView | null }).getView() as EditorView
    const positions = matchPositions(view, NEEDLE)
    expect(positions).toHaveLength(2)

    window.dispatchEvent(new CustomEvent('editor:find'))
    await settle()

    const panel = wrapper.findComponent({ name: 'FindReplacePanel' })
    await panel.find('input.find-replace-input').setValue(NEEDLE)
    await nextTick()

    // 输入查找词后先落到第一处
    expect(view.state.selection.from).toBe(positions[0])
    expect(view.state.selection.to).toBe(positions[0] + NEEDLE.length)

    const nextButton = panel.findAll('button').find((b) => b.attributes('aria-label') === '下一个')
    expect(nextButton).toBeTruthy()
    await nextButton!.trigger('click')
    await nextTick()

    const selection = view.state.selection
    expect(selection.from).toBe(positions[1])
    expect(selection.to).toBe(positions[1] + NEEDLE.length)
    // 跳转不能把焦点从查找框抢走，否则下一次输入会打进正文
    expect(document.activeElement?.className).toContain('find-replace-input')
    wrapper.unmount()
  })
})
