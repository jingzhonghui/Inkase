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
  WorkspaceDirectoryResult
} from '../../shared/ai/types'
import { resolveRgPath } from './rg-resolver'
import { isPathWithinRoot } from './workspace-authorization'
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
}

export const DEFAULT_SEARCH_LIMITS: WorkspaceSearchLimits = {
  timeoutMs: 30_000,
  maxResults: 100,
  defaultMaxResults: 50,
  maxOutputBytes: 1024 * 1024,
  maxPreviewLength: 500,
  mdx: DEFAULT_MDX_SEARCH_LIMITS,
  maxMdxTotalBytes: 200 * 1024 * 1024,
  mdxConcurrency: 4
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

  /** 读取工作区内文本文件（md/mdx/txt/代码等），有界、拒绝二进制与目录。 */
  async readFile(root: string, relativePath: string, signal: AbortSignal): Promise<string> {
    this.throwIfAborted(signal)
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
    if (stat.size > this.deps.limits.mdx.maxFileBytes) {
      throw new WorkspaceSearchError('FILE_TOO_LARGE', '文件超过大小上限')
    }

    const bytes = fs.readFileSync(absolute)
    if (relativePath.toLowerCase().endsWith('.mdx')) {
      const { extractMdxContentText } = await import('./mdx-content-search')
      return extractMdxContentText(bytes, this.deps.limits.mdx)
    }

    this.rejectBinary(bytes)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new WorkspaceSearchError('NOT_UTF8', '文件不是有效的 UTF-8 文本')
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
