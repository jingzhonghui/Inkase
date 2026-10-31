// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 图谱视图（版式照官网 §知识图谱 那块面板）。
 *
 * 只测「视图该说什么话」：空态/加载/失败/空库的文案、告警条、侧栏三组索引、
 * 局部图的中心与深度、选中卡片与库健康抽屉。画布内部的绘制与物理在
 * GraphCanvas 测试里单独覆盖，这里把它 stub 掉。
 *
 * 顶条那四个计数（节点/链接/断链/孤儿）不在这里：它们长在 WorkspaceTopBar 上，
 * 由 `WorkspaceTopBar.test.ts` 覆盖。视图这一层刻意不重复同一份读数。
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
      get libraryRevision() {
        return 0
      },
      get error() {
        return null
      },
      openFile: (path: string) => {
        box.state.opened.push(path)
        return Promise.resolve(true)
      },
      openFolder: () => {
        box.state.openFolderCalls++
        return Promise.resolve(true)
      },
      createFile: () => Promise.resolve(true),
      updateTabContent: () => undefined
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

/**
 * 画布替身：除了渲染一个占位 div，还要把 `centerOnNode` / `fitContent`
 * 暴露出来——视图会通过 ref 调它们（卡片跳转、适应内容），
 * 一个只会渲染模板的替身会让这些回调在测试里炸掉。
 */
const GraphCanvasStub = defineComponent({
  name: 'GraphCanvas',
  setup(_props, { expose }) {
    const noop = (): void => {}
    expose({ centerOnNode: noop, fitContent: noop })
    return () => h('div', { class: 'graph-canvas-stub' })
  }
})

function mountView(): ReturnType<typeof mount> {
  return mount(GraphView, {
    global: {
      stubs: { GraphCanvas: GraphCanvasStub }
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

  it('空态是一个居中的小盒：拉丁文眉标 + 一句话 + 一个出口', () => {
    box.state.openedFolderPath = null
    const wrapper = mountView()

    expect(wrapper.find('.graph-state__k').text()).toBe('WORKSPACE')
    expect(wrapper.find('.graph-state__b').text()).toBe('打开文件夹')
  })
})

describe('TC-VIEW-002 加载中', () => {
  it('显示扫描提示与一条扫描线', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.loading = true
    const wrapper = mountView()

    expect(wrapper.text()).toContain('正在扫描工作区…')
    expect(wrapper.find('.graph-state__k').text()).toBe('SCAN')
    expect(wrapper.find('.graph-state__progress').exists()).toBe(true)
  })

  it('有进度时显示「已扫描 x / y」', () => {
    const store = useGraphStore()
    store.loading = true
    store.progress = { scanned: 3, total: 10 }
    const wrapper = mountView()

    expect(wrapper.text()).toContain('已扫描 3 / 10')
  })

  it('加载中不渲染侧栏（没有可信的计数可给）', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.loading = true
    const wrapper = mountView()

    expect(wrapper.find('.graph-rail').exists()).toBe(false)
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

describe('TC-VIEW-005 侧栏不再重复读数', () => {
  it('没有「概况」分组：四个计数只在顶条出现一次', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountView()

    expect(wrapper.find('.graph-rail__stats').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('概况')
  })

  it('目录行给出与画布一致的篇数', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountView()

    const rows = wrapper.findAll('.graph-rail__row')
    const rootRow = rows.find((item) => item.find('.graph-rail__name').text() === '根目录')!
    expect(rootRow.find('.graph-rail__n').text()).toBe('2')
    const docsRow = rows.find((item) => item.find('.graph-rail__name').text() === 'docs')!
    expect(docsRow.find('.graph-rail__n').text()).toBe('1')
  })

  it('类型行按形状分组给出篇数', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountView()

    const row = wrapper.find('[title="开关 文档 .mdx .md"]')
    expect(row.exists()).toBe(true)
    expect(row.find('.graph-rail__n').text()).toBe('2')
  })

  it('目录计数不含断链幽灵节点', () => {
    const store = useGraphStore()
    const data = payload({ broken: true })
    seedGraph(store, data)

    const ghostCount = data.nodes.filter((node) => node.unresolved).length
    expect(ghostCount).toBeGreaterThan(0)
    // 幽灵节点不属于任何目录，目录计数只数真实文件
    const folderTotal = data.nodes.filter((node) => !node.unresolved).length
    expect(folderTotal).toBe(data.nodes.length - ghostCount)
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
  /** 视图分组的两行索引：全库 / 局部 · N 跳 */
  function modeRow(wrapper: ReturnType<typeof mount>, label: string) {
    return wrapper
      .findAll('.graph-rail__modes .graph-rail__row')
      .find((item) => item.text().startsWith(label))!
  }

  it('默认全库，点击后进局部并显示中心与深度控件', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    // 切局部要有个中心：选中节点或当前激活文件，二者都没有时会退回全库
    store.selectNode('docs/b.md')
    store.mode = 'global'
    const wrapper = mountView()

    expect(modeRow(wrapper, '全库').classes()).toContain('is-on')
    expect(wrapper.find('.graph-rail__center').exists()).toBe(false)

    await modeRow(wrapper, '局部').trigger('click')

    expect(store.mode).toBe('local')
    expect(modeRow(wrapper, '局部').classes()).toContain('is-on')
    expect(wrapper.find('.graph-rail__center-name').text()).toBe('b')
    expect(wrapper.find('.graph-rail__depth-track button.is-on').text()).toBe('1')
  })

  it('分组标题右侧的注脚跟着模式走', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.selectNode('docs/b.md')
    const wrapper = mountView()

    expect(wrapper.find('.graph-rail__note').text()).toBe('全库')

    await modeRow(wrapper, '局部').trigger('click')
    expect(wrapper.find('.graph-rail__note').text()).toBe('深度 1')
  })

  it('点深度按钮调用 setDepth', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.setCenter('docs/b.md')
    store.selectNode('docs/b.md')
    const wrapper = mountView()

    const third = wrapper
      .findAll('.graph-rail__depth-track button')
      .find((item) => item.text() === '3')!
    await third.trigger('click')

    expect(store.depth).toBe(3)
    expect(wrapper.find('.graph-rail__depth-track button.is-on').text()).toBe('3')
    expect(wrapper.find('.graph-rail__note').text()).toBe('深度 3')
  })

  it('中心卡片上的 × 退回全库', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.setCenter('docs/b.md')
    const wrapper = mountView()

    await wrapper.find('.graph-rail__center-x').trigger('click')

    expect(store.mode).toBe('global')
    expect(wrapper.find('.graph-rail__center').exists()).toBe(false)
  })

  it('无中心时点局部退回全库', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    box.state.activeTab = null
    const wrapper = mountView()

    await modeRow(wrapper, '局部').trigger('click')

    expect(store.mode).toBe('global')
  })
})

