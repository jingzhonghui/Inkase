import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, GraphNodeFormat } from '../../../../shared/graph/types'
import { SHAPE_GROUPS, nodeShape } from '../shape'
import { renderGraph, type RenderGraphOptions } from '../render'
import type { SimNode } from '../simulation'

/**
 * 画布渲染契约。
 *
 * 这里不断言像素（jsdom 没有真实 2D 上下文），而是记录绘制指令序列，
 * 验证「设计里的视觉编码真的落到了画布上」：
 * 点阵底画了、格式换了形状、标签按重要性和避让规则出现、
 * 焦点边多了方向箭头。这类回归肉眼很难在 code review 里看出来。
 */

interface DrawOp {
  op: string
  args: unknown[]
}

function recordingContext(): CanvasRenderingContext2D & { ops: DrawOp[] } {
  const ops: DrawOp[] = []
  const record =
    (op: string) =>
    (...args: unknown[]): void => {
      ops.push({ op, args })
    }

  const ctx: Record<string, unknown> = {
    ops,
    save: record('save'),
    restore: record('restore'),
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    arcTo: record('arcTo'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    setLineDash: record('setLineDash'),
    // 纸面暗角用的径向渐变；只关心「有没有铺一层」，不关心色标
    createRadialGradient: () => ({ addColorStop: () => {} }),
    // 字符数 × 6 足够稳定，用于制造标签宽度
    measureText: (text: string) => ({ width: text.length * 6 }),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic'
  }

  return ctx as unknown as CanvasRenderingContext2D & { ops: DrawOp[] }
}

function count(ops: DrawOp[], op: string): number {
  return ops.filter((item) => item.op === op).length
}

function node(
  overrides: Partial<GraphNode> & { id: string; format?: GraphNodeFormat }
): GraphNode {
  return {
    path: `${overrides.id}.md`,
    label: overrides.id,
    format: 'markdown',
    folder: '',
    inDegree: 0,
    outDegree: 0,
    unresolved: false,
    ...overrides
  } as GraphNode
}

function simNode(id: string, x: number, y: number, radius = 3): SimNode {
  return { id, x, y, vx: 0, vy: 0, fx: null, fy: null, radius }
}

function render(
  nodes: GraphNode[],
  positions: Map<string, SimNode>,
  overrides: Partial<RenderGraphOptions> = {}
): DrawOp[] {
  const ctx = recordingContext()
  renderGraph({
    ctx,
    width: 800,
    height: 600,
    transform: { x: 0, y: 0, k: 1 },
    nodes,
    edges: [],
    positions,
    theme: 'light',
    highlightIds: null,
    selectedId: null,
    searchMatches: null,
    showLabels: false,
    focusId: null,
    ...overrides
  })
  return ctx.ops
}

describe('格式 → 形状', () => {
  it('正文文档是圆点，导图是菱形，图表是方形，其他文件是三角', () => {
    expect(nodeShape('mdx')).toBe('circle')
    expect(nodeShape('markdown')).toBe('circle')
    expect(nodeShape('mindmap')).toBe('diamond')
    expect(nodeShape('diagram')).toBe('square')
    expect(nodeShape('attachment')).toBe('triangle')
  })

  it('侧栏分组恰好覆盖五种格式、互不重叠', () => {
    const covered = SHAPE_GROUPS.flatMap((group) => group.formats)
    expect(covered.slice().sort()).toEqual([
      'attachment',
      'diagram',
      'markdown',
      'mdx',
      'mindmap'
    ])
    expect(new Set(covered).size).toBe(covered.length)
  })

  it('附件与文档必须是两种形状（否则看不出目标打不开）', () => {
    expect(nodeShape('attachment')).not.toBe(nodeShape('markdown'))
  })

  it('侧栏样本形状与画布上的形状同源', () => {
    for (const group of SHAPE_GROUPS) {
      for (const format of group.formats) {
        expect(nodeShape(format)).toBe(group.shape)
      }
    }
  })

  it('侧栏把每种后缀都写出来（不再有“后缀没显示完”）', () => {
    const all = SHAPE_GROUPS.map((group) => group.extensions).join(' ')
    for (const extension of ['.mdx', '.md', '.inkmind', '.drawio']) {
      expect(all).toContain(extension)
    }
  })
})

describe('渲染 · 点阵背景', () => {
  const empty = new Map<string, SimNode>()

  it('画点阵（不止一次铺底）', () => {
    const ops = render([], empty)
    // 第一次 fillRect 是整屏铺底，之后每次都是点阵上的一个点
    expect(count(ops, 'fillRect')).toBeGreaterThan(1)
  })

  it('缩得很小时点间距自适应，最密也不低于阈值（否则会连成灰雾）', () => {
    for (const k of [1, 0.5, 0.12, 0.05]) {
      const ops = render([], empty, { transform: { x: 0, y: 0, k } })
      // 排除整屏铺底那一笔，只留 1×1 的格点
      const xs = [
        ...new Set(
          ops
            .filter((item) => item.op === 'fillRect' && item.args[2] === 1)
            .map((item) => Number(item.args[0]))
        )
      ].sort((a, b) => a - b)

      expect(xs.length).toBeGreaterThan(1)
      const minGap = xs
        .slice(1)
        .reduce((min, x, index) => Math.min(min, x - xs[index]!), Number.POSITIVE_INFINITY)
      expect(minGap).toBeGreaterThanOrEqual(15)
    }
  })
})

describe('渲染 · 形状编码', () => {
  it('圆点节点走弧线', () => {
    const nodes = [node({ id: 'a', format: 'markdown' })]
    const ops = render(nodes, new Map([['a', simNode('a', 100, 100)]]))

    expect(count(ops, 'arc')).toBeGreaterThan(0)
    expect(count(ops, 'lineTo')).toBe(0)
  })

  it('菱形节点不画弧线，改走折线', () => {
    const nodes = [node({ id: 'm', format: 'mindmap' })]
    const ops = render(nodes, new Map([['m', simNode('m', 100, 100)]]))

    expect(count(ops, 'arc')).toBe(0)
    expect(count(ops, 'lineTo')).toBeGreaterThan(0)
  })

  it('方形节点走圆角矩形', () => {
    const nodes = [node({ id: 'd', format: 'diagram' })]
    const ops = render(nodes, new Map([['d', simNode('d', 100, 100)]]))

    expect(count(ops, 'arc')).toBe(0)
    expect(count(ops, 'arcTo')).toBeGreaterThan(0)
  })

  it('附件节点走三条折线的三角，且与文档的圆弧区分开', () => {
    const nodes = [node({ id: 'f', format: 'attachment' })]
    const ops = render(nodes, new Map([['f', simNode('f', 100, 100)]]))

    expect(count(ops, 'arc')).toBe(0)
    expect(count(ops, 'arcTo')).toBe(0)
    // moveTo + 两次 lineTo + closePath
    expect(count(ops, 'lineTo')).toBe(2)
  })

  it('断链节点永远是圆点，不因原格式变成别的形状', () => {
    const nodes = [node({ id: 'g', format: 'mindmap', unresolved: true })]
    const ops = render(nodes, new Map([['g', simNode('g', 100, 100)]]))

    expect(count(ops, 'arc')).toBeGreaterThan(0)
    expect(count(ops, 'lineTo')).toBe(0)
  })
})

describe('渲染 · 标签渐进披露', () => {
  const nodes = [node({ id: 'a' })]

  it('缩小时不给小节点画标签', () => {
    const ops = render(nodes, new Map([['a', simNode('a', 100, 100, 3)]]), {
      showLabels: true,
      transform: { x: 0, y: 0, k: 0.5 }
    })
    expect(count(ops, 'fillText')).toBe(0)
  })

  it('放大后画标签', () => {
    const ops = render(nodes, new Map([['a', simNode('a', 100, 100, 3)]]), {
      showLabels: true,
      transform: { x: 0, y: 0, k: 2 }
    })
    expect(count(ops, 'fillText')).toBe(1)
  })

  it('焦点节点的标签在最小时也画出来', () => {
    const ops = render(nodes, new Map([['a', simNode('a', 100, 100, 3)]]), {
      showLabels: true,
      transform: { x: 0, y: 0, k: 0.4 },
      highlightIds: new Set(['a'])
    })
    expect(count(ops, 'fillText')).toBe(1)
  })
})

describe('渲染 · 标签避让', () => {
  it('位置重合的标签只保留一个', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => node({ id }))
    const positions = new Map(
      nodes.map((item) => [item.id, simNode(item.id, 200, 200, 6)] as const)
    )

    const ops = render(nodes, positions, {
      showLabels: true,
      transform: { x: 0, y: 0, k: 2 }
    })

    expect(count(ops, 'fillText')).toBe(1)
  })
})

describe('渲染 · 焦点边方向', () => {
  const nodes = [node({ id: 'a' }), node({ id: 'b' })]
  const positions = new Map([
    ['a', simNode('a', 0, 0)],
    ['b', simNode('b', 300, 0)]
  ])
  const edges: GraphEdge[] = [{ source: 'a', target: 'b', count: 1, unresolved: false }]

  it('没有焦点时只画一条直线', () => {
    const ops = render(nodes, positions, { edges })
    expect(count(ops, 'lineTo')).toBe(1)
  })

  it('焦点边多画一个方向箭头', () => {
    const ops = render(nodes, positions, { edges, focusId: 'a' })
    // 直线一条 + 箭头两笔
    expect(count(ops, 'lineTo')).toBe(3)
  })

  it('无关的边不加箭头', () => {
    const ops = render(nodes, positions, { edges, focusId: 'unrelated' })
    expect(count(ops, 'lineTo')).toBe(1)
  })
})
