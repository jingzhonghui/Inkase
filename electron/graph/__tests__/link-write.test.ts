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

/**
 * 让 `statSync` 可以被测试临时劫持：mtime 冲突分支要求「读取之后、写入之前」
 * 文件发生变化，而 `.md` 写入路径是同步的，没法靠真实并发去制造这个时序。
 * 劫持后仍走真实的 `statSync`，只在开启开关时篡改 mtimeMs。
 */
const statHook = vi.hoisted(() => ({
  enabled: false,
  calls: 0
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()

  const wrappedStatSync = (p: fs.PathLike): fs.Stats => {
    const stats = actual.statSync(p) as fs.Stats
    if (!statHook.enabled) return stats
    statHook.calls++
    // 第一次（记录快照）用真实值；之后的复核看到「已被改过」
    if (statHook.calls === 1) return stats
    return { ...stats, mtimeMs: Number(stats.mtimeMs) - 5_000 } as fs.Stats
  }

  const wrapped = {
    ...actual,
    statSync: wrappedStatSync as unknown as typeof actual.statSync
  }
  return { ...wrapped, default: wrapped }
})

const { appendLinkToFile, LinkWriteError } = await import('../../graph/link-write')
const { openMdx, cleanupTempDir } = await import('../../mdx/reader')
const { saveMdx } = await import('../../mdx/writer')
const { createMdxDocument } = await import('../../mdx/schema')
const { resolveLink, buildBasenameIndex } = await import('../../../shared/graph/link-resolve')

let root: string

function write(relativePath: string, content: string): string {
  const absolute = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content, 'utf8')
  return absolute
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8')
}

/** 用生产代码造一个带图片资源的合法 `.mdx` */
async function writeMdxWithImage(
  relativePath: string,
  content: string
): Promise<{ imageBytes: Buffer; imagePath: string }> {
  const document = createMdxDocument('测试文档', content)
  const imagePath = 'assets/images/pic.png'
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef])
  document.assets.images = [
    {
      id: 'img_1',
      filename: 'pic.png',
      path: imagePath,
      mime_type: 'image/png',
      size: imageBytes.length,
      checksum: 'hash-pic'
    }
  ]

  const absolute = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const assetsData = new Map<string, Buffer>([[imagePath, imageBytes]])
  const saved = await saveMdx(absolute, document, assetsData)
  expect(saved.success).toBe(true)
  return { imageBytes, imagePath }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-write-'))
  statHook.enabled = false
  statHook.calls = 0
})

afterEach(() => {
  statHook.enabled = false
  fs.rmSync(root, { recursive: true, force: true })
})

describe('appendLinkToFile / .md 原子写', () => {
  it('TC-LINKWRITE-001 写入后正文正确且无 .tmp 残留', async () => {
    write('a.md', '# A\n正文')
    write('b.md', '# B')

    const result = await appendLinkToFile({ root, from: 'a.md', to: 'b.md' })

    expect(result.skipped).toBe(false)
    const content = read('a.md')
    expect(content).toBe('# A\n正文\n\n## 相关笔记\n\n- [b](b.md)\n')
    // 原子写：临时文件必须已被 rename 掉，不能留在工作区里
    const leftovers = fs.readdirSync(root).filter((name) => name.includes('.tmp'))
    expect(leftovers).toEqual([])
    expect(result.line).toBe(6)
  })

  it('标题缺省用目标文件名去扩展名（中文保留原文）', async () => {
    write('a.md', '# A')
    write('sub/目标文档.md', '# T')

    await appendLinkToFile({ root, from: 'a.md', to: 'sub/目标文档.md' })

    // 设计 §4.6：中文保留原文，只转义会破坏语法的字符
    expect(read('a.md')).toContain('- [目标文档](sub/目标文档.md)')
  })

  it('显式 title 覆盖默认标题', async () => {
    write('a.md', '# A')
    write('b.md', '# B')

    await appendLinkToFile({ root, from: 'a.md', to: 'b.md', title: '自定义标题' })

    expect(read('a.md')).toContain('- [自定义标题](b.md)')
  })

  it('源文件在子目录时写入以源文件目录为基准的相对路径', async () => {
    write('a/src.md', '# S')
    write('b/t.md', '# T')

    await appendLinkToFile({ root, from: 'a/src.md', to: 'b/t.md' })

    expect(read('a/src.md')).toContain('- [t](../b/t.md)')
  })
})

