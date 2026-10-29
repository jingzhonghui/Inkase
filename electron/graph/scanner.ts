import * as fs from 'node:fs'
import * as path from 'node:path'
import { extractLinksDetailed } from '../../shared/graph/link-extract'
import {
  GRAPH_LINK_SOURCE_FORMATS,
  graphFormatForPath,
  type FileLinkRecord,
  type RawLink
} from '../../shared/graph/types'
import {
  DEFAULT_MDX_SEARCH_LIMITS,
  extractMdxContentText,
  type MdxSearchLimits
} from '../workspace/mdx-content-search'

/**
 * 工作区文件遍历与「每个文件有多少条出链」的抽取。
 *
 * 三件事必须在这里做对：
 * 1. `.mdx` 是 ZIP，不能当文本读——只解 `content.md`，并沿用搜索子系统的
 *    解压限额防压缩炸弹；
 * 2. `(mtimeMs, size)` 没变的文件不重读——图谱每次打开都全量重解析会在
 *    上千文档的工作区里卡住好几秒；
 * 3. 单个文件失败不能中断整体构建，只能变成一条 warning。
 */

export interface GraphScanLimits {
  /** 索引文件数上限 */
  maxFiles: number
  /**
   * 非文档文件（任意扩展名）的记录上限。
   *
   * 它们不会被打开、也不会被读取，只是留一份路径集合来判断「链接目标是不是
   * 真实文件」。这个上限只防病态目录，正常仓库远够用。
   */
  maxKnownFiles: number
  /** 单文件原始字节上限（超出跳过） */
  maxFileBytes: number
  /** `.mdx` 解压后正文上限 */
  maxMdxContentBytes: number
  /** `.mdx` ZIP 条目数上限 */
  maxMdxEntries: number
  /** `.mdx` 压缩比上限 */
  maxMdxRatio: number
  /** 单文件链接数上限 */
  maxLinksPerFile: number
  /** 单次扫描总时限 */
  maxDurationMs: number
  /** 并发解析数 */
  concurrency: number
  /** 每处理多少个文件发一次进度 */
  progressEvery: number
  /** 目录递归深度上限（防符号链接环与病态目录树） */
  maxDepth: number
}

export const DEFAULT_GRAPH_LIMITS: GraphScanLimits = {
  maxFiles: 5000,
  maxKnownFiles: 50_000,
  maxFileBytes: 50 * 1024 * 1024,
  maxMdxContentBytes: 10 * 1024 * 1024,
  maxMdxEntries: 1_000,
  maxMdxRatio: 100,
  maxLinksPerFile: 2000,
  maxDurationMs: 20_000,
  concurrency: 4,
  progressEvery: 200,
  maxDepth: 32
}

/** 与工作区搜索保持一致的三类排除，外加所有点开头的条目 */
const EXCLUDED_DIRS = new Set(['node_modules'])

export interface GraphScanOptions {
  signal?: AbortSignal
  /** 每处理 `progressEvery` 个文件回调一次 */
  onProgress?: (scanned: number, total: number) => void
  limits?: Partial<GraphScanLimits>
}

export interface GraphScanResult {
  records: FileLinkRecord[]
  /** 磁盘上发现的全部白名单文件（含读取失败 / 被限额跳过的） */
  knownPaths: string[]
  /** 磁盘上发现的非文档文件（任意扩展名，不读内容），用于给被链接到的目标补叶子节点 */
  attachmentPaths: string[]
  truncated: boolean
  warnings: string[]
  filesScanned: number
}

interface CacheEntry {
  mtimeMs: number
  size: number
  links: RawLink[]
}

const MAX_WARNINGS = 50

function isBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

export class GraphScanner {
  /** 工作区根 → 相对路径 → 缓存条目 */
  private readonly caches = new Map<string, Map<string, CacheEntry>>()

  /** 切换工作区根时清空对应缓存（不传则全清） */
  invalidateWorkTree(root?: string): void {
    if (root === undefined) this.caches.clear()
    else this.caches.delete(path.resolve(root))
  }

