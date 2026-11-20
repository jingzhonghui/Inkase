// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import IrEditor from '../IrEditor.vue'
import { useFileStore } from '../../../stores/file'
import { createMdxDocument } from '../../../types/mdx'

function stubElectronAPI(content: string): void {
  const api = {
    openFile: vi.fn().mockResolvedValue({
      success: true,
      data: {
        document: createMdxDocument('doc', content),
        filePath: 'C:/ws/a.md',
        format: 'markdown',
        isNew: false,
        largeFileWarning: false
      }
    }),
    getImage: vi.fn(async () => ({ success: true })),
    setCachedImage: vi.fn(),
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
  vi.stubGlobal('navigator', { userAgent: 'Windows', clipboard: { writeText: vi.fn(), readText: vi.fn(async () => '') } })
  // @ts-expect-error 测试环境最小 DOM
  window.requestAnimationFrame ??= (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16)
  // @ts-expect-error 测试环境最小 DOM
  window.cancelAnimationFrame ??= (id: number) => clearTimeout(id)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    await nextTick()
  }
}

async function mountEditorWith(text: string): Promise<ReturnType<typeof useFileStore>> {
  stubElectronAPI(text)
  const store = useFileStore()
  await store.openFile('C:/ws/a.md')
  mount(IrEditor, { attachTo: document.body })
  await settle()
  return store
}

function trigger(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('.ir-code-language')
  if (!el) throw new Error('代码块语言按钮没渲染出来')
  return el
}

async function openMenu(): Promise<void> {
  trigger().click()
  await nextTick()
  await nextTick()
}

function menuInput(): HTMLInputElement {
  const el = document.body.querySelector<HTMLInputElement>('.code-language-menu__input')
  if (!el) throw new Error('语言浮层没打开')
  return el
}

async function typeQuery(text: string): Promise<void> {
  const input = menuInput()
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  await nextTick()
}

async function pressEnter(): Promise<void> {
  menuInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await nextTick()
}

describe('代码块语言下拉', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('按钮显示当前语言，点开后是自绘浮层而不是原生 select', async () => {
    await mountEditorWith('```js\ncode\n```\n')

    expect(trigger().textContent).toBe('JavaScript')
    expect(document.querySelector('.ir-code-block select')).toBeNull()

    await openMenu()
    expect(document.body.querySelector('.code-language-menu')).not.toBeNull()
  })

  it('纯文本只剩一个 txt 选项', async () => {
    await mountEditorWith('```js\ncode\n```\n')
    await openMenu()

    const labels = Array.from(document.body.querySelectorAll('.code-language-menu__item'))
      .map((el) => el.textContent?.replace('✓', '').trim())
    expect(labels.filter((label) => label === 'txt')).toHaveLength(1)
    expect(labels).not.toContain('纯文本')
  })

  it('输入 cmakelists 选中 CMake，围栏写成 cmake', async () => {
    const store = await mountEditorWith('```js\ncode\n```\n')
    await openMenu()
    await typeQuery('cmakelists')

    const items = document.body.querySelectorAll('.code-language-menu__item')
    expect(items).toHaveLength(1)
    expect(items[0].textContent).toContain('CMake')

    await pressEnter()
    await settle()

    expect(store.fileContent).toContain('```cmake')
    expect(trigger().textContent).toBe('CMake')
    expect(document.body.querySelector('.code-language-menu')).toBeNull()
  })

  it('选 txt 写的是 txt，不是空围栏', async () => {
    const store = await mountEditorWith('```js\ncode\n```\n')
    await openMenu()
    await typeQuery('txt')

    await pressEnter()
    await settle()

    expect(store.fileContent).toContain('```txt')
  })

  it('Escape 收起浮层且不改文档', async () => {
    const store = await mountEditorWith('```js\ncode\n```\n')
    const before = store.fileContent

    await openMenu()
    menuInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()

    expect(document.body.querySelector('.code-language-menu')).toBeNull()
    expect(store.fileContent).toBe(before)
  })
})
