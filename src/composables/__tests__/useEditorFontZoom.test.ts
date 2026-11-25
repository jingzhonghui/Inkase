// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, onMounted, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useEditorFontZoom } from '../useEditorFontZoom'
import { useAppearanceStore, DEFAULT_EDITOR_FONT_SIZE } from '../../stores/appearance'
import { useZoomStore } from '../../stores/zoom'

/**
 * 编辑区 Ctrl+滚轮缩放
 *
 * 行为已从「改全局字号」改成「步进当前标签页的正文缩放倍率」：
 * 100% 仍等于设置中心里的字号，但滚轮不再改写那个设置，也不会波及别的标签。
 */

const activeTabId = ref<string | null>('tab-1')

// 真实 store 里 `activeTabId` 是被 pinia 解包后的字符串，mock 必须保持一致
vi.mock('../../stores/file', () => ({
  useFileStore: () => ({
    get activeTabId(): string | null {
      return activeTabId.value
    }
  })
}))

function createWheelEvent(init: { ctrlKey: boolean; deltaY: number }): WheelEvent {
  return new WheelEvent('wheel', {
    ctrlKey: init.ctrlKey,
    deltaY: init.deltaY,
    bubbles: true,
    cancelable: true
  })
}

async function mountHost() {
  const target = ref<HTMLElement | null>(null)
  const host = defineComponent({
    setup() {
      const { attach } = useEditorFontZoom()
      onMounted(() => {
        if (target.value) attach(target.value)
      })
      return { target }
    },
    template: '<div><div ref="target" data-test="target" /></div>'
  })
  const wrapper = mount(host)
  await wrapper.vm.$nextTick()
  return { wrapper, el: wrapper.find('[data-test="target"]').element as HTMLElement }
}

describe('useEditorFontZoom', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    activeTabId.value = 'tab-1'
  })

  it('ctrl+wheel up 放大当前标签的正文倍率（每档 25%）', async () => {
    const { wrapper, el } = await mountHost()

    el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: -100 }))

    const zoomStore = useZoomStore()
    expect(zoomStore.valueOf('tab-1')).toBe(1.25)
    wrapper.unmount()
  })

  it('ctrl+wheel down 缩小当前标签的正文倍率', async () => {
    const { wrapper, el } = await mountHost()

    el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: 100 }))

    const zoomStore = useZoomStore()
    expect(zoomStore.valueOf('tab-1')).toBe(0.75)
    wrapper.unmount()
  })

  it('只影响当前标签，别的标签仍是 100%', async () => {
    const { wrapper, el } = await mountHost()

    el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: -100 }))

    const zoomStore = useZoomStore()
    expect(zoomStore.valueOf('tab-1')).toBe(1.25)
    expect(zoomStore.valueOf('tab-2')).toBe(1)
    wrapper.unmount()
  })

  it('不再改写设置里的字号（那是缩放的基准，不是缩放本身）', async () => {
    const { wrapper, el } = await mountHost()

    el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: -100 }))

    const store = useAppearanceStore()
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE)
    wrapper.unmount()
  })

  it('ignores plain wheel without ctrl', async () => {
    const { wrapper, el } = await mountHost()

    el.dispatchEvent(createWheelEvent({ ctrlKey: false, deltaY: -100 }))

    const zoomStore = useZoomStore()
    expect(zoomStore.valueOf('tab-1')).toBe(1)
    wrapper.unmount()
  })

  it('prevents default on ctrl+wheel', async () => {
    const { wrapper, el } = await mountHost()

    const event = createWheelEvent({ ctrlKey: true, deltaY: -100 })
    const preventDefault = vi.spyOn(event, 'preventDefault')
    el.dispatchEvent(event)

    expect(preventDefault).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('clamps at bounds after repeated zooming', async () => {
    const { wrapper, el } = await mountHost()
    const zoomStore = useZoomStore()

    for (let i = 0; i < 30; i++) {
      el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: -100 }))
    }
    // 文本缩放的上下限是 300% / 50%
    expect(zoomStore.valueOf('tab-1')).toBe(3)

    for (let i = 0; i < 30; i++) {
      el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: 100 }))
    }
    expect(zoomStore.valueOf('tab-1')).toBe(0.5)
    wrapper.unmount()
  })

  it('removes listener on unmount', async () => {
    const { wrapper, el } = await mountHost()
    wrapper.unmount()

    const zoomStore = useZoomStore()
    el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: -100 }))
    expect(zoomStore.valueOf('tab-1')).toBe(1)
  })
})
