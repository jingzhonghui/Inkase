// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 工作台顶条（照官网 §知识图谱 面板的 `.grf__bar`）。
 *
 * 这一条是整屏唯一说「这个库有多大」的地方：分段 · 已筛选标记 · 搜索 ·
 * 四个计数 · 两个图标按钮。四个计数里的断链与孤儿是库健康抽屉的入口，
 * 抽屉本体在画布那一层，所以这里断言的是「点了有没有把状态交出去」。
 */

const BOX = vi.hoisted(() => ({ root: 'C:\\ws' as string | null }))

vi.mock('../../../stores/file', async () => {
  const { reactive } = await import('vue')
  const state = reactive({ openedFolderPath: BOX.root })
  return {
    useFileStore: () => ({
      get openedFolderPath() {
        return state.openedFolderPath
      },
      get tabs() {
        return []
      },
      get activeTab() {
        return null
      }
    })
  }
})

vi.mock('../../../stores/ai', () => ({
  useAiStore: () => ({
    panelOpen: false,
    panelActive: false,
    openPanel: vi.fn(),
    activatePanel: vi.fn(),
    deactivatePanel: vi.fn()
  })
}))

const { default: WorkspaceTopBar } = await import('../WorkspaceTopBar.vue')
const { useGraphStore } = await import('../../../stores/graph')
const { useWorkspaceStore } = await import('../../../stores/workspace')
const { buildGraph } = await import('../../../../shared/graph/build')

const ROOT = 'C:\\ws'

function payload(options: { broken?: boolean; orphan?: boolean } = {}) {
  const files = [
    { path: 'a.md', format: 'markdown' as const, links: [{ href: 'docs/b.md', line: 1 }] },
    { path: 'docs/b.md', format: 'markdown' as const, links: [] }
  ]
  if (options.broken) {
    files[0].links.push({ href: 'not-here.md', line: 3 })
  }
  return buildGraph({ root: ROOT, files })
}

function seedGraph(
  store: ReturnType<typeof useGraphStore>,
  data: ReturnType<typeof buildGraph> | null
): void {
  store.payload = data
  store.builtRoot = data ? ROOT : null
}

beforeEach(() => {
  setActivePinia(createPinia())
  const workspace = useWorkspaceStore()
  workspace.segment = 'graph'
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    buildGraph: vi.fn().mockResolvedValue({ success: true, data: payload() }),
    onGraphProgress: () => () => {}
  }
})

function mountBar(): ReturnType<typeof mount> {
  return mount(WorkspaceTopBar)
}

describe('顶条 · 分段', () => {
  it('两个段都渲染，当前段是实心浅蓝胶囊', async () => {
    const wrapper = mountBar()
    const segments = wrapper.findAll('.ws-seg')
    expect(segments.map((item) => item.text())).toEqual(['图谱', 'AI 助手'])
    expect(segments[0]!.classes()).toContain('active')

    await segments[1]!.trigger('click')
    expect(useWorkspaceStore().segment).toBe('ai')
    expect(wrapper.findAll('.ws-seg')[1]!.classes()).toContain('active')
  })
})

