import { buildGraph } from '../../shared/graph/build'
import type { FileLinkRecord, GraphPayload } from '../../shared/graph/types'
import {
  DEFAULT_GRAPH_LIMITS,
  GraphScanner,
  type GraphScanLimits,
  type GraphScanResult
} from './scanner'

/**
 * 索引编排：把「扫描」与「构建」两步串起来，并负责进度、取消与限额。
 *
 * 扫描器实例挂在服务上而不是每次新建——`(mtimeMs, size)` 缓存就活在里面，
 * 第二次打开图谱只重解析真正变过的文件。
 */

/** 构建被取消（切换工作区）。渲染层应当静默忽略，不要弹错误。 */
export class GraphBuildCancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'GraphBuildCancelledError'
  }
}

export interface GraphBuildOptions {
  signal?: AbortSignal
  onProgress?: (scanned: number, total: number) => void
  limits?: Partial<GraphScanLimits>
}

/**
 * 文件系统是否大小写不敏感。
 *
 * Windows 与 macOS 默认卷都是不敏感——不折叠会让 `Notes/a.md` 与
 * `notes/a.md` 变成两个互不相连的节点。
 */
export function isCaseInsensitiveFileSystem(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

export class GraphService {
  private readonly scanner = new GraphScanner()

  /** 构建整库图谱 */
  async build(root: string, options: GraphBuildOptions = {}): Promise<GraphPayload> {
    const startedAt = Date.now()
    const limits: GraphScanLimits = { ...DEFAULT_GRAPH_LIMITS, ...options.limits }

    const scan: GraphScanResult = await this.scanner.scan(root, {
      signal: options.signal,
      onProgress: options.onProgress,
      limits
    })

    if (options.signal?.aborted) throw new GraphBuildCancelledError()

    return buildGraph({
      root,
      files: scan.records,
      knownPaths: scan.knownPaths,
      attachmentPaths: scan.attachmentPaths,
      caseInsensitive: isCaseInsensitiveFileSystem(),
      truncated: scan.truncated,
      warnings: scan.warnings,
      filesScanned: scan.filesScanned,
      elapsedMs: Date.now() - startedAt
    })
  }

  /** 单文件重算（写入链接之后就地把这个节点的出边换掉，不必整库重建） */
  async refreshFile(
    root: string,
    relativePath: string,
    limits?: Partial<GraphScanLimits>
  ): Promise<FileLinkRecord | null> {
    return this.scanner.scanFile(root, relativePath, { ...DEFAULT_GRAPH_LIMITS, ...limits })
  }

  /** 工作区切换或文件变动后丢弃缓存 */
  invalidate(root?: string): void {
    this.scanner.invalidateWorkTree(root)
  }
}

/** 进程内单例：缓存要跨多次 build 存活 */
let sharedService: GraphService | null = null

export function getGraphService(): GraphService {
  if (!sharedService) sharedService = new GraphService()
  return sharedService
}
