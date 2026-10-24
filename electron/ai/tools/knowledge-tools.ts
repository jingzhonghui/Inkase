/**
 * 知识库只读工具
 *
 * 全部 `approval: 'never'`：读类操作不应打断用户（设计文档 §5.9 / §5.10）。
 *
 * 安全边界：
 * - 工作区根只来自 `context.snapshot.workspaceRoot`（由主进程按 sender 授权后写入）；
 * - 所有文件路径都先经 `resolveRelPath`（拒绝绝对路径、盘符路径与 `..`），
 *   再对 `realpath` 结果做一次 `isPathWithinRoot` 校验，防止符号链接逃逸。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import { z } from 'zod'
import type { GraphLayer, GraphNode } from '../../../shared/knowledge/graph'
import { isStructuralNode, type Graph } from '../../../shared/knowledge/graph'
import type {
  KnowledgeIndex,
  KnowledgeQuery,
  LinkRef,
  NodeKind,
  SearchHit
} from '../../../shared/knowledge/types'
import { buildGraph } from '../../knowledge/graph-service'
import type { KnowledgeIndexService } from '../../knowledge/index-service'
import { resolveRelPath } from '../../knowledge/rel-path'
import { searchKnowledge } from '../../knowledge/search-service'
import { getKnowledgeService } from '../../knowledge/service-registry'
import { readVaultText } from '../../knowledge/vault-text'
import { isPathWithinRoot } from '../../workspace/workspace-authorization'
import { defineTool, type ToolDefinition, type ToolExecutionContext } from '../tool-registry'

/** 单次返回的笔记条数上限 */
const MAX_NOTES = 200
/** 按任务状态筛选时最多读取的候选文件数 */
const MAX_TASK_CANDIDATES = 300
/** 图谱扩散返回节点上限 */
const MAX_EXPAND_NODES = 300
/** 断链清单返回上限 */
const MAX_BROKEN_LINKS = 500
/** 附件正文默认/最大字符数 */
const DEFAULT_ATTACHMENT_CHARS = 100_000
const MAX_ATTACHMENT_CHARS = 500_000
/** 附件文件大小上限（与来源读取一致） */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
/** PDF 页数上限 */
const MAX_PDF_PAGES = 500

/** 任务标记：`- [ ]` / `* [x]` / `+ [X]` */
const TASK_PATTERN = '^[ \\t]*[-*+] \\[([ xX])\\]'

export type AttachmentKind = 'pdf' | 'office'

export interface AttachmentTextSegment {
  /** 出处标签：`第 3 页` / `段落 2` */
  locator: string
  /** PDF 页码（1-based），非 PDF 为 undefined */
  page?: number
  text: string
}

export interface AttachmentTextResult {
  path: string
  kind: AttachmentKind
  segments: AttachmentTextSegment[]
  /** 总字符数（截断前） */
  totalChars: number
  truncated: boolean
}

export interface QueryNotesItem {
  path: string
  title: string
  kind: NodeKind
  mtime: number
  aliases: string[]
  tags: string[]
  /** 全文命中位置；仅索引筛选时为空 */
  line: number
  column: number
  preview: string
  /** 该文件的任务统计（仅在按任务状态筛选时提供） */
  tasks?: { open: number; done: number }
}

export interface QueryNotesResult {
  items: QueryNotesItem[]
  /** 满足条件的笔记总数（可能大于 items.length） */
  total: number
  truncated: boolean
}

export interface ExpandLinksNode {
  id: string
  label: string
  kind: GraphNode['kind']
  distance: number
  degree: number
  /** 首次到达该节点的边 */
  via?: {
    from: string
    to: string
    layer: GraphLayer
    direction: 'out' | 'in'
    relation?: string
    embed?: boolean
  }
}

export interface ExpandLinksResult {
  seed: { id: string; label: string; kind: GraphNode['kind']; degree: number }
  nodes: ExpandLinksNode[]
  edges: Array<{
    from: string
    to: string
    layer: GraphLayer
    relation?: string
    embed?: boolean
  }>
  truncated: boolean
}

export interface GraphOverviewResult {
  counts: {
    notes: number
    files: number
    tags: number
    isolatedNotes: number
    brokenLinks: number
    components: number
  }
  /** 度数最高的笔记 */
  central: Array<{ path: string; title: string; degree: number; kind: NodeKind }>
  /** 孤立笔记（无任何 L1–L5 边） */
  isolated: Array<{ path: string; title: string; mtime: number }>
  /** 连通分量，按节点数降序 */
  components: Array<{ size: number; sample: string[] }>
  /** 使用次数最多的标签 */
  tags: Array<{ tag: string; count: number }>
}

