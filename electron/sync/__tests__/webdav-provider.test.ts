import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import {
  WebdavConflictError,
  WebdavSyncProvider,
  createWebdavClient,
  quotedEtag,
  toRemotePath,
  type WebdavClient
} from '../webdav-provider'
import type { SyncConfig } from '../types'

/**
 * I2 测试用的 fs 故障注入：默认完全委托真实 fs，仅在 `failState` 被设置时对
 * 指定后缀的路径抛错（模拟 EACCES 等本地扫描失败）。
 */
const failState = vi.hoisted(() => ({ readdirSuffix: null as string | null, readSuffix: null as string | null }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readdirSync: vi.fn((dir: fs.PathLike, opts?: unknown) => {
      if (failState.readdirSuffix && String(dir).endsWith(failState.readdirSuffix)) {
        throw new Error('EACCES: permission denied')
      }
      return (actual.readdirSync as (d: fs.PathLike, o?: unknown) => unknown)(dir, opts)
    }),
    readFileSync: vi.fn((file: fs.PathLike, opts?: unknown) => {
      if (failState.readSuffix && String(file).endsWith(failState.readSuffix)) {
        throw new Error('EACCES: permission denied')
      }
      return (actual.readFileSync as (f: fs.PathLike, o?: unknown) => unknown)(file, opts)
    })
  }
})

const dirsToClean: string[] = []

/** 建立临时工作区，按「相对路径 → 内容」写入文件 */
function makeWorkspace(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-webdav-'))
  dirsToClean.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
  }
  return dir
}

/** 测试用 WebDAV 配置：不设 remoteRoot，fake client 以相对路径为 key */
function webdavConfig(): SyncConfig {
  return {
    version: 1,
    provider: 'webdav',
    autoCommit: false,
    autoPull: true,
    autoPush: true,
    url: 'https://dav.example.com/dav',
    username: 'me'
  }
}

function makeFakeClient(initial: Record<string, string> = {}): WebdavClient & { files: Map<string, { data: Buffer; etag: string | null }> } {
  const files = new Map(Object.entries(initial).map(([k, v]): [string, { data: Buffer; etag: string | null }] => [k, { data: Buffer.from(v), etag: `"${k}"` }]))
  return {
    files,
    ensureDir: vi.fn(async () => {}),
    list: vi.fn(async () => [...files.entries()].map(([p, f]) => ({ path: p, etag: f.etag, size: f.data.length, mtime: 0 }))),
    readFile: vi.fn(async (p: string) => { const f = files.get(p); if (!f) throw new Error(`404 ${p}`); return f.data }),
    writeFile: vi.fn(async (p: string, data: Buffer, etag: string | null) => {
      const cur = files.get(p) ?? null
      if (etag !== null && (cur?.etag ?? null) !== etag) throw new WebdavConflictError(p)
      const next = `"${p}-${data.length}"`
      files.set(p, { data, etag: next }); return next
    }),
    delete: vi.fn(async (p: string) => { files.delete(p) })
  }
}

afterEach(() => {
  while (dirsToClean.length > 0) fs.rmSync(dirsToClean.pop()!, { recursive: true, force: true })
})

