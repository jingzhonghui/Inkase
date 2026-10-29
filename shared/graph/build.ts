import { buildBasenameIndex, resolveLink, type ResolveContext } from './link-resolve'
import {
  GRAPH_LINK_SOURCE_FORMATS,
  baseLabelOf,
  basenameOf,
  folderOf,
  normalizeGraphId,
  type FileLinkRecord,
  type GraphEdge,
  type GraphIssue,
  type GraphNode,
  type GraphPayload
} from './types'

/**
 * 出链记录 → 图谱数据。
 *
 * 纯函数：输入是「每个文件的出链」与「文件名索引」，输出节点 / 边 / 统计 / 问题清单。
 * 主进程建索引与渲染层重算脏标签都走这里，保证两边算出来的图完全一致。
 */

export interface BuildGraphInput {
  root: string
  /** 所有可索引文件（已带格式与出链） */
  files: readonly FileLinkRecord[]
  /** 磁盘上发现、带白名单扩展名但没能成为节点的路径（限额跳过 / 读取失败） */
  knownPaths?: readonly string[]
  /** 磁盘上存在的非文档文件（任意扩展名）。只用于给被链接到的目标补叶子节点 */
  attachmentPaths?: readonly string[]
  /** 文件系统是否大小写不敏感 */
  caseInsensitive?: boolean
  /** 是否因限额被截断 */
  truncated?: boolean
  warnings?: readonly string[]
  filesScanned?: number
  elapsedMs?: number
}

/** 同一对文件之间的链接条数上限（只是防御，正常不会触发） */
const MAX_EDGE_COUNT = 9_999

export function buildGraph(input: BuildGraphInput): GraphPayload {
  const caseInsensitive = input.caseInsensitive ?? false
  const warnings = [...(input.warnings ?? [])]

  // ===== 节点 =====
  const nodes = new Map<string, GraphNode>()
  const orderedFiles: FileLinkRecord[] = []
  for (const file of input.files) {
    const id = normalizeGraphId(file.path, caseInsensitive)
    if (nodes.has(id)) continue
    nodes.set(id, {
      id,
      path: file.path,
      label: baseLabelOf(file.path),
      format: file.format,
      folder: folderOf(file.path),
      inDegree: 0,
      outDegree: 0,
      unresolved: false
    })
    orderedFiles.push(file)
  }

  const indexed = new Set(nodes.keys())
  const known = input.knownPaths
    ? new Set(input.knownPaths.map((p) => normalizeGraphId(p, caseInsensitive)))
    : undefined
  const attachments = input.attachmentPaths
    ? new Map(
        input.attachmentPaths.map((path) => [normalizeGraphId(path, caseInsensitive), path] as const)
      )
    : undefined
  const basenames = buildBasenameIndex(
    [...nodes.values()]
      .filter((node): node is GraphNode & { path: string } => node.path !== null)
      .map((node) => ({ id: node.id, path: node.path }))
  )

  // ===== 边 =====
  interface EdgeAccumulator {
    source: string
    target: string
    count: number
    unresolved: boolean
  }
  const edges = new Map<string, EdgeAccumulator>()
  /** 幽灵节点：id → 展示用原文 */
  const ghosts = new Map<string, string>()
  const unresolvedIssues: GraphIssue[] = []
  const ambiguous = new Set<string>()

  for (const file of orderedFiles) {
    if (!GRAPH_LINK_SOURCE_FORMATS.has(file.format)) continue
    if (file.links.length === 0) continue

    const fromId = normalizeGraphId(file.path, caseInsensitive)
    const ctx: ResolveContext = {
      fromId,
      fromPath: file.path,
      indexed,
      known,
      attachments,
      basenames,
      caseInsensitive
    }

    for (const link of file.links) {
      const resolution = resolveLink(link.href, ctx)
      if (resolution.kind === 'ignore') continue

      if (resolution.kind === 'attachment') {
        // 附件节点在这里按需补：只有被链接到的非文档文件才进图，
        // 遍历阶段不读它们，所以永远没有出链。
        if (!nodes.has(resolution.targetId)) {
          nodes.set(resolution.targetId, {
            id: resolution.targetId,
            path: resolution.targetPath,
            // 附件保留扩展名：`deploy.sh` 与 `deploy.txt` 都叫 deploy 就没法区分了
            label: basenameOf(resolution.targetPath),
            format: 'attachment',
            folder: folderOf(resolution.targetPath),
            inDegree: 0,
            outDegree: 0,
            unresolved: false
          })
        }
        addEdge(edges, fromId, resolution.targetId, false)
        continue
      }

      if (resolution.kind === 'unresolved') {
        ghosts.set(resolution.ghostId, ghosts.get(resolution.ghostId) ?? link.href)
        unresolvedIssues.push({
          path: file.path,
          label: baseLabelOf(file.path),
          href: link.href,
          line: link.line
        })
        addEdge(edges, fromId, resolution.ghostId, true)
        continue
      }

      // 自环不计入边（设计文档 §5.2）
      if (resolution.targetId === fromId) continue
      if (resolution.ambiguous) ambiguous.add(basenameOf(link.href))
      addEdge(edges, fromId, resolution.targetId, false)
    }
  }

  for (const name of [...ambiguous].sort()) {
    warnings.push(`链接「${name}」在工作区内有多个同名文件，已取路径最短者`)
  }

  // ===== 幽灵节点入图 =====
  for (const [ghostId, display] of ghosts) {
    if (nodes.has(ghostId)) continue
    nodes.set(ghostId, {
      id: ghostId,
      path: null,
      label: display,
      format: 'markdown',
      folder: '',
      inDegree: 0,
      outDegree: 0,
      unresolved: true
    })
  }

  // ===== 度数 =====
  const edgeList = [...edges.values()].sort((a, b) =>
    a.source === b.source ? a.target.localeCompare(b.target) : a.source.localeCompare(b.source)
  )
  for (const edge of edgeList) {
    const source = nodes.get(edge.source)
    if (source) source.outDegree += 1
    const target = nodes.get(edge.target)
    if (target) target.inDegree += 1
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))

  // ===== 孤儿：度为 0 的真实节点（幽灵节点不算孤儿） =====
  const orphans: GraphIssue[] = nodeList
    .filter((node) => !node.unresolved && node.inDegree === 0 && node.outDegree === 0)
    .map((node) => ({
      path: node.path ?? node.id,
      label: node.label,
      href: null,
      line: null
    }))

  unresolvedIssues.sort((a, b) =>
    a.path === b.path ? (a.line ?? 0) - (b.line ?? 0) : a.path.localeCompare(b.path)
  )

  const finalEdges: GraphEdge[] = edgeList.map((edge) => ({
    source: edge.source,
    target: edge.target,
    count: edge.count,
    unresolved: edge.unresolved
  }))

  const unresolvedCount = nodeList.filter((node) => node.unresolved).length

  return {
    root: input.root,
    nodes: nodeList,
    edges: finalEdges,
    stats: {
      nodeCount: nodeList.length,
      edgeCount: finalEdges.length,
      unresolvedCount,
      orphanCount: orphans.length,
      filesScanned: input.filesScanned ?? orderedFiles.length,
      elapsedMs: input.elapsedMs ?? 0,
      truncated: input.truncated ?? false
    },
    warnings,
    resolution: {
      caseInsensitive,
      knownPaths: input.knownPaths ? [...input.knownPaths] : undefined,
      attachmentPaths: input.attachmentPaths ? [...input.attachmentPaths] : undefined
    },
    issues: {
      unresolved: unresolvedIssues,
      orphans
    }
  }
}

