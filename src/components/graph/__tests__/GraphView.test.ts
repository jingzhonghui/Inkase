// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 图谱视图（设计 §4.1 / §5.7 / §7）。
 * 对应 TC-VIEW-001 ~ 010。
 *
 * 只测「视图该说什么话」：空态/加载/失败/空库的文案、四个计数、告警条、
 * 模式切换、搜索与过滤、选中节点信息卡。画布内部的绘制与物理在
 * GraphCanvas 测试里单独覆盖，这里把它 stub 掉。
 */

const box = vi.hoisted(() => ({
  state: null as unknown as {
    openedFolderPath: string | null
    tabs: unknown[]
    activeTab: null | { id: string; fileInfo?: { path: string } }
    opened: string[]
    openFolderCalls: number
  }
}))

vi.mock('../../../stores/file', async () => {
  const { reactive } = await import('vue')
  box.state = reactive({
    openedFolderPath: null as string | null,
    tabs: [] as unknown[],
    activeTab: null,
    opened: [] as string[],
    openFolderCalls: 0
  })
  return {
    useFileStore: () => ({
      get openedFolderPath() {
        return box.state.openedFolderPath
      },
      get tabs() {
        return box.state.tabs
      },
      get activeTab() {
        return box.state.activeTab
      },
      openFile: (path: string) => {
        box.state.opened.push(path)
        return Promise.resolve(true)
      },
      openFolder: () => {
        box.state.openFolderCalls++
        return Promise.resolve(true)
      }
    })
  }
})

vi.mock('../../../stores/ai', () => ({
  useAiStore: () => ({ panelOpen: false, panelActive: false, deactivatePanel: vi.fn() })
}))

const { default: GraphView } = await import('../GraphView.vue')
const { useGraphStore } = await import('../../../stores/graph')
const { buildGraph } = await import('../../../../shared/graph/build')

type Payload = ReturnType<typeof buildGraph>

const ROOT = 'C:\\ws'

function payload(options: { broken?: boolean; orphan?: boolean; attachment?: boolean } = {}): Payload {
  const files = [
    { path: 'a.md', format: 'markdown' as const, links: [{ href: 'docs/b.md', line: 1 }] },
    { path: 'docs/b.md', format: 'markdown' as const, links: [] },
    { path: 'map.inkmind', format: 'mindmap' as const, links: [] }
  ]
  if (options.broken) {
    files[0].links.push({ href: 'not-here.md', line: 3 })
  }
  if (options.attachment) {
    files[0].links.push({ href: 'scripts/deploy.sh', line: 5 })
  }
  return buildGraph({
    root: ROOT,
    files,
    attachmentPaths: options.attachment ? ['scripts/deploy.sh'] : undefined
  })
}

function mountView(): ReturnType<typeof mount> {
  return mount(GraphView, {
    global: {
      stubs: { GraphCanvas: { template: '<div class="graph-canvas-stub" />' } }
    }
  })
}

function seedGraph(store: ReturnType<typeof useGraphStore>, data: Payload | null): void {
  store.payload = data
  store.builtRoot = data ? ROOT : null
}

beforeEach(() => {
  setActivePinia(createPinia())
  box.state.openedFolderPath = ROOT
  box.state.tabs = []
  box.state.activeTab = null
  box.state.opened = []
  box.state.openFolderCalls = 0
  // 注意：只能挂 electronAPI，不能整体替换 window——否则 jsdom 的 Event
  // 构造器会丢，@vue/test-utils 的 trigger() 会报 SupportedEventInterface 不是构造器
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    buildGraph: vi.fn().mockResolvedValue({ success: true, data: payload() }),
    onGraphProgress: () => () => {}
  }
})

describe('TC-VIEW-001 未打开文件夹', () => {
  it('显示「以工作区为范围」空态并给出打开文件夹入口', () => {
    box.state.openedFolderPath = null
    const wrapper = mountView()

    expect(wrapper.find('.graph-state').text()).toContain('知识图谱以工作区为范围')
    expect(wrapper.text()).toContain('先打开一个文件夹')
    // 没有打开文件夹时不该渲染画布
    expect(wrapper.find('.graph-canvas-stub').exists()).toBe(false)
  })

  it('点「打开文件夹」调用 fileStore.openFolder', async () => {
    box.state.openedFolderPath = null
    const wrapper = mountView()

    const button = wrapper.findAll('button').find((item) => item.text() === '打开文件夹')
    await button!.trigger('click')

    expect(box.state.openFolderCalls).toBe(1)
  })
})

