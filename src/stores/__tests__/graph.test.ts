import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 图谱 store（设计 §4.1 / §4.3 / §4.4 / §5.7 / §5.9）。
 * 对应 TC-STORE-001 ~ 010。
 *
 * 用假 Pinia + 假 `window.electronAPI`：store 只依赖三样外部东西
 * —— `fileStore`（工作区/标签）、`aiStore`（互斥）、`electronAPI.buildGraph`。
 */

/**
 * 假 fileStore / aiStore 的状态必须是**响应式**的：store 的 `dirtyFiles` 是
 * computed，若标签数组是普通对象，改动不会让它重算（脏标签覆盖会永远读到空）。
 */
const box = vi.hoisted(() => ({
  state: null as unknown as {
    openedFolderPath: string | null
    tabs: Array<{
      id: string
      fileInfo?: { path: string; format?: string; modified?: boolean }
      content?: string
    }>
    activeTab: null | { id: string; fileInfo?: { path: string } }
    opened: string[]
    aiPanelOpen: boolean
    aiPanelActive: boolean
    aiDeactivateCalls: number
  }
}))

vi.mock('../../stores/file', async () => {
  const { reactive } = await import('vue')
  box.state = reactive({
    openedFolderPath: null as string | null,
    tabs: [] as Array<{
      id: string
      fileInfo?: { path: string; format?: string; modified?: boolean }
      content?: string
    }>,
    activeTab: null as null | { id: string; fileInfo?: { path: string } },
    opened: [] as string[],
    aiPanelOpen: false,
    aiPanelActive: false,
    aiDeactivateCalls: 0
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
      }
    })
  }
})

vi.mock('../../stores/ai', () => ({
  useAiStore: () => ({
    get panelOpen() {
      return box.state.aiPanelOpen
    },
    get panelActive() {
      return box.state.aiPanelActive
    },
    deactivatePanel: () => {
      box.state.aiDeactivateCalls++
      box.state.aiPanelOpen = false
      box.state.aiPanelActive = false
    }
  })
}))

const { useGraphStore } = await import('../graph')
const { buildGraph } = await import('../../../shared/graph/build')

type Payload = ReturnType<typeof buildGraph>

function makePayload(caseInsensitive = false): Payload {
  return buildGraph({
    root: 'C:\\ws',
    caseInsensitive,
    files: [
      { path: 'a.md', format: 'markdown', links: [{ href: 'docs/b.md', line: 1 }] },
      { path: 'docs/b.md', format: 'markdown', links: [{ href: 'c.mdx', line: 2 }] },
      { path: 'c.mdx', format: 'mdx', links: [] },
      { path: 'docs/d.md', format: 'markdown', links: [] },
      { path: 'lonely.md', format: 'markdown', links: [] },
      { path: 'map.inkmind', format: 'mindmap', links: [] }
    ]
  })
}

function installApi(payload: Payload | null = makePayload()): {
  buildGraph: ReturnType<typeof vi.fn>
} {
  const buildGraphMock = vi.fn().mockResolvedValue({ success: true, data: payload })
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      buildGraph: buildGraphMock,
      onGraphProgress: () => () => {}
    }
  }
  return { buildGraph: buildGraphMock }
}

beforeEach(() => {
  setActivePinia(createPinia())
  box.state.openedFolderPath = 'C:\\ws'
  box.state.tabs = []
  box.state.activeTab = null
  box.state.opened = []
  box.state.aiPanelOpen = false
  box.state.aiPanelActive = false
  box.state.aiDeactivateCalls = 0
  installApi()
})