export interface BrokenLinkItem {
  from: string
  fromTitle: string
  target?: string
  raw: string
  kind: LinkRef['kind']
  status: LinkRef['status']
  line: number
  column: number
  context: string
  candidates?: string[]
}

export interface BrokenLinksResult {
  items: BrokenLinkItem[]
  total: number
  truncated: boolean
}

export interface KnowledgeToolDeps {
  /** 索引服务工厂（测试注入）；默认按根目录取全局注册表 */
  getService?: (root: string) => KnowledgeIndexService
  /** 结构化查询实现（测试注入） */
  search?: typeof searchKnowledge
  /** 附件正文读取实现（测试注入） */
  readAttachment?: (
    root: string,
    relPath: string,
    kind: AttachmentKind,
    maxChars: number,
    signal: AbortSignal
  ) => Promise<AttachmentTextResult>
}

export interface QueryNotesInput {
  text?: string
  regex?: string
  tags?: string[]
  props?: Record<string, string>
  paths?: string[]
  caseSensitive?: boolean
  tasks?: 'open' | 'done' | 'any'
  limit?: number
}

export interface ExpandLinksInput {
  seed: string
  depth?: number
  layers?: GraphLayer[]
  direction?: 'both' | 'out' | 'in'
  limit?: number
}

export interface GraphOverviewInput {
  top?: number
}

export interface BrokenLinksInput {
  path?: string
  limit?: number
}

export interface ReadAttachmentTextInput {
  path: string
  maxChars?: number
}

export interface KnowledgeToolRegistry {
  queryNotes: ToolDefinition<QueryNotesInput, QueryNotesResult>
  expandLinks: ToolDefinition<ExpandLinksInput, ExpandLinksResult>
  graphOverview: ToolDefinition<GraphOverviewInput, GraphOverviewResult>
  findBrokenLinks: ToolDefinition<BrokenLinksInput, BrokenLinksResult>
  readAttachmentText: ToolDefinition<ReadAttachmentTextInput, AttachmentTextResult>
}

function requireWorkspaceRoot(context: ToolExecutionContext): string {
  const root = context.snapshot.workspaceRoot
  if (!root) throw new Error('当前没有打开工作区，无法访问知识库')
  if (!path.isAbsolute(root)) throw new Error('工作区根目录无效')
  return root
}

function requireSignal(context: ToolExecutionContext): AbortSignal {
  const signal = context.abortSignal
  if (!signal) throw new Error('知识库操作缺少中止信号')
  if (signal.aborted) throw new Error('知识库操作已中止')
  return signal
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('知识库操作已中止')
}

/** 索引优先从磁盘加载；缺失或过期时增量构建 */
async function ensureIndex(service: KnowledgeIndexService): Promise<KnowledgeIndex> {
  return service.load() ?? (await service.build())
}

function titleOf(index: KnowledgeIndex, relPath: string): string {
  const entry = index.files[relPath]
  const title = entry?.props?.title
  if (typeof title === 'string' && title.trim() !== '') return title.trim()
  const normalized = relPath.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return base.replace(/\.[^./]+$/, '')
}

