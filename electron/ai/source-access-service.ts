import * as fs from 'node:fs'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import { parse as parseHtml } from 'node-html-parser'
import { PDFParse } from 'pdf-parse'
import type {
  AiErrorCode,
  LocalFileInspection,
  LocalFileReadResult,
  LocalFileType,
  SourceChunk,
  WebSourceReadResult
} from '../../shared/ai/types'
import { validatePublicHttpsUrl } from './url-policy'

interface SourceStats {
  size: number
  dev?: number | bigint
  ino?: number | bigint
  mode?: number
  mtimeMs?: number
  ctimeMs?: number
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isReparsePoint?: () => boolean
}

export interface SourceFileHandle {
  stat(): Promise<SourceStats>
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

export interface SourceFileSystem {
  lstat(filePath: string): Promise<SourceStats>
  stat(filePath: string): Promise<SourceStats>
  realpath(filePath: string): Promise<string>
  open(filePath: string, flags: string): Promise<SourceFileHandle>
  readFile?(filePath: string): Promise<Buffer>
}

export interface SourceAccessDeps {
  fileSystem?: SourceFileSystem
}

export interface SourceAccessOptions {
  fetchTimeoutMs?: number
  maxUrlBytes?: number
  maxFileBytes?: number
  maxExtractedChars?: number
  maxRedirects?: number
  targetChunkSize?: number
  maxZipEntries?: number
  maxZipRatio?: number
  maxPdfPages?: number
}

export interface SourceFileInspection extends LocalFileInspection {
  resolvedPath: string
  dev?: number | bigint
  ino?: number | bigint
  mode?: number
  mtimeMs?: number
  ctimeMs?: number
}

const defaults = {
  fetchTimeoutMs: 30_000,
  maxUrlBytes: 5 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  maxExtractedChars: 1_000_000,
  maxRedirects: 5,
  targetChunkSize: 10_000,
  maxZipEntries: 1_000,
  maxZipRatio: 100,
  maxPdfPages: 500
}

export class SourceAccessError extends Error {
  constructor(readonly code: AiErrorCode, message: string) {
    super(message)
    this.name = 'SourceAccessError'
  }
}

function normalizeText(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function chunksFor(text: string, target: number): readonly SourceChunk[] {
  const chunks: SourceChunk[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + target, text.length)
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n\n', end)
      if (boundary >= start + Math.floor(target * 0.8)) end = boundary + 2
    }
    chunks.push(Object.freeze({ index: chunks.length, content: text.slice(start, end), startOffset: start, endOffset: end }))
    start = end
  }
  return Object.freeze(chunks)
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right)
}

function sameIdentity(left: SourceStats, right: SourceStats): boolean {
  if (left.size !== right.size) return false
  if (left.dev !== undefined && right.dev !== undefined && left.dev !== right.dev) return false
  if (left.ino !== undefined && right.ino !== undefined && left.ino !== right.ino) return false
  if (left.mode !== undefined && right.mode !== undefined && left.mode !== right.mode) return false
  if (left.mtimeMs !== undefined && right.mtimeMs !== undefined && left.mtimeMs !== right.mtimeMs) return false
  if (left.ctimeMs !== undefined && right.ctimeMs !== undefined && left.ctimeMs !== right.ctimeMs) return false
  return true
}

function inspectionIdentity(inspection: SourceFileInspection): SourceStats {
  return {
    size: inspection.size ?? 0,
    dev: inspection.dev,
    ino: inspection.ino,
    mode: inspection.mode,
    mtimeMs: inspection.mtimeMs,
    ctimeMs: inspection.ctimeMs,
    isDirectory: () => false,
    isSymbolicLink: () => false
  }
}

function inferType(filePath: string): LocalFileType | null {
  switch (path.extname(filePath).toLowerCase()) {
    case '.pdf': return 'pdf'
    case '.md': case '.markdown': return 'markdown'
    case '.mdx': return 'mdx'
    case '.txt': return 'text'
    default: return null
  }
}

export class SourceAccessService {
  private readonly fileSystem: SourceFileSystem
  private readonly options: Required<SourceAccessOptions>

