import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  SourceAccessError,
  SourceAccessService,
  type SourceAccessDeps,
  type SourceAccessOptions,
  type SourceFileSystem
} from '../source-access-service'
import { validatePublicHttpsUrl } from '../url-policy'

const FIXTURES_DIR = path.join(__dirname, 'fixtures')
const SAMPLE_PDF = path.join(FIXTURES_DIR, 'sample.pdf')
const SAMPLE_MDX = path.join(FIXTURES_DIR, 'sample.mdx')
const signal = (): AbortSignal => new AbortController().signal

function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html', ...headers } })
}

function createService(deps: SourceAccessDeps = {}, options: SourceAccessOptions = {}) {
  return new SourceAccessService(deps, options)
}

describe('public URL policy', () => {
  it('allows public HTTPS and rejects unsafe URL/address forms', () => {
    expect(validatePublicHttpsUrl('https://example.com/article')).toBe(true)
    for (const url of ['http://example.com', 'file:///C:/secret', 'https://user:pass@example.com', 'https://127.0.0.1', 'https://[fd00::1]', 'https://[fec0::1]', 'https://2130706433']) {
      expect(validatePublicHttpsUrl(url)).toBe(false)
    }
  })
})

describe('SourceAccessService.readWebUrl', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  afterEach(() => {
    fetchSpy.mockReset()
  })

  it('returns visible content, original/final URLs and chunks', async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url)
      return u.endsWith('/start')
        ? htmlResponse('', 302, { location: '/final' })
        : htmlResponse('<title>Page</title><style>bad</style><script>bad2</script><noscript>bad3</noscript><p>visible text</p>')
    })
    const service = createService()
    const result = await service.readWebUrl('https://example.com/start', signal())
    expect(result).toMatchObject({ url: 'https://example.com/start', finalUrl: 'https://example.com/final', title: 'Page', truncated: false })
    expect(result.content).toContain('visible text')
    expect(result.content).not.toMatch(/bad|bad2|bad3/)
    expect(result.chunks.map((chunk) => chunk.content).join('')).toBe(result.content)
  })

  it('rejects redirects to unsafe URLs with credentials', async () => {
    fetchSpy.mockResolvedValue(htmlResponse('', 302, { location: 'https://user:pass@example.com/secret' }))
    const service = createService()
    await expect(service.readWebUrl('https://example.com', signal())).rejects.toMatchObject({ code: 'SOURCE_POLICY_BLOCKED' })
  })

  it('enforces streaming size and caller abort', async () => {
    fetchSpy.mockResolvedValue(htmlResponse('123456'))
    const service = createService({}, { maxUrlBytes: 5 })
    await expect(service.readWebUrl('https://example.com', signal())).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' })
    const controller = new AbortController()
    controller.abort()
    await expect(service.readWebUrl('https://example.com', controller.signal)).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
  })

  it('bounds by caller abort and the per-hop deadline', async () => {
    vi.useFakeTimers()
    // fetch 永不主动 resolve，但响应 abort signal
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const sig = init?.signal
        if (sig) {
          if (sig.aborted) reject(new DOMException('Aborted', 'AbortError'))
          else sig.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        }
      })
    })
    const service = createService({}, { fetchTimeoutMs: 20 })

    // 测试超时
    const timeoutRead = service.readWebUrl('https://example.com', signal())
    const timeoutAssertion = expect(timeoutRead).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
    await vi.advanceTimersByTimeAsync(20)
    await timeoutAssertion

    // 测试调用方 abort
    const controller = new AbortController()
    const abortedRead = service.readWebUrl('https://example.com', controller.signal)
    const abortAssertion = expect(abortedRead).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
    controller.abort()
    await abortAssertion
    vi.useRealTimers()
  })

  it('cancels redirect bodies before following and rejects non-HTML response metadata', async () => {
    let cancelled = false
    const redirectBody = new ReadableStream({ cancel: () => { cancelled = true } })
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url)
      return u.endsWith('/start')
        ? new Response(redirectBody, { status: 302, headers: { location: '/final', 'content-type': 'text/html' } })
        : htmlResponse('<p>ok</p>')
    })
    const service = createService()
    await expect(service.readWebUrl('https://example.com/start', signal())).resolves.toMatchObject({ content: 'ok' })
    expect(cancelled).toBe(true)

    for (const response of [
      new Response('<p>missing</p>'),
      new Response('plain', { headers: { 'content-type': 'text/plain' } }),
      new Response(Buffer.from([0, 1, 2]), { headers: { 'content-type': 'application/octet-stream' } })
    ]) {
      fetchSpy.mockResolvedValue(response)
      await expect(service.readWebUrl('https://example.com', signal())).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
    }

    // fetch 自动解压 gzip，content-encoding 头不再被拒绝
    fetchSpy.mockResolvedValue(new Response('<p>encoded</p>', { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } }))
    await expect(service.readWebUrl('https://example.com', signal())).resolves.toMatchObject({ content: 'encoded' })
  })

  it('cancels a blocked response stream promptly when the caller aborts', async () => {
    let cancelled = false
    const body = new ReadableStream({
      pull: async () => new Promise<void>(() => {}),
      cancel: () => { cancelled = true }
    })
    fetchSpy.mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/html' } }))
    const service = createService()
    const controller = new AbortController()
    const reading = service.readWebUrl('https://example.com', controller.signal)
    const assertion = expect(reading).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
    await vi.waitFor(() => expect(body.locked).toBe(true))
    controller.abort()
    await assertion
    expect(cancelled).toBe(true)
  })
})

