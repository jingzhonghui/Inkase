// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { useFileStore } from '../../../stores/file'
import { createMdxDocument } from '../../../types/mdx'

// Shiki 初始化要走真实的高亮器加载，测试里不需要
vi.mock('../../../utils/shiki', () => ({
  getHighlighter: vi.fn(async () => ({
    codeToHtml: (code: string) => `<pre class="shiki"><code>${code}</code></pre>`
  }))
}))

import PreviewPanel from '../PreviewPanel.vue'

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

function stubElectronAPI(content: string): void {
  const api = {
    openFile: vi.fn().mockResolvedValue({
      success: true,
      data: {
        document: createMdxDocument('doc', content),
        filePath: 'C:/ws/测试.md',
        format: 'markdown',
        isNew: false,
        largeFileWarning: false
      }
    }),
    getImage: vi.fn(async () => ({ success: true, data: { buffer: [1, 2, 3], mimeType: 'image/png' } })),
    getRecentFiles: vi.fn(async () => ({ success: true, data: [] })),
    clearRecovery: vi.fn(async () => ({ success: true })),
    writeRecovery: vi.fn(async () => ({ success: true })),
    readRecovery: vi.fn(async () => ({ success: true, data: null })),
    recoveryStatus: vi.fn(async () => ({ success: true, data: { available: false } })),
    addRecentFile: vi.fn(async () => ({ success: true }))
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn()
  })
  vi.stubGlobal('navigator', {
    userAgent: 'Windows',
    clipboard: { writeText: vi.fn(), readText: vi.fn(async () => '') }
  })
}

function previewRoot(wrapper: ReturnType<typeof mount>): HTMLElement {
  return wrapper.find('.preview-content').element as HTMLElement
}

function imageSrc(wrapper: ReturnType<typeof mount>): string | null {
  const img = previewRoot(wrapper).querySelector('img')
  return img ? img.getAttribute('src') : null
}

describe('PreviewPanel 图片不随打字闪烁', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('renders an already-loaded image straight from the cache', async () => {
    stubElectronAPI('![截图](测试.assets/a.png)\n')
    const store = useFileStore()
    await store.openFile('C:/ws/测试.md')
    // 图片此前已读进内存
    store.setCachedImage('C:/ws/测试.md:测试.assets/a.png', DATA_URL)

    const wrapper = mount(PreviewPanel, { attachTo: document.body })
    await nextTick()

    expect(imageSrc(wrapper)).toBe(DATA_URL)
    wrapper.unmount()
  })

  it('keeps the same <img> node when the text above the image changes', async () => {
    stubElectronAPI('![截图](测试.assets/a.png)\n')
    const store = useFileStore()
    await store.openFile('C:/ws/测试.md')
    store.setCachedImage('C:/ws/测试.md:测试.assets/a.png', DATA_URL)

    const wrapper = mount(PreviewPanel, { attachTo: document.body })
    await nextTick()
    const imgBefore = previewRoot(wrapper).querySelector('img')
    expect(imgBefore).toBeTruthy()

    // 在图片上方打字：整篇 markdown 重新渲染，但图片块本身没变
    store.updateContent('第一行\n\n![截图](测试.assets/a.png)\n')
    await nextTick()

    const imgAfter = previewRoot(wrapper).querySelector('img')
    // 节点对象必须还是同一个：重建才会闪（重新解码、重新布局）
    expect(imgAfter).toBe(imgBefore)
    expect(imageSrc(wrapper)).toBe(DATA_URL)
    // 上方的文字确实更新了
    expect(previewRoot(wrapper).textContent).toContain('第一行')

    wrapper.unmount()
  })

  it('patches only the changed block and keeps source line markers in sync', async () => {
    stubElectronAPI('第一段\n\n第二段\n')
    const store = useFileStore()
    await store.openFile('C:/ws/测试.md')

    const wrapper = mount(PreviewPanel, { attachTo: document.body })
    await nextTick()

    const linesBefore = Array.from(previewRoot(wrapper).querySelectorAll('[data-source-line]'))
      .map((el) => el.getAttribute('data-source-line'))
    expect(linesBefore.length).toBeGreaterThan(0)

    // 顶部插入一行：所有块的 data-source-line 都会平移
    store.updateContent('新增的一行\n\n第一段\n\n第二段\n')
    await nextTick()

    const blocks = Array.from(previewRoot(wrapper).querySelectorAll('[data-source-line]'))
    expect(previewRoot(wrapper).textContent).toContain('新增的一行')
    // 行号跟着更新，否则预览的阅读位置恢复会错位
    expect(blocks.map((el) => el.getAttribute('data-source-line'))).not.toEqual(linesBefore)

    wrapper.unmount()
  })

  it('falls back to the local path when the image has not loaded yet', async () => {
    stubElectronAPI('![截图](测试.assets/a.png)\n')
    const store = useFileStore()
    await store.openFile('C:/ws/测试.md')

    const wrapper = mount(PreviewPanel, { attachTo: document.body })
    await nextTick()

    // 还没进缓存：保留解码后的本地路径，交给 loadVisibleImages 异步补齐
    expect(imageSrc(wrapper)).toBe('测试.assets/a.png')
    wrapper.unmount()
  })

  it('keeps the highlighted <pre> node when other text changes', async () => {
    stubElectronAPI('```ts\nconst a = 1\n```\n')
    const store = useFileStore()
    await store.openFile('C:/ws/测试.md')

    const wrapper = mount(PreviewPanel, { attachTo: document.body })
    // 等 100ms 的渲染防抖跑完，Shiki 高亮落到 DOM 上
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    await nextTick()

    const preBefore = previewRoot(wrapper).querySelector('pre')
    expect(preBefore?.hasAttribute('data-shiki-done')).toBe(true)

    store.updateContent('说明文字\n\n```ts\nconst a = 1\n```\n')
    await nextTick()

    // 高亮后的 <pre> 结构与模板里的原始 HTML 不同，签名必须按文本比，
    // 否则每次打字都会重建代码块、丢掉高亮
    expect(previewRoot(wrapper).querySelector('pre')).toBe(preBefore)
    expect(previewRoot(wrapper).textContent).toContain('说明文字')

    wrapper.unmount()
  })
})
