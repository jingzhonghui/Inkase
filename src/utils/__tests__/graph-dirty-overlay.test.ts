import { describe, expect, it } from 'vitest'
import { buildGraph } from '../../../shared/graph/build'
import type { FileLinkRecord, GraphPayload } from '../../../shared/graph/types'
import { applyDirtyOverlay, toWorkspaceRelative } from '../graph/dirty-overlay'

/**
 * 脏标签覆盖（设计 §5.9）。对应 TC-STORE-010。
 *
 * 覆盖目标是「索引读磁盘、但用户刚在编辑器里写完还没保存」的那条缝：
 * 用与主进程完全相同的抽取/解析规则，在内存里换掉该节点的出边，
 * 于是新链接不必保存、也不必整库重建就能出现在图上。
 */

function file(path: string, links: Array<[string, number]> = []): FileLinkRecord {
  return {
    path,
    format: path.endsWith('.inkmind') ? 'mindmap' : path.endsWith('.md') ? 'markdown' : 'mdx',
    links: links.map(([href, line]) => ({ href, line }))
  }
}

function payloadOf(files: FileLinkRecord[], caseInsensitive = false): GraphPayload {
  return buildGraph({ root: 'ws', files, caseInsensitive })
}

function degrees(payload: GraphPayload, id: string): [number, number] {
  const node = payload.nodes.find((n) => n.id === id)
  if (!node) throw new Error(`找不到节点 ${id}`)
  return [node.inDegree, node.outDegree]
}

describe('applyDirtyOverlay / 空输入', () => {
  it('没有脏标签时原样返回同一个对象', () => {
    const payload = payloadOf([file('a.md', [['b.md', 1]]), file('b.md')])

    expect(applyDirtyOverlay(payload, [])).toBe(payload)
  })

  it('脏标签不在图里（未被索引）时不做任何修改', () => {
    const payload = payloadOf([file('a.md'), file('b.md')])
    const result = applyDirtyOverlay(payload, [
      { path: 'outside/none.md', content: '[a](a.md)' }
    ])

    expect(result).toBe(payload)
  })

  it('断链幽灵节点不能作为脏标签的覆盖目标', () => {
    const payload = payloadOf([file('a.md', [['missing.md', 1]])])
    const result = applyDirtyOverlay(payload, [
      { path: 'missing.md', content: '[a](a.md)' }
    ])

    expect(result).toBe(payload)
  })

  it('导图/图表不能产出出链，被忽略', () => {
    const payload = payloadOf([file('a.md'), file('map.inkmind')])
    const result = applyDirtyOverlay(payload, [
      { path: 'map.inkmind', content: '[a](a.md)' }
    ])

    expect(result).toBe(payload)
  })
})

