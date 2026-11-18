import AdmZip from 'adm-zip'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type {
  ContentSearchMatch,
  DirectoryEntry,
  FilenameSearchMatch,
  SearchTruncationReason,
  SearchWorkspaceInput,
  SearchWorkspaceResult,
  WorkspaceDirectoryResult,
  WorkspaceFileFormat,
  WorkspaceFileSlice,
  WorkspaceFileStat
} from '../../shared/ai/types'
import { resolveRgPath } from './rg-resolver'
import { isPathWithinRoot } from './workspace-authorization'
import { extractMindMapOutline } from '../../shared/mindmap/outline'
import { MINDMAP_ENTRY } from '../mindmap/inkmind-archive'
import {
  searchMdxFile,
  DEFAULT_MDX_SEARCH_LIMITS,
  type MdxSearchLimits
} from './mdx-content-search'

/**
 * 工作区实时受限搜索服务。
 *
 * - 文件名搜索：固定执行 `rg --files --null --no-config`，在进程内按
 *   query/extensions 过滤；模型不能构造 glob 或额外参数。
 * - 正文搜索：固定执行 `rg --json --line-number --column --no-config`，
 *   literal 自动加 `--fixed-strings`，regex 作为独立 argv 传入；
 *   额外 `--glob '!*.mdx'`，MDX 由应用内存解包后搜索，结果合并。
 * - 遵循 .gitignore，固定排除 .git / node_modules / .inkase。
 * - 资源限制：30 秒超时、结果上限、输出字节上限、MDX 累计字节上限。
 */

export interface WorkspaceSearchLimits {
  timeoutMs: number
  maxResults: number
  defaultMaxResults: number
  maxOutputBytes: number
  maxPreviewLength: number
  mdx: MdxSearchLimits
  maxMdxTotalBytes: number
  mdxConcurrency: number
  /** 单次 readFileSlice 返回的正文字节上限；超出时截断并给出 nextOffset */
  maxReadBytes: number
}

export const DEFAULT_SEARCH_LIMITS: WorkspaceSearchLimits = {
  timeoutMs: 30_000,
  maxResults: 100,
  defaultMaxResults: 50,
  maxOutputBytes: 1024 * 1024,
  maxPreviewLength: 500,
  mdx: DEFAULT_MDX_SEARCH_LIMITS,
  maxMdxTotalBytes: 200 * 1024 * 1024,
  mdxConcurrency: 4,
  // 256 KiB：约 6 万汉字，够一次读完普通文档，又不至于把上下文撑爆。
  // 更大的文件由模型按 nextOffset 分多次读取。
  maxReadBytes: 256 * 1024
}

export interface WorkspaceSearchDeps {
  rgPath: string | null
  spawn: typeof spawn
  realpathSync: (p: string) => string
  limits: WorkspaceSearchLimits
}

function defaultDeps(): WorkspaceSearchDeps {
  let rgPath: string | null = null
  try {
    rgPath = resolveRgPath()
  } catch {
    rgPath = null
  }
  return {
    rgPath,
    spawn,
    realpathSync: fs.realpathSync,
    limits: DEFAULT_SEARCH_LIMITS
  }
}

export class WorkspaceSearchError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WorkspaceSearchError'
  }
}

/** 判断二进制时只看文件头这么多字节，避免为了「是不是文本」整文件读一遍。 */
const BINARY_PROBE_BYTES = 8192

/** 单次读取上限的合法区间：太小读不动正文，太大又会撑爆模型上下文。 */
export const MIN_READ_BYTES = 4 * 1024
export const MAX_READ_BYTES = 4 * 1024 * 1024

/**
 * 校验调用方传入的单次读取上限。
 *
 * 设置里的值来自用户，工具调用里的值来自模型，两边都不能直接信；
 * 越界时夹到合法区间，缺省时用服务配置。
 */
export function resolveMaxReadBytes(requested: number | undefined, fallback: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return fallback
  }
  return Math.min(Math.max(Math.floor(requested), MIN_READ_BYTES), MAX_READ_BYTES)
}

