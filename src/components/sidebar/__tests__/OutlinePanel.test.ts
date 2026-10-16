// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import OutlinePanel from '../OutlinePanel.vue'
import { useFileStore } from '../../../stores/file'
import { useOutlineStore } from '../../../stores/outline'
import type { TabInfo } from '../../../stores/file/types'
import type { DocumentFormat } from '../../../types/mdx'

function makeTab(id: string, name: string, format: DocumentFormat = 'mdx'): TabInfo {
  return {
    id,
    fileInfo: { path: `C:/ws/${name}`, name, modified: false, format },
    document: null,
    content: '',
    revision: 0
  }
}

function mountPanel() {
  return mount(OutlinePanel)
}

describe('OutlinePanel', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('shows 未打开文件 when no file is open', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('.outline-empty').text()).toBe('未打开文件')
  })

  it('shows unsupported message for non-markdown files', () => {
    const store = useFileStore()
    store.tabs = [makeTab('t1', 'a.txt')]
    store.activeTabId = 't1'
    const wrapper = mountPanel()
    expect(wrapper.find('.outline-empty').text()).toBe('当前文件不支持大纲')
  })

  it('shows 暂无标题 for markdown files without headings', () => {
    const store = useFileStore()
    store.tabs = [makeTab('t1', 'a.md')]
    store.activeTabId = 't1'
    const wrapper = mountPanel()
    expect(wrapper.find('.outline-empty').text()).toBe('暂无标题')
  })

  it('lists headings and dispatches a jump event on click', async () => {
    const store = useFileStore()
    store.tabs = [makeTab('t1', 'a.md')]
    store.activeTabId = 't1'
    const outline = useOutlineStore()
    outline.setHeadings([
      { level: 1, text: '第一章' },
      { level: 2, text: '第二节' }
    ])

    const wrapper = mountPanel()
    const items = wrapper.findAll('.outline-item')
    expect(items.map((i) => i.text())).toEqual(['第一章', '第二节'])

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    await items[1].trigger('click')

    const jump = dispatchSpy.mock.calls
      .map((call) => call[0] as Event)
      .find((event) => event.type === 'inkase:outline-jump')
    expect(jump).toBeTruthy()
    expect((jump as CustomEvent).detail).toEqual({ index: 1 })
  })

  it('highlights the active heading', () => {
    const store = useFileStore()
    store.tabs = [makeTab('t1', 'a.md')]
    store.activeTabId = 't1'
    const outline = useOutlineStore()
    outline.setHeadings([
      { level: 1, text: '第一章' },
      { level: 2, text: '第二节' }
    ])
    outline.setActiveIndex(1)

    const wrapper = mountPanel()
    const active = wrapper.findAll('.outline-item').filter((i) => i.classes().includes('is-active'))
    expect(active).toHaveLength(1)
    expect(active[0].text()).toBe('第二节')
  })

  it('lists PDF outline items with page numbers', () => {
    const store = useFileStore()
    store.tabs = [makeTab('t1', 'a.pdf', 'pdf')]
    store.activeTabId = 't1'
    const outline = useOutlineStore()
    outline.setHeadings(
      [
        { level: 1, text: '封面', page: 1 },
        { level: 2, text: '引言', page: 3 }
      ],
      'pdf'
    )

    const wrapper = mountPanel()
    expect(wrapper.find('.outline-empty').exists()).toBe(false)
    const items = wrapper.findAll('.outline-item')
    expect(items.map((i) => i.find('.outline-item-text').text())).toEqual(['封面', '引言'])
    expect(items.map((i) => i.find('.outline-item-page').text())).toEqual(['1', '3'])
  })

  it('shows 该 PDF 无目录 for PDF without outline', () => {
    const store = useFileStore()
    store.tabs = [makeTab('t1', 'a.pdf', 'pdf')]
    store.activeTabId = 't1'
    const wrapper = mountPanel()
    expect(wrapper.find('.outline-empty').text()).toBe('该 PDF 无目录')
  })

  it('shows loading message while the PDF outline is being parsed', () => {
    const store = useFileStore()
    store.tabs = [makeTab('t1', 'a.pdf', 'pdf')]
    store.activeTabId = 't1'
    useOutlineStore().setLoading('pdf')
    const wrapper = mountPanel()
    expect(wrapper.find('.outline-empty').text()).toBe('正在加载目录…')
  })
})
