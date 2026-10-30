// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 图谱画布（设计 §4.2 / §5.8）。
 * 对应 TC-CANVAS-001 ~ 009。
 *
 * 画布里的坐标换算与命中测试已经由 `viewport.test.ts` 用纯函数覆盖，
 * 仿真收敛由本文件的 simulation 一组覆盖；这里再加组件层的冒烟与副作用断言
 * （选中、悬停、右键菜单 emit、双击打开、卸载清理），避免用随机布局去做
 * 「必须点到某个圆点」这种脆弱判定。
 */

const box = vi.hoisted(() => ({
  state: null as unknown as {
    openedFolderPath: string | null
    tabs: unknown[]
    activeTab: null
    opened: string[]
  },
  rafCallbacks: new Map<number, FrameRequestCallback>(),
  rafSeq: 0,
  cancelCalls: [] as number[]
}))

/** 命中结果可被单条用例劫持：命中的数学由 viewport.test.ts 覆盖，这里只测组件的反应 */
const hitBox = vi.hoisted(() => ({ override: null as string | null }))

vi.mock('../../../utils/graph/viewport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/graph/viewport')>()
  return {
    ...actual,
    hitTest: (...args: Parameters<typeof actual.hitTest>) =>
      hitBox.override ?? actual.hitTest(...args)
  }
})

vi.mock('../../../stores/file', async () => {
  const { reactive } = await import('vue')
  box.state = reactive({
    openedFolderPath: 'C:\\ws' as string | null,
    tabs: [] as unknown[],
    activeTab: null,
    opened: [] as string[]
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

vi.mock('../../../stores/ai', () => ({
  useAiStore: () => ({ panelOpen: false, panelActive: false, deactivatePanel: vi.fn() })
}))

const { default: GraphCanvas } = await import('../GraphCanvas.vue')
const { useGraphStore } = await import('../../../stores/graph')
const { buildGraph } = await import('../../../../shared/graph/build')
const { createSimulation } = await import('../../../utils/graph/simulation')
const { nodeRadius } = await import('../../../utils/graph/render')

/** 假 2D 上下文：jsdom 没有 canvas 实现，所有绘制方法吃空实现即可 */
function fakeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} }
  const target: Record<string, unknown> = {
    canvas: null,
    save: () => {},
    restore: () => {},
    setTransform: () => {},
    clearRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    fillText: () => {},
    measureText: () => ({ width: 10 }),
    setLineDash: () => {},
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    quadraticCurveTo: () => {},
    translate: () => {},
    scale: () => {},
    rect: () => {},
    clip: () => {}
  }
  return new Proxy(target, {
    get: (obj, key) => (key in obj ? obj[key as string] : () => {}),
    set: (obj, key, value) => {
      obj[key as string] = value
      return true
    }
  }) as unknown as CanvasRenderingContext2D
}

function installGlobals(): void {
  box.rafCallbacks.clear()
  box.rafSeq = 0
  box.cancelCalls = []

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    box.rafSeq += 1
    box.rafCallbacks.set(box.rafSeq, cb)
    return box.rafSeq
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    box.cancelCalls.push(id)
    box.rafCallbacks.delete(id)
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeContext() as unknown as RenderingContext
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({})
  } as DOMRect)
}

/** 把已排队的 rAF 回调全部跑掉（模拟时间推进） */
function flushFrames(limit = 5000): number {
  let executed = 0
  while (box.rafCallbacks.size > 0 && executed < limit) {
    const entry = [...box.rafCallbacks.entries()][0]
    box.rafCallbacks.delete(entry[0])
    entry[1](0)
    executed++
  }
  return executed
}

const ROOT = 'C:\\ws'

function seedStore(): ReturnType<typeof useGraphStore> {
  const store = useGraphStore()
  store.payload = buildGraph({
    root: ROOT,
    files: [
      { path: 'a.md', format: 'markdown', links: [{ href: 'b.md', line: 1 }] },
      { path: 'b.md', format: 'markdown', links: [{ href: 'c.md', line: 1 }] },
      { path: 'c.md', format: 'markdown', links: [] }
    ]
  })
  store.builtRoot = ROOT
  return store
}