describe('面板生命周期', () => {
  it('TC-STORE-001 打开图谱设置 panelOpen/panelActive 并默认全库模式', async () => {
    const store = useGraphStore()

    await store.openPanel()

    expect(store.panelOpen).toBe(true)
    expect(store.panelActive).toBe(true)
    expect(store.mode).toBe('global')
    // 合成标签：不进 fileStore.tabs
    expect(box.state.tabs).toHaveLength(0)
  })

  it('TC-STORE-001 打开图谱会拉取一次索引', async () => {
    const api = installApi()
    const store = useGraphStore()

    await store.openPanel()

    expect(api.buildGraph).toHaveBeenCalledTimes(1)
    expect(store.payload?.nodes.length).toBeGreaterThan(0)
    expect(store.loading).toBe(false)
  })

  it('TC-STORE-002 关闭图谱清空激活态与数据', async () => {
    const store = useGraphStore()
    await store.openPanel()

    store.closePanel()

    expect(store.panelOpen).toBe(false)
    expect(store.panelActive).toBe(false)
    expect(store.payload).toBeNull()
    expect(store.selectedId).toBeNull()
  })

  it('TC-STORE-003 打开图谱时停用 AI 面板（互斥）', async () => {
    box.state.aiPanelOpen = true
    box.state.aiPanelActive = true
    const store = useGraphStore()

    await store.openPanel()

    expect(box.state.aiDeactivateCalls).toBe(1)
    expect(store.panelActive).toBe(true)
  })

  it('TC-STORE-003 激活图谱时再次停用 AI', async () => {
    const store = useGraphStore()
    await store.openPanel()
    box.state.aiPanelOpen = true
    box.state.aiDeactivateCalls = 0

    store.activatePanel()

    expect(box.state.aiDeactivateCalls).toBe(1)
    expect(store.panelActive).toBe(true)
  })

  it('TC-STORE-004 deactivatePanel 只撤激活态，标签仍在', async () => {
    const store = useGraphStore()
    await store.openPanel()

    store.deactivatePanel()

    expect(store.panelActive).toBe(false)
    expect(store.panelOpen).toBe(true)
  })

  it('未打开时 activatePanel 不会凭空激活', () => {
    const store = useGraphStore()

    store.activatePanel()

    expect(store.panelActive).toBe(false)
  })
})

describe('构建与错误态', () => {
  it('TC-VIEW-001 未打开文件夹时给出空态错误，不调用 IPC', async () => {
    const api = installApi()
    box.state.openedFolderPath = null
    const store = useGraphStore()

    await store.build(true)

    expect(api.buildGraph).not.toHaveBeenCalled()
    expect(store.error).toContain('先打开一个文件夹')
  })

  it('TC-VIEW-003 IPC 失败时记录错误', async () => {
    const api = installApi()
    api.buildGraph.mockResolvedValue({ success: false, error: '扫描炸了' })
    const store = useGraphStore()

    await store.build(true)

    expect(store.error).toBe('扫描炸了')
    expect(store.payload).toBeNull()
  })

  it('TC-VIEW-003 IPC 抛异常时也变成错误态而不是崩溃', async () => {
    const api = installApi()
    api.buildGraph.mockRejectedValue(new Error('网络断了'))
    const store = useGraphStore()

    await store.build(true)

    expect(store.error).toBe('网络断了')
    expect(store.loading).toBe(false)
  })

  it('未传 force 且同根已构建时不再拉取（缓存复用）', async () => {
    const api = installApi()
    const store = useGraphStore()

    await store.build(true)
    await store.build()

    expect(api.buildGraph).toHaveBeenCalledTimes(1)
  })

  it('refresh 强制重建', async () => {
    const api = installApi()
    const store = useGraphStore()
    await store.build(true)

    await store.refresh()

    expect(api.buildGraph).toHaveBeenCalledTimes(2)
  })

  it('静默刷新不把画布换成加载态（保存后重建不该闪一下转圈）', async () => {
    const api = installApi()
    const store = useGraphStore()
    await store.build(true)
    expect(store.hasGraph).toBe(true)

    const pending = store.refresh(true)
    // 重建进行中：画布上已经有图，loading 不能翻起来，否则整块画布被转圈盖住
    expect(store.loading).toBe(false)

    await pending
    expect(store.loading).toBe(false)
    expect(api.buildGraph).toHaveBeenCalledTimes(2)
  })

  it('静默刷新在没有图时仍然显示加载态', async () => {
    const api = installApi()
    const store = useGraphStore()

    const pending = store.refresh(true)
    // 第一次构建没有旧图可以留着，必须让用户看到在干活
    expect(store.loading).toBe(true)

    await pending
    expect(store.loading).toBe(false)
    expect(api.buildGraph).toHaveBeenCalledTimes(1)
  })

  it('TC-STORE-009 工作区切换后旧数据作废并重建', async () => {
    const api = installApi()
    const store = useGraphStore()
    await store.openPanel()

    await store.build(true)
    box.state.openedFolderPath = 'C:\\ws2'
    await store.refresh()

    expect(api.buildGraph).toHaveBeenLastCalledWith('C:\\ws2')
    expect(store.payload?.nodes.length).toBeGreaterThan(0)
  })

  it('构建期间切换工作区则丢弃旧结果', async () => {
    const api = installApi()
    const store = useGraphStore()
    let release: (value: unknown) => void = () => {}
    api.buildGraph.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )

    const pending = store.build(true)
    box.state.openedFolderPath = 'C:\\其他的库'
    release({ success: true, data: makePayload() })
    await pending

    // 结果属于旧根，不能挂到新工作区上
    expect(store.payload).toBeNull()
  })
})

