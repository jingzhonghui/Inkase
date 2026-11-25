// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorState, TextSelection } from 'prosemirror-state'
import MarkdownToolbar from '../MarkdownToolbar.vue'
import { parseMarkdown } from '../../../utils/prosemirror'
import { readFormatStateFromProseMirror } from '../../../utils/prosemirror/format-state'
import {
  EDITOR_FORMAT_STATE_EVENT,
  EMPTY_EDITOR_FORMAT_STATE,
  type EditorFormatState
} from '../../../types/editor-format-state'

/**
 * 工具栏只做两件事：把点击翻译成 `editor:*` 事件、把 `editor:format-state`
 * 翻译成按钮高亮。所以这一组用例全部在验证这两条通道，不碰任何真实编辑器。
 */
function emitFormatState(patch: Partial<EditorFormatState>): void {
  window.dispatchEvent(
    new CustomEvent(EDITOR_FORMAT_STATE_EVENT, {
      detail: { ...EMPTY_EDITOR_FORMAT_STATE, ...patch }
    })
  )
}

function mountToolbar(): ReturnType<typeof mount> {
  return mount(MarkdownToolbar, { attachTo: document.body })
}

describe('MarkdownToolbar 命令派发', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    Object.defineProperty(window, 'electronAPI', { value: {}, configurable: true })
  })

  it('点击加粗派发 editor:format', async () => {
    const listener = vi.fn()
    window.addEventListener('editor:format', listener)
    const wrapper = mountToolbar()
    await nextTick()

    await wrapper.find('[data-format="bold"]').trigger('click')

    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('bold')
    window.removeEventListener('editor:format', listener)
    wrapper.unmount()
  })

  it('代码块按钮带上 language 字段，不是裸事件', async () => {
    const listener = vi.fn()
    window.addEventListener('editor:codeBlock', listener)
    const wrapper = mountToolbar()
    await nextTick()

    await wrapper.find('[data-format="codeBlock"]').trigger('click')

    // 处理器那边是 `const { language } = detail`：`new CustomEvent(name)`
    // 的 detail 是 null，解构它会抛 TypeError，按钮就变成点了没反应
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ language: '' })
    window.removeEventListener('editor:codeBlock', listener)
    wrapper.unmount()
  })

  it('链接按钮复用顶栏对话框，不自己弹第二个', async () => {
    const listener = vi.fn()
    window.addEventListener('editor:showLinkDialog', listener)
    const wrapper = mountToolbar()
    await nextTick()

    await wrapper.find('[data-format="link"]').trigger('click')

    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('editor:showLinkDialog', listener)
    wrapper.unmount()
  })

  it('标题下拉选二级标题后派发 editor:heading', async () => {
    const listener = vi.fn()
    window.addEventListener('editor:heading', listener)
    const wrapper = mountToolbar()
    await nextTick()

    await wrapper.find('[data-format-trigger="heading"]').trigger('click')
    await nextTick()

    const option = document.body.querySelector<HTMLElement>('[data-heading-level="2"]')
    expect(option).not.toBeNull()
    option!.click()
    await nextTick()

    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe(2)
    window.removeEventListener('editor:heading', listener)
    wrapper.unmount()
  })
})

describe('MarkdownToolbar 高亮跟随编辑器状态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    Object.defineProperty(window, 'electronAPI', { value: {}, configurable: true })
  })

  it('收到 editor:format-state 后按钮与标题文案同步', async () => {
    const wrapper = mountToolbar()
    await nextTick()

    // 初始：什么都不亮
    expect(wrapper.find('[data-format="bold"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.find('[data-format-trigger="heading"]').text()).toContain('正文')

    emitFormatState({ bold: true, heading: 2, bulletList: true })
    await nextTick()

    expect(wrapper.find('[data-format="bold"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-format="bulletList"]').attributes('aria-pressed')).toBe('true')
    // 没在状态里的按钮不该被点亮
    expect(wrapper.find('[data-format="italic"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.find('[data-format-trigger="heading"]').text()).toContain('H2')

    wrapper.unmount()
  })
})

describe('readFormatStateFromProseMirror', () => {
  /** 在文档里找到某段文字的起点，用来摆光标 */
  function findTextPos(state: EditorState, target: string): number {
    let found = -1
    state.doc.descendants((node, pos) => {
      if (found >= 0) return false
      if (node.isText && node.text?.includes(target)) {
        found = pos + node.text.indexOf(target)
        return false
      }
      return true
    })
    return found
  }

  it('光标在二级标题里时报告 heading=2', () => {
    const state = EditorState.create({ doc: parseMarkdown('## 小标题\n\n正文') })
    const pos = findTextPos(state, '小标题')
    expect(pos).toBeGreaterThan(0)

    const withCursor = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, pos + 1))
    )
    const formatState = readFormatStateFromProseMirror(withCursor)
    expect(formatState.heading).toBe(2)
  })

  it('光标落在加粗文字里时报告 bold', () => {
    const state = EditorState.create({ doc: parseMarkdown('正文 **加粗** 结尾') })
    const pos = findTextPos(state, '加粗')

    const withCursor = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, pos + 1))
    )
    const formatState = readFormatStateFromProseMirror(withCursor)
    expect(formatState.bold).toBe(true)
    expect(formatState.italic).toBe(false)
  })
})
