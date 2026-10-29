import { describe, expect, it } from 'vitest'
import { buildGraph } from '../build'
import type { FileLinkRecord } from '../types'

function file(path: string, links: Array<[string, number]> = []): FileLinkRecord {
  const format = path.endsWith('.inkmind')
    ? 'mindmap'
    : path.endsWith('.drawio')
      ? 'diagram'
      : path.endsWith('.md')
        ? 'markdown'
        : 'mdx'
  return {
    path,
    format,
    links: links.map(([href, line]) => ({ href, line }))
  }
}

function edgeOf(
  payload: ReturnType<typeof buildGraph>,
  source: string,
  target: string
): { count: number; unresolved: boolean } | undefined {
  const edge = payload.edges.find((item) => item.source === source && item.target === target)
  return edge ? { count: edge.count, unresolved: edge.unresolved } : undefined
}

describe('buildGraph：边与度数', () => {
  it('同一对文件的多次链接合并成一条带 count 的边', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['b.md', 1], ['b.md', 3]]), file('b.md', [['a.md', 5]])]
    })

    expect(payload.edges).toHaveLength(2)
    expect(edgeOf(payload, 'a.md', 'b.md')).toEqual({ count: 2, unresolved: false })
    expect(edgeOf(payload, 'b.md', 'a.md')).toEqual({ count: 1, unresolved: false })

    const a = payload.nodes.find((node) => node.id === 'a.md')!
    expect(a.outDegree).toBe(1)
    expect(a.inDegree).toBe(1)
  })

  it('自环不计入边，但文件本身仍是孤儿', () => {
    const payload = buildGraph({ root: 'ws', files: [file('a.md', [['a.md', 1]])] })

    expect(payload.edges).toHaveLength(0)
    expect(payload.stats.orphanCount).toBe(1)
    expect(payload.issues.orphans.map((issue) => issue.path)).toEqual(['a.md'])
  })

  it('度为 0 的真实节点是孤儿，断链幽灵节点不是', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['missing.md', 2]]), file('lonely.md')]
    })

    const ghost = payload.nodes.find((node) => node.id === '!missing.md')!
    expect(ghost.unresolved).toBe(true)
    expect(ghost.inDegree).toBe(1)
    expect(ghost.path).toBeNull()

    expect(payload.issues.orphans.map((issue) => issue.path)).toEqual(['lonely.md'])
    expect(payload.stats.orphanCount).toBe(1)
  })
})

describe('buildGraph：断链清单', () => {
  it('断链条目带原文与行号，指向来源文件', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('notes/a.md', [['../nowhere/x.md', 7]])]
    })

    expect(payload.issues.unresolved).toEqual([
      { path: 'notes/a.md', label: 'a', href: '../nowhere/x.md', line: 7 }
    ])
    expect(payload.stats.unresolvedCount).toBe(1)
  })

  it('同一个失效目标被多处引用时合并成一个幽灵节点', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [
        file('notes/a.md', [['missing.md', 1]]),
        file('b.md', [['notes/missing.md', 1]])
      ]
    })

    const ghosts = payload.nodes.filter((node) => node.unresolved)
    expect(ghosts).toHaveLength(1)
    expect(ghosts[0].id).toBe('!notes/missing.md')
    // 两条断链仍然各记一条，问题清单要能看到是谁引用的
    expect(payload.issues.unresolved).toHaveLength(2)
  })
})

describe('buildGraph：节点集合', () => {
  it('导图与图表只作为叶子节点，不产出出链', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [
        file('a.md', [['plan.inkmind', 1], ['flow.drawio', 2]]),
        file('plan.inkmind', [['b.md', 1]]),
        file('flow.drawio', [['b.md', 1]])
      ]
    })

    expect(payload.nodes.map((node) => node.id).sort()).toEqual(['a.md', 'flow.drawio', 'plan.inkmind'])
    expect(payload.edges).toHaveLength(2)
    expect(payload.edges.every((edge) => edge.source === 'a.md')).toBe(true)
  })

  it('顶层文件夹与展示名从路径推导', () => {
    const payload = buildGraph({ root: 'ws', files: [file('notes/sub/a.md'), file('root.md')] })

    const nested = payload.nodes.find((node) => node.id === 'notes/sub/a.md')!
    expect(nested.folder).toBe('notes')
    expect(nested.label).toBe('a')

    const root = payload.nodes.find((node) => node.id === 'root.md')!
    expect(root.folder).toBe('')
  })

  it('文件存在但没进索引时不算断链', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['skipped.md', 1]])],
      knownPaths: ['skipped.md']
    })

    expect(payload.stats.unresolvedCount).toBe(0)
    expect(payload.issues.unresolved).toHaveLength(0)
    expect(payload.resolution.knownPaths).toEqual(['skipped.md'])
  })
})

