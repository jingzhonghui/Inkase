import { describe, expect, it } from 'vitest'
import { layoutNetwork } from '../graph-layout'

/** 造 n 个互不相连的节点 */
function isolatedNodes(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `n${index}` }))
}

/** 造一条链 */
function chainEdges(count: number): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = []
  for (let index = 0; index < count - 1; index++) {
    edges.push({ from: `n${index}`, to: `n${index + 1}` })
  }
  return edges
}

const SIZE = { width: 800, height: 600 }

describe('layoutNetwork', () => {
  it('returns an empty map when there is nothing to place', () => {
    expect(layoutNetwork([], [], SIZE).size).toBe(0)
  })

  it('places a single node in the middle', () => {
    const positions = layoutNetwork([{ id: 'solo' }], [], SIZE)

    expect(positions.size).toBe(1)
    expect(positions.get('solo')).toEqual({ x: SIZE.width / 2, y: SIZE.height / 2 })
  })

  it('gives every node a point', () => {
    const positions = layoutNetwork(isolatedNodes(20), chainEdges(20), SIZE)

    expect(positions.size).toBe(20)
    for (let index = 0; index < 20; index++) {
      expect(positions.has(`n${index}`)).toBe(true)
    }
  })

  it('keeps every point inside the canvas', () => {
    const positions = layoutNetwork(isolatedNodes(120), chainEdges(120), SIZE)

    for (const point of positions.values()) {
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(SIZE.width)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(SIZE.height)
    }
  })

  it('never stacks two nodes on the same point', () => {
    const positions = layoutNetwork(isolatedNodes(40), [], SIZE)
    const unique = new Set([...positions.values()].map((point) => `${point.x},${point.y}`))

    expect(unique.size).toBe(40)
  })

  it('is deterministic for the same seed', () => {
    const nodes = isolatedNodes(30)
    const edges = chainEdges(30)

    const first = JSON.stringify([...layoutNetwork(nodes, edges, { ...SIZE, seed: 7 })])
    const second = JSON.stringify([...layoutNetwork(nodes, edges, { ...SIZE, seed: 7 })])

    expect(first).toBe(second)
  })

  it('moves things around for a different seed', () => {
    const nodes = isolatedNodes(30)
    const edges = chainEdges(30)

    const first = JSON.stringify([...layoutNetwork(nodes, edges, { ...SIZE, seed: 1 })])
    const second = JSON.stringify([...layoutNetwork(nodes, edges, { ...SIZE, seed: 2 })])

    expect(first).not.toBe(second)
  })

  it('ignores edges whose endpoints are unknown', () => {
    const positions = layoutNetwork([{ id: 'a' }, { id: 'b' }], [
      { from: 'a', to: 'ghost' },
      { from: 'ghost', to: 'b' }
    ], SIZE)

    expect(positions.size).toBe(2)
    expect(positions.has('ghost')).toBe(false)
  })

  it('tolerates duplicate edges and duplicate nodes', () => {
    const positions = layoutNetwork(
      [{ id: 'a' }, { id: 'b' }, { id: 'a' }],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'b' },
        { from: 'a', to: 'b' }
      ],
      SIZE
    )

    expect(positions.size).toBe(2)
  })

  it('honours an explicit iteration count', () => {
    const positions = layoutNetwork(isolatedNodes(10), chainEdges(10), { ...SIZE, iterations: 0 })

    expect(positions.size).toBe(10)
    for (const point of positions.values()) {
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
    }
  })

  it('does not mutate its inputs', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }]
    const edges = [{ from: 'a', to: 'b' }]
    const snapshot = JSON.stringify({ nodes, edges })

    layoutNetwork(nodes, edges, SIZE)

    expect(JSON.stringify({ nodes, edges })).toBe(snapshot)
  })

  it('pulls linked neighbours closer than unrelated pairs', () => {
    // 两组各 6 个节点的链：组内相连，组间不相连
    const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `n${index}` }))
    const edges: Array<{ from: string; to: string }> = []
    for (let index = 0; index < 5; index++) {
      edges.push({ from: `n${index}`, to: `n${index + 1}` })
      edges.push({ from: `n${index + 6}`, to: `n${index + 7}` })
    }

    const positions = layoutNetwork(nodes, edges, { ...SIZE, seed: 3 })
    const distance = (a: string, b: string): number => {
      const left = positions.get(a)!
      const right = positions.get(b)!
      return Math.hypot(left.x - right.x, left.y - right.y)
    }

    let linkedSum = 0
    for (const edge of edges) linkedSum += distance(edge.from, edge.to)
    const linkedAverage = linkedSum / edges.length

    let unrelatedSum = 0
    let unrelatedCount = 0
    for (let i = 0; i < 6; i++) {
      for (let j = 6; j < 12; j++) {
        unrelatedSum += distance(`n${i}`, `n${j}`)
        unrelatedCount++
      }
    }

    expect(linkedAverage).toBeLessThan(unrelatedSum / unrelatedCount)
  })

  it('handles a degenerate canvas size without producing NaN', () => {
    const positions = layoutNetwork(isolatedNodes(5), chainEdges(5), { width: 0, height: 0 })

    for (const point of positions.values()) {
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
    }
  })
})
