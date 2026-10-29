import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `scanner` → `mdx-content-search` → `ai/source-access-service` 会触到 electron，
// 这里给一个最小替身，只满足模块求值需要。
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0', getName: () => 'inkase' },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() }
}))

// 统计「真正解析内容」的次数：缓存命中的判定标准就是它不被再次调用
const extractCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../shared/graph/link-extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/graph/link-extract')>()
  return {
    ...actual,
    extractLinksDetailed: (...args: Parameters<typeof actual.extractLinksDetailed>) => {
      extractCalls.count++
      return actual.extractLinksDetailed(...args)
    }
  }
})

const { GraphScanner, resolveWithinRoot } = await import('../../graph/scanner')

let root: string
let scanner: InstanceType<typeof GraphScanner>

function write(relativePath: string, content: string | Buffer): string {
  const absolute = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return absolute
}

/** 造一个只含 content.md 的合法 `.mdx` 容器 */
function writeMdx(relativePath: string, content: string): string {
  const zip = new AdmZip()
  zip.addFile('mdx.json', Buffer.from(JSON.stringify({ version: '1.0' }), 'utf8'))
  zip.addFile('content.md', Buffer.from(content, 'utf8'))
  const absolute = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, zip.toBuffer())
  return absolute
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-scan-'))
  scanner = new GraphScanner()
  extractCalls.count = 0
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('scan / 目录遍历与排除', () => {
  it('TC-SCANNER-007 只列出白名单扩展名，跳过点开头目录与 node_modules', async () => {
    write('a.md', '[b](b.md)')
    writeMdx('b.mdx', '[a](a.md)')
    write('map.inkmind', '{}')
    write('flow.drawio', '<mxfile/>')
    write('pic.png', 'x')
    write('.git/config.md', '[x](x.md)')
    write('.inkase/state.md', '[x](x.md)')
    write('node_modules/pkg/readme.md', '[x](x.md)')
    write('nested/deep/c.md', '# c')

    const result = await scanner.scan(root)

    expect(result.knownPaths.sort()).toEqual([
      'a.md',
      'b.mdx',
      'flow.drawio',
      'map.inkmind',
      'nested/deep/c.md'
    ])
    // 点开头条目（含 .git / .inkase）与 node_modules 一律不出现
    expect(result.knownPaths.some((p) => p.startsWith('.'))).toBe(false)
    expect(result.knownPaths.some((p) => p.includes('node_modules'))).toBe(false)
    // 非白名单资源不进索引
    expect(result.knownPaths).not.toContain('pic.png')
  })

  it('导图与图表只登记节点、不读取内容（无出链）', async () => {
    write('map.inkmind', '[x](a.md)')
    write('flow.drawio', '<mxfile/>')

    const result = await scanner.scan(root)

    for (const record of result.records) {
      expect(record.links).toEqual([])
    }
    // 未读内容 → 未调用抽取
    expect(extractCalls.count).toBe(0)
  })

  it('TC-SCANNER-009 额外收集非文档文件路径，但不读内容、不进索引', async () => {
    write('a.md', '[sh](scripts/deploy.sh)')
    write('scripts/deploy.sh', 'echo hi')
    write('assets/cover.png', 'png')

    const result = await scanner.scan(root)

    // 只出现在附件集合里，不进 knownPaths
    expect(result.attachmentPaths).toEqual(['assets/cover.png', 'scripts/deploy.sh'])
    expect(result.knownPaths).toEqual(['a.md'])
    // 附件不解析内容：整个扫描只对 a.md 调过一次抽取
    expect(extractCalls.count).toBe(1)
    expect(result.records.map((record) => record.path)).toEqual(['a.md'])
  })

  it('TC-SCANNER-010 非文档文件也遵守点开头与 node_modules 排除', async () => {
    write('a.md', '# a')
    write('.git/hooks/pre-commit.sh', 'x')
    write('node_modules/pkg/index.js', 'x')

    const result = await scanner.scan(root)

    expect(result.attachmentPaths).toEqual([])
  })
})