/**
 * 按扩展名判定可读格式。
 *
 * `.mdx` / `.inkmind` 是 ZIP 容器，直接按文本读会拿到压缩字节；
 * `.drawio` 相反，它本来就是一整份 XML 文本，按文本读即可。
 */
export function detectWorkspaceFileFormat(relativePath: string): WorkspaceFileFormat {
  const lower = relativePath.toLowerCase()
  if (lower.endsWith('.mdx')) return 'mdx'
  if (lower.endsWith('.inkmind')) return 'mindmap'
  if (lower.endsWith('.drawio')) return 'diagram'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  return 'text'
}

/** 跳过开头的不完整 UTF-8 续字节（0b10xxxxxx），返回第一个可解码位置。 */
function utf8AlignedStart(bytes: Buffer): number {
  let index = 0
  while (index < bytes.length && (bytes[index] & 0xc0) === 0x80) index++
  return index
}

/**
 * 解码一段 UTF-8 窗口，必要时丢掉末尾半个字符。
 *
 * 窗口边界由字节数决定，最后几个字节可能只是一个多字节字符的前半截；
 * 用 fatal 解码 + 最多回退 3 字节，既能保证不出乱码，也不会掩盖真正的非 UTF-8 文件。
 */
function decodeUtf8Window(bytes: Buffer): { text: string; length: number } {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let trim = 0; trim <= 3 && trim <= bytes.length; trim++) {
    try {
      return { text: decoder.decode(bytes.subarray(0, bytes.length - trim)), length: bytes.length - trim }
    } catch {
      // 末字节是被截断的多字节字符，再退一个字节试试
    }
  }
  throw new WorkspaceSearchError('NOT_UTF8', '文件不是有效的 UTF-8 文本')
}

interface RgRunResult {
  stdout: Buffer
  code: number | null
  killed: boolean
  signalReason: 'timeout' | 'abort' | 'output-limit' | null
}

interface RgJsonMatch {
  type: string
  data: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
    submatches?: Array<{ start?: number; text?: string }>
  }
}

export class WorkspaceSearchService {
  private readonly deps: WorkspaceSearchDeps

  constructor(deps: WorkspaceSearchDeps = defaultDeps()) {
    this.deps = deps
  }

  get rgAvailable(): boolean {
    return this.deps.rgPath !== null
  }

  /**
   * 解析 scope 相对路径为工作区内绝对路径，并校验不逃逸。
   * 返回 { absolute, relPrefix }：relPrefix 用于把 rg 相对输出换算为相对工作区根。
   */
  resolveScope(root: string, scope: string | undefined): { absolute: string; relPrefix: string } {
    const realRoot = this.deps.realpathSync(root)
    const raw = scope && scope.trim() ? scope : '.'
    if (path.isAbsolute(raw)) {
      throw new WorkspaceSearchError('SCOPE_INVALID', 'scope 必须是工作区内的相对路径')
    }
    const absolute = this.deps.realpathSync(path.resolve(realRoot, raw))
    if (!isPathWithinRoot(realRoot, absolute)) {
      throw new WorkspaceSearchError('SCOPE_ESCAPE', 'scope 逃逸了工作区边界')
    }
    const relPrefix =
      absolute === realRoot
        ? ''
        : path.relative(realRoot, absolute).replace(/\\/g, '/')
    return { absolute, relPrefix }
  }

  async search(
    input: SearchWorkspaceInput,
    root: string,
    signal: AbortSignal
  ): Promise<SearchWorkspaceResult> {
    const started = Date.now()
    const query = input.query
    if (!query.trim()) {
      throw new WorkspaceSearchError('QUERY_EMPTY', '搜索关键词不能为空')
    }
    if (query.length > 500) {
      throw new WorkspaceSearchError('QUERY_TOO_LONG', '搜索关键词过长')
    }
    const maxResults = Math.min(
      this.deps.limits.maxResults,
      Math.max(1, input.maxResults ?? this.deps.limits.defaultMaxResults)
    )
    const scope = this.resolveScope(root, input.scope)

    if (input.mode === 'filename') {
      const { matches, truncated, reason } = await this.searchFileNames(
        input,
        scope,
        maxResults,
        signal
      )
      return {
        status: 'completed',
        mode: 'filename',
        query,
        matches,
        truncated,
        truncationReason: reason,
        elapsedMs: Date.now() - started
      }
    }

    const result = await this.searchContent(input, scope, maxResults, signal)
    return {
      status: 'completed',
      mode: 'content',
      query,
      matches: result.matches,
      truncated: result.truncated,
      truncationReason: result.reason,
      elapsedMs: Date.now() - started,
      warnings: result.warnings
    }
  }