describe('SourceAccessService local files', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-access-'))
    const zip = new AdmZip()
    zip.addFile('mdx.json', Buffer.from(JSON.stringify({ content_file: 'content.md' })))
    zip.addFile('content.md', Buffer.from('# MDX\n\nMDX material body'))
    zip.writeZip(SAMPLE_MDX)
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(SAMPLE_MDX, { force: true })
  })

  it('inspection is metadata-only', async () => {
    const stats = { size: 10, dev: 1, ino: 2, mode: 0, mtimeMs: 3, ctimeMs: 4, isDirectory: () => false, isSymbolicLink: () => false }
    const fileSystem = {
      lstat: vi.fn(async () => stats), stat: vi.fn(async () => stats), realpath: vi.fn(async (p: string) => path.resolve(p)),
      open: vi.fn(), readFile: vi.fn()
    } as unknown as SourceFileSystem
    const result = await createService({ fileSystem }).inspectLocalFile('C:\\Docs\\report.pdf')
    expect(result.fileType).toBe('pdf')
    expect(fileSystem.lstat).toHaveBeenCalled()
    expect(fileSystem.stat).toHaveBeenCalled()
    expect(fileSystem.realpath).toHaveBeenCalled()
    expect(fileSystem.open).not.toHaveBeenCalled()
    expect(fileSystem.readFile).not.toHaveBeenCalled()
    expect(result).toMatchObject({ resolvedPath: path.resolve('C:\\Docs\\report.pdf'), dev: 1, ino: 2, mode: 0, mtimeMs: 3, ctimeMs: 4 })
  })

  it('reads UTF-8 text, Markdown, MDX and PDF fixtures', async () => {
    const txt = path.join(tmpDir, 'note.txt'); fs.writeFileSync(txt, 'plain text')
    const md = path.join(tmpDir, 'note.md'); fs.writeFileSync(md, '# heading\n\nbody')
    const service = createService()
    await expect(service.readLocalFile(txt, signal())).resolves.toMatchObject({ fileType: 'text', content: 'plain text', truncated: false })
    await expect(service.readLocalFile(md, signal())).resolves.toMatchObject({ fileType: 'markdown', content: '# heading\n\nbody' })
    expect((await service.readLocalFile(SAMPLE_MDX, signal())).content).toContain('MDX material body')
    expect((await service.readLocalFile(SAMPLE_PDF, signal())).content).toContain('Inkase PDF material sample')
  })

  it.each(['folder', 'unsupported', 'symlink', 'realpath'])('fails closed for unsafe metadata: %s', async (kind) => {
    const target = path.join(tmpDir, kind === 'unsupported' ? `${kind}.exe` : `${kind}.md`)
    if (kind === 'folder') fs.mkdirSync(target); else fs.writeFileSync(target, 'body')
    if (kind === 'symlink') {
      const link = path.join(tmpDir, 'link.md'); fs.symlinkSync(target, link); await expect(createService().inspectLocalFile(link)).rejects.toMatchObject({ code: 'SOURCE_POLICY_BLOCKED' }); return
    }
    if (kind === 'realpath') {
      const real = path.join(tmpDir, 'other.md')
      const base = fs.promises
      const injected = { ...base, realpath: async () => real } as unknown as SourceFileSystem
      await expect(createService({ fileSystem: injected }).inspectLocalFile(target)).rejects.toMatchObject({ code: 'SOURCE_POLICY_BLOCKED' }); return
    }
    await expect(createService().inspectLocalFile(target)).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
  })

  it('rejects pre-open/post-open identity changes and reported reparse metadata', async () => {
    const target = path.join(tmpDir, 'race.md'); fs.writeFileSync(target, 'body')
    const realOpen = fs.promises.open.bind(fs.promises)
    const fileSystem = {
      ...fs.promises,
      lstat: async () => {
        const value = await fs.promises.lstat(target)
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
          isSymbolicLink: () => false,
          isReparsePoint: () => true
        })
      },
      open: async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await realOpen(...args)
        return Object.assign(handle, { stat: async () => ({ ...(await fs.promises.stat(target)), ino: 999999 }) })
      }
    } as unknown as SourceFileSystem
    await expect(createService({ fileSystem }).inspectLocalFile(target)).rejects.toMatchObject({ code: 'SOURCE_POLICY_BLOCKED' })

    const raceFs = { ...fs.promises, lstat: fs.promises.lstat.bind(fs.promises), open: fileSystem.open } as unknown as SourceFileSystem
    await expect(createService({ fileSystem: raceFs }).readLocalFile(target, signal())).rejects.toMatchObject({ code: 'SOURCE_POLICY_BLOCKED' })
  })

  it('rejects a same-size mutation after approval and after reading', async () => {
    const target = path.join(tmpDir, 'same-size.md')
    fs.writeFileSync(target, 'first')
    const service = createService()
    const approved = await service.inspectLocalFile(target)
    const changedTime = new Date(Date.now() + 5_000)
    fs.writeFileSync(target, 'other')
    fs.utimesSync(target, changedTime, changedTime)
    await expect(service.readLocalFile(target, signal(), approved)).rejects.toMatchObject({ code: 'SOURCE_POLICY_BLOCKED' })

    const realOpen = fs.promises.open.bind(fs.promises)
    let statCalls = 0
    const fileSystem = {
      ...fs.promises,
      open: async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await realOpen(...args)
        const originalStat = handle.stat.bind(handle)
        return Object.assign(handle, {
          stat: async () => {
            const stats = await originalStat()
            statCalls++
            return statCalls > 1 ? Object.assign(stats, { mtimeMs: stats.mtimeMs + 1 }) : stats
          }
        })
      }
    } as unknown as SourceFileSystem
    const inspected = await createService({ fileSystem }).inspectLocalFile(target)
    await expect(createService({ fileSystem }).readLocalFile(target, signal(), inspected)).rejects.toMatchObject({ code: 'SOURCE_POLICY_BLOCKED' })
  })

  it('reads at most max plus one byte in chunks and stops on abort', async () => {
    const stats = { size: 4, dev: 1, ino: 2, mode: 0, mtimeMs: 3, ctimeMs: 4, isDirectory: () => false, isSymbolicLink: () => false }
    const controller = new AbortController()
    const read = vi.fn(async (buffer: Buffer, offset: number) => {
      buffer[offset] = 65
      controller.abort()
      return { bytesRead: 1, buffer }
    })
    const handle = { stat: vi.fn(async () => stats), read, readFile: vi.fn(), close: vi.fn(async () => {}) }
    const fileSystem = {
      lstat: vi.fn(async () => stats), stat: vi.fn(async () => stats), realpath: vi.fn(async (p: string) => path.resolve(p)), open: vi.fn(async () => handle)
    } as unknown as SourceFileSystem
    await expect(createService({ fileSystem }, { maxFileBytes: 4 }).readLocalFile('note.md', controller.signal)).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
    expect(handle.readFile).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledOnce()
    expect(read.mock.calls[0]![0]).toHaveLength(5)
  })

  it('rejects oversize, misleading PDF, binary text and unsafe MDX entries/limits', async () => {
    const huge = path.join(tmpDir, 'huge.md'); fs.writeFileSync(huge, '123456')
    await expect(createService({}, { maxFileBytes: 5 }).inspectLocalFile(huge)).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' })
    const fakePdf = path.join(tmpDir, 'fake.pdf'); fs.writeFileSync(fakePdf, 'not pdf')
    await expect(createService().readLocalFile(fakePdf, signal())).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
    const binary = path.join(tmpDir, 'binary.txt'); fs.writeFileSync(binary, Buffer.from([0, 0, 1, 2, 0, 3]))
    await expect(createService().readLocalFile(binary, signal())).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
    const unsafe = path.join(tmpDir, 'unsafe.mdx'); const zip = new AdmZip(); zip.addFile('../content.md', Buffer.from('x')); zip.addFile('mdx.json', Buffer.from('{"content_file":"../content.md"}')); zip.writeZip(unsafe)
    await expect(createService().readLocalFile(unsafe, signal())).rejects.toMatchObject({ code: 'SOURCE_POLICY_BLOCKED' })
    const alias = path.join(tmpDir, 'alias.mdx'); const aliasZip = new AdmZip(); aliasZip.addFile('mdx.json', Buffer.from('{"content_file":"content.md"}')); aliasZip.addFile('content.md', Buffer.from('safe')); aliasZip.addFile('xontent.md', Buffer.from('ambiguous')); const aliasBytes = aliasZip.toBuffer(); for (let offset = 0; offset <= aliasBytes.length - 10; offset++) { if (aliasBytes.subarray(offset, offset + 10).equals(Buffer.from('xontent.md'))) Buffer.from('content.md').copy(aliasBytes, offset) } fs.writeFileSync(alias, aliasBytes)
    await expect(createService().readLocalFile(alias, signal())).rejects.toMatchObject({ code: 'SOURCE_POLICY_BLOCKED' })
    await expect(createService({}, { maxPdfPages: 0 }).readLocalFile(SAMPLE_PDF, signal())).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' })
  })

  it('enforces extracted text limit and returns bounded immutable chunks', async () => {
    const file = path.join(tmpDir, 'long.md'); fs.writeFileSync(file, 'A'.repeat(250))
    await expect(createService({}, { maxExtractedChars: 100 }).readLocalFile(file, signal())).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' })
    const result = await createService({}, { targetChunkSize: 100 }).readLocalFile(file, signal())
    expect(result.chunks.map((chunk) => chunk.content).join('')).toBe(result.content)
    expect(result.chunks.every((chunk) => Object.isFrozen(chunk) && chunk.content.length <= 100)).toBe(true)
    expect(Object.isFrozen(result.chunks)).toBe(true)
  })

  it('exposes coded errors', () => {
    expect(new SourceAccessError('SOURCE_INVALID', 'OCR')).toMatchObject({ code: 'SOURCE_INVALID' })
  })
})