function isNoteKind(kind: NodeKind | undefined): boolean {
  return kind === 'md' || kind === 'mdx'
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function countTasks(text: string): { open: number; done: number } {
  const pattern = new RegExp(TASK_PATTERN, 'gm')
  let open = 0
  let done = 0
  for (const match of text.matchAll(pattern)) {
    if (match[1] === ' ' || match[1] === '') open += 1
    else done += 1
  }
  return { open, done }
}

/** 校验相对路径对应的真实路径仍在库内，并拒绝符号链接与目录 */
async function resolveVaultFile(root: string, relPath: string): Promise<{
  rel: string
  abs: string
  size: number
}> {
  const rel = resolveRelPath(root, relPath)
  const abs = path.resolve(root, rel)

  let lstat: fs.Stats
  try {
    lstat = await fs.promises.lstat(abs)
  } catch {
    throw new Error(`文件不存在或不可读：${rel}`)
  }
  if (lstat.isSymbolicLink()) throw new Error('不允许读取符号链接')
  if (!lstat.isFile()) throw new Error('目标不是文件')

  let real: string
  try {
    real = await fs.promises.realpath(abs)
  } catch {
    throw new Error(`文件不存在或不可读：${rel}`)
  }
  if (!isPathWithinRoot(root, real)) throw new Error('路径越权')

  const stat = await fs.promises.stat(real)
  if (!stat.isFile()) throw new Error('目标不是文件')
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`)
  }
  return { rel, abs: real, size: stat.size }
}

/** 从真实文件中抽取 PDF / Office 正文，带页码或段落出处 */
export async function readAttachmentTextFromDisk(
  root: string,
  relPath: string,
  kind: AttachmentKind,
  maxChars: number,
  signal: AbortSignal
): Promise<AttachmentTextResult> {
  throwIfAborted(signal)
  const { rel, abs } = await resolveVaultFile(root, relPath)

  if (kind === 'pdf') {
    const bytes = await fs.promises.readFile(abs)
    throwIfAborted(signal)
    if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('PDF 文件签名无效')
    }
    if (!bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from('%%EOF'))) {
      throw new Error('PDF 文件结尾无效')
    }

    const parser = new PDFParse({ data: bytes })
    try {
      const info = await parser.getInfo()
      if (info.total > MAX_PDF_PAGES) {
        throw new Error(`PDF 页数超过 ${MAX_PDF_PAGES} 页上限`)
      }
      const result = await parser.getText({ pageJoiner: '' })
      throwIfAborted(signal)

      const pages = result.pages
        .map((page) => ({ num: page.num, text: page.text.trim() }))
        .filter((page) => page.text !== '')
      const segments: AttachmentTextSegment[] = []
      const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0)
      let truncated = false
      let used = 0
      for (const page of pages) {
        const remaining = maxChars - used
        if (remaining <= 0) {
          truncated = true
          break
        }
        const text = page.text.length > remaining ? page.text.slice(0, remaining) : page.text
        segments.push({ locator: `第 ${page.num} 页`, page: page.num, text })
        used += text.length
        if (text.length < page.text.length) {
          truncated = true
          break
        }
      }

      if (segments.length === 0) {
        throw new Error('扫描版 PDF 无有效文本，当前版本不支持 OCR')
      }
      return { path: rel, kind, segments, totalChars, truncated }
    } finally {
      await parser.destroy()
    }
  }

  if (path.extname(rel).toLowerCase() !== '.docx') {
    throw new Error('仅支持读取 .docx 的 Office 正文（其它格式暂不支持抽取）')
  }
  const buffer = await fs.promises.readFile(abs)
  throwIfAborted(signal)
  const result = await mammoth.extractRawText({ buffer })
  throwIfAborted(signal)

  const paragraphs = result.value
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter((item) => item !== '')

  const segments: AttachmentTextSegment[] = []
  const totalChars = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0)
  let truncated = false
  let used = 0
  for (const [index, paragraph] of paragraphs.entries()) {
    const remaining = maxChars - used
    if (remaining <= 0) {
      truncated = true
      break
    }
    const text = paragraph.length > remaining ? paragraph.slice(0, remaining) : paragraph
    segments.push({ locator: `段落 ${index + 1}`, text })
    used += text.length
    if (text.length < paragraph.length) {
      truncated = true
      break
    }
  }

  if (segments.length === 0) throw new Error('文档没有可读取的正文')
  return { path: rel, kind, segments, totalChars, truncated }
}

export function createKnowledgeTools(deps: KnowledgeToolDeps = {}): KnowledgeToolRegistry {
  const getService = deps.getService ?? getKnowledgeService
  const search = deps.search ?? searchKnowledge
  const readAttachment = deps.readAttachment ?? readAttachmentTextFromDisk

  const queryNotes = defineTool<QueryNotesInput, QueryNotesResult>({
    name: 'query_notes',
    description:
      '按标签、frontmatter 属性、路径或全文关键词精确查询知识库笔记，可按未完成/已完成任务筛选。返回路径、标题、标签与命中位置；需要读取正文时再调用 read_workspace_file。',
    inputSchema: z
      .object({
        text: z.string().trim().min(1).max(500).optional(),
        regex: z.string().trim().min(1).max(500).optional(),
        tags: z.array(z.string().trim().min(1)).max(20).optional(),
        props: z.record(z.string(), z.string()).optional(),
        paths: z.array(z.string().trim().min(1)).max(20).optional(),
        caseSensitive: z.boolean().optional(),
        tasks: z.enum(['open', 'done', 'any']).optional(),
        limit: z.number().int().min(1).max(MAX_NOTES).optional()
      })
      .strict(),
    policy: {
      effect: 'read',
      approval: 'never',
      riskLevel: 'low',
      supportsRememberDecision: false
    },
    execution: 'main',
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      const signal = requireSignal(context)
      const service = getService(root)
      const index = await ensureIndex(service)
      const limit = input.limit ?? 50

      const tasks = input.tasks
      const needsTaskRead = tasks !== undefined && tasks !== 'any'
      const query: KnowledgeQuery = {
        text: input.text,
        regex: input.regex,
        tags: input.tags,
        props: input.props,
        paths: input.paths,
        caseSensitive: input.caseSensitive,
        // 任务筛选需要先拿到足够多的候选文件再逐篇统计
        limit: needsTaskRead ? MAX_TASK_CANDIDATES : limit
      }
      const hasCriteria =
        (query.regex ?? query.text ?? '') !== '' ||
        (query.tags?.length ?? 0) > 0 ||
        Object.keys(query.props ?? {}).length > 0 ||
        (query.paths?.length ?? 0) > 0

      // 没有任何条件时列出全部文件；searchKnowledge 对空查询返回空集，不能直接复用
      const hits: SearchHit[] = hasCriteria
        ? await search(root, query, index, signal)
        : Object.keys(index.files)
            .sort((a, b) => a.localeCompare(b))
            .map((rel) => ({ path: rel, line: 1, column: 1, text: '', source: 'index' as const }))
      throwIfAborted(signal)

      const byPath = new Map<string, { line: number; column: number; preview: string }>()
      for (const hit of hits) {
        if (!byPath.has(hit.path)) {
          byPath.set(hit.path, { line: hit.line, column: hit.column, preview: hit.text })
        }
      }

      let paths = [...byPath.keys()].filter((rel) => isNoteKind(index.files[rel]?.kind))
      const truncated = needsTaskRead && paths.length > MAX_TASK_CANDIDATES
      const taskCounts = new Map<string, { open: number; done: number }>()
      if (needsTaskRead) {
        paths = paths.slice(0, MAX_TASK_CANDIDATES)
        const filtered: string[] = []
        for (const rel of paths) {
          throwIfAborted(signal)
          const entry = index.files[rel]
          if (entry === undefined || !isNoteKind(entry.kind)) continue
          let text: string | null
          try {
            text = await readVaultText(path.resolve(root, rel), rel)
          } catch {
            continue
          }
          if (text === null) continue
          const counts = countTasks(text)
          if (tasks === 'open' ? counts.open === 0 : counts.done === 0) continue
          taskCounts.set(rel, counts)
          filtered.push(rel)
        }
        paths = filtered
      }

      const items: QueryNotesItem[] = paths.slice(0, limit).map((rel) => {
        const entry = index.files[rel]
        const hit = byPath.get(rel)
        const tagUses = index.tagUses[rel] ?? []
        const item: QueryNotesItem = {
          path: rel,
          title: titleOf(index, rel),
          kind: entry?.kind ?? 'other',
          mtime: entry?.mtime ?? 0,
          aliases: entry?.aliases ?? [],
          tags: unique(tagUses.map((use) => use.tag)),
          line: hit?.line ?? 1,
          column: hit?.column ?? 1,
          preview: hit?.preview ?? ''
        }
        const counts = taskCounts.get(rel)
        if (counts !== undefined) item.tasks = counts
        return item
      })

      return { items, total: paths.length, truncated: truncated || paths.length > limit }
    }
  })

  const expandLinks = defineTool<ExpandLinksInput, ExpandLinksResult>({
    name: 'expand_links',
    description:
      '从一篇种子笔记出发，沿链接、资源、标签、frontmatter 关系（可含未链接提及）做 1–3 跳扩散，返回邻居节点与边类型。用于发现与当前笔记结构相关的其它内容。',
    inputSchema: z
      .object({
        seed: z.string().trim().min(1),
        depth: z.number().int().min(1).max(3).optional(),
        layers: z.array(z.enum(['link', 'resource', 'tag', 'relation', 'mention'])).min(1).optional(),
        direction: z.enum(['both', 'out', 'in']).optional(),
        limit: z.number().int().min(1).max(MAX_EXPAND_NODES).optional()
      })
      .strict(),
    policy: {
      effect: 'read',
      approval: 'never',
      riskLevel: 'low',
      supportsRememberDecision: false
    },
    execution: 'main',
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      requireSignal(context)
      const service = getService(root)
      const index = await ensureIndex(service)

      const layers = input.layers ?? ['link', 'resource', 'tag', 'relation']
      const graph = buildGraph(index, { layers })
      const seedId = resolveSeed(index, service, input.seed, graph)
      const seed = graph.nodes.find((node) => node.id === seedId)
      if (seed === undefined) throw new Error(`种子笔记不在图谱中：${input.seed}`)

      const depth = input.depth ?? 1
      const limit = input.limit ?? 80
      const direction = input.direction ?? 'both'
      const layerSet = new Set<GraphLayer>(layers)

      const adjacency = new Map<
        string,
        Array<{ to: string; edge: Graph['edges'][number]; direction: 'out' | 'in' }>
      >()
      const push = (
        from: string,
        item: { to: string; edge: Graph['edges'][number]; direction: 'out' | 'in' }
      ): void => {
        const list = adjacency.get(from)
        if (list === undefined) adjacency.set(from, [item])
        else list.push(item)
      }
      for (const edge of graph.edges) {
        if (!layerSet.has(edge.layer)) continue
        if (direction !== 'in') push(edge.from, { to: edge.to, edge, direction: 'out' })
        if (direction !== 'out') push(edge.to, { to: edge.from, edge, direction: 'in' })
      }

      const visited = new Set<string>([seedId])
      const nodes: ExpandLinksNode[] = []
      let frontier: string[] = [seedId]
      let truncated = false

      for (let hop = 1; hop <= depth; hop++) {
        const next: string[] = []
        for (const current of frontier) {
          for (const neighbour of adjacency.get(current) ?? []) {
            if (visited.has(neighbour.to)) continue
            if (nodes.length >= limit) {
              truncated = true
              break
            }
            visited.add(neighbour.to)
            next.push(neighbour.to)
            const node = graph.nodes.find((item) => item.id === neighbour.to)
            if (node === undefined) continue
            nodes.push({
              id: node.id,
              label: node.label,
              kind: node.kind,
              distance: hop,
              degree: node.degree,
              via: {
                from: neighbour.edge.from,
                to: neighbour.edge.to,
                layer: neighbour.edge.layer,
                direction: neighbour.direction,
                relation: neighbour.edge.relation,
                embed: neighbour.edge.embed
              }
            })
          }
          if (truncated) break
        }
        if (truncated) break
        frontier = next
        if (frontier.length === 0) break
      }

      const included = new Set<string>([seedId, ...nodes.map((node) => node.id)])
      const edges = graph.edges
        .filter((edge) => included.has(edge.from) && included.has(edge.to))
        .map((edge) => ({
          from: edge.from,
          to: edge.to,
          layer: edge.layer,
          relation: edge.relation,
          embed: edge.embed
        }))

      return {
        seed: { id: seed.id, label: seed.label, kind: seed.kind, degree: seed.degree },
        nodes,
        edges,
        truncated
      }
    }
  })

  const graphOverview = defineTool<GraphOverviewInput, GraphOverviewResult>({
    name: 'graph_overview',
    description:
      '读取整库结构概览：笔记/文件/标签数量、度数最高的中心笔记、孤立笔记、连通分量与标签分布。用于判断知识库的组织状况。',
    inputSchema: z
      .object({ top: z.number().int().min(1).max(50).optional() })
      .strict(),
    policy: {
      effect: 'read',
      approval: 'never',
      riskLevel: 'low',
      supportsRememberDecision: false
    },
    execution: 'main',
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      requireSignal(context)
      const service = getService(root)
      const index = await ensureIndex(service)
      const graph = buildGraph(index)
      const top = input.top ?? 8

      const fileNodes = graph.nodes.filter((node) => !isStructuralNode(node))
      const noteNodes = fileNodes.filter((node) => isNoteKind(index.files[node.id]?.kind))

      const central = [...noteNodes]
        .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
        .slice(0, top)
        .map((node) => ({
          path: node.id,
          title: titleOf(index, node.id),
          degree: node.degree,
          kind: index.files[node.id]?.kind ?? 'other'
        }))

      const isolated = graph.isolated
        .filter((id) => isNoteKind(index.files[id]?.kind))
        .map((id) => ({
          path: id,
          title: titleOf(index, id),
          mtime: index.files[id]?.mtime ?? 0
        }))
        .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
        .slice(0, 50)

      const components = graph.components
        .map((group) => ({
          size: group.length,
          sample: group.slice(0, 5).map((id) => titleOf(index, id))
        }))
        .slice(0, 10)

      const tags = service
        .queryTags()
        .slice(0, top)
        .map((tag) => ({ tag: tag.tag, count: tag.count }))

      return {
        counts: {
          notes: noteNodes.length,
          files: fileNodes.length,
          tags: Object.keys(index.tags).length,
          isolatedNotes: graph.isolated.filter((id) => isNoteKind(index.files[id]?.kind)).length,
          brokenLinks: index.unresolved.length,
          components: graph.components.length
        },
        central,
        isolated,
        components,
        tags
      }
    }
  })

  const findBrokenLinks = defineTool<BrokenLinksInput, BrokenLinksResult>({
    name: 'find_broken_links',
    description:
      '列出知识库中的断链与歧义链接（来自索引 unresolved），包含来源文件、行号、上下文与歧义候选。可指定 path 只看某个文件。',
    inputSchema: z
      .object({
        path: z.string().trim().min(1).optional(),
        limit: z.number().int().min(1).max(MAX_BROKEN_LINKS).optional()
      })
      .strict(),
    policy: {
      effect: 'read',
      approval: 'never',
      riskLevel: 'low',
      supportsRememberDecision: false
    },
    execution: 'main',
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      requireSignal(context)
      const service = getService(root)
      const index = await ensureIndex(service)
      const limit = input.limit ?? 100

      let refs = index.unresolved
      if (input.path !== undefined) {
        const rel = resolveRelPath(root, input.path)
        refs = refs.filter((ref) => ref.from === rel)
      }

      const sorted = [...refs].sort(
        (a, b) => a.from.localeCompare(b.from) || a.line - b.line
      )
      return {
        items: sorted.slice(0, limit).map((ref) => ({
          from: ref.from,
          fromTitle: titleOf(index, ref.from),
          target: ref.target,
          raw: ref.raw,
          kind: ref.kind,
          status: ref.status,
          line: ref.line,
          column: ref.column,
          context: ref.context ?? '',
          candidates: ref.candidates
        })),
        total: sorted.length,
        truncated: sorted.length > limit
      }
    }
  })

  const readAttachmentText = defineTool<ReadAttachmentTextInput, AttachmentTextResult>({
    name: 'read_attachment_text',
    description:
      '按需读取知识库中被引用的 PDF 或 .docx 正文，返回带页码/段落出处的文本。不落盘、不写入索引；读取前会校验文件位于当前工作区内。',
    inputSchema: z
      .object({
        path: z.string().trim().min(1),
        maxChars: z.number().int().min(1_000).max(MAX_ATTACHMENT_CHARS).optional()
      })
      .strict(),
    policy: {
      effect: 'read',
      approval: 'never',
      riskLevel: 'low',
      supportsRememberDecision: false
    },
    execution: 'main',
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      const signal = requireSignal(context)
      const service = getService(root)
      const index = await ensureIndex(service)
      const rel = resolveRelPath(root, input.path)
      const entry = index.files[rel]
      if (entry === undefined) throw new Error(`文件不在知识库索引中：${rel}`)
      if (entry.kind !== 'pdf' && entry.kind !== 'office') {
        throw new Error('read_attachment_text 仅支持 PDF 与 Office 附件；笔记请用 read_workspace_file')
      }
      return readAttachment(root, rel, entry.kind, input.maxChars ?? DEFAULT_ATTACHMENT_CHARS, signal)
    }
  })

  return { queryNotes, expandLinks, graphOverview, findBrokenLinks, readAttachmentText }
}

/** 把路径、basename 或别名解析成图谱节点 id；歧义时列出候选而不是猜 */
function resolveSeed(
  index: KnowledgeIndex,
  service: KnowledgeIndexService,
  seed: string,
  graph: Graph
): string {
  const trimmed = seed.trim()
  if (trimmed.startsWith('#')) {
    if (graph.nodes.some((node) => node.id === trimmed)) return trimmed
    throw new Error(`标签不在知识库中：${trimmed}`)
  }

  const normalized = trimmed.replace(/\\/g, '/')
  if (index.files[normalized] !== undefined) return normalized

  const resolution = service.resolveTargets([trimmed], undefined)[trimmed]
  if (resolution === undefined || resolution.status === 'missing') {
    throw new Error(`找不到种子笔记：${trimmed}`)
  }
  if (resolution.status === 'ambiguous') {
    throw new Error(`种子笔记不唯一，请改用完整路径：${resolution.candidates.join('、')}`)
  }
  return resolution.targetPath
}