describe('WebdavSyncProvider', () => {
  it('reports upToDate when local and remote match the recorded state', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    // 首次：状态为 pendingPush（清单为空），push 后应 upToDate
    await provider.push()
    expect(await provider.status()).toBe('upToDate')
  })

  it('reports conflict when both sides changed after a sync', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    fs.writeFileSync(path.join(ws, 'a.mdx'), 'LOCAL')
    client.files.set('a.mdx', { data: Buffer.from('REMOTE'), etag: '"r"' })
    expect(await provider.status()).toBe('conflict')
    expect(await provider.conflictedFiles()).toEqual([path.join(ws, 'a.mdx')])
  })

  it('push deletes the remote file when it was deleted locally', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A', 'b.mdx': 'B' })
    const client = makeFakeClient({ 'a.mdx': 'A', 'b.mdx': 'B' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    fs.rmSync(path.join(ws, 'b.mdx'))
    const res = await provider.push()
    expect(res.success).toBe(true)
    expect(client.files.has('b.mdx')).toBe(false)
  })

  it('pull deletes the local file when it was deleted remotely', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A', 'b.mdx': 'B' })
    const client = makeFakeClient({ 'a.mdx': 'A', 'b.mdx': 'B' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    client.files.delete('b.mdx')
    const res = await provider.pull()
    expect(res.success).toBe(true)
    expect(fs.existsSync(path.join(ws, 'b.mdx'))).toBe(false)
  })

  it('push does not touch conflicting files', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    fs.writeFileSync(path.join(ws, 'a.mdx'), 'LOCAL')
    client.files.set('a.mdx', { data: Buffer.from('REMOTE'), etag: '"r"' })
    await provider.push()
    expect(client.files.get('a.mdx')!.data.toString()).toBe('REMOTE')
  })

  it('aborts instead of deleting everything when the remote lists empty', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    client.files.clear()
    const res = await provider.pull()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/中止/)
    expect(fs.existsSync(path.join(ws, 'a.mdx'))).toBe(true)
  })

  // I2（数据安全）：本地扫描失败绝不能等同「本地已删」，否则 push() 会据 deleteRemote 删掉远端文件（§5.4 护栏）
  it('push aborts instead of deleting the remote when a local directory scan fails', async () => {
    const ws = makeWorkspace({ 'keep/a.mdx': 'A', 'locked/b.mdx': 'B' })
    const client = makeFakeClient({ 'keep/a.mdx': 'A', 'locked/b.mdx': 'B' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    failState.readdirSuffix = `${path.sep}locked`
    try {
      const res = await provider.push()
      expect(res.success).toBe(false)
    } finally {
      failState.readdirSuffix = null
    }
    expect(client.files.has('locked/b.mdx')).toBe(true)
    expect(client.files.has('keep/a.mdx')).toBe(true)
  })

  // I2（数据安全）：普通文件读失败（EACCES/锁文件/超长路径）同样不得当作「本地已删」
  it('push aborts instead of deleting the remote when a local file cannot be read', async () => {
    const ws = makeWorkspace({ 'keep/a.mdx': 'A', 'locked/b.mdx': 'B' })
    const client = makeFakeClient({ 'keep/a.mdx': 'A', 'locked/b.mdx': 'B' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    failState.readSuffix = `${path.sep}b.mdx`
    try {
      const res = await provider.push()
      expect(res.success).toBe(false)
    } finally {
      failState.readSuffix = null
    }
    expect(client.files.has('locked/b.mdx')).toBe(true)
  })

  it('keeps going when one file fails and reports an error', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A', 'b.mdx': 'B' })
    const client = makeFakeClient({})
    client.writeFile = vi.fn(async () => { throw new Error('EACCES') })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    const res = await provider.push()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/EACCES/)
  })

  // 简报 Interfaces 要求「读/写/删抛错」均收集为错误信息；读发生在 pull() 的 download 分支
  it('keeps going when one download fails and reports an error', async () => {
    const ws = makeWorkspace({})
    const client = makeFakeClient({ 'a.mdx': 'A', 'b.mdx': 'B' })
    client.readFile = vi.fn(async () => { throw new Error('EACCES') })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    const res = await provider.pull()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/EACCES/)
  })

  it('treats same-name same-content files as unchanged on first bind', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    expect(await provider.status()).toBe('upToDate')
  })

  it('reports a conflict on first bind when the same name differs, and never overwrites the remote', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'LOCAL' })
    const client = makeFakeClient({ 'a.mdx': 'REMOTE' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    expect(await provider.status()).toBe('conflict')
    expect(await provider.conflictedFiles()).toEqual([path.join(ws, 'a.mdx')])
    await provider.push()
    expect(client.files.get('a.mdx')!.data.toString()).toBe('REMOTE')
    expect(fs.readFileSync(path.join(ws, 'a.mdx'), 'utf8')).toBe('LOCAL')
  })

  // status() 命中首绑对齐项时必须落盘，否则后续本地改动会因 base 仍缺失而误报 conflict
  it('persists the first-bind alignment on status() so a later local edit is pendingPush', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    expect(await provider.status()).toBe('upToDate')
    fs.writeFileSync(path.join(ws, 'a.mdx'), 'LOCAL')
    expect(await provider.status()).toBe('pendingPush')
  })

  // 对齐项落盘后，重复 status() 不应再次下载远端内容
  it('does not re-download aligned files on a second status() call', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.status()
    const callsAfterFirst = vi.mocked(client.readFile).mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)
    await provider.status()
    expect(vi.mocked(client.readFile).mock.calls.length).toBe(callsAfterFirst)
  })

  // 冲突项不得写入基准：重复 status() 仍应为 conflict（若误写基准会变成 pendingPush）
  it('does not persist a base for conflicting first-bind files', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'LOCAL' })
    const client = makeFakeClient({ 'a.mdx': 'REMOTE' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    expect(await provider.status()).toBe('conflict')
    expect(await provider.status()).toBe('conflict')
  })

  it('resolveConflicts keeps the local side', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    fs.writeFileSync(path.join(ws, 'a.mdx'), 'LOCAL')
    client.files.set('a.mdx', { data: Buffer.from('REMOTE'), etag: '"r"' })
    const res = await provider.resolveConflicts([{ path: path.join(ws, 'a.mdx'), choice: 'local' }])
    expect(res.success).toBe(true)
    expect(client.files.get('a.mdx')!.data.toString()).toBe('LOCAL')
    expect(await provider.status()).toBe('upToDate')
  })

  it('resolveConflicts takes the remote side', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    fs.writeFileSync(path.join(ws, 'a.mdx'), 'LOCAL')
    client.files.set('a.mdx', { data: Buffer.from('REMOTE'), etag: '"r"' })
    await provider.resolveConflicts([{ path: path.join(ws, 'a.mdx'), choice: 'remote' }])
    expect(fs.readFileSync(path.join(ws, 'a.mdx'), 'utf-8')).toBe('REMOTE')
  })

  it('encodes spaces and non-ascii in remote paths', () => {
    expect(toRemotePath('/inkase', '我的 笔记/a#1.mdx')).toBe('/inkase/%E6%88%91%E7%9A%84%20%E7%AC%94%E8%AE%B0/a%231.mdx')
  })

  it('treats a null remote etag as unchanged rather than a conflict', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    client.list = vi.fn(async () => [{ path: 'a.mdx', etag: null, size: 1, mtime: 0 }])
    expect(await provider.status()).toBe('upToDate')
  })

  // resolveConflicts 与 pull() 一样必须具备「远端疑似被清空」护栏，否则会按镜像语义批量删本地文件
  it('resolveConflicts aborts instead of acting when the remote lists empty', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const client = makeFakeClient({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, webdavConfig(), client)
    await provider.push()
    client.files.clear()
    const res = await provider.resolveConflicts([{ path: path.join(ws, 'a.mdx'), choice: 'local' }])
    expect(res.success).toBe(false)
    expect(res.error).toBe('远端目录为空但本地记录非空，已中止以避免误删本地文件')
    expect(fs.existsSync(path.join(ws, 'a.mdx'))).toBe(true)
    expect(client.files.size).toBe(0)
  })
})