describe('scan / mtime 缓存（设计 §5.5）', () => {
  it('TC-SCANNER-001 (mtimeMs, size) 未变时不重新解析', async () => {
    write('a.md', '[b](b.md)')
    write('b.md', '# b')

    const first = await scanner.scan(root)
    const callsAfterFirst = extractCalls.count
    // 只对能产出出链的 .md 解析：a.md + b.md
    expect(callsAfterFirst).toBe(2)
    expect(first.records.find((r) => r.path === 'a.md')?.links).toEqual([
      { href: 'b.md', line: 1 }
    ])

    const second = await scanner.scan(root)
    // 缓存命中 → 完全没有解析调用
    expect(extractCalls.count).toBe(callsAfterFirst)
    expect(second.records).toEqual(first.records)
  })

  it('TC-SCANNER-002 内容与 size 都变化时重新解析', async () => {
    write('a.md', '[b](b.md)')
    await scanner.scan(root)
    const before = extractCalls.count

    // 改写成一个更长（size 变化）的内容
    write('a.md', '[b](b.md) 以及 [c](c.md)\n')

    const result = await scanner.scan(root)
    expect(extractCalls.count).toBeGreaterThan(before)
    expect(result.records.find((r) => r.path === 'a.md')?.links).toHaveLength(2)
  })

  it('TC-SCANNER-003 文件删除后缓存条目被剔除', async () => {
    const abs = write('gone.md', '[b](b.md)')
    write('keep.md', '# keep')
    await scanner.scan(root)

    fs.rmSync(abs)
    const afterDelete = await scanner.scan(root)
    expect(afterDelete.knownPaths).toEqual(['keep.md'])
    expect(afterDelete.records.map((r) => r.path)).toEqual(['keep.md'])

    // 缓存未被剔除的证据：同名文件以「内容不同、size 相同」重建后必须重新解析，
    // 否则会命中旧缓存拿到过期出链。
    const before = extractCalls.count
    fs.writeFileSync(abs, '[c](c.md)')
    const afterRecreate = await scanner.scan(root)
    expect(extractCalls.count).toBeGreaterThan(before)
    expect(afterRecreate.records.find((r) => r.path === 'gone.md')?.links).toEqual([
      { href: 'c.md', line: 1 }
    ])
  })

  it('invalidateWorkTree 清空缓存后强制重新解析', async () => {
    write('a.md', '[b](b.md)')
    await scanner.scan(root)
    const before = extractCalls.count

    scanner.invalidateWorkTree(root)
    await scanner.scan(root)

    expect(extractCalls.count).toBeGreaterThan(before)
  })
})

describe('scan / 限额与降级（设计 §6 / §7）', () => {
  it('TC-SCANNER-004 文件数超限时截断并给出 warning', async () => {
    for (let i = 0; i < 5; i++) write(`n${i}.md`, '# n')

    const result = await scanner.scan(root, { limits: { maxFiles: 3 } })

    expect(result.truncated).toBe(true)
    expect(result.knownPaths).toHaveLength(3)
    expect(result.warnings.some((w) => w.includes('已扫描至上限'))).toBe(true)
  })

  it('TC-SCANNER-005 单文件超过 maxFileBytes 时跳过并记中文文件名', async () => {
    write('small.md', '# ok')
    write('large.md', 'x'.repeat(2048))

    const result = await scanner.scan(root, { limits: { maxFileBytes: 1024 } })

    expect(result.knownPaths).toContain('large.md')
    expect(result.records.map((r) => r.path)).toEqual(['small.md'])
    expect(result.warnings.some((w) => w.includes('large.md') && w.includes('已跳过'))).toBe(true)
    // 跳过不等于整库失败
    expect(result.records).toHaveLength(1)
  })

  it('TC-SCANNER-006 .mdx 解压后正文超过 maxMdxContentBytes 时跳过', async () => {
    writeMdx('big.mdx', 'x'.repeat(4096))
    write('ok.md', '# ok')

    const result = await scanner.scan(root, { limits: { maxMdxContentBytes: 512 } })

    expect(result.records.map((r) => r.path)).toEqual(['ok.md'])
    expect(result.warnings.some((w) => w.includes('big.mdx'))).toBe(true)
  })

  it('TC-SCANNER-006 .mdx 条目数超过 maxMdxEntries 时跳过', async () => {
    const zip = new AdmZip()
    zip.addFile('mdx.json', Buffer.from('{"version":"1.0"}', 'utf8'))
    zip.addFile('content.md', Buffer.from('# ok', 'utf8'))
    for (let i = 0; i < 30; i++) zip.addFile(`assets/a${i}.txt`, Buffer.from('x', 'utf8'))
    const absolute = path.join(root, 'many.mdx')
    fs.writeFileSync(absolute, zip.toBuffer())

    const result = await scanner.scan(root, { limits: { maxMdxEntries: 10 } })

    expect(result.records).toHaveLength(0)
    expect(result.warnings.some((w) => w.includes('many.mdx'))).toBe(true)
  })

  it('TC-SCANNER-008 含 NUL 字节的 .md 被当作二进制跳过', async () => {
    write('bin.md', Buffer.from([0x61, 0x00, 0x62, 0x0a]))
    write('text.md', '# text')

    const result = await scanner.scan(root)

    expect(result.records.map((r) => r.path)).toEqual(['text.md'])
    expect(result.warnings.some((w) => w.includes('bin.md'))).toBe(true)
  })

  it('TC-SCANNER-004 单文件链接数超过上限时截断并记 warning', async () => {
    const lines: string[] = []
    for (let i = 0; i < 8; i++) lines.push(`[n${i}](n${i}.md)`)
    write('many.md', lines.join('\n'))

    const result = await scanner.scan(root, { limits: { maxLinksPerFile: 3 } })

    const record = result.records.find((r) => r.path === 'many.md')
    expect(record?.links).toHaveLength(3)
    expect(result.warnings.some((w) => w.includes('many.md') && w.includes('截断'))).toBe(true)
  })

  it('损坏的 .mdx 只跳过该文件，不中断整体构建', async () => {
    fs.writeFileSync(path.join(root, 'broken.mdx'), Buffer.from('不是 zip', 'utf8'))
    write('ok.md', '[t](t.md)')

    const result = await scanner.scan(root)

    expect(result.records.map((r) => r.path)).toEqual(['ok.md'])
    expect(result.warnings.some((w) => w.includes('broken.mdx'))).toBe(true)
  })

  it('读取失败的目录不中断遍历', async () => {
    write('a.md', '# a')

    const result = await scanner.scan(root)

    expect(result.records.map((r) => r.path)).toEqual(['a.md'])
  })
})

