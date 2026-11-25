// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import EditorPanel from '../EditorPanel.vue'
import { useFileStore } from '../../../stores/file'
import { useAppearanceStore } from '../../../stores/appearance'
import type { DocumentFormat } from '../../../types/mdx'

/**
 * 格式工具栏的显示条件。
 *
 * 这条用例外置的原因：主进程打开 `.sh` / `.txt` / `.json` 这类文件时也返回
 * `format: 'markdown'`（打开逻辑里「其余一律按文本」的兜底），所以**只按 format
 * 判显示**会把 Markdown 工具栏挂到脚本文件上。工具栏的可见性必须跟「这是不是
 * Markdown 文档」一致，也就是跟编辑模式切换看同一份判定。
 */

/** 子组件全部打桩：这条用例只关心工具栏在不在，不需要真的起 CodeMirror / ProseMirror */
const STUBS = {
  TabBar: true,
  WorkspaceTopBar: true,
  MarkdownToolbar: true,
  SourceEditor: true,
  IrEditor: true,
  PreviewPanel: true,
  ImageViewer: true,
  PdfViewer: true,
  HtmlPreview: true,
  AiPanel: true,
  GraphView: true,
  MindMapEditor: true,
  DiagramEditor: true,
  Splitpanes: true,
  Pane: true
}

function openTab(name: string, format: DocumentFormat): void {
  const store = useFileStore()
  store.tabs.push({
    id: `tab-${name}`,
    fileInfo: {
      path: `C:/docs/${name}`,
      name,
      modified: false,
      format
    },
    document: null,
    content: '',
    revision: 0
  })
  store.activeTabId = `tab-${name}`
}

async function mountPanel(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(EditorPanel, { global: { stubs: STUBS } })
  await nextTick()
  return wrapper
}

/** 工具栏是否渲染：桩组件会渲染成 `<markdown-toolbar-stub>` */
function toolbarVisible(wrapper: ReturnType<typeof mount>): boolean {
  return wrapper.find('markdown-toolbar-stub').exists()
}

describe('EditorPanel 格式工具栏的显示条件', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    Object.defineProperty(window, 'electronAPI', { value: {}, configurable: true })
  })

  it('脚本 / 纯文本文件不显示工具栏（它们同样带着 format: markdown）', async () => {
    openTab('deploy.sh', 'markdown')
    const wrapper = await mountPanel()

    expect(toolbarVisible(wrapper)).toBe(false)
    wrapper.unmount()
  })

  it('Markdown 文件显示工具栏', async () => {
    for (const [name, format] of [
      ['notes.md', 'markdown'],
      ['notes.markdown', 'markdown'],
      ['notes.mdx', 'mdx']
    ] as const) {
      setActivePinia(createPinia())
      openTab(name, format)
      const wrapper = await mountPanel()

      expect(toolbarVisible(wrapper)).toBe(true)
      wrapper.unmount()
    }
  })

  it('其它容器格式不显示工具栏', async () => {
    for (const [name, format] of [
      ['map.inkmind', 'mindmap'],
      ['flow.drawio', 'diagram'],
      ['pic.png', 'image'],
      ['doc.pdf', 'pdf']
    ] as const) {
      setActivePinia(createPinia())
      openTab(name, format)
      const wrapper = await mountPanel()

      expect(toolbarVisible(wrapper)).toBe(false)
      wrapper.unmount()
    }
  })

  it('设置里关掉工具栏后，Markdown 文件也不再显示', async () => {
    openTab('notes.md', 'markdown')
    const wrapper = await mountPanel()
    expect(toolbarVisible(wrapper)).toBe(true)

    const appearance = useAppearanceStore()
    appearance.setShowEditorToolbar(false)
    await nextTick()
    expect(toolbarVisible(wrapper)).toBe(false)

    wrapper.unmount()
  })
})
