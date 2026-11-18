import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import { writeArchive } from '../../mindmap/inkmind-archive'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import {
  WorkspaceSearchService,
  DEFAULT_SEARCH_LIMITS,
  WorkspaceSearchError
} from '../workspace-search-service'
import type { ChildProcess } from 'node:child_process'

/**
 * 构造一个假 rg 子进程：由注入的 output 决定 stdout 内容。
 */
function fakeChildProcess(output: string | (() => string)): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  const stdout = new EventEmitter() as unknown as NodeJS.ReadableStream
  const stderr = new EventEmitter() as unknown as NodeJS.ReadableStream
  ;(child as unknown as { stdout: unknown }).stdout = stdout
  ;(child as unknown as { stderr: unknown }).stderr = stderr
  ;(child as unknown as { exitCode: number | null }).exitCode = null
  ;(child as unknown as { killed: boolean }).killed = false
  ;(child as unknown as { kill: () => void }).kill = () => {
    ;(child as unknown as { killed: boolean }).killed = true
  }

  setTimeout(() => {
    const data = typeof output === 'function' ? output() : output
    stdout.emit('data', Buffer.from(data, 'utf8'))
    stderr.emit('data', Buffer.from('', 'utf8'))
    ;(child as unknown as { exitCode: number | null }).exitCode = 0
    child.emit('close', 0)
  }, 0)
  return child
}

interface ServiceFactory {
  service: WorkspaceSearchService
  spawnSpy: ReturnType<typeof vi.fn>
}

function makeService(output: string | ((args: string[]) => string)): ServiceFactory {
  const spawnSpy = vi.fn((_cmd: string, args: string[]) => {
    const data = typeof output === 'function' ? output(args) : output
    return fakeChildProcess(data)
  })
  const service = new WorkspaceSearchService({
    rgPath: 'fake-rg',
    spawn: spawnSpy as unknown as typeof import('node:child_process').spawn,
    realpathSync: fs.realpathSync,
    limits: DEFAULT_SEARCH_LIMITS
  })
  return { service, spawnSpy }
}

function makeServiceWithLimits(limits: Partial<typeof DEFAULT_SEARCH_LIMITS>): WorkspaceSearchService {
  return new WorkspaceSearchService({
    rgPath: 'fake-rg',
    spawn: vi.fn() as unknown as typeof import('node:child_process').spawn,
    realpathSync: fs.realpathSync,
    limits: { ...DEFAULT_SEARCH_LIMITS, ...limits }
  })
}

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-search-'))
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.inkase'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'notes.md'), '# Notes\n\nrelease 内容', 'utf8')
  fs.writeFileSync(path.join(dir, 'docs', 'report.md'), '# Report\n\nroadmap', 'utf8')
  fs.writeFileSync(path.join(dir, 'README.md'), '# README\n\nrelease', 'utf8')
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg.js'), 'node_modules', 'utf8')
  fs.writeFileSync(path.join(dir, '.inkase', 'hidden.md'), 'hidden', 'utf8')
  return dir
}