  private async searchFileNames(
    input: SearchWorkspaceInput,
    scope: { absolute: string; relPrefix: string },
    maxResults: number,
    signal: AbortSignal
  ): Promise<{ matches: FilenameSearchMatch[]; truncated: boolean; reason?: SearchTruncationReason }> {
    if (!this.deps.rgPath) throw new WorkspaceSearchError('RG_UNAVAILABLE', '搜索组件不可用')
    const run = await this.runRg(
      ['--files', '--null', '--no-config', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!.inkase/**'],
      { cwd: scope.absolute },
      signal
    )
    const matches: FilenameSearchMatch[] = []
    const caseSensitive = input.caseSensitive ?? false
    const extensions = (input.extensions ?? []).map((e) => e.toLowerCase().replace(/^\./, ''))
    const matcher = this.buildStringMatcher(input.query, input.match ?? 'literal', caseSensitive)

    const lines = run.stdout.toString('utf8').split('\0')
    for (const line of lines) {
      if (signal.aborted || matches.length >= maxResults) break
      const raw = line.replace(/\\/g, '/')
      const relative = raw.replace(/^\.\//, '')
      if (!relative) continue
      const fullRelative = scope.relPrefix ? `${scope.relPrefix}/${relative}` : relative
      const name = path.posix.basename(relative)
      const ext = path.posix.extname(name).slice(1).toLowerCase()
      if (extensions.length > 0 && !extensions.includes(ext)) continue
      if (!matcher(name) && !matcher(relative)) continue
      matches.push({ type: 'filename', path: fullRelative, extension: ext })
    }

    const truncated = matches.length >= maxResults && !signal.aborted
    return { matches, truncated, reason: truncated ? 'result-limit' : undefined }
  }

  private async searchContent(
    input: SearchWorkspaceInput,
    scope: { absolute: string; relPrefix: string },
    maxResults: number,
    signal: AbortSignal
  ): Promise<{
    matches: ContentSearchMatch[]
    truncated: boolean
    reason?: SearchTruncationReason
    warnings?: string[]
  }> {
    if (!this.deps.rgPath) throw new WorkspaceSearchError('RG_UNAVAILABLE', '搜索组件不可用')

    const args = [
      '--json',
      '--line-number',
      '--column',
      '--no-config',
      '--glob',
      '!.git/**',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!.inkase/**',
      '--glob',
      '!*.mdx'
    ]
    if ((input.match ?? 'literal') === 'literal') args.push('--fixed-strings')
    if (!(input.caseSensitive ?? false)) args.push('--ignore-case')
    const contextLines = Math.min(3, Math.max(0, input.contextLines ?? 1))
    if (contextLines > 0) {
      args.push('--context', String(contextLines))
    }
    args.push('--', input.query, '.')

    const run = await this.runRg(args, { cwd: scope.absolute }, signal)

    const matches: ContentSearchMatch[] = []
    let truncated = false
    let reason: SearchTruncationReason | undefined
    if (run.signalReason === 'timeout') {
      truncated = true
      reason = 'timeout'
    } else if (run.signalReason === 'output-limit') {
      truncated = true
      reason = 'output-limit'
    } else if (run.signalReason === 'abort') {
      truncated = true
    }

    const textMatches = this.parseRgJson(run.stdout, scope.relPrefix, this.deps.limits.maxPreviewLength)
    for (const m of textMatches) {
      if (signal.aborted || matches.length >= maxResults) break
      matches.push(m)
    }

    // MDX 正文搜索
    const mdxResult = await this.searchMdx(input, scope, maxResults - matches.length, signal)
    matches.push(...mdxResult.matches)
    if (!truncated && mdxResult.reason) {
      truncated = true
      reason = mdxResult.reason
    }

    matches.sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.line - b.line ||
        a.column - b.column
    )
    if (matches.length > maxResults) {
      matches.length = maxResults
      truncated = true
      reason = 'result-limit'
    }

    return { matches, truncated, reason, warnings: mdxResult.warnings }
  }

  private parseRgJson(
    stdout: Buffer,
    relPrefix: string,
    maxPreviewLength: number
  ): ContentSearchMatch[] {
    const result: ContentSearchMatch[] = []
    const text = stdout.toString('utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      let parsed: RgJsonMatch
      try {
        parsed = JSON.parse(line) as RgJsonMatch
      } catch {
        continue
      }
      if (parsed.type !== 'match') continue
      const data = parsed.data
      const rawPath = data.path?.text ?? ''
      const relative = rawPath.replace(/\\/g, '/').replace(/^\.\//, '')
      const fullRelative = relPrefix ? `${relPrefix}/${relative}` : relative
      const lineNumber = data.line_number ?? 1
      const lineText = data.lines?.text ?? ''
      for (const submatch of data.submatches ?? []) {
        const column = (submatch.start ?? 0) + 1
        const preview = lineText.trim().slice(0, maxPreviewLength)
        result.push({
          type: 'content',
          path: fullRelative,
          source: 'text',
          line: lineNumber,
          column,
          preview
        })
      }
    }
    return result
  }

  private async searchMdx(
    input: SearchWorkspaceInput,
    scope: { absolute: string; relPrefix: string },
    remaining: number,
    signal: AbortSignal
  ): Promise<{
    matches: ContentSearchMatch[]
    reason?: SearchTruncationReason
    warnings: string[]
  }> {
    const matches: ContentSearchMatch[] = []
    const warnings: string[] = []
    if (remaining <= 0) return { matches, warnings }

    if (!this.deps.rgPath) throw new WorkspaceSearchError('RG_UNAVAILABLE', '搜索组件不可用')
    const fileRun = await this.runRg(
      ['--files', '--null', '--no-config', '--glob', '*.mdx'],
      { cwd: scope.absolute },
      signal
    )
    const mdxFiles = fileRun.stdout
      .toString('utf8')
      .split('\0')
      .map((p) => p.replace(/\\/g, '/'))
      .filter((p) => p.toLowerCase().endsWith('.mdx'))

    let totalBytes = 0
    let stopReason: SearchTruncationReason | undefined
    let index = 0

    const worker = async (): Promise<void> => {
      while (!signal.aborted && matches.length < remaining) {
        const i = index++
        if (i >= mdxFiles.length) return
        const relative = mdxFiles[i]
        const absolute = path.join(scope.absolute, relative)
        let size = 0
        try {
          size = fs.statSync(absolute).size
        } catch {
          continue
        }
        if (totalBytes + size > this.deps.limits.maxMdxTotalBytes) {
          stopReason = 'mdx-byte-limit'
          return
        }
        totalBytes += size
        const fullRelative = scope.relPrefix ? `${scope.relPrefix}/${relative}` : relative
        try {
          await searchMdxFile({
            filePath: absolute,
            relativePath: fullRelative,
            query: input.query,
            caseSensitive: input.caseSensitive ?? false,
            isRegex: (input.match ?? 'literal') === 'regex',
            limits: this.deps.limits.mdx,
            signal,
            onMatch: (m) => {
              if (matches.length >= remaining) return
              matches.push({ type: 'content', source: 'mdx', path: fullRelative, ...m })
            }
          })
        } catch (error) {
          warnings.push(`${fullRelative}: ${error instanceof Error ? error.message : '读取失败'}`)
        }
      }
    }

    const workers = Array.from(
      { length: Math.max(1, this.deps.limits.mdxConcurrency) },
      () => worker()
    )
    await Promise.all(workers)

    return { matches, reason: stopReason, warnings }
  }

  private buildStringMatcher(
    query: string,
    match: 'literal' | 'regex',
    caseSensitive: boolean
  ): (value: string) => boolean {
    if (match === 'regex') {
      try {
        const re = new RegExp(query, caseSensitive ? '' : 'i')
        return (value) => re.test(value)
      } catch {
        throw new WorkspaceSearchError('REGEX_INVALID', '正则表达式无效')
      }
    }
    const needle = caseSensitive ? query : query.toLowerCase()
    return (value) => (caseSensitive ? value.includes(needle) : value.toLowerCase().includes(needle))
  }

  private runRg(
    args: string[],
    opts: { cwd: string },
    signal: AbortSignal
  ): Promise<RgRunResult> {
    return new Promise<RgRunResult>((resolve) => {
      const child: ChildProcess = this.deps.spawn(this.deps.rgPath!, args, {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        env: { PATH: process.env.PATH ?? '' }
      })

      const chunks: Buffer[] = []
      let stdout = Buffer.alloc(0)
      let killed = false
      let signalReason: 'timeout' | 'abort' | 'output-limit' | null = null

      child.stdout?.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        const total = chunks.reduce((sum, c) => sum + c.length, 0)
        if (total > this.deps.limits.maxOutputBytes) {
          killed = true
          signalReason = 'output-limit'
          child.kill()
        }
      })
      child.stderr?.on('data', () => {
        /* 忽略 stderr 正文，仅以退出码判断 */
      })

      const onAbort = (): void => {
        if (!killed && child.exitCode === null) {
          killed = true
          signalReason = 'abort'
          child.kill()
        }
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })

