// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TabBar from '../TabBar.vue'
import { useFileStore } from '../../../stores/file'
import { createMdxDocument } from '../../../types/mdx'

/**
 * 标签名必须跟随另存后的新文件名。
 * 用户报的现象：新建 → 保存为 1.mdx → 标签仍显示「未命名.mdx」。
 */
describe('TabBar 标签名跟随另存', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const api = {
      newFile: vi.fn(async () => ({
        success: true,
        data: { document: createMdxDocument('未命名文档', ''), isNew: true }
      })),
      saveFile: vi.fn(async () => ({ success: false, error: 'NEW_FILE' })),
      saveAsFile: vi.fn(async () => ({ success: true, data: 'C:/notes/1.mdx' })),
      getRecentFiles: vi.fn(async () => ({ success: true, data: [] })),
      addRecentFile: vi.fn(async () => ({ success: true })),
      clearRecovery: vi.fn(async () => ({ success: true })),
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

  it('另存为 1.mdx 之后标签显示 1.mdx', async () => {
    const store = useFileStore()
    await store.newFile()

    const wrapper = mount(TabBar, { global: { stubs: { Teleport: true } } })
    await nextTick()
    const before = wrapper.findAll('[data-tab-id] .tab-label').map((n) => n.text())
    console.log('保存前标签：', before)

    await store.saveFile()
    await nextTick()
    await nextTick()

    const after = wrapper.findAll('[data-tab-id] .tab-label').map((n) => n.text())
    console.log('保存后标签：', after, 'fileInfo=', store.activeTab?.fileInfo)
    expect(after).toContain('1.mdx')
  })
})
