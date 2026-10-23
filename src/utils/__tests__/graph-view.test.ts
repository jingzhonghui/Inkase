import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from '../../../shared/knowledge/graph'
import {
  FIT_PADDING,
  MAX_NODE_RADIUS,
  MAX_SCALE,
  MIN_NODE_RADIUS,
  MIN_SCALE,
  buildAdjacency,
  clampScale,
  colorForKey,
  colorGroupOf,
  fitTransform,
  hitTest,
  isOpenableKind,
  layoutIterations,
  neighborsOf,
  radiusForDegree,
  screenToWorld,
  worldBounds,
  zoomAt,
  type PositionedNode
} from '../graph-view'

function node(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    kind: 'md',
    label: partial.id,
    folder: '',
    degree: 0,
    isolated: false,
    ...partial
  }
}

function positioned(partial: Partial<PositionedNode> & { id: string; x: number; y: number }): PositionedNode {
  return { ...node({ id: partial.id }), radius: 5, ...partial }
}

function edge(from: string, to: string): GraphEdge {
  return { from, to, layer: 'link' }
}

describe('radiusForDegree', () => {
  it('grows with degree but stays inside the configured band', () => {
    expect(radiusForDegree(0, 10)).toBe(MIN_NODE_RADIUS)
    expect(radiusForDegree(1, 10)).toBeGreaterThan(MIN_NODE_RADIUS)
    expect(radiusForDegree(5, 10)).toBeGreaterThan(radiusForDegree(1, 10))
    expect(radiusForDegree(10, 10)).toBeCloseTo(MAX_NODE_RADIUS, 5)
    expect(radiusForDegree(999, 10)).toBeLessThanOrEqual(MAX_NODE_RADIUS)
  })

  it('falls back to the minimum when there is no degree to compare against', () => {
    expect(radiusForDegree(3, 0)).toBe(MIN_NODE_RADIUS)
  })
})

describe('layoutIterations', () => {
  it('trades iterations for first paint as the graph grows', () => {
    expect(layoutIterations(10)).toBe(220)
    expect(layoutIterations(400)).toBe(220)
    expect(layoutIterations(401)).toBe(140)
    expect(layoutIterations(1200)).toBe(140)
    expect(layoutIterations(2000)).toBe(90)
  })
})

describe('buildAdjacency / neighborsOf', () => {
  it('links both directions and de-duplicates parallel edges', () => {
    const adjacency = buildAdjacency([edge('a', 'b'), edge('a', 'b'), edge('b', 'c')])
    expect([...adjacency.get('a')!]).toEqual(['b'])
    expect([...adjacency.get('b')!].sort()).toEqual(['a', 'c'])
    expect(adjacency.get('c')).toEqual(new Set(['b']))
  })

  it('always includes the hovered node itself', () => {
    const adjacency = buildAdjacency([edge('a', 'b')])
    expect(neighborsOf(adjacency, 'a')).toEqual(new Set(['a', 'b']))
    expect(neighborsOf(adjacency, 'lonely')).toEqual(new Set(['lonely']))
  })
})

describe('hitTest', () => {
  it('picks the nearest node inside its radius', () => {
    const nodes = [
      positioned({ id: 'a', x: 0, y: 0, radius: 6 }),
      positioned({ id: 'b', x: 30, y: 0, radius: 6 })
    ]
    expect(hitTest(nodes, 1, 1)?.id).toBe('a')
    expect(hitTest(nodes, 29, 0)?.id).toBe('b')
  })

  it('returns null outside every reach and honours the tolerance', () => {
    const nodes = [positioned({ id: 'a', x: 0, y: 0, radius: 4 })]
    expect(hitTest(nodes, 0, 20)).toBeNull()
    // 半径边界内（4 ≤ 4）算命中，越界即松手
    expect(hitTest(nodes, 0, 4, 0)).not.toBeNull()
    expect(hitTest(nodes, 0, 4.5, 0)).toBeNull()
    expect(hitTest(nodes, 0, 9, 0)).toBeNull()
    expect(hitTest(nodes, 0, 9, 6)).not.toBeNull()
  })

  it('prefers the closer of two overlapping nodes', () => {
    const nodes = [
      positioned({ id: 'big', x: 0, y: 0, radius: 12 }),
      positioned({ id: 'small', x: 4, y: 0, radius: 4 })
    ]
    expect(hitTest(nodes, 4, 0)?.id).toBe('small')
  })
})