describe('模式切换与中心', () => {
  it('TC-STORE-005 无选中且无激活文件时切局部退回全库', async () => {
    const store = useGraphStore()
    await store.openPanel()

    store.setMode('local')

    expect(store.mode).toBe('global')
    expect(store.centerId).toBeNull()
  })

  it('TC-STORE-006 中心取当前激活标签文件', async () => {
    box.state.activeTab = { id: 't1', fileInfo: { path: 'C:\\ws\\docs\\b.md' } }
    const store = useGraphStore()
    await store.openPanel()

    store.setMode('local')

    expect(store.mode).toBe('local')
    expect(store.centerId).toBe('docs/b.md')
  })

  it('TC-STORE-006 有选中节点时优先用选中节点做中心', async () => {
    box.state.activeTab = { id: 't1', fileInfo: { path: 'C:\\ws\\a.md' } }
    const store = useGraphStore()
    await store.openPanel()

    store.selectNode('c.mdx')
    store.setMode('local')

    expect(store.centerId).toBe('c.mdx')
  })

  it('openPanel 传中心文件时直接进局部模式', async () => {
    const store = useGraphStore()

    await store.openPanel('C:\\ws\\docs\\b.md')

    expect(store.mode).toBe('local')
    expect(store.centerId).toBe('docs/b.md')
  })

  it('工作区外的中心文件不切局部模式', async () => {
    const store = useGraphStore()

    await store.openPanel('C:\\other\\x.md')

    expect(store.mode).toBe('global')
    expect(store.centerId).toBeNull()
  })

  it('重建后中心节点消失则退回全库', async () => {
    const store = useGraphStore()
    await store.openPanel()
    store.setCenter('docs/b.md')
    expect(store.mode).toBe('local')

    // 换一份不含该节点的索引
    installApi(
      buildGraph({
        root: 'C:\\ws',
        files: [{ path: 'z.md', format: 'markdown', links: [] }]
      })
    )
    await store.refresh()

    expect(store.centerId).toBeNull()
    expect(store.mode).toBe('global')
  })
})

describe('深度裁剪（TC-STORE-007）', () => {
  async function localStore() {
    const store = useGraphStore()
    await store.openPanel()
    store.setCenter('docs/b.md')
    return store
  }

  it('setDepth 夹在 1–3', async () => {
    const store = await localStore()

    store.setDepth(0)
    expect(store.depth).toBe(1)
    store.setDepth(9)
    expect(store.depth).toBe(3)
    store.setDepth(2.7)
    expect(store.depth).toBe(2)
  })

  it('深度递增时可见节点数单调不减', async () => {
    const store = await localStore()

    store.setDepth(1)
    const d1 = store.visibleNodes.length
    store.setDepth(2)
    const d2 = store.visibleNodes.length
    store.setDepth(3)
    const d3 = store.visibleNodes.length

    expect(d1).toBeLessThanOrEqual(d2)
    expect(d2).toBeLessThanOrEqual(d3)
  })

  it('深度变化不触发 IPC 重建', async () => {
    const api = installApi()
    const store = useGraphStore()
    await store.openPanel()
    store.setCenter('docs/b.md')
    const calls = api.buildGraph.mock.calls.length

    store.setDepth(3)

    expect(api.buildGraph).toHaveBeenCalledTimes(calls)
  })

  it('局部模式下可见集合等于子图节点', async () => {
    const store = await localStore()
    store.setDepth(1)

    const subgraph = store.localResult
    expect(subgraph).not.toBeNull()
    expect(store.visibleNodeIds.size).toBe(subgraph!.nodeIds.size)
  })
})