      const timer = setTimeout(() => {
        if (!killed && child.exitCode === null) {
          killed = true
          signalReason = 'timeout'
          child.kill()
        }
      }, this.deps.limits.timeoutMs)

      child.on('error', () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve({ stdout, code: null, killed, signalReason })
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        stdout = Buffer.concat(chunks)
        resolve({ stdout, code, killed, signalReason })
      })
    })
  }

  /** 列出工作区根目录（等价于 readDirectory('.')）。 */
  async listRoot(root: string, signal: AbortSignal): Promise<WorkspaceDirectoryResult> {
    return this.readDirectory(root, '.', signal)
  }

  /** 实时列出工作区内目录的直接子项（文件 + 子目录），过滤隐藏与排除目录。 */
  async readDirectory(
    root: string,
    scope: string,
    signal: AbortSignal
  ): Promise<WorkspaceDirectoryResult> {
    this.throwIfAborted(signal)
    const { absolute, relPrefix } = this.resolveScope(root, scope)
    const entries = fs.readdirSync(absolute, { withFileTypes: true })
    const files: DirectoryEntry[] = []
    const subDirs: string[] = []
    for (const entry of entries) {
      if (this.isExcluded(entry.name)) continue
      const full = path.join(absolute, entry.name)
      if (entry.isDirectory()) {
        subDirs.push(entry.name)
        files.push({ name: entry.name, path: full.replace(/\\/g, '/'), isDirectory: true })
      } else if (entry.isFile()) {
        files.push({ name: entry.name, path: full.replace(/\\/g, '/'), isDirectory: false })
      }
    }
    files.sort((a, b) =>
      a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1
    )
    subDirs.sort()
    const displayPath = relPrefix || '.'
    return {
      path: displayPath,
      files,
      subDirectories: subDirs,
      totalFiles: files.filter((f) => !f.isDirectory).length,
      isEmpty: files.length === 0
    }
  }

  /**
   * 读取工作区内文本文件全文。
   *
   * 保留给内部使用；AI 工具走 `readFileSlice`，以便拿到 offset/length/eof 等
   * 分块元信息。返回值同样受单次读取上限约束。
   */
  async readFile(root: string, relativePath: string, signal: AbortSignal): Promise<string> {
    const slice = await this.readFileSlice(root, relativePath, {}, signal)
    return slice.content
  }
  /**
   * 查询文件大小与可读性，供模型决定「一次读完还是分多次读」。
   *
   * 容器格式必须解包才能知道正文长度，这里直接给出 totalSize；
   * 二进制文件不抛错，而是 readable=false，让模型换别的办法。
   */
  async statFile(
    root: string,
    relativePath: string,
    signal: AbortSignal
  ): Promise<WorkspaceFileStat> {
    this.throwIfAborted(signal)
    const { absolute, stat, relative } = this.resolveExistingFile(root, relativePath)
    const format = detectWorkspaceFileFormat(relative)
    const base: WorkspaceFileStat = {
      path: relative,
      format,
      fileSize: stat.size,
      totalSize: stat.size,
      readable: true,
      modifiedAt: Math.floor(stat.mtimeMs)
    }

    if (format === 'mdx' || format === 'mindmap') {
      try {
        const text = await this.loadReadableBytes(absolute, format)
        return { ...base, totalSize: text.length, readable: true }
      } catch (error) {
        return {
          ...base,
          totalSize: 0,
          readable: false,
          reason: error instanceof Error ? error.message : '无法解包文件'
        }
      }
    }

    try {
      this.rejectBinary(this.readRange(absolute, 0, Math.min(stat.size, BINARY_PROBE_BYTES)))
    } catch {
      return { ...base, totalSize: 0, readable: false, reason: '文件是二进制内容或非 UTF-8 文本，无法按文本读取' }
    }
    return base
  }

  /**
   * 范围读取工作区文件的正文。
   *
   * - `offset` 起始字节，默认 0；落在多字节字符中间时自动对齐到下一个字符。
   * - `length` 读取字节数，默认 -1 表示读到末尾；超过单次上限时截断并给出 nextOffset。
   * - 容器格式（`.mdx` / `.inkmind`）先解包，再对解包后的正文做同样的切片，
   *   因此 offset / length 与 `statFile` 的 totalSize 是同一把尺子。
   */
  async readFileSlice(
    root: string,
    relativePath: string,
    range: { offset?: number; length?: number; maxBytes?: number },
    signal: AbortSignal
  ): Promise<WorkspaceFileSlice> {
    this.throwIfAborted(signal)
    const offsetInput = range.offset ?? 0
    const lengthInput = range.length ?? -1
    if (!Number.isInteger(offsetInput) || offsetInput < 0) {
      throw new WorkspaceSearchError('RANGE_INVALID', 'offset 必须是非负整数')
    }
    if (!Number.isInteger(lengthInput) || (lengthInput !== -1 && lengthInput < 1)) {
      throw new WorkspaceSearchError('RANGE_INVALID', 'length 必须是 -1 或正整数')
    }
    const maxReadBytes = resolveMaxReadBytes(range.maxBytes, this.deps.limits.maxReadBytes)

    const { absolute, stat, relative } = this.resolveExistingFile(root, relativePath)
    const format = detectWorkspaceFileFormat(relative)

    if (format === 'mdx' || format === 'mindmap') {
      if (stat.size > this.deps.limits.mdx.maxFileBytes) {
        throw new WorkspaceSearchError('FILE_TOO_LARGE', '文件超过大小上限')
      }
      const text = await this.loadReadableBytes(absolute, format)
      const start = Math.min(offsetInput, text.length)
      const available = text.length - start
      const wanted = lengthInput === -1 ? available : Math.min(lengthInput, available)
      const windowBytes = text.subarray(start, start + Math.min(wanted, maxReadBytes))
      return this.buildSlice(relative, format, stat.size, text.length, windowBytes, start)
    }

    // 普通文本：只探测文件头判断二进制，再按窗口读取，不整文件载入
    this.rejectBinary(this.readRange(absolute, 0, Math.min(stat.size, BINARY_PROBE_BYTES)))
    const start = Math.min(offsetInput, stat.size)
    const available = stat.size - start
    const wanted = lengthInput === -1 ? available : Math.min(lengthInput, available)
    const windowBytes = this.readRange(absolute, start, Math.min(wanted, maxReadBytes))
    return this.buildSlice(relative, format, stat.size, stat.size, windowBytes, start)
  }

  /**
   * 把一段窗口字节包装成带分块信息的读取结果。
   *
   * 窗口起点可能落在多字节字符中间（模型传入的 offset 不受字节对齐约束），
   * 先丢掉半个字符；窗口末尾同理，宁可少给一个字符也不返回乱码，
   * 这样 nextOffset 落到的永远是可解码的位置。
   */
  private buildSlice(
    relative: string,
    format: WorkspaceFileFormat,
    fileSize: number,
    totalSize: number,
    windowBytes: Buffer,
    start: number
  ): WorkspaceFileSlice {
    const leading = utf8AlignedStart(windowBytes)
    const { text, length } = decodeUtf8Window(windowBytes.subarray(leading))
    const offset = start + leading
    const eof = offset + length >= totalSize
    return {
      path: relative,
      format,
      fileSize,
      totalSize,
      offset,
      length,
      content: text,
      eof,
      truncated: !eof,
      nextOffset: eof ? null : offset + length,
      encoding: 'utf-8'
    }
  }

  /** 只读元信息：目录是否存在、是不是目录。 */
  inspectDirectory(root: string, relativePath: string): { relative: string; absolute: string } {
    const { absolute, relative } = this.resolveExistingEntry(root, relativePath)
    if (!fs.statSync(absolute).isDirectory()) {
      throw new WorkspaceSearchError('PATH_NOT_DIR', '目标不是目录')
    }
    return { relative, absolute }
  }

  /** 只读元信息：条目是否存在、是文件还是目录。 */
  inspectEntry(
    root: string,
    relativePath: string
  ): { relative: string; absolute: string; isDirectory: boolean; fileSize: number } {
    const { absolute, relative } = this.resolveExistingEntry(root, relativePath)
    const stat = fs.statSync(absolute)
    return {
      relative,
      absolute,
      isDirectory: stat.isDirectory(),
      fileSize: stat.isDirectory() ? 0 : stat.size
    }
  }

  /**
   * 解析一个「尚不存在」的路径，用于新建目录/文件。
   *
   * 与 resolveExistingFile 相反：这里不要求目标存在，但要求父目录在
   * 工作区内且真实存在，避免模型用 `a/../../x` 这类写法造出越界目标。
   */
  resolveNewPath(
    root: string,
    relativePath: string
  ): { relative: string; absolute: string; parentRelative: string; parentAbsolute: string } {
    if (path.isAbsolute(relativePath)) {
      throw new WorkspaceSearchError('PATH_INVALID', '必须使用工作区内的相对路径')
    }
    const realRoot = this.deps.realpathSync(root)
    const normalized = relativePath.replace(/\\/g, '/')
    if (!normalized || normalized.split('/').some((part) => part === '..' || part === '')) {
      throw new WorkspaceSearchError('PATH_INVALID', '路径不合法')
    }
    const absolute = path.resolve(realRoot, normalized)
    if (!isPathWithinRoot(realRoot, absolute)) {
      throw new WorkspaceSearchError('PATH_ESCAPE', '路径逃逸了工作区边界')
    }
    const parentAbsoluteRaw = path.dirname(absolute)
    let parentAbsolute: string
    try {
      parentAbsolute = this.deps.realpathSync(parentAbsoluteRaw)
    } catch {
      throw new WorkspaceSearchError('PATH_NOT_FOUND', '父目录不存在')
    }
    if (!isPathWithinRoot(realRoot, parentAbsolute)) {
      throw new WorkspaceSearchError('PATH_ESCAPE', '路径逃逸了工作区边界')
    }
    if (!fs.statSync(parentAbsolute).isDirectory()) {
      throw new WorkspaceSearchError('PATH_NOT_DIR', '父路径不是目录')
    }
    const parentRelative = path
      .relative(realRoot, parentAbsolute)
      .replace(/\\/g, '/')
    return {
      relative: path.posix.join(parentRelative, path.basename(absolute)),
      absolute: path.join(parentAbsolute, path.basename(absolute)),
      parentRelative,
      parentAbsolute
    }
  }

  private resolveExistingEntry(
    root: string,
    relativePath: string
  ): { absolute: string; relative: string } {
    if (path.isAbsolute(relativePath)) {
      throw new WorkspaceSearchError('PATH_INVALID', '必须使用工作区内的相对路径')
    }
    const realRoot = this.deps.realpathSync(root)
    const candidate = path.resolve(realRoot, relativePath)
    if (!isPathWithinRoot(realRoot, candidate)) {
      throw new WorkspaceSearchError('PATH_ESCAPE', '路径逃逸了工作区边界')
    }
    let absolute: string
    try {
      absolute = this.deps.realpathSync(candidate)
    } catch {
      throw new WorkspaceSearchError('PATH_NOT_FOUND', '路径不存在或不可访问')
    }
    if (!isPathWithinRoot(realRoot, absolute)) {
      throw new WorkspaceSearchError('PATH_ESCAPE', '路径逃逸了工作区边界')
    }
    return { absolute, relative: relativePath.replace(/\\/g, '/') }
  }

  private resolveExistingFile(
    root: string,
    relativePath: string
  ): { realRoot: string; absolute: string; stat: fs.Stats; relative: string } {
    if (path.isAbsolute(relativePath)) {
      throw new WorkspaceSearchError('PATH_INVALID', '必须使用工作区内的相对路径')
    }
    const realRoot = this.deps.realpathSync(root)
    const candidate = path.resolve(realRoot, relativePath)
    if (!isPathWithinRoot(realRoot, candidate)) {
      throw new WorkspaceSearchError('PATH_ESCAPE', '路径逃逸了工作区边界')
    }
    let absolute: string
    try {
      absolute = this.deps.realpathSync(candidate)
    } catch {
      throw new WorkspaceSearchError('PATH_NOT_FOUND', '文件不存在或不可访问')
    }
    if (!isPathWithinRoot(realRoot, absolute)) {
      throw new WorkspaceSearchError('PATH_ESCAPE', '路径逃逸了工作区边界')
    }
    const stat = fs.statSync(absolute)
    if (stat.isDirectory()) throw new WorkspaceSearchError('PATH_IS_DIR', '目标是一个目录')
    return {
      realRoot,
      absolute,
      stat,
      relative: relativePath.replace(/\\/g, '/')
    }
  }

  /** 取出可读正文的原始 UTF-8 字节（容器先解包）。 */
  private async loadReadableBytes(absolute: string, format: WorkspaceFileFormat): Promise<Buffer> {
    const bytes = fs.readFileSync(absolute)
    if (format === 'mdx') {
      const { extractMdxContentText } = await import('./mdx-content-search')
      return Buffer.from(extractMdxContentText(bytes, this.deps.limits.mdx), 'utf8')
    }
    if (format === 'mindmap') {
      const outline = readMindMapOutline(bytes)
      if (!outline) throw new WorkspaceSearchError('PATH_INVALID', '思维导图没有可读取的主题文本')
      return Buffer.from(outline, 'utf8')
    }
    return bytes
  }

  /** 从绝对路径读取一段字节，长度不足时按实际读到的返回。 */
  private readRange(absolute: string, start: number, length: number): Buffer {
    if (length <= 0) return Buffer.alloc(0)
    const fd = fs.openSync(absolute, 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      const read = fs.readSync(fd, buffer, 0, length, start)
      return read === length ? buffer : buffer.subarray(0, read)
    } finally {
      fs.closeSync(fd)
    }
  }

  private isExcluded(name: string): boolean {
    if (name === '.git' || name === 'node_modules' || name === '.inkase') return true
    return name.startsWith('.')
  }

  private rejectBinary(bytes: Uint8Array): void {
    if (!bytes.length) return
    let nul = 0
    let controls = 0
    for (const byte of bytes) {
      if (byte === 0) nul++
      if (byte < 9 || (byte > 13 && byte < 32)) controls++
    }
    if (nul > 0 || controls / bytes.length > 0.1) {
      throw new WorkspaceSearchError('BINARY_FILE', '文件不是文本内容')
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new WorkspaceSearchError('ABORTED', '搜索已取消')
  }
}


/**
 * 从容器字节里取出可读大纲。
 *
 * 单独抽成函数：`.inkmind` 是 ZIP，任何「当文本读」的入口都得先解包，
 * 否则拿到的是压缩后的二进制。
 */
export function readMindMapOutline(bytes: Buffer): string {
  let zip: AdmZip
  try {
    zip = new AdmZip(bytes)
  } catch {
    throw new WorkspaceSearchError('PATH_INVALID', '思维导图无法解压')
  }
  const mapEntry = zip.getEntries().find((entry) => entry.entryName === MINDMAP_ENTRY)
  if (!mapEntry) throw new WorkspaceSearchError('PATH_INVALID', '思维导图缺少 map.json')
  return extractMindMapOutline(mapEntry.getData().toString('utf8'))
}
