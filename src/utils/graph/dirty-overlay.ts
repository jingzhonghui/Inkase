import { buildResolveContextFromPayload } from '../../../shared/graph/build'
import { extractLinks } from '../../../shared/graph/link-extract'
import { resolveLink } from '../../../shared/graph/link-resolve'
import {
  GRAPH_LINK_SOURCE_FORMATS,
  baseLabelOf,
  basenameOf,
  folderOf,
  normalizeGraphId,
  type GraphEdge,
  type GraphIssue,
  type GraphNode,
  type GraphPayload
} from '../../../shared/graph/types'

/**
 * 脏标签覆盖（设计文档 §5.9）。
 *
 * 索引读的是磁盘，但用户可能刚写完一条链接还没保存。这里用**与主进程完全
 * 相同的**抽取与解析规则，在内存里把「已打开且已修改」的标签的出边换掉，
 * 于是新建笔记、刚建立的链接立刻就能在图上看到，不必等保存、也不必整库重建。
 */

export interface DirtyGraphFile {
  /** 工作区相对 POSIX 路径 */
  path: string
  content: string
}

/** 覆盖这些节点的出边 */
export function applyDirtyOverlay(
  payload: GraphPayload,
  dirtyFiles: readonly DirtyGraphFile[]
): GraphPayload {
  const caseInsensitive = payload.resolution.caseInsensitive

  const overridden = new Map<string, DirtyGraphFile>()
  for (const file of dirtyFiles) {
    const id = normalizeGraphId(file.path, caseInsensitive)
    overridden.set(id, file)
  }
  if (overridden.size === 0) return payload

  // 必须浅拷贝：`payload` 由 store 长期持有，覆盖结果得是新对象，
  // 否则下面清零 / 累加度数会渗回原始索引（节点半径按 inDegree 缩放，画出来就是错的）。
  // 节点字段都是标量，浅拷贝足够。
  const nodes = new Map<string, GraphNode>(payload.nodes.map((node) => [node.id, { ...node }]))
  // 只有真正在图里的文件才需要覆盖；未索引的文件改不成节点
  const effective = new Map<string, DirtyGraphFile>()
  for (const [id, file] of overridden) {
    const node = nodes.get(id)
    if (node && !node.unresolved && GRAPH_LINK_SOURCE_FORMATS.has(node.format)) {
      effective.set(id, file)
    }
  }
  if (effective.size === 0) return payload

  // ===== 先摘掉被覆盖节点的全部出边 =====
  const edges = new Map<string, GraphEdge>()
  for (const edge of payload.edges) {
    if (effective.has(edge.source)) continue
    edges.set(`${edge.source}\u0000${edge.target}`, { ...edge })
  }

  const unresolvedIssues: GraphIssue[] = payload.issues.unresolved.filter(
    (issue) => !effective.has(normalizeGraphId(issue.path, caseInsensitive))
  )

  // ===== 按缓冲区内容重新解析 =====
  for (const [fromId, file] of effective) {
    const ctx = buildResolveContextFromPayload(payload, file.path)
    for (const link of extractLinks(file.content)) {
      const resolution = resolveLink(link.href, ctx)
      if (resolution.kind === 'ignore') continue

      if (resolution.kind === 'attachment') {
        // 与 build.ts 保持同一套规则：按需补附件叶子节点
        if (!nodes.has(resolution.targetId)) {
          nodes.set(resolution.targetId, {
            id: resolution.targetId,
            path: resolution.targetPath,
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
        if (!nodes.has(resolution.ghostId)) {
          nodes.set(resolution.ghostId, {
            id: resolution.ghostId,
            path: null,
            label: link.href,
            format: 'markdown',
            folder: '',
            inDegree: 0,
            outDegree: 0,
            unresolved: true
          })
        }
        unresolvedIssues.push({
          path: file.path,
          label: baseLabelOf(file.path),
          href: link.href,
          line: link.line
        })
        addEdge(edges, fromId, resolution.ghostId, true)
        continue
      }

      if (resolution.targetId === fromId) continue
      addEdge(edges, fromId, resolution.targetId, false)
    }
  }

  // ===== 重算度数 =====
  for (const node of nodes.values()) {
    node.inDegree = 0
    node.outDegree = 0
  }

  const finalEdges: GraphEdge[] = [...edges.values()].sort((a, b) =>
    a.source === b.source ? a.target.localeCompare(b.target) : a.source.localeCompare(b.source)
  )

  for (const edge of finalEdges) {
    const source = nodes.get(edge.source)
    if (source) source.outDegree += 1
    const target = nodes.get(edge.target)
    if (target) target.inDegree += 1
  }

  // 没有任何边指向的幽灵节点要收掉，否则它会一直挂在小地图上
  for (const [id, node] of [...nodes]) {
    if (node.unresolved && node.inDegree === 0 && node.outDegree === 0) nodes.delete(id)
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))
  const orphans: GraphIssue[] = nodeList
    .filter((node) => !node.unresolved && node.inDegree === 0 && node.outDegree === 0)
    .map((node) => ({ path: node.path ?? node.id, label: node.label, href: null, line: null }))

  unresolvedIssues.sort((a, b) =>
    a.path === b.path ? (a.line ?? 0) - (b.line ?? 0) : a.path.localeCompare(b.path)
  )

  return {
    ...payload,
    nodes: nodeList,
    edges: finalEdges,
    stats: {
      ...payload.stats,
      nodeCount: nodeList.length,
      edgeCount: finalEdges.length,
      unresolvedCount: nodeList.filter((node) => node.unresolved).length,
      orphanCount: orphans.length
    },
    issues: { unresolved: unresolvedIssues, orphans }
  }
}

function addEdge(
  edges: Map<string, GraphEdge>,
  source: string,
  target: string,
  unresolved: boolean
): void {
  const key = `${source}\u0000${target}`
  const existing = edges.get(key)
  if (existing) {
    existing.count = Math.min(existing.count + 1, 9_999)
    return
  }
  edges.set(key, { source, target, count: 1, unresolved })
}

/**
 * 绝对路径 → 工作区相对 POSIX 路径。
 *
 * 拿不到相对路径（文件不在工作区内）时返回 null：这类标签不该参与覆盖。
 */
export function toWorkspaceRelative(root: string, absolutePath: string): string | null {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedRoot = normalize(root)
  const normalizedPath = normalize(absolutePath)
  if (!normalizedRoot) return null

  const caseInsensitive = /^[a-zA-Z]:/.test(normalizedRoot)
  const rootForCompare = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot
  const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath

  if (pathForCompare === rootForCompare) return null
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null
  return normalizedPath.slice(normalizedRoot.length + 1)
}
