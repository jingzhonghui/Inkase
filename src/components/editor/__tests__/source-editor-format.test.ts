// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SourceEditor from '../SourceEditor.vue'
import { useFileStore } from '../../../stores/file'

async function waitFor(cond: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!cond()) throw new Error('waitFor 超时')
}

function menuLabels(): string[] {
  return Array.from(document.body.querySelectorAll('.context-menu-item')).map(
    (node) => node.textContent?.trim() ?? ''
  )
}

describe('SourceEditor 代码格式化的右键菜单接入', () => {
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

  it('受支持文件显示「格式化文档」并能格式化内容', async () => {
    const store = useFileStore()
    store.createGeneratedDocument('data', '{"a":1,"b":[1,2]}', 'markdown')
    store.tabs[0].fileInfo = { path: 'data.json', name: 'data.json', modified: false, format: 'markdown' }
    const wrapper = mount(SourceEditor, { props: { plainText: true }, attachTo: document.body })
    await nextTick()

    await wrapper.find('.codemirror-wrapper').trigger('contextmenu', { clientX: 20, clientY: 20 })
    await nextTick()
    expect(menuLabels()).toContain('格式化文档')

    const item = Array.from(document.body.querySelectorAll<HTMLElement>('.context-menu-item')).find(
      (node) => node.textContent?.trim() === '格式化文档'
    )!
    item.click()

    await waitFor(() => store.fileContent === '{ "a": 1, "b": [1, 2] }\n')
    expect(store.fileContent).toBe('{ "a": 1, "b": [1, 2] }\n')
    wrapper.unmount()
  })

  it('不受支持文件不显示「格式化文档」', async () => {
    const store = useFileStore()
    store.createGeneratedDocument('notes', 'hello', 'markdown')
    store.tabs[0].fileInfo = { path: 'notes.txt', name: 'notes.txt', modified: false, format: 'markdown' }
    const wrapper = mount(SourceEditor, { props: { plainText: true }, attachTo: document.body })
    await nextTick()

    await wrapper.find('.codemirror-wrapper').trigger('contextmenu', { clientX: 20, clientY: 20 })
    await nextTick()
    expect(menuLabels()).not.toContain('格式化文档')
    wrapper.unmount()
  })

  /**
   * 五级/六级标题曾经会被叠加成 `###### ##### 原文`：判定既有标记与剥离标记的
   * 正则都写死成 `{1,4}`，遇到 5 个井号时匹配不上，于是「先剥再拼」退化成
   * 「只拼不剥」。工具栏的标题下拉能选到 6 级，所以这条路径现在真的会走到。
   */
  it('把五级标题改成六级不会叠加井号', async () => {
    const store = useFileStore()
    store.createGeneratedDocument('deep', '##### 五级标题', 'markdown')
    store.tabs[0].fileInfo = { path: 'deep.md', name: 'deep.md', modified: false, format: 'markdown' }
    const wrapper = mount(SourceEditor, { attachTo: document.body })
    await nextTick()

    // 光标默认在文档开头，正是那一行
    window.dispatchEvent(new CustomEvent('editor:heading', { detail: 6 }))

    await waitFor(() => store.fileContent === '###### 五级标题')
    expect(store.fileContent).toBe('###### 五级标题')
    wrapper.unmount()
  })

  /**
   * 工具栏最初把「代码块」派发成裸事件（`new CustomEvent('editor:codeBlock')`），
   * 而处理器是 `const { language } = detail` —— 解构 `null` 抛 TypeError，
   * 事件回调当场中断，用户看到的就是「点了没反应」。这里同时守住两端：
   * 不带 detail 的事件也不能把处理器打崩。
   */
  it('收到不带 detail 的 editor:codeBlock 也能插入代码块', async () => {
    const store = useFileStore()
    store.createGeneratedDocument('code', 'hello', 'markdown')
    store.tabs[0].fileInfo = { path: 'code.md', name: 'code.md', modified: false, format: 'markdown' }
    const wrapper = mount(SourceEditor, { attachTo: document.body })
    await nextTick()

    window.dispatchEvent(new CustomEvent('editor:codeBlock'))

    await waitFor(() => store.fileContent.includes('```'))
    expect(store.fileContent).toContain('```')
    wrapper.unmount()
  })
})
