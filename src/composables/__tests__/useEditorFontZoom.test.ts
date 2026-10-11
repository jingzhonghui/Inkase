// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, onMounted, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useEditorFontZoom } from '../useEditorFontZoom'
import { useAppearanceStore, DEFAULT_EDITOR_FONT_SIZE } from '../../stores/appearance'

function createWheelEvent(init: { ctrlKey: boolean; deltaY: number }): WheelEvent {
  const event = new WheelEvent('wheel', {
    ctrlKey: init.ctrlKey,
    deltaY: init.deltaY,
    bubbles: true,
    cancelable: true
  })
  return event
}

async function mountHost() {
  const target = ref<HTMLElement | null>(null)
  const host = defineComponent({
    setup() {
      const store = useAppearanceStore()
      const { attach } = useEditorFontZoom()
      onMounted(() => {
        if (target.value) attach(target.value)
      })
      return { target, store }
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
  })

  it('increases font size on ctrl+wheel up', async () => {
    const { wrapper, el } = await mountHost()

    el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: -100 }))

    const store = useAppearanceStore()
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE + 1)
    wrapper.unmount()
  })

  it('decreases font size on ctrl+wheel down', async () => {
    const { wrapper, el } = await mountHost()

    el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: 100 }))

    const store = useAppearanceStore()
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE - 1)
    wrapper.unmount()
  })

  it('ignores plain wheel without ctrl', async () => {
    const { wrapper, el } = await mountHost()

    el.dispatchEvent(createWheelEvent({ ctrlKey: false, deltaY: -100 }))

    const store = useAppearanceStore()
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE)
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
    const store = useAppearanceStore()

    for (let i = 0; i < 30; i++) {
      el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: -100 }))
    }
    expect(store.editorFontSize).toBe(24)

    for (let i = 0; i < 30; i++) {
      el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: 100 }))
    }
    expect(store.editorFontSize).toBe(12)
    wrapper.unmount()
  })

  it('removes listener on unmount', async () => {
    const { wrapper, el } = await mountHost()
    wrapper.unmount()

    const store = useAppearanceStore()
    el.dispatchEvent(createWheelEvent({ ctrlKey: true, deltaY: -100 }))
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE)
  })
})