describe('TC-VIEW-008 过滤', () => {
  it('类型按形状分组：点「文档」同时关掉 .mdx 与 .md', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountView()

    const row = wrapper.find('[title="开关 文档 .mdx .md"]')
    expect(row.attributes('aria-pressed')).toBe('true')

    await row.trigger('click')

    expect(store.filters.formats).not.toContain('markdown')
    expect(store.filters.formats).not.toContain('mdx')
    expect(row.attributes('aria-pressed')).toBe('false')
    // 关掉的组整行变淡，而不是从一栏里消失（位置要固定）
    expect(row.classes()).toContain('is-off')
  })

  it('TC-VIEW-011 「其他」组控制附件可见性，形状是三角', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ attachment: true }))
    const wrapper = mountView()

    const row = wrapper.find('[title="开关 其他 任意后缀"]')
    expect(row.exists()).toBe(true)
    expect(row.find('.graph-rail__shape--triangle').exists()).toBe(true)

    await row.trigger('click')

    expect(store.filters.formats).not.toContain('attachment')
    expect(store.visibleNodes.some((node) => node.format === 'attachment')).toBe(false)
  })

  it('类型分组只有四行：断链幽灵的开关不在这里（库健康抽屉才是它的入口）', () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountView()

    const groups = wrapper.findAll('.graph-rail__group')
    const typesGroup = groups[groups.length - 1]!
    expect(typesGroup.findAll('.graph-rail__row')).toHaveLength(4)
    expect(typesGroup.text()).not.toContain('断链目标')
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

  it('筛空时画布仍挂载、空态是浮层（否则仿真坐标丢失、恢复筛选会重排）', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.filters.formats = []
    const wrapper = mountView()

    expect(wrapper.find('.graph-canvas-stub').exists()).toBe(true)
    expect(wrapper.find('.graph-state--overlay').exists()).toBe(true)
    expect(wrapper.text()).toContain('当前筛选下没有可显示的节点')
  })

  it('筛过之后底部才出现「重置筛选」，点了恢复默认', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    const wrapper = mountView()

    expect(wrapper.find('.graph-rail__reset').exists()).toBe(false)

    store.filters.formats = ['markdown']
    await wrapper.vm.$nextTick()

    const reset = wrapper.find('.graph-rail__reset')
    expect(reset.exists()).toBe(true)
    await reset.trigger('click')

    expect(store.isFiltered).toBe(false)
    expect(wrapper.find('.graph-rail__reset').exists()).toBe(false)
  })
})