// 修复项 3②：webdav 的 prepareFileFromProps 会剥掉 ETag 引号，弱 ETag 必须被正确还原
describe('quotedEtag', () => {
  it('为不带引号的 ETag 补上引号', () => {
    expect(quotedEtag('abc')).toBe('"abc"')
  })

  it('已带引号的 ETag 原样保留', () => {
    expect(quotedEtag('"abc"')).toBe('"abc"')
  })

  it('还原被 webdav 剥掉引号的弱 ETag（W/abc → W/"abc"）', () => {
    expect(quotedEtag('W/abc')).toBe('W/"abc"')
  })
})

/* ------------------------------------------------------------------ *
 * 以下为 createWebdavClient() 的集成测试：用 Node 内置 http 起一个
 * 本机内存 WebDAV stub 服务器，走真实的 webdav 客户端（含其内部编码、
 * If-Match、PROPFIND 解析等），不新增任何依赖。
 * ------------------------------------------------------------------ */

const STUB_BASE = '/dav'

/** stub 中一个文件：`etag` 为完整 entity-tag（含引号，可带 `W/` 前缀） */
interface StubFile {
  data: Buffer
  etag: string
  lastmod: Date
}

/** stub 收到的请求（`rawPath` 为请求行里的原始目标，用于断言编码行为） */
interface StubRequest {
  method: string
  rawPath: string
  /** 解码后的路径 key（相对 stub 根，`/` 分隔，无前后导斜杠） */
  path: string
  ifMatch: string | undefined
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 把请求 URL 的 pathname 转成 stub 内部 key；段级 decodeURIComponent */
function toStubKey(pathname: string): { key: string; isCollection: boolean } {
  const raw = pathname.startsWith(STUB_BASE) ? pathname.slice(STUB_BASE.length) : pathname
  const key = raw
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeURIComponent)
    .join('/')
  return { key, isCollection: raw.endsWith('/') }
}

