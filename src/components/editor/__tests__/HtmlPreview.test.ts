// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import HtmlPreview from '../HtmlPreview.vue'
import { useFileStore } from '../../../stores/file'

describe('HtmlPreview', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function mountWithTab(overrides: { modified?: boolean; path?: string } = {}): ReturnType<typeof mount> {
    const store = useFileStore()
    store.tabs.push({
      id: 'html-tab',
      fileInfo: {
        path: overrides.path ?? 'C:/docs/page.html',
        name: 'page.html',
        modified: overrides.modified ?? false,
        format: 'markdown'
      },
      document: null,
      content: '<h1>hello</h1>',
      revision: 0
    })
    store.activeTabId = 'html-tab'
    return mount(HtmlPreview)
  }

  it('renders a sandboxed iframe pointing at the preview protocol url', () => {
    const wrapper = mountWithTab()
    const iframe = wrapper.find('iframe')
    expect(iframe.exists()).toBe(true)
    expect(iframe.attributes('src')).toBe('inkase-preview://local/C%3A/docs/page.html')
    expect(iframe.attributes('sandbox')).toBe('allow-scripts')
  })

  it('hides the saved-version hint when tab is clean and shows it when modified', async () => {
    const wrapper = mountWithTab({ modified: false })
    expect(wrapper.text()).not.toContain('预览为已保存版本')

    const store = useFileStore()
    store.activeTab!.fileInfo!.modified = true
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('预览为已保存版本')
  })

  it('reloads the iframe when the refresh button is clicked', async () => {
    const wrapper = mountWithTab()
    const iframeEl = wrapper.find('iframe').element
    await wrapper.find('.html-preview-refresh').trigger('click')
    await wrapper.vm.$nextTick()
    // src 稳定不变，重载通过 :key 重建 iframe 元素实现
    expect(wrapper.find('iframe').attributes('src')).toBe('inkase-preview://local/C%3A/docs/page.html')
    expect(wrapper.find('iframe').element).not.toBe(iframeEl)
  })
})
