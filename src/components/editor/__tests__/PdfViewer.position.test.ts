// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

/**
 * pdfjs 只在浏览器里可用，这里把两个动态导入的模块换成够用的替身：
 * 页数固定 5 页、页面基准尺寸 600×800、没有文本层与目录。
 */
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const viewport = (scale: number): { width: number; height: number; transform: number[] } => ({
    width: 600 * scale,
    height: 800 * scale,
    transform: [1, 0, 0, 1, 0, 0]
  })
  const makePage = () => ({
    getViewport: ({ scale }: { scale: number }) => viewport(scale),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({ items: [] })
  })
  return {
    GlobalWorkerOptions: {},
    Util: { transform: () => [1, 0, 0, 1, 0, 0] },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 5,
        getPage: async () => makePage(),
        getOutline: async () => null,
        destroy: () => {}
      })
    })
  }
})

vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker', () => ({ default: class {} }))

import PdfViewer from '../PdfViewer.vue'
import { useFileStore } from '../../../stores/file'

/** 与组件 CSS 一致：页面高 800（scale=1），页间距 16，上下内边距 24 */
const PAGE_HEIGHT = 800
const PAGE_GAP = 16
const STAGE_PADDING = 24
const PAGE_COUNT = 5
const CLIENT_HEIGHT = 600

const pageTop = (index: number): number => STAGE_PADDING + index * (PAGE_HEIGHT + PAGE_GAP)
const scrollHeight = STAGE_PADDING * 2 + PAGE_COUNT * PAGE_HEIGHT + (PAGE_COUNT - 1) * PAGE_GAP

function mockScrollMetrics(element: HTMLElement): void {
  let top = 0
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => CLIENT_HEIGHT })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value }
  })
}

/** 让布局测量拿到真实形状：第 n 页的顶边按页高累加 */
function mockPageGeometry(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      const page = Number(this.dataset?.page)
      return Number.isFinite(page) && page > 0 ? pageTop(page - 1) : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains('pdf-page') ? PAGE_HEIGHT : 0
    }
  })
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
    const isPage = !!this.classList?.contains('pdf-page')
    // 与真实浏览器一致：页面元素的视口坐标 = 内容坐标 - 滚动容器已滚过的距离；
    // 滚动容器自身的位置固定，不随内部滚动变化。
    const scroller = isPage ? (this.closest('.pdf-scroll') as HTMLElement | null) : null
    const scrollTop = scroller ? scroller.scrollTop : 0
    const page = Number(this.dataset?.page)
    const top = (isPage && Number.isFinite(page) && page > 0 ? pageTop(page - 1) : 0) - scrollTop
    const height = isPage ? PAGE_HEIGHT : 0
    return {
      x: 0,
      y: top,
      width: 600,
      height,
      top,
      bottom: top + height,
      left: 0,
      right: 600,
      toJSON: () => ({})
    } as DOMRect
  }
}

const originalDescriptors = {
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  offsetTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
  getBoundingClientRect: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
}

function restoreDescriptor(
  key: keyof typeof originalDescriptors,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor)
  else Reflect.deleteProperty(HTMLElement.prototype, key)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await nextTick()
  }
  // 位置恢复的重试间隔是 50ms，留一次余量
  await new Promise<void>((resolve) => setTimeout(resolve, 80))
  await flushPromises()
  await nextTick()
}

describe('PdfViewer 切换标签保持阅读位置', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    // clientWidth 让「适应宽度」正好算出 scale=1：(648-48)/600
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 648 })
    HTMLCanvasElement.prototype.getContext = (() => ({})) as never
    mockPageGeometry()

    const store = useFileStore()
    store.tabs.push({
      id: 'pdf-tab',
      fileInfo: { path: 'C:/doc.pdf', name: 'doc.pdf', modified: false, format: 'pdf' },
      document: null,
      content: '',
      revision: 0,
      pdfBase64: 'JVBERi0xLjQ='
    })
    store.activeTabId = 'pdf-tab'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    restoreDescriptor('clientWidth', originalDescriptors.clientWidth)
    restoreDescriptor('offsetTop', originalDescriptors.offsetTop)
    restoreDescriptor('offsetHeight', originalDescriptors.offsetHeight)
    restoreDescriptor('getBoundingClientRect', originalDescriptors.getBoundingClientRect)
    document.body.innerHTML = ''
  })

  it('滚动到某页后卸载重建（切走再切回），仍停在该页', async () => {
    const store = useFileStore()

    const first = mount(PdfViewer, { attachTo: document.body })
    // 挂载后立刻撑起尺度：loadPdf 是异步的，布局测量与位置恢复都在它内部执行
    const container = first.find('.pdf-scroll').element as HTMLElement
    mockScrollMetrics(container)
    await settle()

    expect(first.findAll('.pdf-page')).toHaveLength(PAGE_COUNT)

    // 读到第 3 页：滚动位置与页码输入框应同步
    container.scrollTop = pageTop(2)
    await first.find('.pdf-scroll').trigger('scroll')
    await nextTick()

    expect(store.tabs[0].pdfPosition?.page).toBe(3)
    expect((first.find('.pdf-page-input').element as HTMLInputElement).value).toBe('3')

    // 切到别的标签：EditorPanel 用 `:key` 卸载整个查看器
    first.unmount()

    // 切回来：组件重建，读同一份数据
    const second = mount(PdfViewer, { attachTo: document.body })
    const restored = second.find('.pdf-scroll').element as HTMLElement
    mockScrollMetrics(restored)
    await settle()

    expect(restored.scrollTop).toBe(pageTop(2))
    expect((second.find('.pdf-page-input').element as HTMLInputElement).value).toBe('3')
    second.unmount()
  })

  it('首次打开没有记录时停在第一页', async () => {
    const store = useFileStore()
    const wrapper = mount(PdfViewer, { attachTo: document.body })
    const container = wrapper.find('.pdf-scroll').element as HTMLElement
    mockScrollMetrics(container)
    await settle()

    expect(container.scrollTop).toBe(0)
    expect((wrapper.find('.pdf-page-input').element as HTMLInputElement).value).toBe('1')
    expect(store.tabs[0].pdfPosition).toBeUndefined()
    wrapper.unmount()
  })
})
