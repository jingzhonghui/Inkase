import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0', getName: () => 'inkase' },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() }
}))

const {
  GraphService,
  GraphBuildCancelledError,
  isCaseInsensitiveFileSystem,
  getGraphService
} = await import('../../graph/service')

let root: string
let service: InstanceType<typeof GraphService>

function write(relativePath: string, content: string | Buffer): string {
  const absolute = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return absolute
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-svc-'))
  service = new GraphService()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('GraphService.build / 编排', () => {
  it('TC-SERVICE-001 进度回调按 progressEvery 透传，末次为 (total,total)', async () => {
    for (let i = 0; i < 5; i++) write(`f${i}.md`, '# f')
    const calls: Array<[number, number]> = []

    await service.build(root, {
      limits: { progressEvery: 2, concurrency: 1 },
      onProgress: (scanned, total) => calls.push([scanned, total])
    })

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.at(-1)).toEqual([5, 5])
    expect(calls.some(([scanned]) => scanned === 2)).toBe(true)
  })

  it('返回可直接渲染的 payload：节点/边/stats/warnings/issues 齐全', async () => {
    write('a.md', '[b](b.md)')
    write('b.md', '# b')

    const payload = await service.build(root)

    expect(payload.root).toBe(root)
    expect(payload.nodes.map((n) => n.id).sort()).toEqual(['a.md', 'b.md'])
    expect(payload.edges).toEqual([{ source: 'a.md', target: 'b.md', count: 1, unresolved: false }])
    expect(payload.stats.nodeCount).toBe(payload.nodes.length)
    expect(payload.stats.edgeCount).toBe(1)
    expect(payload.stats.filesScanned).toBe(2)
    expect(Array.isArray(payload.warnings)).toBe(true)
    expect(payload.issues.unresolved).toEqual([])
    expect(payload.resolution.caseInsensitive).toBe(isCaseInsensitiveFileSystem())
  })

  it('TC-SERVICE-007 链接到非文档文件时端到端生成附件叶子节点', async () => {
    write('docs/a.md', '[部署](scripts/deploy.sh) 与 [图](assets/logo.png)')
    write('docs/scripts/deploy.sh', 'echo hi')
    write('docs/assets/logo.png', 'png')

    const payload = await service.build(root)

    const ids = payload.nodes.map((node) => node.id).sort()
    expect(ids).toEqual(['docs/a.md', 'docs/assets/logo.png', 'docs/scripts/deploy.sh'])

    const script = payload.nodes.find((node) => node.id === 'docs/scripts/deploy.sh')!
    expect(script).toMatchObject({ format: 'attachment', label: 'deploy.sh', inDegree: 1 })
    expect(payload.stats.unresolvedCount).toBe(0)
    // 附件路径随 payload 带回，脏标签重算才能算出同样的结论
    expect(payload.resolution.attachmentPaths).toContain('docs/scripts/deploy.sh')
  })

  it('TC-SERVICE-003 坏文件只产生 warning，不影响正常文件入图', async () => {    write('ok.md', '[t](t.md)')
    write('t.md', '# t')
    fs.writeFileSync(path.join(root, 'broken.mdx'), Buffer.from('不是 zip', 'utf8'))
    write('huge.md', 'x'.repeat(4096))

    const payload = await service.build(root, { limits: { maxFileBytes: 1024 } })

    expect(payload.nodes.some((n) => n.path === 'ok.md')).toBe(true)
    // 至少两条：损坏 .mdx + 超限文件，且都带文件名
    expect(payload.warnings.length).toBeGreaterThanOrEqual(2)
    expect(payload.warnings.some((w) => w.includes('broken.mdx'))).toBe(true)
    expect(payload.warnings.some((w) => w.includes('huge.md'))).toBe(true)
  })

  it('TC-SERVICE-004 时限到达时返回部分结果 + warning + truncated，不挂死', async () => {
    for (let i = 0; i < 10; i++) write(`d${i}.md`, '# d')

    const payload = await service.build(root, { limits: { maxDurationMs: -1 } })

    // 按裁定：只断言「有 warning 且 truncated」，不断言孤儿数绝对值
    expect(payload.stats.truncated).toBe(true)
    expect(payload.warnings.some((w) => w.includes('部分结果'))).toBe(true)
  })

  it('TC-SERVICE-004 限额截断透传到 stats.truncated', async () => {
    for (let i = 0; i < 5; i++) write(`m${i}.md`, '# m')

    const payload = await service.build(root, { limits: { maxFiles: 2 } })

    expect(payload.stats.truncated).toBe(true)
    expect(payload.nodes).toHaveLength(2)
    expect(payload.warnings.some((w) => w.includes('已扫描至上限'))).toBe(true)
  })
})

describe('GraphService.build / 取消', () => {
  it('TC-SERVICE-002 已中止的 signal 抛出 GraphBuildCancelledError', async () => {
    write('a.md', '# a')
    const controller = new AbortController()
    controller.abort()

    await expect(service.build(root, { signal: controller.signal })).rejects.toBeInstanceOf(
      GraphBuildCancelledError
    )
  })

  it('取消错误的 message 是「已取消」，便于 handler 原样返回', async () => {
    const error = new GraphBuildCancelledError()

    expect(error.message).toBe('已取消')
    expect(error.name).toBe('GraphBuildCancelledError')
  })

  it('取消优先于返回半成品：aborted 时不产出 payload', async () => {
    for (let i = 0; i < 3; i++) write(`c${i}.md`, '# c')
    const controller = new AbortController()
    controller.abort()

    await expect(
      service.build(root, { signal: controller.signal, limits: { progressEvery: 1 } })
    ).rejects.toThrow('已取消')
  })
})

describe('GraphService.refreshFile / invalidate', () => {
  it('单文件重算只返回该文件的出链', async () => {
    write('a.md', '[b](b.md)\n[c](c.md)')
    write('b.md', '# b')
    await service.build(root)

    const record = await service.refreshFile(root, 'a.md')

    expect(record?.path).toBe('a.md')
    expect(record?.links).toEqual([
      { href: 'b.md', line: 1 },
      { href: 'c.md', line: 2 }
    ])
  })

  it('文件内容变化后 refreshFile 给出新出链', async () => {
    const abs = write('a.md', '[b](b.md)')
    await service.build(root)

    fs.writeFileSync(abs, '[b](b.md)\n[d](d.md)')
    const record = await service.refreshFile(root, 'a.md')

    expect(record?.links).toHaveLength(2)
  })

  it('invalidate 后重新 build 会重新解析（缓存已丢弃）', async () => {
    const abs = write('a.md', '[b](b.md)')
    write('b.md', '# b')
    write('e.md', '# e')
    await service.build(root)

    service.invalidate(root)
    fs.writeFileSync(abs, '[b](b.md)\n[e](e.md)')
    const payload = await service.build(root)

    expect(payload.edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual([
      'a.md>b.md',
      'a.md>e.md'
    ])
  })
})

describe('getGraphService 单例', () => {
  it('多次调用返回同一实例（缓存跨构建存活）', () => {
    expect(getGraphService()).toBe(getGraphService())
  })
})

describe('isCaseInsensitiveFileSystem', () => {
  it('与当前平台一致（win32/darwin 不敏感）', () => {
    expect(isCaseInsensitiveFileSystem()).toBe(
      process.platform === 'win32' || process.platform === 'darwin'
    )
  })
})