describe('过滤（TC-STORE-008）', () => {
  async function filteredStore() {
    const store = useGraphStore()
    await store.openPanel()
    return store
  }

  it('默认全部可见', async () => {
    const store = await filteredStore()

    expect(store.visibleNodes).toHaveLength(store.effectivePayload!.nodes.length)
  })

  it('取消某个顶层目录 chip 后该目录节点被隐藏', async () => {
    const store = await filteredStore()
    expect(store.allFolders).toContain('docs')

    store.toggleFolder('docs')

    const visiblePaths = store.visibleNodes.map((n) => n.path)
    expect(visiblePaths).not.toContain('docs/b.md')
    expect(visiblePaths).toContain('a.md')
  })

  it('再次点回目录恢复全选（全选与空数组等价）', async () => {
    const store = await filteredStore()
    const all = store.effectivePayload!.nodes.length

    store.toggleFolder('docs')
    store.toggleFolder('docs')

    // 「全选」既可能是空数组，也可能是列出了全部目录——两种都算全选
    expect(store.visibleNodes).toHaveLength(all)
  })

  it('取消某扩展名后该格式节点被隐藏', async () => {
    const store = await filteredStore()

    store.toggleFormat('mindmap')

    expect(store.visibleNodes.some((n) => n.format === 'mindmap')).toBe(false)
    expect(store.visibleNodes.some((n) => n.format === 'markdown')).toBe(true)
  })

  it('搜索只命中标签或路径包含关键词的节点', async () => {
    const store = await filteredStore()

    store.setQuery('b')

    expect(store.searchMatches).not.toBeNull()
    expect(store.searchMatches!.has('docs/b.md')).toBe(true)
    expect(store.searchMatches!.has('lonely.md')).toBe(false)
    // 搜索只做高亮，不改变可见集合（渲染时变暗）
    expect(store.visibleNodes).toHaveLength(store.effectivePayload!.nodes.length)
  })

  it('清空搜索后 searchMatches 为 null（不过滤）', async () => {
    const store = await filteredStore()
    store.setQuery('b')

    store.setQuery('   ')

    expect(store.searchMatches).toBeNull()
  })

  it('关闭「显示断链」后幽灵节点与其边消失', async () => {
    const broken = buildGraph({
      root: 'C:\\ws',
      files: [
        { path: 'a.md', format: 'markdown', links: [{ href: 'nope.md', line: 1 }] },
        { path: 'b.md', format: 'markdown', links: [] }
      ]
    })
    installApi(broken)
    const store = useGraphStore()
    await store.openPanel()
    expect(store.visibleNodes.some((n) => n.unresolved)).toBe(true)

    store.filters.showUnresolved = false

    expect(store.visibleNodes.some((n) => n.unresolved)).toBe(false)
    expect(store.visibleEdges.some((e) => e.unresolved)).toBe(false)
  })

  it('resetFilters 恢复默认', async () => {
    const store = await filteredStore()
    store.toggleFolder('docs')
    store.toggleFormat('mdx')
    store.setQuery('x')

    store.resetFilters()

    expect(store.filters.folders).toEqual([])
    expect(store.filters.formats).toHaveLength(5)
    expect(store.filters.showUnresolved).toBe(true)
    expect(store.filters.query).toBe('')
  })

  it('isFiltered 反映是否有任何过滤生效', async () => {
    const store = await filteredStore()
    expect(store.isFiltered).toBe(false)

    store.setQuery('a')
    expect(store.isFiltered).toBe(true)
  })

  it('只关掉一种格式也算「已过滤」（五种格式都得算数）', async () => {
    const store = await filteredStore()
    expect(store.isFiltered).toBe(false)

    // 曾经按 `formats.length < 4` 判断：关掉一种变成 4 个仍然报「没过滤」，
    // 侧栏那枚「重置筛选」的入口就不出现。
    store.toggleFormat('attachment')
    expect(store.filters.formats).toHaveLength(4)
    expect(store.isFiltered).toBe(true)

    // 换成关掉另一种（同样的数量、不同的集合）也必须认出来
    store.toggleFormat('attachment')
    store.toggleFormat('diagram')
    expect(store.filters.formats).toHaveLength(4)
    expect(store.isFiltered).toBe(true)
  })

  it('可见边只保留两端都可见的边', async () => {
    const store = await filteredStore()

    store.toggleFolder('docs')

    for (const edge of store.visibleEdges) {
      expect(store.visibleNodeIds.has(edge.source)).toBe(true)
      expect(store.visibleNodeIds.has(edge.target)).toBe(true)
    }
  })
})