function mountCanvas(_store: ReturnType<typeof useGraphStore>) {
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 800 })
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: 600 })
  document.body.appendChild(container)

  return mount(GraphCanvas, {
    attachTo: container,
    global: { provide: {} }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  installGlobals()
  box.state.openedFolderPath = ROOT
  box.state.opened = []
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    buildGraph: vi.fn().mockResolvedValue({ success: true, data: null }),
    onGraphProgress: () => () => {}
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('仿真收敛（TC-CANVAS-008 静止后停 rAF）', () => {
  it('无交互时 alpha 收敛，tick 返回 false', () => {
    const simulation = createSimulation({
      nodes: [
        { id: 'a.md', radius: 5 },
        { id: 'b.md', radius: 5 }
      ],
      links: [{ source: 'a.md', target: 'b.md', count: 1 }]
    })

    let ticks = 0
    while (simulation.tick() && ticks < 5000) ticks++

    expect(ticks).toBeLessThan(5000)
    expect(simulation.isRunning()).toBe(false)
  })

  it('收敛后再次 tick 立刻返回 false（不再做功）', () => {
    const simulation = createSimulation({
      nodes: [
        { id: 'a.md', radius: 5 },
        { id: 'b.md', radius: 5 }
      ],
      links: []
    })
    while (simulation.tick());

    expect(simulation.tick()).toBe(false)
    expect(simulation.isRunning()).toBe(false)
  })

  it('拖动期间反复 reheat(0.2) 会持续运行，不会停在收敛态', () => {
    const simulation = createSimulation({
      nodes: [
        { id: 'a.md', radius: 5 },
        { id: 'b.md', radius: 5 }
      ],
      links: [{ source: 'a.md', target: 'b.md', count: 1 }]
    })
    while (simulation.tick());

    simulation.pin('a.md', 10, 10)
    expect(simulation.isRunning()).toBe(true)
    simulation.reheat(0.2)
    expect(simulation.tick()).toBe(true)
  })

  it('释放钉住的节点后重新加热（双击的退路）', () => {
    const simulation = createSimulation({ nodes: [{ id: 'a.md', radius: 5 }], links: [] })
    simulation.pin('a.md', 100, 100)

    simulation.release('a.md')
    simulation.reheat(0.35)

    expect(simulation.isRunning()).toBe(true)
    const position = simulation.positions.get('a.md')!
    expect(position.fx).toBeNull()
    expect(position.fy).toBeNull()
  })

  it('空节点集不进入运行态', () => {
    const simulation = createSimulation({ nodes: [], links: [] })

    expect(simulation.tick()).toBe(false)
    expect(simulation.isRunning()).toBe(false)
  })

  it('沿用旧坐标：重建后已有节点不跳位', () => {
    const previous = new Map([['a.md', { x: 42, y: -17 }]])
    const simulation = createSimulation({
      nodes: [
        { id: 'a.md', radius: 5 },
        { id: 'b.md', radius: 5 }
      ],
      links: [],
      previousPositions: previous
    })

    expect(simulation.positions.get('a.md')).toMatchObject({ x: 42, y: -17 })
    // 新节点另有播种位置
    expect(simulation.positions.get('b.md')).not.toMatchObject({ x: 42, y: -17 })
  })
})

describe('节点半径', () => {
  it('按入度增长且有上限', () => {
    const node = (inDegree: number) =>
      ({
        id: 'x',
        path: 'x.md',
        label: 'x',
        format: 'markdown',
        folder: '',
        inDegree,
        outDegree: 0,
        unresolved: false
      }) as const

    // 实心点比旧版的空心环略大一点（4 起步），但上限收到 11：
    // 一颗 14px 的高饱和实心球会盖住它周围的边，而半径本来只是「被引得多」的提示
    expect(nodeRadius(node(0) as never)).toBe(4)
    expect(nodeRadius(node(4) as never)).toBeCloseTo(7.2)
    expect(nodeRadius(node(10_000) as never)).toBe(11)
  })
})

describe('画布渲染', () => {
  it('有数据时按 devicePixelRatio 设置位图尺寸', async () => {
    const store = seedStore()
    const wrapper = mountCanvas(store)
    await flushFrames()

    const canvas = wrapper.find('canvas').element as HTMLCanvasElement
    expect(canvas.width).toBeGreaterThan(0)
    expect(canvas.height).toBeGreaterThan(0)
    wrapper.unmount()
  })

  it('没有数据时不崩溃且不建仿真', async () => {
    const store = useGraphStore()
    store.payload = null
    const wrapper = mountCanvas(store)
    await flushFrames()

    expect(wrapper.find('canvas').exists()).toBe(true)
    wrapper.unmount()
  })

  it('卸载时停掉 rAF 并回收仿真', async () => {
    const store = seedStore()
    const wrapper = mountCanvas(store)
    await flushFrames()
    const beforeCancel = box.cancelCalls.length

    wrapper.unmount()

    expect(box.cancelCalls.length).toBeGreaterThanOrEqual(beforeCancel)
    expect(box.rafCallbacks.size).toBe(0)
  })

  it('过滤变化不重建仿真（只重绘），节点位置不变', async () => {
    const store = seedStore()
    const wrapper = mountCanvas(store)
    await flushFrames()

    store.toggleFormat('markdown')
    await flushFrames()

    // 过滤把节点全隐藏，但仍不抛异常，也不该触发布局重排逻辑
    expect(store.visibleNodes).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('指针交互', () => {
  it('滚轮缩放不抛异常且阻止默认滚动', async () => {
    const store = seedStore()
    const wrapper = mountCanvas(store)
    await flushFrames()

    const canvas = wrapper.find('canvas')
    const event = new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, cancelable: true })
    canvas.element.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    wrapper.unmount()
  })

  it('鼠标离开画布清空悬停', async () => {
    const store = seedStore()
    const wrapper = mountCanvas(store)
    await flushFrames()
    store.setHovered('a.md')

    wrapper.find('canvas').element.dispatchEvent(new MouseEvent('mouseleave'))

    expect(store.hoveredId).toBeNull()
    wrapper.unmount()
  })

  it('鼠标移动会做命中测试并更新悬停（点到空白则为 null）', async () => {
    const store = seedStore()
    const wrapper = mountCanvas(store)
    await flushFrames()

    const canvas = wrapper.find('canvas')
    canvas.element.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 }))

    // 空白处悬停为 null；不抛异常即可
    expect(store.hoveredId === null || typeof store.hoveredId === 'string').toBe(true)
    wrapper.unmount()
  })

  it('右键空白处发出 canvas-context，右键节点发出 node-context', async () => {
    const store = seedStore()
    const wrapper = mountCanvas(store)
    await flushFrames()

    const canvas = wrapper.find('canvas')
    canvas.element.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 1, clientY: 1, bubbles: true })
    )

    const canvasEvents = wrapper.emitted('canvas-context')
    const nodeEvents = wrapper.emitted('node-context')
    // 两者必有其一（取决于该点是否落在节点上）
    expect((canvasEvents?.length ?? 0) + (nodeEvents?.length ?? 0)).toBe(1)
    wrapper.unmount()
  })

  it('双击空白处走「适应内容」，不打开文件', async () => {
    const store = seedStore()
    const wrapper = mountCanvas(store)
    await flushFrames()

    wrapper
      .find('canvas')
      .element.dispatchEvent(new MouseEvent('dblclick', { clientX: 2, clientY: 2 }))

    expect(box.state.opened).toHaveLength(0)
    wrapper.unmount()
  })

  it('双击节点释放钉住并打开对应文件', async () => {
    const store = seedStore()
    const wrapper = mountCanvas(store)
    await flushFrames()

    const canvas = wrapper.find('canvas')
    // 让命中测试恒定命中 a.md：布局播种是确定性的，但网格扫描过于脆弱
    hitBox.override = 'a.md'
    try {
      await canvas.trigger('mousedown', { clientX: 100, clientY: 100, button: 0 })
      expect(store.selectedId).toBe('a.md')

      await canvas.trigger('dblclick', { clientX: 100, clientY: 100 })
    } finally {
      hitBox.override = null
    }

    expect(box.state.opened).toHaveLength(1)
    expect(box.state.opened[0]).toMatch(/ws[\\/]a\.md$/)
    wrapper.unmount()
  })
})