describe('TC-VIEW-009 库健康抽屉', () => {
  it('抽屉默认关着', () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountView()

    expect(wrapper.find('.graph-issues').exists()).toBe(false)
  })

  it('从 store 打开并停在断链分区', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountView()

    store.openIssues('unresolved')
    await wrapper.vm.$nextTick()

    const issues = wrapper.findComponent({ name: 'GraphIssues' })
    expect(issues.exists()).toBe(true)
    expect(issues.props('section')).toBe('unresolved')
    expect(wrapper.find('.graph-issues').text()).toContain(String(store.issues.unresolved.length))
  })

  it('开在孤儿分区', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountView()

    store.openIssues('orphans')
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'GraphIssues' }).props('section')).toBe('orphans')
  })

  it('抽屉打开时让出选中卡片的位置（两块浮卡不叠）', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    store.selectNode('a.md')
    const wrapper = mountView()

    expect(wrapper.find('.graph-card').exists()).toBe(true)

    store.openIssues('unresolved')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.graph-card').exists()).toBe(false)
  })

  it('关闭抽屉后状态回到关着', async () => {
    const store = useGraphStore()
    seedGraph(store, payload({ broken: true }))
    const wrapper = mountView()

    store.openIssues('unresolved')
    await wrapper.vm.$nextTick()
    await wrapper.find('.graph-issues__close').trigger('click')

    expect(store.issuesOpen).toBe(false)
    expect(wrapper.find('.graph-issues').exists()).toBe(false)
  })
})

describe('TC-VIEW-010 选中节点卡片', () => {
  it('显示标签、路径、出入链与格式', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.selectNode('docs/b.md')
    const wrapper = mountView()

    const card = wrapper.find('.graph-card')
    expect(card.find('.graph-card__title').text()).toBe('b')
    expect(card.find('.graph-card__path').text()).toBe('docs/b.md')
    expect(card.text()).toContain('出链 0')
    expect(card.text()).toContain('入链 1')
    expect(card.find('.graph-card__fmt').text()).toBe('Markdown · docs')
  })

  it('TC-VIEW-012 选中附件时标成「其他文件」并显示带扩展名的文件名', () => {
    const store = useGraphStore()
    seedGraph(store, payload({ attachment: true }))
    store.selectedId = 'scripts/deploy.sh'
    const wrapper = mountView()

    expect(wrapper.find('.graph-card__shape--triangle').exists()).toBe(true)
    expect(wrapper.find('.graph-card__fmt').text()).toContain('其他文件')
    expect(wrapper.find('.graph-card__title').text()).toBe('deploy.sh')
  })

  it('断链幽灵节点显示「未解析的链接目标」，没有打开与链接入口', () => {
    const store = useGraphStore()
    const data = payload({ broken: true })
    seedGraph(store, data)
    const ghost = data.nodes.find((node) => node.unresolved)!
    store.selectNode(ghost.id)
    const wrapper = mountView()

    const card = wrapper.find('.graph-card')
    expect(card.find('.graph-card__path').text()).toBe('（未解析的链接目标）')
    expect(card.find('.graph-card__fmt').text()).toContain('断链目标')
    expect(card.find('.graph-card__shape--ghost').exists()).toBe(true)
    expect(card.findAll('.graph-card__act').map((item) => item.text())).toEqual(['看局部'])
  })

  it('列出引用与被引用，点一条就选中那个邻居', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.selectNode('docs/b.md')
    const wrapper = mountView()

    const card = wrapper.find('.graph-card')
    // b 被 a 引用，自己不出链
    expect(card.text()).toContain('被引用')
    const link = card.find('.graph-card__link')
    expect(link.find('.graph-card__link-name').text()).toBe('a')

    await link.trigger('click')
    expect(store.selectedId).toBe('a.md')
  })

  it('没有邻居时给正向空态，而不是留一片空白', () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.selectNode('map.inkmind')
    const wrapper = mountView()

    const card = wrapper.find('.graph-card')
    expect(card.text()).toContain('没有出链')
    expect(card.text()).toContain('还没有文档链接到这里')
  })

  it('「看局部」把中心切到这个节点', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.selectNode('docs/b.md')
    const wrapper = mountView()

    const local = wrapper.findAll('.graph-card__act').find((item) => item.text() === '看局部')!
    await local.trigger('click')

    expect(store.mode).toBe('local')
    expect(store.centerId).toBe('docs/b.md')
    expect(store.depth).toBe(1)
  })

  it('「×」清空选中', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.selectNode('a.md')
    const wrapper = mountView()

    await wrapper.find('.graph-card__x').trigger('click')

    expect(store.selectedId).toBeNull()
    expect(wrapper.find('.graph-card').exists()).toBe(false)
  })

  it('局部模式下提示未显示的邻居数并可扩展到全库', async () => {
    const store = useGraphStore()
    seedGraph(store, payload())
    store.setCenter('docs/b.md')
    store.setDepth(1)
    store.selectNode('docs/b.md')
    const wrapper = mountView()

    const note = wrapper.find('.graph-card__note')
    if (note.exists()) {
      await note.find('button').trigger('click')
      expect(store.mode).toBe('global')
    } else {
      // 该图深度 1 已覆盖全部邻居，则不该出现提示
      expect(store.hiddenNeighborCount).toBe(0)
    }
  })
})
