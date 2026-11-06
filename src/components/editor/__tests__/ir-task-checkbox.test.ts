// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import IrEditor from '../IrEditor.vue'
import type { EditorView } from 'prosemirror-view'
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
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    await nextTick()
  }
}

async function mountEditor(content: string): Promise<ReturnType<typeof mount>> {
  stubElectronAPI(content)
  const store = useFileStore()
  await store.openFile('C:/ws/a.md')
  const wrapper = mount(IrEditor, { attachTo: document.body })
  await settle()
  return wrapper
}

describe('IrEditor 任务列表勾选框', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('renders a real checkbox per task item and reflects checked state', async () => {
    const wrapper = await mountEditor('- [ ] todo\n- [x] done\n')
    const boxes = wrapper.findAll('input.task-checkbox')
    expect(boxes).toHaveLength(2)
    expect((boxes[0].element as HTMLInputElement).checked).toBe(false)
    expect((boxes[1].element as HTMLInputElement).checked).toBe(true)
  })

  it('toggles the source markdown when a checkbox is clicked', async () => {
    const wrapper = await mountEditor('- [ ] todo\n')
    const store = useFileStore()
    expect(store.fileContent).toContain('- [ ] todo')

    await wrapper.find('input.task-checkbox').trigger('click')
    await settle()

    expect(store.fileContent).toContain('- [x] todo')
    expect((wrapper.find('input.task-checkbox').element as HTMLInputElement).checked).toBe(true)
  })

  it('renders nested task items as separate checkboxes', async () => {
    const wrapper = await mountEditor('- [ ] 父项\n  - [x] 子项\n')
    const boxes = wrapper.findAll('input.task-checkbox')
    expect(boxes).toHaveLength(2)
    expect((boxes[0].element as HTMLInputElement).checked).toBe(false)
    expect((boxes[1].element as HTMLInputElement).checked).toBe(true)
  })

  it('does not mark the document dirty when merely opening', async () => {
    const store = useFileStore()
    await mountEditor('- [ ] todo\n- [x] done\n')
    expect(store.isModified).toBe(false)
  })

  it('typing "- [ ] " then Enter keeps a valid task list and adds a second checkbox', async () => {
    const wrapper = await mountEditor('')
    const view = (wrapper.vm as unknown as { getView: () => EditorView | null }).getView()
    expect(view).not.toBeNull()
    if (!view) return

    // 通过 inputrules 插件的 handleTextInput 逐字输入，走真实的 Markdown 输入规则链路；
    // 没有规则命中时（返回 false）由「浏览器」插入文本，这里手动补上。
    const typeText = (text: string): void => {
      const { from, to } = view.state.selection
      const handled = view.someProp('handleTextInput', (handler) => handler(view, from, to, text))
      if (!handled) {
        view.dispatch(view.state.tr.insertText(text, from, to))
      }
    }
    for (const chunk of ['-', ' ', '[', ' ', ']', ' ', '任务']) {
      typeText(chunk)
    }

    // 输入规则必须产出合法的 task_list，而不是装着 task_item 的 bullet_list
    expect(view.state.doc.firstChild?.type.name).toBe('task_list')
    expect(view.state.doc.firstChild?.firstChild?.type.name).toBe('task_item')

    // 回车：应抛异常的话这里会失败（旧实现的症状来源）
    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
    )

    const list = view.state.doc.firstChild
    expect(list?.type.name).toBe('task_list')
    expect(list?.childCount).toBe(2)
    expect(list?.child(0).textContent).toBe('任务')
    expect(list?.child(1).textContent).toBe('')
    expect(wrapper.findAll('input.task-checkbox')).toHaveLength(2)

    // 继续在第二项输入，序列化回 Markdown 应是标准 GFM 任务列表
    typeText('第二项')
    await settle()
    const store = useFileStore()
    expect(store.fileContent).toContain('- [ ] 任务')
    expect(store.fileContent).toContain('- [ ] 第二项')
  })
})