/** `prefix` 的直接子项（不含更深层） */
function isDirectChild(prefix: string, key: string): boolean {
  if (!key.startsWith(prefix)) return false
  const rest = key.slice(prefix.length)
  return rest !== '' && !rest.includes('/')
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value[0] : undefined
}

/**
 * 最小内存 WebDAV 服务器，只实现 createWebdavClient() 实际用到的方法：
 * PROPFIND（Depth 0/1）、GET、PUT（含 If-Match → 412）、DELETE、MKCOL。
 */
class WebdavStubServer {
  readonly files = new Map<string, StubFile>()
  /** 已存在的集合（目录）key；`''` 为根 */
  readonly dirs = new Set<string>([''])
  readonly requests: StubRequest[] = []
  /** 写入/播种时是否使用弱 ETag（`W/"..."`） */
  weakEtags = false

  private server: http.Server | null = null
  private port = 0
  private seq = 0

  get url(): string {
    return `http://127.0.0.1:${this.port}${STUB_BASE}`
  }

  /** 播种一个文件；返回该文件（含完整 ETag） */
  seedFile(key: string, content: string, weak = this.weakEtags): StubFile {
    this.addParents(key)
    const file: StubFile = {
      data: Buffer.from(content, 'utf-8'),
      etag: this.makeEtag(weak),
      lastmod: new Date(Date.UTC(2025, 0, 1))
    }
    this.files.set(key, file)
    return file
  }

