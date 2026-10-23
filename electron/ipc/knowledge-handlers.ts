/**
 * 知识库 IPC 处理器
 *
 * 安全边界（与 AI 子系统一致）：
 * - 工作区根目录**只信任主进程的授权状态**（`getAuthorizedWorkspaceRoot`），
 *   绝不接受渲染进程传来的绝对路径；
 * - 渲染进程只能传库内相对路径，一律经 `resolveRelPath` 校验（拒绝绝对路径、
 *   盘符相对路径与 `..`），并复用 `isPathWithinRoot` 做最终兜底。
 */

import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import {
  DEFAULT_LAYERS,
  applyGuardrail,
  emptyGraph,
  type Graph,
  type GraphLayer
} from '../../shared/knowledge/graph'
import type {
  BacklinkItem,
  IndexStatus,
  KnowledgeQuery,
  LinkRef,
  LinkResolution,
  MentionConversion,
  MentionConversionResult,
  NoteEntry,
  SearchHit,
  TagNote
} from '../../shared/knowledge/types'
import { buildGraph } from '../knowledge/graph-service'
import { resolveRelPath } from '../knowledge/rel-path'
import { searchKnowledge } from '../knowledge/search-service'
import {
  getKnowledgeService,
  peekKnowledgeService,
  subscribeKnowledgeProgress
} from '../knowledge/service-registry'
import { getAuthorizedWorkspaceRoot } from '../workspace/workspace-authorization'
import { IPC_CHANNELS } from './channels'

const { KNOWLEDGE } = IPC_CHANNELS

/** 未授权 / 未构建时的状态 */
const IDLE_STATUS: IndexStatus = {
  state: 'idle',
  progress: { phase: 'idle', done: 0, total: 0 },
  fileCount: 0
}

/** 单次批量解析的目标上限（一篇文档的链接数远小于此） */
const RESOLVE_MAX = 500

/** 六层边的合法取值（用于校验渲染层传来的 layers） */
const VALID_LAYERS: ReadonlySet<string> = new Set<string>([
  'link',
  'resource',
  'tag',
  'relation',
  'mention',
  'folder'
])

/**
 * 收敛渲染层传来的层列表
 *
 * 非数组或全部非法时退回默认层（L6 目录边默认关闭）；
 * 空数组视为「只要节点，不要边」是合法请求，故仅在**全部非法**时兜底。
 */
function sanitizeLayers(raw: unknown): readonly GraphLayer[] {
  if (!Array.isArray(raw)) return DEFAULT_LAYERS
  if (raw.length === 0) return []
  const layers = raw.filter(
    (item): item is GraphLayer => typeof item === 'string' && VALID_LAYERS.has(item)
  )
  return layers.length > 0 ? layers : DEFAULT_LAYERS
}

/**
 * 是否启用规模护栏
 *
 * 只有渲染层明确传 `{ aggregated: false }` 才放行原图（用户点了「显示全部」）；
 * 其余任何情况（含畸形参数）都按聚合处理，安全默认。
 */
function wantsAggregation(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return true
  return (raw as { aggregated?: unknown }).aggregated !== false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

function toResult<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: unknown): { success: false; error: string } {
  return { success: false, error: errorMessage(error) }
}

/** 取已授权的工作区根；未授权即拒绝 */
function requireRoot(senderId: number): string {
  const root = getAuthorizedWorkspaceRoot(senderId)
  if (root === null) throw new Error('尚未授权工作区')
  return root
}

/**
 * 注册知识库相关 IPC 处理器。返回清理器（移除已注册的 handler）。
 */