function makeMdxFile(filePath: string, content: string): void {
  const zip = new AdmZip()
  zip.addFile('mdx.json', Buffer.from(JSON.stringify({ version: '1.0', content_file: 'content.md' }), 'utf8'))
  zip.addFile('content.md', Buffer.from(content, 'utf8'))
  zip.writeZip(filePath)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('WorkspaceSearchService', () => {
  describe('resolveScope', () => {
    it('rejects absolute scopes', () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')
      expect(() => service.resolveScope(root, 'C:\\docs')).toThrow(WorkspaceSearchError)
    })

    it('rejects scopes that escape the root', () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')
      expect(() => service.resolveScope(root, '..')).toThrow(WorkspaceSearchError)
    })

    it('resolves a relative scope within the root', () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')
      const { absolute, relPrefix } = service.resolveScope(root, 'docs')
      expect(path.resolve(absolute)).toBe(path.resolve(root, 'docs'))
      expect(relPrefix).toBe('docs')
    })
  })

  describe('filename search', () => {
    it('lists files and filters by query and extension in-process', async () => {
      const root = makeTempWorkspace()
      const { service, spawnSpy } = makeService(
        'docs/notes.md\0docs/report.md\0node_modules/pkg.js\0.git/config\0'
      )
      const result = await service.search(
        { query: 'report', mode: 'filename', extensions: ['md'] },
        root,
        new AbortController().signal
      )
      expect(spawnSpy).toHaveBeenCalledTimes(1)
      expect(spawnSpy.mock.calls[0][1]).toEqual([
        '--files', '--null', '--no-config',
        '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!.inkase/**'
      ])
      expect(result.matches).toEqual([
        { type: 'filename', path: 'docs/report.md', extension: 'md' }
      ])
      expect(result.truncated).toBe(false)
    })

    it('includes the scope prefix in returned relative paths', async () => {
      const root = makeTempWorkspace()
      const { service } = makeService('report.md\0notes.md\0')
      const result = await service.search(
        { query: 'report', mode: 'filename', scope: 'docs' },
        root,
        new AbortController().signal
      )
      expect(result.matches).toEqual([
        { type: 'filename', path: 'docs/report.md', extension: 'md' }
      ])
    })

    it('rejects an empty query', async () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')
      await expect(
        service.search({ query: '  ', mode: 'filename' }, root, new AbortController().signal)
      ).rejects.toThrow(WorkspaceSearchError)
    })

    it('rejects an invalid regex', async () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')
      await expect(
        service.search({ query: '(', mode: 'filename', match: 'regex' }, root, new AbortController().signal)
      ).rejects.toThrow('正则表达式无效')
    })
  })

  describe('content search', () => {
    it('passes rg args and parses JSON matches into content results', async () => {
      const root = makeTempWorkspace()
      const json =
        '{"type":"match","data":{"path":{"text":"docs/notes.md"},"lines":{"text":"## release 内容"},"line_number":2,"submatches":[{"start":3,"text":"release"}]}}\n' +
        '{"type":"end"}\n'
      const { service, spawnSpy } = makeService(json)
      const result = await service.search(
        { query: 'release', mode: 'content', contextLines: 0 },
        root,
        new AbortController().signal
      )
      expect(spawnSpy).toHaveBeenCalled()
      const args = spawnSpy.mock.calls[0][1] as string[]
      expect(args).toContain('--json')
      expect(args).toContain('--fixed-strings')
      expect(args).toContain('--glob')
      expect(args).toContain('!*.mdx')
      expect(result.matches).toContainEqual(
        expect.objectContaining({
          type: 'content',
          source: 'text',
          path: 'docs/notes.md',
          line: 2,
          column: 4
        })
      )
    })

    it('sets truncated when rg was killed by output limit', async () => {
      const root = makeTempWorkspace()
      const json = '{"type":"match","data":{"path":{"text":"a.md"},"lines":{"text":"x"},"line_number":1,"submatches":[{"start":0,"text":"x"}]}}\n'
      const limits = { ...DEFAULT_SEARCH_LIMITS, maxOutputBytes: 1 }
      const serviceLimited = new WorkspaceSearchService({
        rgPath: 'fake-rg',
        spawn: vi.fn(() => fakeChildProcess(json)) as unknown as typeof import('node:child_process').spawn,
        realpathSync: fs.realpathSync,
        limits
      })
      const result = await serviceLimited.search(
        { query: 'x', mode: 'content' },
        root,
        new AbortController().signal
      )
      expect(result.truncated).toBe(true)
    })
  })

  describe('MDX content search', () => {
    it('searches content.md inside mdx files and merges with text matches', async () => {
      const root = makeTempWorkspace()
      makeMdxFile(path.join(root, 'docs', 'notes.mdx'), '# Notes\n\nrelease 内容 inside mdx')
      // 第一次 spawn 是文本正文搜索（--json），第二次 spawn 是枚举 mdx 清单
      const { service, spawnSpy } = makeService((args) => {
        if (args.includes('--json')) return '{"type":"end"}\n'
        if (args.includes('--files') && args.includes('*.mdx')) return 'docs/notes.mdx\0'
        return ''
      })
      const result = await service.search(
        { query: 'inside mdx', mode: 'content' },
        root,
        new AbortController().signal
      )
      const mdxEnumCall = spawnSpy.mock.calls.find((c) => (c[1] as string[]).includes('*.mdx'))
      expect(mdxEnumCall).toBeDefined()
      expect((mdxEnumCall![1] as string[]).slice(0, 3)).toEqual(['--files', '--null', '--no-config'])
      expect(result.matches).toContainEqual(
        expect.objectContaining({ source: 'mdx', path: 'docs/notes.mdx', line: 3 })
      )
    })

    it('skips malformed mdx files and reports a warning without failing the search', async () => {
      const root = makeTempWorkspace()
      fs.writeFileSync(path.join(root, 'docs', 'broken.mdx'), 'not a zip at all', 'utf8')
      const { service } = makeService('docs/broken.mdx\0')
      const result = await service.search(
        { query: 'x', mode: 'content' },
        root,
        new AbortController().signal
      )
      expect(result.matches).toEqual([])
      expect(result.warnings?.some((w) => w.includes('broken.mdx'))).toBe(true)
    })
  })

  describe('readDirectory', () => {
    it('lists direct children and excludes hidden and fixed directories', async () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')
      const result = await service.readDirectory(root, '.', new AbortController().signal)
      const names = result.files.map((f) => f.name)
      expect(names).toContain('docs')
      expect(names).toContain('README.md')
      expect(names).not.toContain('node_modules')
      expect(names).not.toContain('.inkase')
      expect(names).not.toContain('.git')
    })
  })

  describe('readFile', () => {
    it('reads a text file within the workspace', async () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')
      const content = await service.readFile(root, 'docs/notes.md', new AbortController().signal)
      expect(content).toContain('release 内容')
    })

    it('extracts content.md from mdx', async () => {
      const root = makeTempWorkspace()
      makeMdxFile(path.join(root, 'docs', 'doc.mdx'), '# Hello from mdx')
      const { service } = makeService('')
      const content = await service.readFile(root, 'docs/doc.mdx', new AbortController().signal)
      expect(content).toContain('Hello from mdx')
    })

    it('turns a mind map container into a readable outline instead of raw JSON', async () => {
      const root = makeTempWorkspace()
      // 思维导图现在是 ZIP 容器，得先打包再读
      writeArchive(
        path.join(root, 'docs', 'plan.inkmind'),
        JSON.stringify({
          schema: 'inkase.mindmap',
          version: 1,
          root: {
            id: 'r',
            text: '项目规划',
            note: '下周一确认预算',
            children: [{ id: 'c1', text: '上线时间', children: [] }]
          }
        })
      )
      const { service } = makeService('')
      const content = await service.readFile(root, 'docs/plan.inkmind', new AbortController().signal)

      expect(content).toBe(['项目规划（备注：下周一确认预算）', '  上线时间'].join('\n'))
      // 大纲里不该再出现 JSON 结构符号，模型读到的就是层级文本
      expect(content).not.toContain('"schema"')
    })

    it('rejects a mind map without readable topics', async () => {
      const root = makeTempWorkspace()
      writeArchive(path.join(root, 'docs', 'broken.inkmind'), '{ broken')
      const { service } = makeService('')

      await expect(
        service.readFile(root, 'docs/broken.inkmind', new AbortController().signal)
      ).rejects.toThrow(WorkspaceSearchError)
    })

    it('rejects a mind map that is not a container', async () => {
      const root = makeTempWorkspace()
      fs.writeFileSync(path.join(root, 'docs', 'plain.inkmind'), '{"schema":"inkase.mindmap"}', 'utf8')
      const { service } = makeService('')

      await expect(
        service.readFile(root, 'docs/plain.inkmind', new AbortController().signal)
      ).rejects.toThrow(WorkspaceSearchError)
    })

    it('rejects absolute paths', async () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')
      await expect(
        service.readFile(root, path.join(root, 'docs', 'notes.md'), new AbortController().signal)
      ).rejects.toThrow(WorkspaceSearchError)
    })

    it('rejects paths that escape the workspace', async () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')
      await expect(
        service.readFile(root, '../../../etc/passwd', new AbortController().signal)
      ).rejects.toThrow(WorkspaceSearchError)
    })
  })

  describe('readFileSlice', () => {
    it('reads a byte range and reports eof/nextOffset', async () => {
      const root = makeTempWorkspace()
      fs.writeFileSync(path.join(root, 'docs', 'digits.txt'), '0123456789', 'utf8')
      const { service } = makeService('')

      const slice = await service.readFileSlice(
        root,
        'docs/digits.txt',
        { offset: 2, length: 3 },
        new AbortController().signal
      )

      expect(slice).toMatchObject({
        path: 'docs/digits.txt',
        format: 'text',
        fileSize: 10,
        totalSize: 10,
        offset: 2,
        length: 3,
        content: '234',
        eof: false,
        truncated: true,
        nextOffset: 5,
        encoding: 'utf-8'
      })
    })

    it('reads to the end by default', async () => {
      const root = makeTempWorkspace()
      fs.writeFileSync(path.join(root, 'docs', 'digits.txt'), '0123456789', 'utf8')
      const { service } = makeService('')

      const slice = await service.readFileSlice(
        root,
        'docs/digits.txt',
        {},
        new AbortController().signal
      )

      expect(slice.content).toBe('0123456789')
      expect(slice).toMatchObject({ eof: true, truncated: false, nextOffset: null, offset: 0 })
    })

    it('caps a single read at maxReadBytes and exposes nextOffset', async () => {
      const root = makeTempWorkspace()
      fs.writeFileSync(path.join(root, 'docs', 'digits.txt'), '0123456789', 'utf8')
      const service = makeServiceWithLimits({ maxReadBytes: 4 })

      const slice = await service.readFileSlice(
        root,
        'docs/digits.txt',
        {},
        new AbortController().signal
      )

      expect(slice).toMatchObject({
        content: '0123',
        length: 4,
        eof: false,
        truncated: true,
        nextOffset: 4
      })
    })

    it('aligns an offset that lands inside a multi-byte character', async () => {
      const root = makeTempWorkspace()
      // 你(0-2) 好(3-5) 世(6-8) 界(9-11)
      fs.writeFileSync(path.join(root, 'docs', 'zh.txt'), '你好世界', 'utf8')
      const { service } = makeService('')

      const slice = await service.readFileSlice(
        root,
        'docs/zh.txt',
        { offset: 1, length: 8 },
        new AbortController().signal
      )

      expect(slice).toMatchObject({
        offset: 3,
        length: 6,
        content: '好世',
        nextOffset: 9
      })
    })

    it('honours a per-call read limit and clamps it to the allowed range', async () => {
      const root = makeTempWorkspace()
      fs.writeFileSync(path.join(root, 'docs', 'digits.txt'), '0123456789', 'utf8')
      const { service } = makeService('')

      const sliced = await service.readFileSlice(
        root,
        'docs/digits.txt',
        { maxBytes: 4 * 1024 },
        new AbortController().signal
      )
      // 4 KiB 已大于文件，仍是一次读完
      expect(sliced.eof).toBe(true)

      // 小于下限的值被抬到 4 KiB，不会读到 0 字节
      const tiny = await service.readFileSlice(
        root,
        'docs/digits.txt',
        { maxBytes: 1 },
        new AbortController().signal
      )
      expect(tiny.content).toBe('0123456789')
      expect(tiny.eof).toBe(true)
    })

    it('slices the extracted text of an mdx container', async () => {
      const root = makeTempWorkspace()
      makeMdxFile(path.join(root, 'docs', 'doc.mdx'), 'Hello from mdx')
      const { service } = makeService('')

      const slice = await service.readFileSlice(
        root,
        'docs/doc.mdx',
        { offset: 0, length: 5 },
        new AbortController().signal
      )

      expect(slice).toMatchObject({
        format: 'mdx',
        content: 'Hello',
        totalSize: 'Hello from mdx'.length,
        eof: false,
        nextOffset: 5
      })
      // 磁盘上是压缩包，正文长度按解包后计算
      expect(slice.fileSize).toBeGreaterThan(slice.totalSize)
    })

    it('rejects invalid ranges and escaping paths', async () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')
      const signal = new AbortController().signal

      await expect(service.readFileSlice(root, 'docs/notes.md', { offset: -1 }, signal)).rejects.toThrow(
        WorkspaceSearchError
      )
      await expect(service.readFileSlice(root, 'docs/notes.md', { length: 0 }, signal)).rejects.toThrow(
        WorkspaceSearchError
      )
      await expect(
        service.readFileSlice(root, '../../../etc/passwd', {}, signal)
      ).rejects.toThrow(WorkspaceSearchError)
    })
  })

  describe('statFile', () => {
    it('reports size and readability for a text file', async () => {
      const root = makeTempWorkspace()
      fs.writeFileSync(path.join(root, 'docs', 'digits.txt'), '0123456789', 'utf8')
      const { service } = makeService('')

      const stat = await service.statFile(root, 'docs/digits.txt', new AbortController().signal)

      expect(stat).toMatchObject({
        path: 'docs/digits.txt',
        format: 'text',
        fileSize: 10,
        totalSize: 10,
        readable: true
      })
    })

    it('reports the extracted text size for an mdx container', async () => {
      const root = makeTempWorkspace()
      makeMdxFile(path.join(root, 'docs', 'doc.mdx'), '# Hello from mdx')
      const { service } = makeService('')

      const stat = await service.statFile(root, 'docs/doc.mdx', new AbortController().signal)

      expect(stat).toMatchObject({ format: 'mdx', totalSize: '# Hello from mdx'.length, readable: true })
      expect(stat.fileSize).toBeGreaterThan(stat.totalSize)
    })

    it('marks a binary file as unreadable instead of throwing', async () => {
      const root = makeTempWorkspace()
      fs.writeFileSync(
        path.join(root, 'docs', 'pic.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x01])
      )
      const { service } = makeService('')

      const stat = await service.statFile(root, 'docs/pic.png', new AbortController().signal)

      expect(stat.readable).toBe(false)
      expect(stat.totalSize).toBe(0)
      expect(stat.reason).toBeTruthy()
    })

    it('rejects a path outside the workspace', async () => {
      const root = makeTempWorkspace()
      const { service } = makeService('')

      await expect(
        service.statFile(root, '../../../etc/passwd', new AbortController().signal)
      ).rejects.toThrow(WorkspaceSearchError)
    })
  })

  describe('real bundled rg integration', () => {
    // 仓库内置的 rg 二进制（仅 Windows 开发环境已放置）
    const bundledRg = path.join(process.cwd(), 'resources', 'rg', 'win32-x64', 'rg.exe')

    function realService(): WorkspaceSearchService | null {
      if (!fs.existsSync(bundledRg)) return null
      return new WorkspaceSearchService({
        rgPath: bundledRg,
        spawn,
        realpathSync: fs.realpathSync,
        limits: DEFAULT_SEARCH_LIMITS
      })
    }

    it('searches real files with the bundled rg (skipped when binary absent)', async () => {
      const service = realService()
      if (!service) return
      const root = makeTempWorkspace()
      const result = await service.search(
        { query: 'notes', mode: 'filename' },
        root,
        new AbortController().signal
      )
      const names = result.matches.map((m) => m.path)
      expect(names).toContain('docs/notes.md')
      expect(names).not.toContain('node_modules/pkg.js')
    })

    it('searches file content with the bundled rg (skipped when binary absent)', async () => {
      const service = realService()
      if (!service) return
      const root = makeTempWorkspace()
      const result = await service.search(
        { query: 'roadmap', mode: 'content' },
        root,
        new AbortController().signal
      )
      expect(result.matches).toContainEqual(
        expect.objectContaining({ source: 'text', path: 'docs/report.md' })
      )
    })

    it('reads a real mdx file with the bundled rg (skipped when binary absent)', async () => {
      const service = realService()
      if (!service) return
      const root = makeTempWorkspace()
      makeMdxFile(path.join(root, 'docs', 'doc.mdx'), '# Hello from bundled mdx')
      const content = await service.readFile(root, 'docs/doc.mdx', new AbortController().signal)
      expect(content).toContain('Hello from bundled mdx')
    })
  })
})