  private cacheFor(root: string): Map<string, CacheEntry> {
    const key = path.resolve(root)
    let cache = this.caches.get(key)
    if (!cache) {
      cache = new Map<string, CacheEntry>()
      this.caches.set(key, cache)
    }
    return cache
  }

  async scan(root: string, options: GraphScanOptions = {}): Promise<GraphScanResult> {
    const limits: GraphScanLimits = { ...DEFAULT_GRAPH_LIMITS, ...options.limits }
    const warnings: string[] = []
    const cache = this.cacheFor(root)
    const startedAt = Date.now()

    const addWarning = (message: string): void => {
      if (warnings.length < MAX_WARNINGS) warnings.push(message)
      else if (warnings.length === MAX_WARNINGS) warnings.push('（更多警告已省略）')
    }

    const listed = await this.listFiles(root, limits, addWarning)
    const total = listed.paths.length
    const records: FileLinkRecord[] = []
    let scanned = 0
    let truncated = listed.truncated
    let timedOut = false

    // 缓存里已经消失的文件要剔除，否则重命名后旧条目会一直占着位置
    const livePaths = new Set(listed.paths)
    for (const cachedPath of [...cache.keys()]) {
      if (!livePaths.has(cachedPath)) cache.delete(cachedPath)
    }

    const worker = async (): Promise<void> => {
      for (;;) {
        if (options.signal?.aborted) return
        if (timedOut) return
        const index = scanned++
        if (index >= listed.paths.length) return
        if (Date.now() - startedAt > limits.maxDurationMs) {
          timedOut = true
          return
        }

        const relativePath = listed.paths[index]
        const record = await this.readOne(root, relativePath, cache, limits, addWarning)
        if (record) records.push(record)

        const processed = index + 1
        if (options.onProgress && (processed % limits.progressEvery === 0 || processed === total)) {
          options.onProgress(processed, total)
        }
      }
    }

    const workerCount = Math.min(limits.concurrency, Math.max(1, listed.paths.length))
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    if (timedOut) {
      truncated = true
      addWarning(`索引超过 ${Math.round(limits.maxDurationMs / 1000)} 秒，已返回部分结果`)
    }

    // 并行读取让 records 乱序，排一下保证同一份数据每次构建结果一致
    records.sort((a, b) => a.path.localeCompare(b.path))

    return {
      records,
      knownPaths: listed.paths,
      attachmentPaths: listed.attachmentPaths,
      truncated,
      warnings,
      filesScanned: records.length
    }
  }

  /**
   * 重算单个文件的出链。
   *
   * 写入链接之后用它就地替换该节点的出边——不必为了看一条新边而整库重建。
   * 缓存仍然生效：文件没变就直接命中。
   */
  async scanFile(
    root: string,
    relativePath: string,
    limits: GraphScanLimits = DEFAULT_GRAPH_LIMITS
  ): Promise<FileLinkRecord | null> {
    const warnings: string[] = []
    const record = await this.readOne(root, relativePath, this.cacheFor(root), limits, (message) =>
      warnings.push(message)
    )
    return record
  }

  private async readOne(
    root: string,
    relativePath: string,
    cache: Map<string, CacheEntry>,
    limits: GraphScanLimits,
    addWarning: (message: string) => void
  ): Promise<FileLinkRecord | null> {    const format = graphFormatForPath(relativePath)
    if (!format) return null

    const absolutePath = path.join(root, ...relativePath.split('/'))

    if (!GRAPH_LINK_SOURCE_FORMATS.has(format)) {
      // 导图 / 图表不读内容，也就没有出链；不需要 stat 与缓存
      return { path: relativePath, format, links: [] }
    }

    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(absolutePath)
    } catch {
      addWarning(`无法读取「${relativePath}」，已跳过`)
      return null
    }

    if (stat.size > limits.maxFileBytes) {
      addWarning(`「${relativePath}」超过 ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB，已跳过`)
      return null
    }

    const cached = cache.get(relativePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { path: relativePath, format, links: cached.links }
    }

