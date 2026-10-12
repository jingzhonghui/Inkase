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
})
