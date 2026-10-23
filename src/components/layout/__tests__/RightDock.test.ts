// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import RightDock from '../RightDock.vue'
import { DOCK_MAX_WIDTH, DOCK_DEFAULT_WIDTH, useDockStore } from '../../../stores/dock'
import { useAiStore } from '../../../stores/ai'

/**
 * 装上最小的 electronAPI
 *
 * AiPanel 与反链/图谱面板在挂载时会读知识库与 AI 能力，缺了桥就整体降级成空态；
 * 这些用例只关心停靠区本身，给一套「什么都不返回」的替身即可。
 */
function installBridge(): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    onAiRunEvent: () => () => {},
    listAiConversations: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getAiConfig: vi.fn().mockResolvedValue({ success: true, data: null }),
    onKnowledgeProgress: () => () => {},
    knowledgeStatus: vi.fn().mockResolvedValue({ success: true, data: null }),
    getKnowledgeTags: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getUnresolvedLinks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    listKnowledgeNotes: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getBacklinks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getKnowledgeGraph: vi.fn().mockResolvedValue({ success: true, data: null })
  }
}

function mountDock() {
  return mount(RightDock, { props: { ready: false } })
}

describe('RightDock', () => {
  const original = window.electronAPI

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    installBridge()
  })

  afterEach(() => {
    window.electronAPI = original
  })

  it('switches between the three panels and keeps the width', async () => {
    const dock = useDockStore()
    dock.open = true
    const wrapper = mountDock()

    expect(wrapper.get('[data-testid="right-dock"]').attributes('style')).toContain(
      `${DOCK_DEFAULT_WIDTH}px`
    )

    dock.setTab('ai')
    await nextTick()
    expect(wrapper.find('[data-testid="dock-tab-ai"]').classes()).toContain('active')

    dock.setWidth(420)
    await nextTick()
    expect(wrapper.get('[data-testid="right-dock"]').attributes('style')).toContain('420px')
  })

  it('widens the AI panel to the dock ceiling instead of taking over the editor', async () => {
    const dock = useDockStore()
    dock.open = true
    dock.setTab('ai')
    const wrapper = mountDock()

    await wrapper.get('[data-testid="dock-ai-expand"]').trigger('click')
    await nextTick()
    expect(dock.wide).toBe(true)
    expect(wrapper.get('[data-testid="right-dock"]').attributes('style')).toContain(
      `${DOCK_MAX_WIDTH}px`
    )
    expect(wrapper.get('[data-testid="dock-ai-expand"]').attributes('aria-pressed')).toBe('true')

    await wrapper.get('[data-testid="dock-ai-expand"]').trigger('click')
    await nextTick()
    expect(dock.wide).toBe(false)
    expect(wrapper.get('[data-testid="right-dock"]').attributes('style')).toContain(
      `${DOCK_DEFAULT_WIDTH}px`
    )
  })

  it('drops the wide mode as soon as the user drags the width', async () => {
    const dock = useDockStore()
    dock.open = true
    dock.setTab('ai')
    dock.toggleWide()
    const wrapper = mountDock()

    const resizer = wrapper.get('[data-testid="dock-resizer"]')
    await resizer.trigger('mousedown', { clientX: 800 })
    // 面板在右侧：向右拖是变窄
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    // 用户自己的宽度选择优先于拉满
    expect(dock.wide).toBe(false)
    expect(dock.width).toBe(DOCK_MAX_WIDTH - 100)
  })

  it('asks the AI store before closing on the AI tab', async () => {
    const dock = useDockStore()
    const aiStore = useAiStore()
    dock.open = true
    dock.setTab('ai')
    const requestClose = vi.spyOn(aiStore, 'requestClose').mockResolvedValue(false)
    const wrapper = mountDock()

    await wrapper.get('[data-testid="dock-close"]').trigger('click')
    await nextTick()

    // 运行中且用户取消 → 面板留着
    expect(requestClose).toHaveBeenCalledTimes(1)
    expect(dock.open).toBe(true)

    requestClose.mockResolvedValue(true)
    await wrapper.get('[data-testid="dock-close"]').trigger('click')
    await nextTick()
    expect(dock.open).toBe(false)
  })

  it('closes other tabs without bothering the AI store', async () => {
    const dock = useDockStore()
    const aiStore = useAiStore()
    dock.open = true
    dock.setTab('backlinks')
    const requestClose = vi.spyOn(aiStore, 'requestClose')
    const wrapper = mountDock()

    await wrapper.get('[data-testid="dock-close"]').trigger('click')
    await nextTick()

    expect(requestClose).not.toHaveBeenCalled()
    expect(dock.open).toBe(false)
  })
})
