// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import FindReplacePanel from '../FindReplacePanel.vue'

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
}

describe('FindReplacePanel', () => {
  it('以选中文本预填查找输入并触发搜索', async () => {
    const wrapper = mount(FindReplacePanel, {
      props: { open: false, replaceMode: false, matchCount: 0, currentIndex: -1 }
    })
    await wrapper.setProps({ open: true, initialQuery: '选中文本' })
    await flush()

    const input = wrapper.find('.find-replace-input').element as HTMLInputElement
    expect(input.value).toBe('选中文本')
    expect(wrapper.emitted('search')?.[0]).toEqual(['选中文本', false])
    wrapper.unmount()
  })

  it('无选中文本时保持空输入且不触发搜索', async () => {
    const wrapper = mount(FindReplacePanel, {
      props: { open: false, replaceMode: false, matchCount: 0, currentIndex: -1 }
    })
    await wrapper.setProps({ open: true, initialQuery: '' })
    await flush()

    const input = wrapper.find('.find-replace-input').element as HTMLInputElement
    expect(input.value).toBe('')
    expect(wrapper.emitted('search')).toBeUndefined()
    wrapper.unmount()
  })

  it('点击切换按钮派发 toggleReplace 事件', async () => {
    const wrapper = mount(FindReplacePanel, {
      props: { open: true, replaceMode: false, matchCount: 0, currentIndex: -1 }
    })
    await flush()

    expect(wrapper.find('.find-replace-toggle').exists()).toBe(true)
    await wrapper.find('.find-replace-toggle').trigger('click')
    expect(wrapper.emitted('toggleReplace')).toHaveLength(1)
    wrapper.unmount()
  })
})