describe('TC-VIEW-002 加载中', () => {
  it('显示扫描提示且隐藏计数（加载中没有可信数字）', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.loading = true
    const wrapper = mountView()

    expect(wrapper.text()).toContain('正在扫描工作区…')
    expect(wrapper.find('.graph-header__stats').exists()).toBe(false)
    expect(wrapper.find('.graph-state__spinner').exists()).toBe(true)
  })

  it('有进度时显示「已扫描 x / y」', () => {
    const store = useGraphStore()
    store.loading = true
    store.progress = { scanned: 3, total: 10 }
    const wrapper = mountView()

    expect(wrapper.text()).toContain('已扫描 3 / 10')
  })

  it('刷新按钮在加载中禁用', () => {
    const store = useGraphStore()
    store.loading = true
    const wrapper = mountView()

    expect(wrapper.find('.graph-header__refresh').attributes('disabled')).toBeDefined()
  })
})

describe('TC-VIEW-003 构建失败', () => {
  it('显示「构建失败」与错误信息，并提供重试', async () => {
    const store = useGraphStore()
    store.error = '扫描炸了'
    const refresh = vi.spyOn(store, 'refresh').mockResolvedValue(undefined)
    const wrapper = mountView()

    expect(wrapper.text()).toContain('构建失败')
    expect(wrapper.text()).toContain('扫描炸了')

    const retry = wrapper.findAll('button').find((item) => item.text() === '重试')
    await retry!.trigger('click')
    expect(refresh).toHaveBeenCalled()
  })

  it('有错误时不渲染画布', () => {
    const store = useGraphStore()
    store.error = '出错了'
    const wrapper = mountView()

    expect(wrapper.find('.graph-canvas-stub').exists()).toBe(false)
  })
})

describe('TC-VIEW-004 空工作区', () => {
  it('提示没有可索引文档并说明支持格式', () => {
    const store = useGraphStore()
    seedGraph(store, buildGraph({ root: ROOT, files: [] }))
    const wrapper = mountView()

    expect(wrapper.text()).toContain('这个工作区里还没有可索引的文档')
    expect(wrapper.text()).toContain('.mdx')
    expect(wrapper.text()).toContain('.inkmind')
    expect(wrapper.text()).toContain('.drawio')
  })
})

describe('TC-VIEW-005 四个计数', () => {
  /** 断链与孤儿是质量指标，归侧栏「质量」分组；节点/链接在页头 */
  function issueRow(wrapper: ReturnType<typeof mount>, key: 'unresolved' | 'orphans') {
    return wrapper.find(`[data-issue="${key}"]`)
  }

  it('节点/链接在页头，断链/孤儿在侧栏', () => {
    const store = useGraphStore()
    const data = payload()
    seedGraph(store, data)
    const wrapper = mountView()

    const header = wrapper.find('.graph-header__stats').text()
    expect(header).toContain(`节点 ${data.stats.nodeCount}`)
    expect(header).toContain(`链接 ${data.stats.edgeCount}`)

    expect(issueRow(wrapper, 'unresolved').text()).toContain(String(data.stats.unresolvedCount))
    expect(issueRow(wrapper, 'orphans').text()).toContain(String(data.stats.orphanCount))
  })

  it('有问题时侧栏计数加 warning 样式', () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountView()

    const warning = wrapper.findAll('.graph-rail__num.warn')
    expect(warning.length).toBeGreaterThan(0)
  })

  it('节点数含断链幽灵节点（与画布圆点数一致）', () => {
    const store = useGraphStore()
    const data = payload({ broken: true })
    seedGraph(store, data)
    const wrapper = mountView()

    const ghostCount = data.nodes.filter((node) => node.unresolved).length
    expect(ghostCount).toBeGreaterThan(0)
    expect(wrapper.find('.graph-header__stats').text()).toContain(`节点 ${data.nodes.length}`)
  })

  it('截断时显示「已截断」标记与说明', () => {
    const store = useGraphStore()
    seedGraph(store, buildGraph({ root: ROOT, files: [], truncated: true }))
    const wrapper = mountView()

    const truncated = wrapper.find('.graph-header__stat.truncated')
    expect(truncated.exists()).toBe(true)
    expect(truncated.text()).toBe('已截断')
    expect(truncated.attributes('title')).toContain('不完整')
  })

  it('统计条的 title 给出扫描文件数与用时', () => {
    const store = useGraphStore()
    seedGraph(store, buildGraph({ root: ROOT, files: [], filesScanned: 12, elapsedMs: 34 }))
    const wrapper = mountView()

    const title = wrapper.find('.graph-header__stats').attributes('title')
    expect(title).toContain('已扫描 12 个文件')
    expect(title).toContain('34 ms')
  })
})