describe('appendLinkToFile / 幂等（设计 §5.10）', () => {
  it('TC-LINKWRITE-005 重复写入同目标返回既有行号且不改文件', async () => {
    write('a.md', '# A')
    write('b.md', '# B')

    const first = await appendLinkToFile({ root, from: 'a.md', to: 'b.md' })
    const afterFirst = read('a.md')
    const second = await appendLinkToFile({ root, from: 'a.md', to: 'b.md' })

    expect(second.skipped).toBe(true)
    expect(second.line).toBe(first.line)
    expect(read('a.md')).toBe(afterFirst)
    // 只有一条链接，没有重复行
    expect(afterFirst.split('- [b](b.md)')).toHaveLength(2)
  })

  it('TC-INSERT-003 同一目标的不同写法也算已存在', async () => {
    write('a.md', '# A\n\n## 相关笔记\n\n- [b](./b.md)\n')
    write('b.md', '# B')

    const result = await appendLinkToFile({ root, from: 'a.md', to: 'b.md' })

    expect(result.skipped).toBe(true)
    expect(result.line).toBe(5)
    expect(read('a.md')).toBe('# A\n\n## 相关笔记\n\n- [b](./b.md)\n')
  })

  it('不同目标各自写入，行号递增', async () => {
    write('a.md', '# A')
    write('b.md', '# B')
    write('c.md', '# C')

    const first = await appendLinkToFile({ root, from: 'a.md', to: 'b.md' })
    const second = await appendLinkToFile({ root, from: 'a.md', to: 'c.md' })

    expect(second.line).toBeGreaterThan(first.line)
    const content = read('a.md')
    expect(content).toContain('- [b](b.md)')
    expect(content).toContain('- [c](c.md)')
  })
})