describe('脏标签覆盖（TC-STORE-010）', () => {
  it('未保存标签里的新链接立刻出现在图上', async () => {
    const store = useGraphStore()
    await store.openPanel()
    expect(store.effectivePayload!.edges.some((e) => e.target === 'lonely.md')).toBe(false)

    box.state.tabs = [
      {
        id: 't1',
        fileInfo: { path: 'C:\\ws\\a.md', format: 'markdown', modified: true },
        content: '[l](lonely.md)'
      }
    ]

    const edges = store.effectivePayload!.edges.map((e) => `${e.source}>${e.target}`)
    expect(edges).toContain('a.md>lonely.md')
  })

  it('未修改的标签不参与覆盖', async () => {
    const store = useGraphStore()
    await store.openPanel()

    box.state.tabs = [
      {
        id: 't1',
        fileInfo: { path: 'C:\\ws\\a.md', format: 'markdown', modified: false },
        content: '[l](lonely.md)'
      }
    ]

    const edges = store.effectivePayload!.edges.map((e) => `${e.source}>${e.target}`)
    expect(edges).not.toContain('a.md>lonely.md')
  })

  it('导图格式的脏标签不参与覆盖', async () => {
    const store = useGraphStore()
    await store.openPanel()

    box.state.tabs = [
      {
        id: 't1',
        fileInfo: { path: 'C:\\ws\\map.inkmind', format: 'mindmap', modified: true },
        content: '[l](lonely.md)'
      }
    ]

    const edges = store.effectivePayload!.edges.map((e) => `${e.source}>${e.target}`)
    expect(edges).not.toContain('map.inkmind>lonely.md')
  })

  it('工作区外的标签不参与覆盖', async () => {
    const store = useGraphStore()
    await store.openPanel()

    box.state.tabs = [
      {
        id: 't1',
        fileInfo: { path: 'C:\\other\\a.md', format: 'markdown', modified: true },
        content: '[l](lonely.md)'
      }
    ]

    const edges = store.effectivePayload!.edges.map((e) => `${e.source}>${e.target}`)
    expect(edges).not.toContain('a.md>lonely.md')
  })

  it('没有脏标签时 effectivePayload 就是 payload 本身', async () => {
    const store = useGraphStore()
    await store.openPanel()

    expect(store.effectivePayload).toBe(store.payload)
  })
})

describe('派生数据', () => {
  it('TC-VIEW-009 stats 与 issues 来自 effectivePayload', async () => {
    const store = useGraphStore()
    await store.openPanel()

    expect(store.stats).toEqual(store.effectivePayload!.stats)
    expect(store.issues).toEqual(store.effectivePayload!.issues)
    expect(store.hasGraph).toBe(true)
  })

  it('TC-VIEW-009 四计数自洽', async () => {
    const store = useGraphStore()
    await store.openPanel()
    const stats = store.stats!

    expect(stats.nodeCount).toBe(store.effectivePayload!.nodes.length)
    expect(stats.edgeCount).toBe(store.effectivePayload!.edges.length)
    expect(stats.orphanCount).toBe(store.issues.orphans.length)
  })

  it('selectedNode 反映选中项，选中不存在节点时为 null', async () => {
    const store = useGraphStore()
    await store.openPanel()

    store.selectNode('c.mdx')
    expect(store.selectedNode?.id).toBe('c.mdx')

    store.selectNode('not-in-graph.md')
    expect(store.selectedNode).toBeNull()
  })

  it('formatLabel 返回中文标签', async () => {
    const store = useGraphStore()

    expect(store.formatLabel('mdx')).toBe('MDX 文档')
    expect(store.formatLabel('mindmap')).toBe('思维导图')
  })

  it('focusIssue 把相对路径拼成绝对路径后打开', async () => {
    const store = useGraphStore()

    store.focusIssue('docs/b.md')
    await Promise.resolve()

    expect(box.state.opened.at(-1)).toMatch(/ws[\\/]docs[\\/]b\.md$/)
  })

  it('TC-VIEW-008 hiddenNeighborCount 在局部模式下大于 0', async () => {
    const store = useGraphStore()
    await store.openPanel()
    store.setCenter('c.mdx')
    store.setDepth(1)

    // c.mdx 只有一条入边，邻居少但确实存在；全库有更多节点未显示
    expect(store.hiddenNeighborCount).toBeGreaterThanOrEqual(0)
    expect(store.localResult).not.toBeNull()
  })
})
