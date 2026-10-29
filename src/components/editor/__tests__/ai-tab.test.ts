// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TabBar from '../TabBar.vue'
import EditorPanel from '../EditorPanel.vue'
import AppHeader from '../../layout/AppHeader.vue'
import { useAiStore } from '../../../stores/ai'
import { useFileStore } from '../../../stores/file'
import { useGraphStore } from '../../../stores/graph'
import { useWorkspaceStore } from '../../../stores/workspace'

/**
 * 工作台（原「AI 标签」测试）。
 *
 * AI 助手与知识图谱不再是标签栏里的合成标签，而是工作台的段；标签栏只剩
 * 「工作台 + 文档」两类语义。这组用例守住三件事：
 * 1. 工作台标签常驻、固定最左、没有关闭按钮；
 * 2. 点文件标签会收起工作台，点工作台会回到前台；
 * 3. AI 的运行/审批状态仍然在标签栏上可见（挪到了工作台标签里）。
 */

function mountTabBar() {
  return mount(TabBar)
}

describe('工作台标签', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
  })

  it('常驻且固定在最左，没有关闭按钮', () => {
    const wrapper = mountTabBar()
    const tabs = wrapper.findAll('.tab')

    expect(tabs.length).toBe(1)
    expect(tabs[0].attributes('data-testid')).toBe('workspace-tab')
    expect(tabs[0].text()).toContain('工作台')
    expect(tabs[0].find('.tab-close-btn').exists()).toBe(false)
  })

  it('有文件时仍然排在最前，文件标签跟在后面', async () => {
    const fileStore = useFileStore()
    fileStore.createGeneratedDocument('一', 'a', 'markdown')
    const wrapper = mountTabBar()
    await nextTick()

    const order = wrapper
      .findAll('.tab')
      .map((tab) => tab.attributes('data-testid') ?? tab.attributes('data-tab-id'))

    expect(order[0]).toBe('workspace-tab')
    expect(order.length).toBe(2)
  })

  it('点击工作台把它提到前台', async () => {
    const wrapper = mountTabBar()
    const workspace = useWorkspaceStore()
    expect(workspace.active).toBe(false)

    await wrapper.get('[data-testid="workspace-tab"]').trigger('click')

    expect(workspace.active).toBe(true)
    expect(wrapper.get('[data-testid="workspace-tab"]').classes()).toContain('active')
  })

  it('选中文件标签后工作台收起，文件成为活动标签', async () => {
    const fileStore = useFileStore()
    const workspace = useWorkspaceStore()
    const tab = fileStore.createGeneratedDocument('文档', 'content', 'markdown')
    const wrapper = mountTabBar()
    workspace.open('graph')
    await nextTick()

    await wrapper.get(`[data-tab-id="${tab.id}"]`).trigger('click')

    expect(workspace.active).toBe(false)
    expect(fileStore.activeTabId).toBe(tab.id)
  })

  it('AI 没有运行时，标签上不显示状态标记', async () => {
    const wrapper = mountTabBar()
    const aiStore = useAiStore()
    aiStore.openPanel()
    aiStore.deactivatePanel()
    await nextTick()

    expect(wrapper.find('[data-testid="ai-running-marker"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ai-approval-marker"]').exists()).toBe(false)
  })

  it('AI 运行与待审批状态显示在工作台标签上', async () => {
    const wrapper = mountTabBar()
    const aiStore = useAiStore()
    aiStore.openPanel()
    aiStore.running = true
    await nextTick()
    expect(wrapper.find('[data-testid="ai-running-marker"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ai-approval-marker"]').exists()).toBe(false)

    aiStore.running = false
    aiStore.pendingApprovals.push({} as never)
    await nextTick()
    expect(wrapper.find('[data-testid="ai-running-marker"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ai-approval-marker"]').exists()).toBe(true)
  })
})