  seedDir(key: string): void {
    if (key === '') return
    this.addParents(key)
    this.dirs.add(key)
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => this.dispatch(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.port = (server.address() as { port: number }).port
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private makeEtag(weak: boolean): string {
    this.seq += 1
    return `${weak ? 'W/' : ''}"v${this.seq}"`
  }

  private addParents(key: string): void {
    const parts = key.split('/')
    parts.pop()
    let current = ''
    for (const part of parts) {
      current = current === '' ? part : `${current}/${part}`
      this.dirs.add(current)
    }
  }

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = (req.method ?? 'GET').toUpperCase()
    const rawPath = req.url ?? '/'
    const { key, isCollection } = toStubKey(new URL(rawPath, 'http://127.0.0.1').pathname)
    this.requests.push({ method, rawPath, path: key, ifMatch: headerValue(req.headers['if-match']) })
    void this.respond(method, key, isCollection, req, res).catch(() => {
      res.statusCode = 500
      res.end()
    })
  }

  private async respond(
    method: string,
    key: string,
    _isCollection: boolean,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    switch (method) {
      case 'PROPFIND':
        this.handlePropfind(key, req, res)
        return
      case 'GET':
        this.handleGet(key, res)
        return
      case 'PUT':
        await this.handlePut(key, req, res)
        return
      case 'DELETE':
        this.handleDelete(key, res)
        return
      case 'MKCOL':
        this.handleMkcol(key, res)
        return
      default:
        res.statusCode = 405
        res.end()
    }
  }

  private handlePropfind(key: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const depth = headerValue(req.headers['depth']) ?? '0'
    const file = this.files.get(key)
    if (!file && !this.dirs.has(key)) {
      res.statusCode = 404
      res.end()
      return
    }
    const entries: string[] = []
    if (file) {
      entries.push(this.fileXml(key, file))
    } else {
      entries.push(this.dirXml(key))
      if (depth !== '0') {
        const prefix = key === '' ? '' : `${key}/`
        for (const [childKey, childFile] of this.files) {
          if (isDirectChild(prefix, childKey)) entries.push(this.fileXml(childKey, childFile))
        }
        for (const dir of this.dirs) {
          if (dir !== '' && isDirectChild(prefix, dir)) entries.push(this.dirXml(dir))
        }
      }
    }
    res.statusCode = 207
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.end(
      `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${entries.join('')}</D:multistatus>`
    )
  }

  private handleGet(key: string, res: http.ServerResponse): void {
    const file = this.files.get(key)
    if (!file) {
      res.statusCode = 404
      res.end()
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('ETag', file.etag)
    res.setHeader('Content-Length', String(file.data.length))
    res.end(file.data)
  }

  private async handlePut(
    key: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
    if (!this.dirs.has(parent)) {
      // 父目录不存在 → 409，逼出 createWebdavClient() 的 ensureDir()
      res.statusCode = 409
      res.end()
      return
    }
    const current = this.files.get(key)
    const ifMatch = headerValue(req.headers['if-match'])
    if (ifMatch !== undefined && (current === undefined || current.etag !== ifMatch)) {
      res.statusCode = 412
      res.end()
      return
    }
    const data = await readBody(req)
    const file: StubFile = { data, etag: this.makeEtag(this.weakEtags), lastmod: new Date() }
    this.files.set(key, file)
    res.statusCode = current ? 204 : 201
    res.setHeader('ETag', file.etag)
    res.end()
  }

  private handleDelete(key: string, res: http.ServerResponse): void {
    if (!this.files.has(key)) {
      res.statusCode = 404
      res.end()
      return
    }
    this.files.delete(key)
    res.statusCode = 204
    res.end()
  }

  private handleMkcol(key: string, res: http.ServerResponse): void {
    if (this.dirs.has(key) || this.files.has(key)) {
      res.statusCode = 405
      res.end()
      return
    }
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
    if (!this.dirs.has(parent)) {
      res.statusCode = 409
      res.end()
      return
    }
    this.dirs.add(key)
    res.statusCode = 201
    res.end()
  }

  private href(key: string, isDir: boolean): string {
    const encoded = key
      .split('/')
      .filter((segment) => segment !== '')
      .map(encodeURIComponent)
      .join('/')
    return `${STUB_BASE}/${encoded}${isDir ? '/' : ''}`
  }

  private fileXml(key: string, file: StubFile): string {
    return (
      `<D:response><D:href>${this.href(key, false)}</D:href><D:propstat><D:prop>` +
      `<D:getlastmodified>${file.lastmod.toUTCString()}</D:getlastmodified>` +
      `<D:getcontentlength>${file.data.length}</D:getcontentlength>` +
      `<D:getetag>${xmlEscape(file.etag)}</D:getetag>` +
      `<D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    )
  }

  private dirXml(key: string): string {
    return (
      `<D:response><D:href>${this.href(key, true)}</D:href><D:propstat><D:prop>` +
      `<D:getlastmodified>${new Date(Date.UTC(2025, 0, 1)).toUTCString()}</D:getlastmodified>` +
      `<D:getcontentlength>0</D:getcontentlength>` +
      `<D:resourcetype><D:collection/></D:resourcetype>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    )
  }
}

describe('createWebdavClient（真实客户端 + 内存 WebDAV stub）', () => {
  let stub: WebdavStubServer
  let client: WebdavClient

  beforeEach(async () => {
    stub = new WebdavStubServer()
    await stub.start()
    client = createWebdavClient({ url: stub.url, username: 'me', password: 'secret' })
  })

  afterEach(async () => {
    await stub.close()
  })

  it('list() 递归列举子目录，并硬排除 .git/.inkase/node_modules', async () => {
    stub.seedDir('sub')
    stub.seedDir('sub/deep')
    stub.seedDir('.git')
    stub.seedDir('node_modules')
    stub.seedFile('a.mdx', 'A')
    stub.seedFile('sub/b.mdx', 'BB')
    stub.seedFile('sub/deep/c.mdx', 'CCC')
    stub.seedFile('.git/config', 'x')
    stub.seedFile('node_modules/dep/index.js', 'x')

    const entries = await client.list('')
    expect(entries.map((e) => e.path).sort()).toEqual(['a.mdx', 'sub/b.mdx', 'sub/deep/c.mdx'])
    const a = entries.find((e) => e.path === 'a.mdx')!
    expect(a.size).toBe(1)
    expect(a.mtime).toBe(Date.parse('Wed, 01 Jan 2025 00:00:00 GMT'))
    // webdav 的 prepareFileFromProps 会剥掉 ETag 的引号
    expect(a.etag).toMatch(/^v\d+$/)
  })

  it('readFile()/writeFile() 往返内容，writeFile() 返回新的 ETag', async () => {
    const data = Buffer.from('hello 世界', 'utf-8')
    const etag = await client.writeFile('note.mdx', data, null)
    expect(etag).toBeTruthy()
    expect((await client.readFile('note.mdx')).toString('utf-8')).toBe('hello 世界')
  })

  it('ensureDir() 递归创建缺失目录，writeFile() 才能成功', async () => {
    const etag = await client.writeFile('fresh/deep/a.mdx', Buffer.from('A'), null)
    expect(etag).toBeTruthy()
    expect(stub.dirs.has('fresh')).toBe(true)
    expect(stub.dirs.has('fresh/deep')).toBe(true)
    expect(stub.requests.some((r) => r.method === 'MKCOL')).toBe(true)
  })

  // C1：远端根尚不存在时（新建目录/被删），list() 的 PROPFIND 会 404；首绑必须先建根再列举
  it('远端根不存在时 push() 创建远端根并上传文件（C1）', async () => {
    const ws = makeWorkspace({ 'a.mdx': 'A' })
    const provider = new WebdavSyncProvider(ws, { ...webdavConfig(), remoteRoot: '/inkase/notes' }, client)
    // remoteRoot 未 seed → stub 对其 PROPFIND 返回 404
    expect(stub.dirs.has('inkase/notes')).toBe(false)
    const res = await provider.push()
    expect(res.success).toBe(true)
    expect(stub.dirs.has('inkase/notes')).toBe(true)
    expect(stub.files.get('inkase/notes/a.mdx')!.data.toString()).toBe('A')
    expect(await provider.status()).not.toBe('error')
  })

  it('delete() 删除远端文件', async () => {
    stub.seedFile('gone.mdx', 'X')
    await client.delete('gone.mdx')
    expect(stub.files.has('gone.mdx')).toBe(false)
  })

  it('writeFile() 在 ETag 不符时抛 WebdavConflictError 且不覆盖远端', async () => {
    stub.seedFile('a.mdx', 'A')
    await expect(client.writeFile('a.mdx', Buffer.from('B'), '"stale"')).rejects.toBeInstanceOf(
      WebdavConflictError
    )
    expect(stub.files.get('a.mdx')!.data.toString()).toBe('A')
  })

  it('writeFile() 在 ETag 相符时成功（乐观锁）', async () => {
    const seeded = stub.seedFile('a.mdx', 'A')
    const etag = await client.writeFile('a.mdx', Buffer.from('B'), seeded.etag.replace(/"/g, ''))
    expect(etag).toBeTruthy()
    expect(stub.files.get('a.mdx')!.data.toString()).toBe('B')
  })

  it('路径含中文/空格/# 时按段单次编码并正确往返', async () => {
    const cases: Array<[string, string]> = [
      ['中文 笔记.mdx', '一'],
      ['a#b.mdx', '二'],
      ['目录 一/c#2 笔记.mdx', '三']
    ]
    for (const [key, content] of cases) {
      await client.writeFile(key, Buffer.from(content, 'utf-8'), null)
    }

    const entries = await client.list('')
    expect(entries.map((e) => e.path).sort()).toEqual(cases.map(([key]) => key).sort())
    for (const [key, content] of cases) {
      expect((await client.readFile(key)).toString('utf-8')).toBe(content)
    }

    // 请求行里必须是「按段、单次」编码：%23 / %20 / UTF-8 百分号转义，而不是未编码或双重编码
    const rawOf = (key: string): string | undefined =>
      stub.requests.find((r) => r.method === 'PUT' && r.path === key)?.rawPath
    expect(rawOf('中文 笔记.mdx')).toBe('/dav/%E4%B8%AD%E6%96%87%20%E7%AC%94%E8%AE%B0.mdx')
    expect(rawOf('a#b.mdx')).toBe('/dav/a%23b.mdx')
    expect(rawOf('目录 一/c#2 笔记.mdx')).toBe(
      '/dav/%E7%9B%AE%E5%BD%95%20%E4%B8%80/c%232%20%E7%AC%94%E8%AE%B0.mdx'
    )
  })

  it('服务器发弱 ETag 时 writeFile() 仍发出正确的 If-Match（不误报 412）', async () => {
    stub.weakEtags = true
    const seeded = stub.seedFile('weak.mdx', 'A')
    expect(seeded.etag).toMatch(/^W\//)

    const [entry] = await client.list('')
    // webdav 剥掉引号 → 'W/v1'；quotedEtag 必须还原成 'W/"v1"' 才能被服务器接受
    expect(entry.etag).toBe(seeded.etag.replace(/"/g, ''))

    const next = await client.writeFile('weak.mdx', Buffer.from('B'), entry.etag)
    expect(next).toBeTruthy()
    expect(stub.files.get('weak.mdx')!.data.toString()).toBe('B')
    const put = stub.requests.find((r) => r.method === 'PUT')!
    expect(put.ifMatch).toBe(seeded.etag)
  })

  it('弱 ETag 不符时同样抛 WebdavConflictError', async () => {
    stub.weakEtags = true
    stub.seedFile('weak.mdx', 'A')
    await expect(
      client.writeFile('weak.mdx', Buffer.from('B'), 'W/stale')
    ).rejects.toBeInstanceOf(WebdavConflictError)
  })
})