describe('TC-VIEW-006 告警条', () => {
  it('最多显示 3 条，其余折叠成「…等 N 条」', () => {
    const store = useGraphStore()
    seedGraph(
      store,
      buildGraph({ root: ROOT, files: [], warnings: ['w1', 'w2', 'w3', 'w4', 'w5'] })
    )
    const wrapper = mountView()

    const banner = wrapper.find('.graph-warnings')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('w1')
    expect(banner.text()).not.toContain('w4')
    expect(banner.text()).toContain('…等 5 条')
  })

  it('没有告警时不渲染告警条', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountView()

    expect(wrapper.find('.graph-warnings').exists()).toBe(false)
  })
})

describe('TC-VIEW-007 全库 ⇄ 局部', () => {
  /** 侧栏「视图」分段：全库 / 局部 */
  function segment(wrapper: ReturnType<typeof mount>, label: '全库' | '局部') {
    return wrapper.findAll('.graph-rail__segment').find((item) => item.text() === label)!
  }

  it('默认全库，点击后进局部并显示中心与深度控件', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    // 切局部要有个中心：选中节点或当前激活文件，二者都没有时会退回全库
    store.selectNode('docs/b.md')
    store.mode = 'global'
    const wrapper = mountView()

    expect(segment(wrapper, '全库').classes()).toContain('active')

    await segment(wrapper, '局部').trigger('click')

    expect(store.mode).toBe('local')
    expect(segment(wrapper, '局部').classes()).toContain('active')
    expect(wrapper.find('.graph-rail__center').text()).toBe('b')
    expect(wrapper.find('.graph-rail__depth-value').text()).toBe('1')
  })

  it('拖深度滑块调用 setDepth', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.setCenter('docs/b.md')
    store.selectNode('docs/b.md')
    const wrapper = mountView()

    const range = wrapper.find('input[type="range"]')
    await range.setValue('3')

    expect(store.depth).toBe(3)
    expect(wrapper.find('.graph-rail__depth-value').text()).toBe('3')
  })

  it('无中心时点局部退回全库', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    box.state.activeTab = null
    const wrapper = mountView()

    await segment(wrapper, '局部').trigger('click')

    expect(store.mode).toBe('global')
  })
})

describe('TC-VIEW-008 搜索与过滤', () => {
  it('输入关键词写入 filters.query', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountView()

    await wrapper.find('.graph-header__search input').setValue('b')

    expect(store.filters.query).toBe('b')
  })

  it('有关键词时出现清除按钮，点击清空', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountView()
    await wrapper.find('.graph-header__search input').setValue('b')

    const clear = wrapper.find('.graph-header__clear')
    expect(clear.exists()).toBe(true)
    await clear.trigger('click')

    expect(store.filters.query).toBe('')
  })

  it('类型按形状分组：点「文档」同时关掉 .mdx 与 .md', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountView()

    const row = wrapper.find('[title="开关 .mdx .md"]')
    expect(row.exists()).toBe(true)
    expect(row.attributes('aria-pressed')).toBe('true')

    await row.trigger('click')

    expect(store.filters.formats).not.toContain('markdown')
    expect(store.filters.formats).not.toContain('mdx')
    expect(row.attributes('aria-pressed')).toBe('false')
  })

  it('TC-VIEW-011 「其他」组控制附件可见性，形状是三角', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ attachment: true }))
    const wrapper = mountView()

    const row = wrapper.find('[title="开关 任意后缀"]')
    expect(row.exists()).toBe(true)
    expect(row.find('.graph-rail__shape--triangle').exists()).toBe(true)
    expect(row.find('.graph-rail__ext').text()).toBe('任意后缀')

    await row.trigger('click')

    expect(store.filters.formats).not.toContain('attachment')
    expect(store.visibleNodes.some((node) => node.format === 'attachment')).toBe(false)
  })

  it('TC-VIEW-012 选中附件时信息卡标成「其他文件」并显示带扩展名的文件名', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ attachment: true }))
    store.selectedId = 'scripts/deploy.sh'
    const wrapper = mountView()

    expect(wrapper.find('.graph-info__shape--triangle').exists()).toBe(true)
    expect(wrapper.find('.graph-info__kind').text()).toContain('其他文件')
    expect(wrapper.find('.graph-info__title').text()).toBe('deploy.sh')
  })

  it('目录行点击切换该目录可见性', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountView()

    const row = wrapper
      .findAll('.graph-rail__row')
      .find((item) => item.find('.graph-rail__name').text() === 'docs')!
    await row.trigger('click')

    expect(store.visibleNodes.some((node) => node.path === 'docs/b.md')).toBe(false)
  })

  it('「断链目标」行控制 showUnresolved', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountView()

    const row = wrapper
      .findAll('.graph-rail__row')
      .find((item) => item.find('.graph-rail__name').text() === '断链目标')!
    expect(row.attributes('aria-pressed')).toBe('true')

    await row.trigger('click')

    expect(store.filters.showUnresolved).toBe(false)
    expect(store.visibleNodes.some((node) => node.unresolved)).toBe(false)
  })

  it('筛空时画布仍挂载、空态是浮层（否则仿真坐标丢失、恢复筛选会重排）', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.filters.formats = []
    const wrapper = mountView()

    expect(wrapper.find('.graph-canvas-stub').exists()).toBe(true)
    expect(wrapper.find('.graph-state--overlay').exists()).toBe(true)
    expect(wrapper.text()).toContain('当前筛选下没有可显示的节点')
  })
})

