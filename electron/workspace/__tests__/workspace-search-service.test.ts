import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
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