    let content: string
    try {
      content =
        format === 'mdx'
          ? await readMdxContent(absolutePath, stat.size, limits)
          : await readPlainText(absolutePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取失败'
      addWarning(`「${relativePath}」解析失败（${message}），已跳过`)
      return null
    }

    const extracted = extractLinksDetailed(content, limits.maxLinksPerFile)
    if (extracted.truncated) {
      addWarning(`「${relativePath}」链接数超过 ${limits.maxLinksPerFile} 条，已截断`)
    }

    cache.set(relativePath, { mtimeMs: stat.mtimeMs, size: stat.size, links: extracted.links })
    return { path: relativePath, format, links: extracted.links }
  }

  private async listFiles(
    root: string,
    limits: GraphScanLimits,
    addWarning: (message: string) => void
  ): Promise<{ paths: string[]; attachmentPaths: string[]; truncated: boolean }> {
    const paths: string[] = []
    const attachmentPaths: string[] = []
    let truncated = false
    let knownCapped = false

    const walk = async (absoluteDir: string, prefix: string, depth: number): Promise<void> => {
      if (truncated) return
      if (depth > limits.maxDepth) {
        addWarning(`目录层级超过 ${limits.maxDepth} 层，已停止向下遍历`)
        return
      }

      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true })
      } catch {
        addWarning(`无法读取目录「${prefix || '.'}」，已跳过`)
        return
      }

      entries.sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        if (truncated) return
        // 所有点开头的条目一律跳过：.git / .inkase / .obsidian / .trash 都在此列
        if (entry.name.startsWith('.')) continue
        if (entry.isSymbolicLink()) continue

        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue
          await walk(path.join(absoluteDir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name, depth + 1)
          continue
        }

        if (!entry.isFile()) continue

        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

        if (!graphFormatForPath(entry.name)) {
          // 非文档文件：只记路径不读内容。有了它，链接到 .sh / .pdf / 图片
          // 才能在图上落到一个真实节点上，而不是凭空消失。
          if (attachmentPaths.length >= limits.maxKnownFiles) {
            if (!knownCapped) {
              knownCapped = true
              addWarning(
                `非文档文件超过 ${limits.maxKnownFiles} 个，超出部分的链接目标会被当作不存在`
              )
            }
            continue
          }
          attachmentPaths.push(relativePath)
          continue
        }

        if (paths.length >= limits.maxFiles) {
          truncated = true
          addWarning(`已扫描至上限 ${limits.maxFiles} 个文件，结果可能不完整`)
          return
        }
        paths.push(relativePath)
      }
    }

    await walk(root, '', 0)
    paths.sort((a, b) => a.localeCompare(b))
    attachmentPaths.sort((a, b) => a.localeCompare(b))
    return { paths, attachmentPaths, truncated }
  }
}

/** `.mdx` 只解正文，沿用搜索子系统的解压限额 */
async function readMdxContent(
  absolutePath: string,
  size: number,
  limits: GraphScanLimits
): Promise<string> {
  const buffer = Buffer.allocUnsafe(size)
  const handle = await fs.promises.open(absolutePath, 'r')
  try {
    const { bytesRead } = await handle.read(buffer, 0, size, 0)
    if (bytesRead !== size) throw new Error('读取不完整')
  } finally {
    await handle.close().catch(() => {})
  }

  const mdxLimits: MdxSearchLimits = {
    ...DEFAULT_MDX_SEARCH_LIMITS,
    maxFileBytes: limits.maxFileBytes,
    maxContentBytes: limits.maxMdxContentBytes,
    maxZipEntries: limits.maxMdxEntries,
    maxZipRatio: limits.maxMdxRatio
  }
  return extractMdxContentText(buffer, mdxLimits)
}

async function readPlainText(absolutePath: string): Promise<string> {
  const buffer = await fs.promises.readFile(absolutePath)
  if (isBinary(buffer)) throw new Error('疑似二进制文件')
  return buffer.toString('utf8')
}

/** 工作区相对路径 → 绝对路径（拒绝越界） */
export function resolveWithinRoot(root: string, relativePath: string): string | null {
  const normalizedRoot = path.resolve(root)
  const absolute = path.resolve(normalizedRoot, ...relativePath.split('/'))
  const relative = path.relative(normalizedRoot, absolute)
  if (relative === '') return absolute
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute
}