function addEdge(
  edges: Map<string, { source: string; target: string; count: number; unresolved: boolean }>,
  source: string,
  target: string,
  unresolved: boolean
): void {
  const key = `${source}\u0000${target}`
  const existing = edges.get(key)
  if (existing) {
    existing.count = Math.min(existing.count + 1, MAX_EDGE_COUNT)
    return
  }
  edges.set(key, { source, target, count: 1, unresolved })
}

/** 需要补进 `warnings` 的链接截断信息（抽取阶段只回报布尔值） */
export function linkTruncationWarning(relativePath: string, limit: number): string {
  return `「${relativePath}」链接数超过 ${limit} 条，已截断`
}

/** 供渲染层重算单个文件出链时复用的最小上下文 */
/**
 * 从已有 payload 重建解析上下文。
 *
 * 脏标签覆盖（§5.9）只需要替换某个节点的出边，没必要整库重建，
 * 但解析仍然要用与主进程相同的目标集合。
 */
export function buildResolveContextFromPayload(
  payload: GraphPayload,
  fromPath: string
): ResolveContext {
  const caseInsensitive = payload.resolution.caseInsensitive
  const realNodes = payload.nodes.filter(
    (node): node is GraphNode & { path: string } => node.path !== null
  )
  // 附件不进 basename 兜底：`deploy.sh` 不该被 `[x](deploy)` 这类文档链接命中
  const documentNodes = realNodes.filter((node) => node.format !== 'attachment')
  return {
    fromId: normalizeGraphId(fromPath, caseInsensitive),
    fromPath,
    indexed: new Set(documentNodes.map((node) => node.id)),
    known: payload.resolution.knownPaths
      ? new Set(payload.resolution.knownPaths.map((p) => normalizeGraphId(p, caseInsensitive)))
      : undefined,
    attachments: payload.resolution.attachmentPaths
      ? new Map(
          payload.resolution.attachmentPaths.map(
            (path) => [normalizeGraphId(path, caseInsensitive), path] as const
          )
        )
      : undefined,
    basenames: buildBasenameIndex(
      documentNodes.map((node) => ({ id: node.id, path: node.path }))
    ),
    caseInsensitive
  }
}