describe('applyDirtyOverlay / 新链接立即可见（TC-STORE-010）', () => {
  it('未保存标签里的新链接出现在图上，出入度各 +1', () => {
    const payload = payloadOf([file('a.md'), file('b.md')])
    expect(degrees(payload, 'a.md')).toEqual([0, 0])

    const result = applyDirtyOverlay(payload, [{ path: 'a.md', content: '[b](b.md)' }])

    expect(result.edges).toEqual([{ source: 'a.md', target: 'b.md', count: 1, unresolved: false }])
    expect(degrees(result, 'a.md')).toEqual([0, 1])
    expect(degrees(result, 'b.md')).toEqual([1, 0])
  })

  it('缓冲区的出边整体替换磁盘出边（不是合并）', () => {
    const payload = payloadOf([file('a.md', [['b.md', 1]]), file('b.md'), file('c.md')])

    const result = applyDirtyOverlay(payload, [{ path: 'a.md', content: '[c](c.md)' }])

    expect(result.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['a.md>c.md'])
    expect(degrees(result, 'b.md')).toEqual([0, 0])
    expect(degrees(result, 'c.md')).toEqual([1, 0])
  })

  it('缓冲区里删掉链接后磁盘那条边消失，目标回归孤儿', () => {
    const payload = payloadOf([file('a.md', [['b.md', 1]]), file('b.md')])
    expect(payload.issues.orphans).toEqual([])

    const result = applyDirtyOverlay(payload, [{ path: 'a.md', content: '# 空空如也' }])

    expect(result.edges).toEqual([])
    expect(result.issues.orphans.map((i) => i.path).sort()).toEqual(['a.md', 'b.md'])
    expect(result.stats.orphanCount).toBe(2)
  })

  it('同一目标多条链接合并成一条边、count 累加', () => {
    const payload = payloadOf([file('a.md'), file('b.md')])

    const result = applyDirtyOverlay(payload, [
      { path: 'a.md', content: '[b](b.md)\n[b 再一次](b.md)' }
    ])

    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toEqual({
      source: 'a.md',
      target: 'b.md',
      count: 2,
      unresolved: false
    })
    expect(degrees(result, 'b.md')).toEqual([1, 0])
  })

  it('扩展名写错（b.mdx 实际是 b.md）记为断链，不做跨扩展名兜底', () => {
    const payload = payloadOf([file('a.md'), file('b.md')])

    const result = applyDirtyOverlay(payload, [{ path: 'a.md', content: '[b](b.mdx)' }])

    // basename 兜底按「完整文件名（含扩展名）」匹配，不会把 b.mdx 认成 b.md
    expect(result.nodes.some((n) => n.unresolved)).toBe(true)
    expect(result.stats.unresolvedCount).toBe(1)
  })

  it('自环不入边', () => {
    const payload = payloadOf([file('a.md')])

    const result = applyDirtyOverlay(payload, [{ path: 'a.md', content: '[自己](a.md)' }])

    expect(result.edges).toEqual([])
    expect(degrees(result, 'a.md')).toEqual([0, 0])
  })

  it('代码块里的链接不会被误算成边（与主进程同一套抽取规则）', () => {
    const payload = payloadOf([file('a.md'), file('b.md')])

    const result = applyDirtyOverlay(payload, [
      { path: 'a.md', content: '```\n[b](b.md)\n```\n' }
    ])

    expect(result.edges).toEqual([])
  })

  it('缓冲区里新写的附件链接立刻补出叶子节点（与主进程同一套规则）', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md')],
      attachmentPaths: ['scripts/deploy.sh']
    })

    const result = applyDirtyOverlay(payload, [
      { path: 'a.md', content: '[部署](scripts/deploy.sh)' }
    ])

    const node = result.nodes.find((item) => item.id === 'scripts/deploy.sh')!
    expect(node).toMatchObject({ format: 'attachment', label: 'deploy.sh', inDegree: 1 })
    expect(result.edges).toEqual([
      { source: 'a.md', target: 'scripts/deploy.sh', count: 1, unresolved: false }
    ])
    expect(result.stats.unresolvedCount).toBe(0)
  })

  it('缓冲区链接到不存在的附件时保持忽略，不产生断链', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md')],
      attachmentPaths: ['scripts/deploy.sh']
    })

    const result = applyDirtyOverlay(payload, [
      { path: 'a.md', content: '[没了](scripts/gone.sh)' }
    ])

    expect(result.edges).toEqual([])
    expect(result.stats.unresolvedCount).toBe(0)
  })
})