export function registerKnowledgeHandlers(_getWindow: () => BrowserWindow | null): () => void {
  const channels = [
    KNOWLEDGE.STATUS,
    KNOWLEDGE.ENSURE,
    KNOWLEDGE.REBUILD,
    KNOWLEDGE.BACKLINKS,
    KNOWLEDGE.TAGS,
    KNOWLEDGE.NOTES_BY_TAG,
    KNOWLEDGE.SEARCH,
    KNOWLEDGE.NOTES,
    KNOWLEDGE.CONVERT_MENTION,
    KNOWLEDGE.RESOLVE,
    KNOWLEDGE.GRAPH,
    KNOWLEDGE.UNRESOLVED
  ]

  /** 每个 sender 的进度订阅；切换工作区时重新订阅 */
  const subscriptions = new Map<number, { root: string; off: () => void }>()
  const observed = new Set<number>()

  const subscribe = (sender: WebContents, root: string): void => {
    const existing = subscriptions.get(sender.id)
    if (existing?.root === root) return
    existing?.off()

    const off = subscribeKnowledgeProgress(root, (progress) => {
      if (!sender.isDestroyed()) sender.send(KNOWLEDGE.PROGRESS, progress)
    })
    subscriptions.set(sender.id, { root, off })

    if (!observed.has(sender.id)) {
      observed.add(sender.id)
      sender.once('destroyed', () => {
        subscriptions.get(sender.id)?.off()
        subscriptions.delete(sender.id)
        observed.delete(sender.id)
      })
    }
  }

  ipcMain.handle(KNOWLEDGE.STATUS, (event) => {
    try {
      const root = getAuthorizedWorkspaceRoot(event.sender.id)
      if (root === null) return toResult(IDLE_STATUS)
      return toResult(peekKnowledgeService(root)?.getStatus() ?? IDLE_STATUS)
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.ENSURE, async (event) => {
    try {
      const root = requireRoot(event.sender.id)
      const service = getKnowledgeService(root)
      subscribe(event.sender, root)
      // 磁盘上已有且未过期则直接载入，否则全量构建
      if (service.getIndex() === null && service.load() === null) {
        await service.build()
      }
      return toResult(service.getStatus())
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.REBUILD, async (event) => {
    try {
      const root = requireRoot(event.sender.id)
      const service = getKnowledgeService(root)
      subscribe(event.sender, root)
      await service.rebuild()
      return toResult(service.getStatus())
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.BACKLINKS, (event, relPath: string) => {
    try {
      const root = requireRoot(event.sender.id)
      const rel = resolveRelPath(root, relPath)
      const service = peekKnowledgeService(root)
      return toResult<BacklinkItem[]>(service?.queryBacklinks(rel) ?? [])
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.TAGS, (event) => {
    try {
      const root = requireRoot(event.sender.id)
      const service = peekKnowledgeService(root)
      return toResult(service?.queryTags() ?? [])
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.NOTES_BY_TAG, (event, tag: string) => {
    try {
      const root = requireRoot(event.sender.id)
      if (typeof tag !== 'string' || tag.trim() === '') throw new Error('标签不能为空')
      const service = peekKnowledgeService(root)
      return toResult<TagNote[]>(service?.queryNotesByTag(tag) ?? [])
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.SEARCH, async (event, query: KnowledgeQuery) => {
    try {
      const root = requireRoot(event.sender.id)
      if (query === null || typeof query !== 'object') throw new Error('查询参数无效')
      const service = peekKnowledgeService(root)
      // 查询语义全部在主进程解释，渲染层只组装 KnowledgeQuery
      return toResult<SearchHit[]>(
        await searchKnowledge(root, query, service?.getIndex() ?? null, new AbortController().signal)
      )
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.NOTES, (event) => {
    try {
      const root = requireRoot(event.sender.id)
      return toResult<NoteEntry[]>(peekKnowledgeService(root)?.listNotes() ?? [])
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.RESOLVE, (event, targets: string[], from?: string) => {
    try {
      const root = requireRoot(event.sender.id)
      if (!Array.isArray(targets)) throw new Error('目标列表无效')
      // 只接受字符串并设上限，避免渲染层构造超大请求
      const list = targets.filter((item): item is string => typeof item === 'string').slice(0, RESOLVE_MAX)
      const rel = typeof from === 'string' && from !== '' ? resolveRelPath(root, from) : undefined
      const service = peekKnowledgeService(root)
      return toResult<Record<string, LinkResolution>>(service?.resolveTargets(list, rel) ?? {})
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.CONVERT_MENTION, async (event, request: MentionConversion) => {
    try {
      const root = requireRoot(event.sender.id)
      if (typeof request !== 'object' || request === null) throw new Error('请求无效')
      const { path: relPath, line, column, raw } = request
      if (typeof relPath !== 'string' || relPath === '') throw new Error('路径无效')
      if (typeof raw !== 'string' || raw === '') throw new Error('提及文本无效')
      if (!Number.isInteger(line) || line < 1) throw new Error('行号无效')
      if (!Number.isInteger(column) || column < 1) throw new Error('列号无效')

      const service = peekKnowledgeService(root)
      if (service === null) throw new Error('索引不可用')

      const result = await service.convertMention({ path: relPath, line, column, raw })
      return toResult<MentionConversionResult>(result)
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.GRAPH, (event, layers?: unknown, options?: unknown) => {
    try {
      const root = requireRoot(event.sender.id)
      const index = peekKnowledgeService(root)?.getIndex() ?? null
      if (index === null) return toResult<Graph>(emptyGraph())
      const graph = buildGraph(index, { layers: sanitizeLayers(layers) })
      // 默认在主进程先跑护栏：聚合后的图仍然可能有上千节点，
      // 没必要把整库节点表推进渲染进程。只有用户显式「显示全部」才放行原图。
      return toResult<Graph>(wantsAggregation(options) ? applyGuardrail(graph) : graph)
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(KNOWLEDGE.UNRESOLVED, (event) => {
    try {
      const root = requireRoot(event.sender.id)
      const service = peekKnowledgeService(root)
      return toResult<LinkRef[]>(service?.getIndex()?.unresolved ?? [])
    } catch (error) {
      return fail(error)
    }
  })

  return () => {
    for (const { off } of subscriptions.values()) off()
    subscriptions.clear()
    observed.clear()
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
    }
  }
}
