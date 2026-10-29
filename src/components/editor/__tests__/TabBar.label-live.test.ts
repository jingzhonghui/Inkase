// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick, toRaw } from 'vue'
import TabBar from '../TabBar.vue'
import { useFileStore } from '../../../stores/file'
import { createMdxDocument } from '../../../types/mdx'

/**
 * 用户报的现象（第二轮）：另存成 1.mdx 之后，**悬停提示**变成了 1.mdx，
 * 标签上的文字还是「未命名.mdx」。
 *
 * 根因：标签文字被存进一个 computed 里缓存（中间省略需要测量宽度），
 * 而 tooltip 是在模板里直接调用函数读取的。只要文件名的那次写入没有
 * 触发依赖收集（例如写入的是原始对象、或从坏掉的对象引用上写），
 * 组件再因为别的原因重渲染时，函数读到新值、computed 还是旧值——
 * 于是同一行里出现「提示 1.mdx、文字 未命名.mdx」。
 *
 * 这条用例锁的是不变量：**只要渲染发生，标签文字就必须与当前文件名一致**。
 */
describe('TabBar 标签文字始终跟当前文件名一致', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const api = {
      newFile: vi.fn(async () => ({
        success: true,
        data: { document: createMdxDocument('未命名文档', ''), isNew: true }
      })),
      getRecentFiles: vi.fn(async () => ({ success: true, data: [] })),
      writeRecovery: vi.fn(async () => ({ success: true }))
    }
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    vi.stubGlobal('navigator', { userAgent: 'Windows', clipboard: { writeText: vi.fn() } })
  })

  it('绕过响应式写入文件名后，重渲染仍显示新名字', async () => {
    const store = useFileStore()
    await store.newFile()

    const wrapper = mount(TabBar, { global: { stubs: { Teleport: true } } })
    await nextTick()
    // 工作台标签也带 .tab-label，这里只看文件标签
    const label = (): string => wrapper.findAll('[data-tab-id] .tab-label')[0].text()
    expect(label()).toBe('未命名.mdx')

    // 写到原始对象上：不触发依赖收集，模拟「文件名静默变了」
    const rawTab = toRaw(store.tabs[0])
    rawTab.fileInfo!.name = '1.mdx'

    // 任何一次重渲染（比如切换活动标签、悬停提示刷新）都应该带上新名字
    wrapper.vm.$forceUpdate()
    await nextTick()

    expect(label()).toBe('1.mdx')
  })
})
