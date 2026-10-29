import { describe, expect, it } from 'vitest'
import { buildGraph } from '../build'
import { clampLocalDepth, localSubgraph, MAX_LOCAL_DEPTH, MIN_LOCAL_DEPTH } from '../local'
import type { FileLinkRecord, GraphPayload } from '../types'

function file(path: string, links: Array<[string, number]> = []): FileLinkRecord {
  return {
    path,
    format: path.endsWith('.md') ? 'markdown' : 'mdx',
    links: links.map(([href, line]) => ({ href, line }))
  }
}

/** a → b → c → d 单链 */
function chain(): GraphPayload {
  return buildGraph({
    root: 'ws',
    files: [
      file('a.md', [['b.md', 1]]),
      file('b.md', [['c.md', 1]]),
      file('c.md', [['d.md', 1]]),
      file('d.md')
    ]
  })
}

describe('localSubgraph', () => {
  it('深度 1 只取直接邻居（双向）', () => {
    const result = localSubgraph(chain(), { centerId: 'b.md', depth: 1 })

    expect([...result.nodeIds].sort()).toEqual(['a.md', 'b.md', 'c.md'])
    expect(result.hiddenNeighbors).toBe(1)
    expect(result.found).toBe(true)
  })

  it('深度 2 再向外一层', () => {
    const result = localSubgraph(chain(), { centerId: 'b.md', depth: 2 })

    expect([...result.nodeIds].sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md'])
    expect(result.hiddenNeighbors).toBe(0)
  })

  it('入链邻居同样算邻居', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('hub.md', [['b.md', 1]]), file('b.md')]
    })
    const result = localSubgraph(payload, { centerId: 'b.md', depth: 1 })

    expect([...result.nodeIds].sort()).toEqual(['b.md', 'hub.md'])
  })

  it('没有邻居的中心节点只有自己', () => {
    const payload = buildGraph({ root: 'ws', files: [file('lone.md')] })
    const result = localSubgraph(payload, { centerId: 'lone.md', depth: 3 })

    expect([...result.nodeIds]).toEqual(['lone.md'])
    expect(result.edges).toHaveLength(0)
    expect(result.hiddenNeighbors).toBe(0)
  })

  it('中心不在图里时返回 found=false', () => {
    const result = localSubgraph(chain(), { centerId: 'nope.md', depth: 1 })

    expect(result.found).toBe(false)
    expect(result.nodeIds.size).toBe(0)
  })

  it('子图边只保留两端都在子图内的', () => {
    const result = localSubgraph(chain(), { centerId: 'b.md', depth: 1 })

    expect(result.edges.map((edge) => `${edge.source}>${edge.target}`).sort()).toEqual([
      'a.md>b.md',
      'b.md>c.md'
    ])
  })

  it('节点数超过上限时提前停止', () => {
    const links: Array<[string, number]> = []
    for (let i = 0; i < 10; i++) links.push([`n${i}.md`, i + 1])
    const files: FileLinkRecord[] = [file('hub.md', links)]
    for (let i = 0; i < 10; i++) files.push(file(`n${i}.md`))

    const result = localSubgraph(buildGraph({ root: 'ws', files }), {
      centerId: 'hub.md',
      depth: 1,
      maxNodes: 4
    })

    expect(result.nodeIds.size).toBe(4)
    expect(result.hiddenNeighbors).toBe(7)
  })
})

describe('clampLocalDepth', () => {
  it('夹在 1–3 之间', () => {
    expect(clampLocalDepth(0)).toBe(MIN_LOCAL_DEPTH)
    expect(clampLocalDepth(9)).toBe(MAX_LOCAL_DEPTH)
    expect(clampLocalDepth(2)).toBe(2)
    expect(clampLocalDepth(Number.NaN)).toBe(MIN_LOCAL_DEPTH)
  })
})