describe('工作台视图', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
  })

  it('AI 段显示 AiPanel，同时保留已打开的文档编辑器', async () => {
    const fileStore = useFileStore()
    fileStore.createGeneratedDocument('文档', 'content', 'markdown')
    const wrapper = mount(EditorPanel, {
      global: {
        stubs: {
          TabBar: true,
          IrEditor: { template: '<div data-testid="document-editor" />' },
          SourceEditor: { template: '<div data-testid="document-editor" />' },
          PreviewPanel: true,
          AiPanel: { template: '<div data-testid="ai-panel" />' }
        }
      }
    })
    const workspace = useWorkspaceStore()
    workspace.open('ai')
    await nextTick()

    expect(wrapper.get('[data-testid="ai-panel"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="document-editor"]').exists()).toBe(true)
  })

  it('把 ready 透传给 AiPanel，并转发设置请求', async () => {
    const wrapper = mount(EditorPanel, {
      props: { aiReady: false },
      global: {
        stubs: {
          TabBar: true,
          AiPanel: {
            props: ['ready'],
            emits: ['open-settings'],
            template:
              '<button data-testid="ai-panel" :data-ready="ready" @click="$emit(\'open-settings\')" />'
          }
        }
      }
    })
    useWorkspaceStore().open('ai')
    await nextTick()

    expect(wrapper.get('[data-testid="ai-panel"]').attributes('data-ready')).toBe('false')
    await wrapper.setProps({ aiReady: true })
    expect(wrapper.get('[data-testid="ai-panel"]').attributes('data-ready')).toBe('true')
    await wrapper.get('[data-testid="ai-panel"]').trigger('click')
    expect(wrapper.emitted('openAiSettings')).toHaveLength(1)
  })

  it('关掉 AI 之后退回图谱段，而不是留一块空白', async () => {
    const wrapper = mount(EditorPanel, {
      global: {
        stubs: { TabBar: true, AiPanel: { template: '<div data-testid="ai-panel" />' } }
      }
    })
    const aiStore = useAiStore()
    const workspace = useWorkspaceStore()
    workspace.open('ai')
    await nextTick()
    expect(workspace.segment).toBe('ai')

    await aiStore.requestClosePanel()
    await nextTick()

    // 图谱段是工作台的默认落点：AI 收起后回到这里，而不是一块什么都没有的空白
    expect(workspace.segment).toBe('graph')
    expect(workspace.active).toBe(true)
    expect(wrapper.find('[data-testid="ai-panel"]').exists()).toBe(false)
  })

  it('切到图谱段时进入图谱模式，且默认不展开', async () => {
    mount(EditorPanel, { global: { stubs: { TabBar: true } } })
    const graphStore = useGraphStore()
    const workspace = useWorkspaceStore()

    workspace.open('graph')
    await nextTick()

    expect(workspace.segment).toBe('graph')
    expect(workspace.active).toBe(true)
    expect(graphStore.panelOpen).toBe(true)
    expect(workspace.expanded).toBe(false)
  })
})

describe('AI 入口', () => {
  it('不再自动打开 AI，从视图菜单打开时进入工作台的 AI 段', async () => {
    setActivePinia(createPinia())
    const wrapper = mount(AppHeader, {
      global: { stubs: { teleport: true } }
    })
    const aiStore = useAiStore()
    const workspace = useWorkspaceStore()
    expect(aiStore.panelOpen).toBe(false)

    await wrapper.findAll('.menu-item').find((item) => item.text() === '视图')!.trigger('click')
    await wrapper.findAll('.menu-entry').find((item) => item.text().includes('AI 助手'))!.trigger('click')

    expect(aiStore.panelOpen).toBe(true)
    expect(workspace.active).toBe(true)
    expect(workspace.segment).toBe('ai')
  })

  it('头部不再有独立的 AI 按钮——AI 常驻工作台，入口只剩菜单与工作台分段', () => {
    setActivePinia(createPinia())
    const wrapper = mount(AppHeader, {
      global: { stubs: { teleport: true } }
    })

    expect(wrapper.find('[aria-label="AI 助手"]').exists()).toBe(false)
    // 菜单里的入口还在：它是键盘/鼠标之外唯一不经过标签栏的路径
    expect(wrapper.find('.menu-item').exists()).toBe(true)
  })
})
