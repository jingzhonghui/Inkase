// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AiQuickAsk from '../AiQuickAsk.vue'
import { useFileStore } from '../../../stores/file'
import { useAiStore } from '../../../stores/ai'

function installDomSelection(text = 'Hello'): HTMLElement {
  const editor = document.createElement('div')
  editor.className = 'source-container'
  const node = document.createElement('span')
  node.textContent = text
  editor.appendChild(node)
  document.body.appendChild(editor)

  const rect = {
    top: 100,
    left: 100,
    right: 200,
    bottom: 120,
    width: 100,
    height: 20,
    x: 100,
    y: 100,
    toJSON: () => ({})
  } as DOMRect

  const range = {
    startContainer: node,
    endContainer: node,
    getBoundingClientRect: () => rect
  } as unknown as Range

  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: node,
    focusNode: node,
    getRangeAt: () => range
  } as unknown as Selection)

  return editor
}

async function settleTrigger(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 25))
  await nextTick()
}

function click(element: Element | null): void {
  if (!(element instanceof HTMLElement)) throw new Error('element not found')
  element.click()
}

describe('AiQuickAsk', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('opens from a selection and replaces the selected text with the answer', async () => {
    const files = useFileStore()
    files.createGeneratedDocument('笔记', 'Hello world', 'markdown')
    files.updateEditorSelection({
      tabId: files.activeTabId!,
      from: 0,
      to: 5,
      cursor: 5,
      text: 'Hello'
    })
    installDomSelection('Hello')

    const ai = useAiStore()
    const send = vi.spyOn(ai, 'sendMessage').mockImplementation(async () => {
      ai.messages.push({
        id: 'assistant-1',
        role: 'assistant',
        content: '你好',
        createdAt: Date.now()
      })
    })

    wrapper = mount(AiQuickAsk, {
      props: { ready: true },
      attachTo: document.body
    })
    await settleTrigger()

    click(document.querySelector('[data-testid="quick-ask-trigger"]'))
    await nextTick()
    expect(document.querySelector('[data-testid="quick-ask-panel"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="quick-ask-panel"]')?.textContent).toContain('Hello')

    const input = document.querySelector('.quick-input') as HTMLTextAreaElement
    input.value = '改写成问候'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    click(document.querySelector('.quick-send'))
    await flushPromises()
    await nextTick()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toContain('Hello')
    expect(document.querySelector('.quick-answer')?.textContent).toContain('你好')

    click(document.querySelector('.quick-action.primary'))
    await nextTick()

    expect(files.tabs[0]?.content).toBe('你好 world')
  })

  it('routes to settings instead of opening when AI is not configured', async () => {
    const files = useFileStore()
    files.createGeneratedDocument('笔记', 'Hello world', 'markdown')
    files.updateEditorSelection({
      tabId: files.activeTabId!,
      from: 0,
      to: 5,
      cursor: 5,
      text: 'Hello'
    })
    installDomSelection('Hello')

    wrapper = mount(AiQuickAsk, {
      props: { ready: false },
      attachTo: document.body
    })
    await settleTrigger()

    click(document.querySelector('[data-testid="quick-ask-trigger"]'))
    await nextTick()

    expect(wrapper.emitted('openSettings')).toHaveLength(1)
    expect(document.querySelector('[data-testid="quick-ask-panel"]')).toBeNull()
  })

  it('keeps the answer but refuses to overwrite text changed while waiting', async () => {
    const files = useFileStore()
    files.createGeneratedDocument('笔记', 'Hello world', 'markdown')
    files.updateEditorSelection({
      tabId: files.activeTabId!,
      from: 0,
      to: 5,
      cursor: 5,
      text: 'Hello'
    })
    installDomSelection('Hello')

    const ai = useAiStore()
    vi.spyOn(ai, 'sendMessage').mockImplementation(async () => {
      ai.messages.push({
        id: 'assistant-2',
        role: 'assistant',
        content: '你好',
        createdAt: Date.now()
      })
    })

    wrapper = mount(AiQuickAsk, {
      props: { ready: true },
      attachTo: document.body
    })
    await settleTrigger()

    click(document.querySelector('[data-testid="quick-ask-trigger"]'))
    await nextTick()
    const input = document.querySelector('.quick-input') as HTMLTextAreaElement
    input.value = '改写'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    click(document.querySelector('.quick-send'))
    await flushPromises()
    await nextTick()

    files.updateContent('Hallo world')
    click(document.querySelector('.quick-action.primary'))
    await nextTick()

    expect(files.tabs[0]?.content).toBe('Hallo world')
    expect(document.querySelector('.quick-flash')?.textContent).toContain('原文已变化')
  })
})