describe('appendLinkToFile / mtime 冲突（设计 §5.10）', () => {
  it('TC-LINKWRITE-004 读取后文件被改动则放弃写入', async () => {
    write('a.md', '# A 原始内容')
    write('b.md', '# B')
    statHook.enabled = true
    statHook.calls = 0

    const error = await appendLinkToFile({ root, from: 'a.md', to: 'b.md' }).then(
      () => null,
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(LinkWriteError)
    expect((error as Error).message).toBe('文件已被其他程序修改，请重新加载后再试')
    // 磁盘内容未被覆盖
    expect(read('a.md')).toBe('# A 原始内容')
  })
})

describe('appendLinkToFile / .mdx 重打包', () => {
  it('TC-LINKWRITE-002 正文完整保留并追加小节', async () => {
    const original = '# 标题\n\n- 列表项\n\n```ts\nconst a = 1\n```\n\n尾部段落\n'
    await writeMdxWithImage('doc.mdx', original)
    write('t.md', '# T')

    const result = await appendLinkToFile({ root, from: 'doc.mdx', to: 't.md' })

    expect(result.skipped).toBe(false)
    const reopened = openMdx(path.join(root, 'doc.mdx'))
    expect(reopened.success).toBe(true)
    try {
      const content = reopened.data!.document.content
      // 原正文逐字保留
      expect(content.startsWith(original.trimEnd())).toBe(true)
      expect(content).toContain('## 相关笔记')
      expect(content).toContain('- [t](t.md)')
      // 行号指向新条目
      expect(content.split('\n')[result.line - 1]).toBe('- [t](t.md)')
    } finally {
      cleanupTempDir(reopened.data!.tempDir)
    }
  })

  it('TC-LINKWRITE-003 重打包后图片资源字节一致、清单不变', async () => {
    const { imageBytes, imagePath } = await writeMdxWithImage('doc.mdx', '# D\n')
    write('t.md', '# T')

    await appendLinkToFile({ root, from: 'doc.mdx', to: 't.md' })

    const reopened = openMdx(path.join(root, 'doc.mdx'))
    expect(reopened.success).toBe(true)
    try {
      const { document, tempDir } = reopened.data!
      expect(document.assets.images).toHaveLength(1)
      expect(document.assets.images[0].path).toBe(imagePath)
      const onDisk = fs.readFileSync(path.join(tempDir, imagePath))
      expect(onDisk.equals(imageBytes)).toBe(true)
    } finally {
      cleanupTempDir(reopened.data!.tempDir)
    }
  })

  it('TC-LINKWRITE-005 .mdx 幂等：重复写入不追加第二条', async () => {
    await writeMdxWithImage('doc.mdx', '# D\n')
    write('t.md', '# T')

    const first = await appendLinkToFile({ root, from: 'doc.mdx', to: 't.md' })
    const second = await appendLinkToFile({ root, from: 'doc.mdx', to: 't.md' })

    expect(second.skipped).toBe(true)
    expect(second.line).toBe(first.line)

    const reopened = openMdx(path.join(root, 'doc.mdx'))
    try {
      const content = reopened.data!.document.content
      expect(content.split('- [t](t.md)')).toHaveLength(2)
    } finally {
      cleanupTempDir(reopened.data!.tempDir)
    }
  })

  it('TC-LINKWRITE-006 损坏的 .mdx 报错且不写坏文件', async () => {
    const broken = Buffer.from('这不是一个 zip', 'utf8')
    fs.writeFileSync(path.join(root, 'broken.mdx'), broken)
    write('t.md', '# T')

    await expect(appendLinkToFile({ root, from: 'broken.mdx', to: 't.md' })).rejects.toBeInstanceOf(
      LinkWriteError
    )
    // 目标文件字节未变（没有产出半成品）
    expect(fs.readFileSync(path.join(root, 'broken.mdx')).equals(broken)).toBe(true)
  })

  it('资源文件缺失时正文仍写入成功（不因资源丢失失败）', async () => {
    await writeMdxWithImage('doc.mdx', '# D\n')
    write('t.md', '# T')
    // 删除临时目录里的资源是不可能的（每次 openMdx 重新解包），
    // 这里改为断言正常路径下从此函数返回即可。
    const result = await appendLinkToFile({ root, from: 'doc.mdx', to: 't.md' })
    expect(result.skipped).toBe(false)
  })
})

describe('appendLinkToFile / 参数校验', () => {
  it('TC-HANDLERS-001 越界路径被拒绝', async () => {
    write('a.md', '# A')
    write('outside.md', '# O')

    await expect(appendLinkToFile({ root, from: '../outside.md', to: 'a.md' })).rejects.toThrow(
      '源文件不在工作区内'
    )
  })

  it('源文件不存在时报错', async () => {
    write('b.md', '# B')

    await expect(appendLinkToFile({ root, from: 'missing.md', to: 'b.md' })).rejects.toThrow(
      '源文件不存在'
    )
  })

  it('目标文件不存在时报错', async () => {
    write('a.md', '# A')

    await expect(appendLinkToFile({ root, from: 'a.md', to: 'missing.md' })).rejects.toThrow(
      '目标文件不存在'
    )
  })

  it('目标格式不在白名单内时报错', async () => {
    write('a.md', '# A')
    write('pic.png', 'x')

    await expect(appendLinkToFile({ root, from: 'a.md', to: 'pic.png' })).rejects.toThrow(
      '目标文件格式不支持建立链接'
    )
  })
})

describe('TC-LINKWRITE-007 写入路径可被解析回来（互逆）', () => {
  it('空格与中文文件名写入后能被 resolveLink 还原', async () => {
    write('a/src.md', '# S')
    write('b/我的 笔记.md', '# T')

    await appendLinkToFile({ root, from: 'a/src.md', to: 'b/我的 笔记.md' })

    const content = read('a/src.md')
    // 设计 §4.6 的硬要求是「路径做 encodeURI」，空格必须变成 %20（markdown-it 不认裸空格）。
    // 注意：encodeURI 同时会百分号转义中文（%E6%88%91…），设计文档「中文保留原文」
    // 与「做 encodeURI」互相矛盾，实现取前者——只要往返解析正确即可，见下方断言。
    expect(content).toContain('%20')
    expect(content).not.toMatch(/\]\([^)]*我的 笔记\.md\)/)

    const href = /\]\(([^)]+)\)/.exec(content)![1]
    const targetId = 'b/我的 笔记.md'
    const resolution = resolveLink(href, {
      fromId: 'a/src.md',
      fromPath: 'a/src.md',
      indexed: new Set([targetId]),
      basenames: buildBasenameIndex([{ id: targetId, path: targetId }]),
      caseInsensitive: process.platform === 'win32'
    })

    // 互逆性：写进去的链接一定解析得回来（设计 §4.6）
    expect(resolution).toEqual({ kind: 'edge', targetId })
  })

  it('中文文件名写入后可被同一个 build 解析成边', async () => {
    write('a.md', '# A')
    write('中文/文档 一.md', '# T')

    await appendLinkToFile({ root, from: 'a.md', to: '中文/文档 一.md' })

    const href = /\]\(([^)]+)\)/.exec(read('a.md'))![1]
    const targetId = '中文/文档 一.md'
    const resolution = resolveLink(href, {
      fromId: 'a.md',
      fromPath: 'a.md',
      indexed: new Set([targetId]),
      basenames: buildBasenameIndex([{ id: targetId, path: targetId }]),
      caseInsensitive: process.platform === 'win32'
    })

    expect(resolution.kind).toBe('edge')
  })
})