describe('顶条 · 四个计数', () => {
  it('节点 / 链接 / 断链 / 孤儿都在这条栏里', () => {
    const store = useGraphStore()
    const data = payload({ broken: true })
    seedGraph(store, data)
    const wrapper = mountBar()

    const counts = wrapper.find('.ws-counts').text()
    expect(counts).toContain(`节点 ${data.stats.nodeCount}`)
    expect(counts).toContain(`链接 ${data.stats.edgeCount}`)
    expect(counts).toContain(`断链 ${data.stats.unresolvedCount}`)
    expect(counts).toContain(`孤儿 ${data.stats.orphanCount}`)
  })

  it('有问题时断链计数转告警色', () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountBar()

    const warn = wrapper.findAll('.ws-count.is-warn')
    expect(warn.length).toBe(1)
    expect(warn[0]!.text()).toContain('断链')
  })

  it('为 0 的计数不抢注意力（is-zero）', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountBar()

    expect(wrapper.findAll('.ws-count.is-zero').length).toBe(2)
  })

  it('加载中不显示计数：宁可空着，也不先闪一个 0', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.loading = true
    const wrapper = mountBar()

    expect(wrapper.find('.ws-counts').exists()).toBe(false)
  })

  it('悬停给出扫描文件数与用时', () => {
    const store = useGraphStore()
    seedGraph(
      store,
      buildGraph({
        root: ROOT,
        files: [{ path: 'a.md', format: 'markdown' as const, links: [] }],
        filesScanned: 12,
        elapsedMs: 34
      })
    )
    const wrapper = mountBar()

    const title = wrapper.find('.ws-counts').attributes('title')
    expect(title).toContain('已扫描 12 个文件')
    expect(title).toContain('34 ms')
  })

  it('点断链计数打开库健康抽屉的断链分区', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountBar()

    const link = wrapper.findAll('.ws-count').find((item) => item.text().includes('断链'))!
    await link.trigger('click')

    expect(store.issuesOpen).toBe(true)
    expect(store.issuesSection).toBe('unresolved')
  })

  it('点孤儿计数打开孤儿分区', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ orphan: true }))
    const wrapper = mountBar()

    const link = wrapper.findAll('.ws-count').find((item) => item.text().includes('孤儿'))!
    await link.trigger('click')

    expect(store.issuesOpen).toBe(true)
    expect(store.issuesSection).toBe('orphans')
  })
})

describe('顶条 · 搜索与筛选标记', () => {
  it('输入关键词写入 filters.query', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountBar()

    await wrapper.find('.ws-search input').setValue('b')
    expect(store.filters.query).toBe('b')
  })

  it('有关键词时出现清除按钮，点击清空', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountBar()

    await wrapper.find('.ws-search input').setValue('b')
    const clear = wrapper.find('.ws-search__clear')
    expect(clear.exists()).toBe(true)

    await clear.trigger('click')
    expect(store.filters.query).toBe('')
    expect(wrapper.find('.ws-search__clear').exists()).toBe(false)
  })

  it('回车把命中项居中（请求发在 store 里）', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountBar()

    await wrapper.find('.ws-search input').setValue('b')
    await wrapper.find('.ws-search input').trigger('keydown.enter')

    expect(store.selectedId).toBe('docs/b.md')
    expect(store.focusRequest?.id).toBe('docs/b.md')
  })

  it('有筛选条件时显示「已筛选」，搜索时把词说出来', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountBar()

    expect(wrapper.find('.ws-chip').exists()).toBe(false)

    store.filters.formats = ['markdown']
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-chip').text()).toBe('已筛选')

    store.setQuery('b')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-chip').text()).toBe('搜「b」')
  })
})

describe('顶条 · 两个图标按钮', () => {
  it('刷新按钮在加载中禁用', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.loading = true
    const wrapper = mountBar()

    const refresh = wrapper.findAll('.ws-bar__icon')[1]!
    expect(refresh.attributes('disabled')).toBeDefined()
  })

  it('侧栏开关把 expanded 翻过来', async () => {
    const workspace = useWorkspaceStore()
    const wrapper = mountBar()

    const toggle = wrapper.findAll('.ws-bar__icon')[0]!
    await toggle.trigger('click')

    expect(workspace.expanded).toBe(true)
    expect(toggle.classes()).toContain('active')
  })

  it('切到 AI 段时这几个控件都不渲染', async () => {
    const wrapper = mountBar()
    await wrapper.findAll('.ws-seg')[1]!.trigger('click')

    expect(wrapper.find('.ws-search').exists()).toBe(false)
    expect(wrapper.find('.ws-counts').exists()).toBe(false)
    expect(wrapper.findAll('.ws-bar__icon').length).toBe(0)
  })
})