describe('applyDirtyOverlay / 断链与问题清单', () => {
  it('缓冲区里的失效链接生成幽灵节点与断链条目（带行号）', () => {
    const payload = payloadOf([file('a.md'), file('b.md')])

    const result = applyDirtyOverlay(payload, [
      { path: 'a.md', content: '# 正文\n\n[x](not-exist.md)\n' }
    ])

    const ghost = result.nodes.find((n) => n.unresolved)
    expect(ghost?.id).toBe('!not-exist.md')
    expect(ghost?.path).toBeNull()
    expect(result.stats.unresolvedCount).toBe(1)
    expect(result.issues.unresolved).toEqual([
      { path: 'a.md', label: 'a', href: 'not-exist.md', line: 3 }
    ])
  })

  it('缓冲区修好断链后，磁盘遗留的断链条目被移除', () => {
    const payload = payloadOf([file('a.md', [['old.md', 1]]), file('new.md')])
    expect(payload.issues.unresolved).toHaveLength(1)

    const result = applyDirtyOverlay(payload, [{ path: 'a.md', content: '[n](new.md)' }])

    expect(result.issues.unresolved).toEqual([])
    expect(result.stats.unresolvedCount).toBe(0)
    expect(result.nodes.some((n) => n.unresolved)).toBe(false)
  })

  it('失去所有边的幽灵节点被收掉', () => {
    const payload = payloadOf([file('a.md', [['ghost.md', 1]])])
    expect(payload.nodes.some((n) => n.unresolved)).toBe(true)

    const result = applyDirtyOverlay(payload, [{ path: 'a.md', content: '# 无链接' }])

    expect(result.nodes.some((n) => n.unresolved)).toBe(false)
    expect(result.stats.unresolvedCount).toBe(0)
  })

  it('断链条目按来源路径与行号排序', () => {
    const payload = payloadOf([file('a.md'), file('b.md')])

    const result = applyDirtyOverlay(payload, [
      { path: 'b.md', content: '[x](zz.md)' },
      { path: 'a.md', content: '[p](y2.md)\n[q](y1.md)' }
    ])

    expect(result.issues.unresolved.map((i) => `${i.path}:${i.line}`)).toEqual([
      'a.md:1',
      'a.md:2',
      'b.md:1'
    ])
  })
})