describe('TC-VIEW-009 问题面板入口', () => {
  it('侧栏显示断链 + 孤儿数量', () => {
    const store = useGraphStore()
    const data = payload({ broken: true })
    seedGraph(store, data)
    const wrapper = mountView()

    expect(wrapper.find('[data-issue="unresolved"]').text()).toContain(
      String(data.issues.unresolved.length)
    )
    expect(wrapper.find('[data-issue="orphans"]').text()).toContain(
      String(data.issues.orphans.length)
    )
  })

  it('点「断链」打开清单并停在断链分区', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountView()

    await wrapper.find('[data-issue="unresolved"]').trigger('click')

    const issues = wrapper.findComponent({ name: 'GraphIssues' })
    expect(issues.exists()).toBe(true)
    expect(issues.props('section')).toBe('unresolved')
  })

  it('点「孤儿」打开清单并直接停在孤儿分区', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountView()

    await wrapper.find('[data-issue="orphans"]').trigger('click')

    expect(wrapper.findComponent({ name: 'GraphIssues' }).props('section')).toBe('orphans')
  })
})

describe('TC-VIEW-010 选中节点信息卡', () => {
  it('显示标签、路径、出入链', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.selectNode('docs/b.md')
    const wrapper = mountView()

    const info = wrapper.find('.graph-info')
    expect(info.find('.graph-info__title').text()).toBe('b')
    expect(info.find('.graph-info__path').text()).toBe('docs/b.md')
    expect(info.text()).toContain('出链 0')
    expect(info.text()).toContain('入链 1')
  })

  it('断链幽灵节点显示「未解析的链接目标」且没有打开按钮', () => {
    const store = useGraphStore()
    const data = payload({ broken: true })
    seedGraph(store, data)
    const ghost = data.nodes.find((node) => node.unresolved)!
    store.selectNode(ghost.id)
    const wrapper = mountView()

    const info = wrapper.find('.graph-info')
    expect(info.find('.graph-info__path').text()).toBe('（未解析的链接目标）')
    expect(info.findAll('.graph-info__btn').map((item) => item.text())).toEqual(['关闭'])
  })

  it('「关闭」清空选中', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.selectNode('a.md')
    const wrapper = mountView()

    const close = wrapper.findAll('.graph-info__btn').find((item) => item.text() === '关闭')
    await close!.trigger('click')

    expect(store.selectedId).toBeNull()
    expect(wrapper.find('.graph-info').exists()).toBe(false)
  })

  it('局部模式下提示未显示的邻居数并可扩展到全库', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.setCenter('docs/b.md')
    store.setDepth(1)
    store.selectNode('docs/b.md')
    const wrapper = mountView()

    const hidden = wrapper.find('.graph-info__hidden')
    if (hidden.exists()) {
      await hidden.find('button').trigger('click')
      expect(store.mode).toBe('global')
    } else {
      // 该图深度 1 已覆盖全部邻居，则不该出现提示
      expect(store.hiddenNeighborCount).toBe(0)
    }
  })
})