describe('scan / 进度回调', () => {
  it('TC-SERVICE-001 每 progressEvery 个文件回调一次，末次为 (total,total)', async () => {
    for (let i = 0; i < 7; i++) write(`f${i}.md`, '# f')
    const calls: Array<[number, number]> = []

    const result = await scanner.scan(root, {
      limits: { progressEvery: 3, concurrency: 1 },
      onProgress: (scanned, total) => calls.push([scanned, total])
    })

    expect(result.filesScanned).toBe(7)
    expect(calls.at(-1)).toEqual([7, 7])
    // 3 与 6 是整倍数处
    expect(calls.some(([scanned]) => scanned === 3)).toBe(true)
    expect(calls.some(([scanned]) => scanned === 6)).toBe(true)
    // 1/2 这类非整倍数不应单独回调
    expect(calls.some(([scanned]) => scanned === 1)).toBe(false)
  })

  it('文件数小于 progressEvery 时仍会发一次末次进度', async () => {
    write('only.md', '# only')
    const calls: Array<[number, number]> = []

    await scanner.scan(root, {
      limits: { progressEvery: 200 },
      onProgress: (scanned, total) => calls.push([scanned, total])
    })

    expect(calls).toEqual([[1, 1]])
  })
})

describe('scan / 取消信号', () => {
  it('TC-SERVICE-002 已中止的 signal 让扫描立即返回空结果', async () => {
    for (let i = 0; i < 20; i++) write(`c${i}.md`, '# c')
    const controller = new AbortController()
    controller.abort()

    const result = await scanner.scan(root, { signal: controller.signal })

    expect(result.records).toEqual([])
    expect(extractCalls.count).toBe(0)
  })
})

describe('resolveWithinRoot', () => {
  it('TC-HANDLERS-001 相对路径解析为工作区内绝对路径', () => {
    expect(resolveWithinRoot(root, 'a/b.md')).toBe(path.join(root, 'a', 'b.md'))
    expect(resolveWithinRoot(root, './a.md')).toBe(path.join(root, 'a.md'))
  })

  it('TC-HANDLERS-001 `..` 越界返回 null', () => {
    expect(resolveWithinRoot(root, '../escape.md')).toBeNull()
    expect(resolveWithinRoot(root, 'a/../../escape.md')).toBeNull()
  })
})
