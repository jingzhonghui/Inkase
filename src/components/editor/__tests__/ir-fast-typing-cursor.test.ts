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

const content = [
  '开场段落，用来把光标放得离文档开头足够远。',
  '',
  '第二段同样要有足够多的文字，避免断言「回到开头」时被巧合命中。',
  ''
].join('\n')

describe('IrEditor 快速输入时的光标稳定性', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('同一帧内连续输入：内容不丢、光标不回到文档开头', async () => {
    stubElectronAPI(content)
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')

    const wrapper = mount(IrEditor, { attachTo: document.body })
    await settle()
    const view = getView(wrapper)

    // 先把光标放到文档末尾，模拟用户接着末尾继续输入
    const end = view.state.doc.content.size
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end - 1)))

    // 同一帧内连按两次（真实场景：快速键入、按键重复、输入法一次提交多个字符）
    view.dispatch(view.state.tr.insertText('甲'))
    view.dispatch(view.state.tr.insertText('乙'))
    const caretAfterTyping = view.state.selection.from

    // 等回写（requestAnimationFrame）与 store → 编辑器的同步 watcher 都跑完
    await settle()

    const after = getView(wrapper)
    expect(after.state.doc.textContent).toContain('甲乙')
    expect(store.fileContent).toContain('甲乙')
    expect(after.state.selection.from).toBeGreaterThan(10)
    expect(after.state.selection.from).toBe(caretAfterTyping)

    wrapper.unmount()
  })

  it('外部改动（非回写回声）仍然会同步进编辑器', async () => {
    stubElectronAPI(content)
    const store = useFileStore()
    await store.openFile('C:/ws/a.md')

    const wrapper = mount(IrEditor, { attachTo: document.body })
    await settle()

    // 模拟 AI / 外部重载写入：内容与编辑器完全不同，必须被采纳
    store.updateContent('# 外部写入的标题\n\n新的正文\n')
    await settle()

    const view = getView(wrapper)
    expect(view.state.doc.textContent).toContain('外部写入的标题')
    expect(view.state.doc.textContent).not.toContain('开场段落')

    wrapper.unmount()
  })
})