  constructor(deps: SourceAccessDeps = {}, options: SourceAccessOptions = {}) {
    this.fileSystem = deps.fileSystem ?? (fs.promises as unknown as SourceFileSystem)
    this.options = { ...defaults, ...options }
  }

  async readWebUrl(url: string, signal: AbortSignal): Promise<WebSourceReadResult> {
    if (!validatePublicHttpsUrl(url)) throw new SourceAccessError('SOURCE_INVALID', '来源 URL 无效：仅允许公网 HTTPS 地址')
    let currentUrl = url
    for (let redirect = 0; redirect <= this.options.maxRedirects; redirect++) {
      this.throwIfAborted(signal)
      const timeout = new AbortController()
      const onAbort = (): void => timeout.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => timeout.abort(), this.options.fetchTimeoutMs)
      try {
        const response = await fetch(currentUrl, {
          signal: timeout.signal,
          headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Inkase/1.0' }
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          await response.body?.cancel().catch(() => {})
          if (!location || redirect === this.options.maxRedirects) throw new SourceAccessError('SOURCE_INVALID', '来源重定向无效或次数过多')
          currentUrl = new URL(location, currentUrl).toString()
          if (!validatePublicHttpsUrl(currentUrl)) throw new SourceAccessError('SOURCE_POLICY_BLOCKED', '来源重定向到了不可访问的地址')
          continue
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new SourceAccessError('SOURCE_INVALID', `来源抓取失败：HTTP ${response.status}`)
        }
        try {
          this.validateHtmlResponse(response)
        } catch (error) {
          await response.body?.cancel().catch(() => {})
          throw error
        }
        const bytes = await this.readBody(response, this.options.maxUrlBytes, timeout.signal)
        const root = parseHtml(new TextDecoder().decode(bytes))
        for (const selector of ['script', 'style', 'noscript']) root.querySelectorAll(selector).forEach((node) => node.remove())
        const title = root.querySelector('title')?.text.trim() || new URL(currentUrl).hostname
        const content = this.acceptText(normalizeText((root.querySelector('body') ?? root).structuredText))
        return { url, finalUrl: currentUrl, title, content, contentType: response.headers.get('content-type') ?? 'text/html', chunks: chunksFor(content, this.options.targetChunkSize) as SourceChunk[], truncated: false }
      } catch (error) {
        if (error instanceof SourceAccessError) throw error
        throw new SourceAccessError('SOURCE_INVALID', error instanceof Error && error.name === 'AbortError' ? '来源抓取已中止或超时' : `来源抓取失败：${error instanceof Error ? error.message : '未知错误'}`)
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    }
    throw new SourceAccessError('SOURCE_INVALID', '来源重定向次数过多')
  }

  async inspectLocalFile(filePath: string): Promise<SourceFileInspection> {
    const normalizedPath = path.resolve(filePath)
    const fileType = inferType(normalizedPath)
    if (!fileType) throw new SourceAccessError('SOURCE_INVALID', '不支持的文件类型')
    let lstat: SourceStats
    let stat: SourceStats
    let finalPath: string
    try {
      lstat = await this.fileSystem.lstat(normalizedPath)
      stat = await this.fileSystem.stat(normalizedPath)
      finalPath = await this.fileSystem.realpath(normalizedPath)
    } catch {
      throw new SourceAccessError('SOURCE_INVALID', '来源文件不存在或不可读')
    }
    if (lstat.isDirectory() || stat.isDirectory()) throw new SourceAccessError('SOURCE_INVALID', '来源必须是文件')
    if (lstat.isSymbolicLink() || lstat.isReparsePoint?.()) throw new SourceAccessError('SOURCE_POLICY_BLOCKED', '不允许链接或已报告的 reparse point')
    if (!samePath(normalizedPath, finalPath)) throw new SourceAccessError('SOURCE_POLICY_BLOCKED', '来源最终路径与获批路径不一致')
    if (!sameIdentity(lstat, stat)) throw new SourceAccessError('SOURCE_POLICY_BLOCKED', '来源元数据不一致')
    if (stat.size > this.options.maxFileBytes) throw new SourceAccessError('SOURCE_TOO_LARGE', `来源文件超过 ${this.options.maxFileBytes} 字节上限`)
    return {
      requestedPath: filePath,
      normalizedPath,
      resolvedPath: finalPath,
      fileType,
      size: stat.size,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs
    }
  }

  async readLocalFile(filePath: string, signal: AbortSignal, approved?: SourceFileInspection): Promise<LocalFileReadResult> {
    this.throwIfAborted(signal)
    const inspection = approved ?? await this.inspectLocalFile(filePath)
    if (!samePath(path.resolve(filePath), inspection.normalizedPath)) {
      throw new SourceAccessError('SOURCE_POLICY_BLOCKED', '来源路径与获批路径不一致')
    }
    const approvedIdentity = inspectionIdentity(inspection)
    const handle = await this.fileSystem.open(inspection.normalizedPath, 'r')
    try {
      const opened = await handle.stat()
      const finalPath = await this.fileSystem.realpath(inspection.normalizedPath)
      const pathStats = await this.fileSystem.stat(inspection.normalizedPath)
      if (!samePath(finalPath, inspection.resolvedPath) || !sameIdentity(approvedIdentity, opened) || !sameIdentity(opened, pathStats)) {
        throw new SourceAccessError('SOURCE_POLICY_BLOCKED', '来源文件在获批后发生变化')
      }
      if (opened.size > this.options.maxFileBytes) throw new SourceAccessError('SOURCE_TOO_LARGE', '来源文件超过大小上限')
      const bytes = await this.readFileBounded(handle, this.options.maxFileBytes, signal)
      if (bytes.length > this.options.maxFileBytes) throw new SourceAccessError('SOURCE_TOO_LARGE', '来源文件超过大小上限')
      const postRead = await handle.stat()
      const finalPathAfterRead = await this.fileSystem.realpath(inspection.normalizedPath)
      const pathStatsAfterRead = await this.fileSystem.stat(inspection.normalizedPath)
      if (!samePath(finalPathAfterRead, inspection.resolvedPath) || !sameIdentity(opened, postRead) || !sameIdentity(postRead, pathStatsAfterRead)) {
        throw new SourceAccessError('SOURCE_POLICY_BLOCKED', '来源文件在读取期间发生变化')
      }
      const content = this.acceptText(normalizeText(await this.extract(bytes, inspection.fileType)))
      return {
        requestedPath: inspection.requestedPath,
        normalizedPath: inspection.normalizedPath,
        fileType: inspection.fileType,
        size: inspection.size,
        content,
        chunks: chunksFor(content, this.options.targetChunkSize) as SourceChunk[],
        truncated: false
      }
    } catch (error) {
      if (error instanceof SourceAccessError) throw error
      throw new SourceAccessError('SOURCE_INVALID', error instanceof Error && error.name === 'AbortError' ? '来源读取已中止' : `来源读取失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      await handle.close().catch(() => {})
    }
  }

  private async extract(bytes: Buffer, type: LocalFileType): Promise<string> {
    if (type === 'pdf') {
      if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new SourceAccessError('SOURCE_INVALID', 'PDF 文件签名无效')
      if (!bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from('%%EOF'))) {
        throw new SourceAccessError('SOURCE_INVALID', 'PDF 文件结尾无效')
      }
      const parser = new PDFParse({ data: bytes })
      try {
        const info = await parser.getInfo()
        if (info.total > this.options.maxPdfPages) throw new SourceAccessError('SOURCE_TOO_LARGE', 'PDF 页数超过处理上限')
        const text = (await parser.getText({ pageJoiner: '' })).text
        if (!text.trim()) throw new SourceAccessError('SOURCE_INVALID', '扫描版 PDF 无有效文本，当前版本不支持 OCR')
        return text
      } finally { await parser.destroy() }
    }
    if (type === 'mdx') return this.extractMdx(bytes)
    this.rejectBinaryText(bytes)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }

  private extractMdx(bytes: Buffer): string {
    let zip: AdmZip
    try { zip = new AdmZip(bytes) } catch { throw new SourceAccessError('SOURCE_INVALID', 'MDX 无法解压') }
    const entries = zip.getEntries()
    if (entries.length > this.options.maxZipEntries) throw new SourceAccessError('SOURCE_TOO_LARGE', 'MDX 条目过多')
    let inflated = 0
    const names = new Set<string>()
    for (const entry of entries) {
      const name = entry.entryName.replace(/\\/g, '/')
      if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw new SourceAccessError('SOURCE_POLICY_BLOCKED', 'MDX 包含不安全条目路径')
      const normalizedName = path.posix.normalize(name)
      if (names.has(normalizedName)) throw new SourceAccessError('SOURCE_POLICY_BLOCKED', 'MDX 包含重复或歧义条目路径')
      names.add(normalizedName)
      if ((entry.header.flags & 1) !== 0) throw new SourceAccessError('SOURCE_POLICY_BLOCKED', 'MDX 包含加密条目')
      inflated += entry.header.size
      const compressed = Math.max(1, entry.header.compressedSize)
      if (entry.header.size > this.options.maxFileBytes || entry.header.size / compressed > this.options.maxZipRatio) throw new SourceAccessError('SOURCE_TOO_LARGE', 'MDX 条目超过解压限制')
    }
    if (inflated > this.options.maxFileBytes) throw new SourceAccessError('SOURCE_TOO_LARGE', 'MDX 解压总量超过限制')
    const manifest = zip.getEntry('mdx.json')
    if (!manifest) throw new SourceAccessError('SOURCE_INVALID', 'MDX 缺少 mdx.json')
    let contentFile = 'content.md'
    try { contentFile = (JSON.parse(manifest.getData().toString('utf8')) as { content_file?: string }).content_file ?? contentFile } catch { throw new SourceAccessError('SOURCE_INVALID', 'MDX 清单无效') }
    const normalized = contentFile.replace(/\\/g, '/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw new SourceAccessError('SOURCE_POLICY_BLOCKED', 'MDX 内容路径不安全')
    const content = zip.getEntry(normalized)
    if (!content) throw new SourceAccessError('SOURCE_INVALID', 'MDX 内容文件不存在')
    const data = content.getData()
    this.rejectBinaryText(data)
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  }

  private acceptText(text: string): string {
    if (!text) throw new SourceAccessError('SOURCE_INVALID', '来源内容为空')
    if (text.length > this.options.maxExtractedChars) throw new SourceAccessError('SOURCE_TOO_LARGE', `提取文本超过 ${this.options.maxExtractedChars} 字符上限`)
    return text
  }

  private rejectBinaryText(bytes: Uint8Array): void {
    if (!bytes.length) return
    let nul = 0
    let controls = 0
    for (const byte of bytes) {
      if (byte === 0) nul++
      if (byte < 9 || (byte > 13 && byte < 32)) controls++
    }
    if (nul > 0 || controls / bytes.length > 0.1) throw new SourceAccessError('SOURCE_INVALID', '文本文件包含二进制数据')
  }

  private async readBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array()
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let total = 0
    const onAbort = (): void => { void reader.cancel(signal.reason).catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        this.throwIfAborted(signal)
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > limit) { await reader.cancel().catch(() => {}); throw new SourceAccessError('SOURCE_TOO_LARGE', '来源抓取内容超过大小上限') }
        parts.push(value)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      reader.releaseLock()
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const part of parts) { result.set(part, offset); offset += part.length }
    return result
  }

  private validateHtmlResponse(response: Response): void {
    const rawContentType = response.headers.get('content-type')
    if (!rawContentType) throw new SourceAccessError('SOURCE_INVALID', '来源响应缺少 Content-Type')
    const contentType = rawContentType.split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      throw new SourceAccessError('SOURCE_INVALID', '来源响应不是受支持的 HTML 内容')
    }
    // fetch 自动解压 gzip/br/deflate，无需校验 content-encoding
  }

  private async readFileBounded(handle: SourceFileHandle, limit: number, signal: AbortSignal): Promise<Buffer> {
    const bytes = Buffer.allocUnsafe(limit + 1)
    let total = 0
    while (total <= limit) {
      this.throwIfAborted(signal)
      const length = Math.min(64 * 1024, limit + 1 - total)
      const { bytesRead } = await handle.read(bytes, total, length, total)
      this.throwIfAborted(signal)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return bytes.subarray(0, total)
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new SourceAccessError('SOURCE_INVALID', '来源操作已中止')
  }
}