describe('worldBounds', () => {
  it('returns a degenerate box for an empty set', () => {
    expect(worldBounds([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
  })

  it('covers every point', () => {
    expect(worldBounds([{ x: -3, y: 5 }, { x: 7, y: -2 }])).toEqual({
      minX: -3,
      minY: -2,
      maxX: 7,
      maxY: 5
    })
  })
})

describe('clampScale', () => {
  it('keeps zoom inside the usable band', () => {
    expect(clampScale(0)).toBe(1)
    expect(clampScale(Number.NaN)).toBe(1)
    expect(clampScale(0.0001)).toBe(MIN_SCALE)
    expect(clampScale(1000)).toBe(MAX_SCALE)
    expect(clampScale(2)).toBe(2)
  })
})

describe('fitTransform', () => {
  const viewport = { width: 800, height: 600 }

  it('centres the graph and keeps every point on screen', () => {
    const points = [
      { x: -200, y: -100 },
      { x: 200, y: 100 }
    ]
    const transform = fitTransform(points, viewport)
    for (const point of points) {
      const x = point.x * transform.scale + transform.x
      const y = point.y * transform.scale + transform.y
      expect(x).toBeGreaterThanOrEqual(FIT_PADDING - 1)
      expect(x).toBeLessThanOrEqual(viewport.width - FIT_PADDING + 1)
      expect(y).toBeGreaterThanOrEqual(FIT_PADDING - 1)
      expect(y).toBeLessThanOrEqual(viewport.height - FIT_PADDING + 1)
    }
    // 图心落在视口中心
    expect(transform.x).toBeCloseTo(viewport.width / 2, 5)
    expect(transform.y).toBeCloseTo(viewport.height / 2, 5)
  })

  it('survives a single point and an empty graph', () => {
    const single = fitTransform([{ x: 40, y: 40 }], viewport)
    expect(Number.isFinite(single.scale)).toBe(true)
    expect(single.x).toBeCloseTo(viewport.width / 2 - 40 * single.scale, 5)

    expect(fitTransform([], viewport)).toEqual({ scale: 1, x: 400, y: 300 })
  })
})

describe('screenToWorld / zoomAt', () => {
  it('inverts the transform', () => {
    const transform = { scale: 2, x: 10, y: -20 }
    expect(screenToWorld(transform, 10, -20)).toEqual({ x: 0, y: 0 })
    expect(screenToWorld(transform, 30, 20)).toEqual({ x: 10, y: 20 })
  })

  it('keeps the anchor point fixed while zooming', () => {
    const transform = { scale: 1, x: 0, y: 0 }
    const zoomed = zoomAt(transform, 2, 100, 50)
    expect(zoomed.scale).toBe(2)
    const world = screenToWorld(zoomed, 100, 50)
    expect(world.x).toBeCloseTo(100, 6)
    expect(world.y).toBeCloseTo(50, 6)
  })

  it('clamps runaway zoom and survives a zero scale', () => {
    expect(zoomAt({ scale: MAX_SCALE, x: 0, y: 0 }, 4, 0, 0).scale).toBe(MAX_SCALE)
    expect(zoomAt({ scale: MIN_SCALE, x: 0, y: 0 }, 0.1, 0, 0).scale).toBe(MIN_SCALE)
    expect(zoomAt({ scale: 0, x: 0, y: 0 }, 2, 10, 10).scale).toBe(2)
  })
})

describe('colorForKey / colorGroupOf', () => {
  it('is deterministic and returns a usable hsl colour', () => {
    expect(colorForKey('folder-a')).toBe(colorForKey('folder-a'))
    expect(colorForKey('folder-a')).toMatch(/^hsl\(\d+ 62% 52%\)$/)
    expect(colorForKey('folder-a')).not.toBe(colorForKey('folder-b'))
  })

  it('groups only ordinary notes by folder', () => {
    expect(colorGroupOf(node({ id: 'a.md', folder: 'notes' }))).toBe('notes')
    expect(colorGroupOf(node({ id: 'b.md', folder: '' }))).toBe('根目录')
    expect(colorGroupOf(node({ id: '#tag', kind: 'tag' }))).toBeNull()
    expect(colorGroupOf(node({ id: 'cluster:x', kind: 'cluster' }))).toBeNull()
    expect(colorGroupOf(node({ id: 'c.md', isolated: true }))).toBeNull()
  })
})

describe('isOpenableKind', () => {
  it('opens files and refuses pure structure nodes', () => {
    expect(isOpenableKind('md')).toBe(true)
    expect(isOpenableKind('mdx')).toBe(true)
    expect(isOpenableKind('pdf')).toBe(true)
    expect(isOpenableKind('tag')).toBe(false)
    expect(isOpenableKind('cluster')).toBe(false)
    expect(isOpenableKind('folder')).toBe(false)
  })
})
