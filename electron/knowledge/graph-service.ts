/**
 * 图谱聚合：由知识索引构建六层边
 *
 * 从索引派生出 L1–L6 边与节点表。图上的纯操作（`focusSubgraph` /
 * `applyGuardrail`）在 `shared/knowledge/graph.ts`，因为渲染层也要用到它们；
 * 本模块只负责「索引 → 图」，**不碰文件系统、不引入 electron API**。
 *
 * 六层边：
 * - L1 `link`     显式引用（`[[链接]]` / Markdown 链接）——图谱骨架
 * - L2 `resource` 资源引用（笔记 → 图片/PDF/Office/附件）——让非文本成为一等节点
 * - L3 `tag`      标签（二部图：笔记 ↔ 标签节点）
 * - L4 `relation` frontmatter `up` / `related` / `source`——手工编织的高价值关系
 * - L5 `mention`  未链接提及——建链抓手
 * - L6 `folder`   目录层级——默认关闭，且**不参与度数**
 *
 * 明确不做：语义相似边（无向量）、共现/时间边（噪声大、不可解释）。
 */

import {
  DEFAULT_LAYERS,
  computeComponents,
  computeDegree,
  isStructuralNode,
  type Graph,
  type GraphEdge,
  type GraphLayer,
  type GraphNode
} from '../../shared/knowledge/graph'
import type { KnowledgeIndex, NodeKind } from '../../shared/knowledge/types'
import { buildLinkIndex, resolveLink } from './link-resolver'

export type {
  Graph,
  GraphEdge,
  GraphLayer,
  GraphNode,
  GraphNodeKind
} from '../../shared/knowledge/graph'
export {
  DEFAULT_LAYERS,
  GUARDRAIL_LIMIT,
  MAX_FOCUS_DEPTH,
  MIN_FOCUS_DEPTH,
  applyGuardrail,
  focusSubgraph
} from '../../shared/knowledge/graph'

/** frontmatter 中参与 L4 的关系字段 */
const RELATION_FIELDS = ['up', 'related', 'source'] as const

/** 属于「笔记」的文件类型；其余类型走 L2 资源边 */
const NOTE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['md', 'mdx'])

export interface BuildGraphOptions {
  /** 启用的层；默认 `DEFAULT_LAYERS` */
  layers?: readonly GraphLayer[]
}

/** 取 basename 并去掉最后一级扩展名 */
function labelOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return base.replace(/\.[^./]+$/, '')
}

/** 取顶层目录（`''` 表示库根） */
function topFolderOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const at = normalized.indexOf('/')
  return at === -1 ? '' : normalized.slice(0, at)
}

/** 取完整目录路径（`''` 表示库根） */
function dirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const at = normalized.lastIndexOf('/')
  return at === -1 ? '' : normalized.slice(0, at)
}

/**
 * L1 + L2：把已解析的出链拆成链接边与资源边
 *
 * 未解析（`missing` / `ambiguous`）的引用不建边——图谱不凭空造节点，
 * 断链由断链清单负责（设计文档 §5.5）。
 */
function collectLinkEdges(index: KnowledgeIndex, edges: GraphEdge[]): void {
  for (const refs of Object.values(index.outgoing)) {
    for (const ref of refs) {
      if (ref.status !== 'resolved' || ref.to === undefined) continue
      const target = index.files[ref.to]
      // 目标不在索引里（可能刚被删）时也跳过，保证边两端都是已知节点
      if (target === undefined) continue

      const layer: GraphLayer = NOTE_KINDS.has(target.kind) ? 'link' : 'resource'
      edges.push(
        layer === 'link' && ref.kind === 'embed'
          ? { from: ref.from, to: ref.to, layer, embed: true }
          : { from: ref.from, to: ref.to, layer }
      )
    }
  }
}

/** L3：笔记 → 标签节点（同一标签在一次构建里只连一次） */
function collectTagEdges(index: KnowledgeIndex, edges: GraphEdge[]): void {
  for (const [path, uses] of Object.entries(index.tagUses)) {
    const seen = new Set<string>()
    for (const use of uses) {
      if (seen.has(use.tag)) continue
      seen.add(use.tag)
      edges.push({ from: path, to: `#${use.tag}`, layer: 'tag' })
    }
  }
}

/**
 * L4：frontmatter 关系字段
 *
 * 字段值按索引约定以 `,` 连接，逐项按链接规则解析（basename / 别名 / 路径），
 * 解析不出来就丢弃——绝不猜。
 */
function collectRelationEdges(index: KnowledgeIndex, edges: GraphEdge[]): void {
  const linkIndex = buildLinkIndex(Object.keys(index.files), aliasesOf(index))

  for (const [path, file] of Object.entries(index.files)) {
    if (file.props === undefined) continue
    for (const field of RELATION_FIELDS) {
      const value = file.props[field]
      if (value === undefined || value.trim() === '') continue

      for (const candidate of value.split(',')) {
        const name = candidate.trim()
        if (name === '') continue
        const resolution = resolveLink(name, linkIndex, path)
        if (resolution.status !== 'resolved') continue
        if (resolution.targetPath === path) continue
        edges.push({ from: path, to: resolution.targetPath, layer: 'relation', relation: field })
      }
    }
  }
}