describe('buildGraph：非文档文件作为叶子节点', () => {
  it('TC-BUILD-008 链接到真实存在的非文档文件时生成附件节点与边', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('docs/a.md', [['scripts/deploy.sh', 3]])],
      attachmentPaths: ['docs/scripts/deploy.sh']
    })

    const node = payload.nodes.find((item) => item.id === 'docs/scripts/deploy.sh')!
    expect(node).toMatchObject({
      format: 'attachment',
      path: 'docs/scripts/deploy.sh',
      // 附件保留扩展名：deploy.sh 和 deploy.txt 不能都叫 deploy
      label: 'deploy.sh',
      folder: 'docs',
      unresolved: false,
      outDegree: 0,
      inDegree: 1
    })
    expect(edgeOf(payload, 'docs/a.md', 'docs/scripts/deploy.sh')).toEqual({
      count: 1,
      unresolved: false
    })
    expect(payload.stats.unresolvedCount).toBe(0)
  })

  it('TC-BUILD-009 附件节点保留磁盘上的真实大小写', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['scripts/Deploy.sh', 1]])],
      attachmentPaths: ['scripts/Deploy.sh'],
      caseInsensitive: true
    })

    const node = payload.nodes.find((item) => item.id === 'scripts/deploy.sh')!
    expect(node.path).toBe('scripts/Deploy.sh')
    expect(node.label).toBe('Deploy.sh')
  })

  it('TC-BUILD-010 只收被链接到的文件：未链接的非文档文件不进图', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['b.md', 1]]), file('b.md')],
      attachmentPaths: ['assets/cover.png', 'scripts/build.sh']
    })

    expect(payload.nodes.map((node) => node.id).sort()).toEqual(['a.md', 'b.md'])
    expect(payload.nodes.some((node) => node.format === 'attachment')).toBe(false)
  })

  it('TC-BUILD-011 同一附件被多篇文档引用只生成一个节点、入链数为 2', () => {    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['shared/spec.pdf', 1]]), file('b.md', [['shared/spec.pdf', 2]])],
      attachmentPaths: ['shared/spec.pdf']
    })

    const node = payload.nodes.find((item) => item.id === 'shared/spec.pdf')!
    expect(node.inDegree).toBe(2)
    expect(payload.nodes.filter((item) => item.format === 'attachment')).toHaveLength(1)
  })

  it('附件路径不存在时保持忽略，不产生幽灵节点', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['scripts/missing.sh', 1]])],
      attachmentPaths: []
    })

    expect(payload.nodes).toHaveLength(1)
    expect(payload.edges).toHaveLength(0)
    expect(payload.stats.unresolvedCount).toBe(0)
  })

  it('附件不会被 basename 兜底当成文档命中', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['deploy', 1]])],
      attachmentPaths: ['scripts/deploy.sh']
    })

    // 无扩展名的链接只补 .mdx / .md，不该落到 deploy.sh 上
    expect(payload.nodes.some((node) => node.format === 'attachment')).toBe(false)
    expect(payload.stats.unresolvedCount).toBe(1)
  })

  it('附件节点不参与孤儿统计（它只因为被引用才存在）', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['readme.txt', 1]])],
      attachmentPaths: ['readme.txt']
    })

    expect(payload.issues.orphans.map((issue) => issue.path)).toEqual([])
    expect(payload.stats.orphanCount).toBe(0)
  })

  it('resolution 里带回附件路径，供脏标签重算复用', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['x.sh', 1]])],
      attachmentPaths: ['x.sh']
    })

    expect(payload.resolution.attachmentPaths).toEqual(['x.sh'])
  })
})

describe('buildGraph：统计与告警', () => {
  it('统计与警告原样带回', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md')],
      truncated: true,
      warnings: ['已扫描至上限'],
      filesScanned: 5000,
      elapsedMs: 1234
    })

    expect(payload.stats).toMatchObject({
      nodeCount: 1,
      edgeCount: 0,
      unresolvedCount: 0,
      orphanCount: 1,
      filesScanned: 5000,
      elapsedMs: 1234,
      truncated: true
    })
    expect(payload.warnings).toContain('已扫描至上限')
  })

  it('模板字符串里的数量与实际节点一致', () => {
    const payload = buildGraph({
      root: 'ws',
      files: [file('a.md', [['b.md', 1]]), file('b.md'), file('c.md')]
    })

    expect(payload.stats.nodeCount).toBe(payload.nodes.length)
    expect(payload.stats.edgeCount).toBe(payload.edges.length)
    expect(payload.stats.orphanCount).toBe(payload.issues.orphans.length)
  })
})