describe('applyDirtyOverlay / 统计与不变量', () => {
  it('stats 四计数与集合长度一致', () => {
    const payload = payloadOf([file('a.md', [['b.md', 1]]), file('b.md'), file('c.md')])

    const result = applyDirtyOverlay(payload, [
      { path: 'a.md', content: '[b](b.md)\n[gone](gone.md)' }
    ])

    expect(result.stats.nodeCount).toBe(result.nodes.length)
    expect(result.stats.edgeCount).toBe(result.edges.length)
    expect(result.stats.unresolvedCount).toBe(result.nodes.filter((n) => n.unresolved).length)
    expect(result.stats.orphanCount).toBe(result.issues.orphans.length)
    // 孤儿只数真实节点
    expect(result.issues.orphans.every((i) => !i.path.startsWith('!'))).toBe(true)
  })

  it('孤儿判定与度数一致（度 0 才算孤儿）', () => {
    const payload = payloadOf([file('a.md', [['b.md', 1]]), file('b.md'), file('lonely.md')])

    const result = applyDirtyOverlay(payload, [{ path: 'a.md', content: '[b](b.md)' }])

    expect(result.issues.orphans.map((i) => i.path)).toEqual(['lonely.md'])
    for (const orphan of result.issues.orphans) {
      expect(degrees(result, orphan.path)).toEqual([0, 0])
    }
  })

  it('节点与边按 id 稳定排序，同一输入两次结果相同', () => {
    const payload = payloadOf([file('b.md'), file('a.md'), file('c.md')])
    const dirty = [{ path: 'b.md', content: '[c](c.md)\n[a](a.md)' }]

    const first = applyDirtyOverlay(payload, dirty)
    const second = applyDirtyOverlay(payload, dirty)

    expect(first.edges).toEqual(second.edges)
    expect(first.nodes.map((n) => n.id)).toEqual(second.nodes.map((n) => n.id))
    expect(first.edges.map((e) => `${e.source}>${e.target}`)).toEqual([
      'b.md>a.md',
      'b.md>c.md'
    ])
  })

  /**
   * D1（已修复）：`applyDirtyOverlay` 曾经就地修改传入 payload 的节点对象
   * ——`nodes` Map 直接复用 `payload.nodes` 的元素引用，重算度数时写回原索引，
   * 而 `edges`/`stats` 是新建的。
   *
   * 后果：脏标签消失（用户关掉未保存标签 / 保存后重算）时，调用方传空数组会
   * 原样拿回 payload，其 `inDegree/outDegree` 仍是被覆盖过的值，与 `edges` 不自洽
   * ——图上节点半径（按入度缩放）与边、与工具条计数会互相矛盾，且只有重建图谱才能恢复。
   *
   * 修复：`new Map(payload.nodes.map((node) => [node.id, { ...node }]))` 浅拷贝。
   * 本用例同时锁住「不共享对象」与「度数不渗回入参」两条不变量。
   */
  it('不修改传入的 payload（纯函数，D1 回归）', () => {
    const payload = payloadOf([file('a.md', [['b.md', 1]]), file('b.md')])
    const before = JSON.stringify(payload)
    const originalDegrees = new Map(payload.nodes.map((node) => [node.id, [node.inDegree, node.outDegree]]))

    // 1) 覆盖一次
    applyDirtyOverlay(payload, [{ path: 'a.md', content: '[c](c.md)' }])
    expect(JSON.stringify(payload)).toBe(before)

    // 2) 再以空脏标签调用（等于用户关掉未保存标签）
    const back = applyDirtyOverlay(payload, [])
    expect(back).toBe(payload)

    // 3) 度数与最初一致（空脏标签时提前返回原对象，节点数组本就是同一个）
    for (const node of back.nodes) {
      expect([node.inDegree, node.outDegree]).toEqual(originalDegrees.get(node.id))
    }

    // 4) 真正做覆盖时结果不能与入参共享节点对象（否则仍会渗回）
    const overlaid = applyDirtyOverlay(payload, [{ path: 'a.md', content: '[c](c.md)' }])
    expect(overlaid.nodes).not.toBe(payload.nodes)
    expect(overlaid.nodes.some((node) => payload.nodes.includes(node))).toBe(false)
  })

  it('多个脏标签一起覆盖', () => {
    const payload = payloadOf([file('a.md'), file('b.md'), file('c.md')])

    const result = applyDirtyOverlay(payload, [
      { path: 'a.md', content: '[b](b.md)' },
      { path: 'b.md', content: '[c](c.md)' }
    ])

    expect(result.edges.map((e) => `${e.source}>${e.target}`)).toEqual([
      'a.md>b.md',
      'b.md>c.md'
    ])
    expect(degrees(result, 'b.md')).toEqual([1, 1])
  })

  it('大小写不敏感时按折叠后的 id 匹配脏标签', () => {
    const payload = payloadOf([file('Notes/A.md'), file('Notes/B.md')], true)

    const result = applyDirtyOverlay(payload, [{ path: 'notes/a.md', content: '[b](B.md)' }])

    expect(result.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['notes/a.md>notes/b.md'])
  })
})

describe('toWorkspaceRelative', () => {
  it('工作区内绝对路径转相对 POSIX 路径', () => {
    expect(toWorkspaceRelative('C:\\ws', 'C:\\ws\\a\\b.md')).toBe('a/b.md')
    expect(toWorkspaceRelative('/ws', '/ws/a/b.md')).toBe('a/b.md')
  })

  it('工作区根自身返回 null', () => {
    expect(toWorkspaceRelative('C:\\ws', 'C:\\ws')).toBeNull()
  })

  it('工作区外的路径返回 null', () => {
    expect(toWorkspaceRelative('C:\\ws', 'C:\\other\\a.md')).toBeNull()
    expect(toWorkspaceRelative('/ws', '/ws2/a.md')).toBeNull()
  })

  it('空 root 返回 null', () => {
    expect(toWorkspaceRelative('', 'C:\\ws\\a.md')).toBeNull()
  })

  it('Windows 盘符下大小写不敏感', () => {
    expect(toWorkspaceRelative('C:\\WS', 'c:\\ws\\a.md')).toBe('a.md')
  })
})