/** L5：未链接提及（同一对 (来源, 目标) 只连一次） */
function collectMentionEdges(index: KnowledgeIndex, edges: GraphEdge[]): void {
  for (const [path, mentions] of Object.entries(index.mentions)) {
    const seen = new Set<string>()
    for (const mention of mentions) {
      if (mention.targetPath === path) continue
      if (index.files[mention.targetPath] === undefined) continue
      if (seen.has(mention.targetPath)) continue
      seen.add(mention.targetPath)
      edges.push({ from: path, to: mention.targetPath, layer: 'mention' })
    }
  }
}

/**
 * L6：目录层级树
 *
 * 目录节点 + 父目录 → 子目录 / 父目录 → 直属笔记。默认关闭，且不参与度数。
 */
function collectFolderEdges(
  index: KnowledgeIndex,
  edges: GraphEdge[],
  folderIds: Set<string>
): void {
  for (const path of Object.keys(index.files)) {
    const dir = dirOf(path)
    if (dir === '') continue

    // 逐级补齐祖先目录，保证树是连通的
    const segments = dir.split('/')
    for (let i = 1; i <= segments.length; i++) {
      const current = segments.slice(0, i).join('/')
      if (folderIds.has(current)) continue
      folderIds.add(current)
      if (i > 1) {
        edges.push({
          from: `folder:${segments.slice(0, i - 1).join('/')}`,
          to: `folder:${current}`,
          layer: 'folder'
        })
      }
    }
    edges.push({ from: `folder:${dir}`, to: path, layer: 'folder' })
  }
}

function aliasesOf(index: KnowledgeIndex): Record<string, string[]> {
  const aliases: Record<string, string[]> = {}
  for (const [path, file] of Object.entries(index.files)) {
    if (file.aliases !== undefined) aliases[path] = file.aliases
  }
  return aliases
}

/**
 * 由索引聚合图谱
 *
 * 孤立判定始终基于 **L1–L5 全量边**，与当前开启的层无关——孤立是库的属性，
 * 不该因为用户临时关掉标签层就变。度数则只统计**实际输出**的边（不含 L6），
 * 这样节点大小与看到的图一致。
 */
export function buildGraph(index: KnowledgeIndex, options: BuildGraphOptions = {}): Graph {
  const layers = new Set<GraphLayer>(options.layers ?? DEFAULT_LAYERS)

  // 先无条件算 L1–L5，用于孤立判定
  const baseEdges: GraphEdge[] = []
  collectLinkEdges(index, baseEdges)
  collectTagEdges(index, baseEdges)
  collectRelationEdges(index, baseEdges)
  collectMentionEdges(index, baseEdges)

  const folderIds = new Set<string>()
  const folderEdges: GraphEdge[] = []
  if (layers.has('folder')) collectFolderEdges(index, folderEdges, folderIds)

  const edges = baseEdges.filter((edge) => layers.has(edge.layer))
  if (layers.has('folder')) edges.push(...folderEdges)

  // 节点：所有已知文件（含非笔记资源）+ 标签 + 目录
  const nodes: GraphNode[] = []

  for (const [path, file] of Object.entries(index.files)) {
    nodes.push({
      id: path,
      kind: file.kind,
      label: labelOf(path),
      folder: topFolderOf(path),
      degree: 0,
      isolated: false
    })
  }

  if (layers.has('tag')) {
    const tagIds = new Set<string>()
    for (const edge of baseEdges) {
      if (edge.layer === 'tag') tagIds.add(edge.to)
    }
    for (const tagId of tagIds) {
      nodes.push({ id: tagId, kind: 'tag', label: tagId, folder: '', degree: 0, isolated: false })
    }
  }

  for (const folderId of folderIds) {
    nodes.push({
      id: `folder:${folderId}`,
      kind: 'folder',
      label: folderId.slice(folderId.lastIndexOf('/') + 1),
      folder: topFolderOf(folderId),
      degree: 0,
      isolated: false
    })
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id))

  const degrees = computeDegree(edges)
  for (const node of nodes) node.degree = degrees.get(node.id) ?? 0

  // 孤立：在全量 L1–L5 边里没有任何连接
  const touched = new Set<string>()
  for (const edge of baseEdges) {
    touched.add(edge.from)
    touched.add(edge.to)
  }
  const isolated: string[] = []
  for (const node of nodes) {
    node.isolated = !isStructuralNode(node) && !touched.has(node.id)
    if (node.isolated) isolated.push(node.id)
  }

  return {
    nodes,
    edges,
    isolated: isolated.sort((a, b) => a.localeCompare(b)),
    components: computeComponents(
      nodes.filter((node) => !isStructuralNode(node)).map((node) => node.id),
      edges
    ),
    aggregated: false,
    hiddenCount: 0
  }
}
