// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import ImageViewer from '../ImageViewer.vue'
import { useFileStore } from '../../../stores/file'
import { IMAGE_ZOOM_PROFILE, useZoomStore } from '../../../stores/zoom'

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

describe('ImageViewer zoom layout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 }
    })
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })

    const store = useFileStore()
    store.tabs.push({
      id: 'image-tab',
      fileInfo: { path: 'C:/image.png', name: 'image.png', modified: false, format: 'image' },
      document: null,
      content: '',
      revision: 0,
      imageDataUrl: 'data:image/png;base64,AAA'
    })
    store.activeTabId = 'image-tab'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
  })

  it('keeps enlarged image content centered in both scroll directions', async () => {
    const wrapper = mount(ImageViewer)
    const stage = wrapper.find('.image-stage').element as HTMLElement

    const image = wrapper.find('img').element as HTMLImageElement
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1000 },
      naturalHeight: { configurable: true, value: 800 }
    })
    await wrapper.find('img').trigger('load')
    const content = wrapper.find('.image-stage-content').element as HTMLElement
    Object.defineProperties(stage, {
      scrollWidth: { configurable: true, get: () => Number.parseInt(content.style.width, 10) },
      scrollHeight: { configurable: true, get: () => Number.parseInt(content.style.height, 10) }
    })

    // 缩放现在由状态栏驱动：改 store 就等价于点状态栏上的「放大」
    const zoomStore = useZoomStore()
    zoomStore.set('image-tab', 2, IMAGE_ZOOM_PROFILE)
    await wrapper.vm.$nextTick()
    // 居中在缩放后的下一帧执行（需要先量到新的 scrollWidth）
    await wrapper.vm.$nextTick()

    expect(Number.parseInt(content.style.width, 10)).toBeGreaterThan(stage.clientWidth)
    expect(Number.parseInt(content.style.height, 10)).toBeGreaterThan(stage.clientHeight)
    expect(stage.scrollLeft).toBe((stage.scrollWidth - stage.clientWidth) / 2)
    expect(stage.scrollTop).toBe((stage.scrollHeight - stage.clientHeight) / 2)
  })

  it('缩放倍率按标签页保存：换标签读到各自的值', async () => {
    const store = useFileStore()
    store.tabs.push({
      id: 'image-tab-2',
      fileInfo: { path: 'C:/other.png', name: 'other.png', modified: false, format: 'image' },
      document: null,
      content: '',
      revision: 0,
      imageDataUrl: 'data:image/png;base64,BBB'
    })
    const zoomStore = useZoomStore()
    zoomStore.set('image-tab', 1.5, IMAGE_ZOOM_PROFILE)

    expect(zoomStore.valueOf('image-tab')).toBe(1.5)
    // 没缩放过的标签是 100%
    expect(zoomStore.valueOf('image-tab-2')).toBe(1)
  })
})
