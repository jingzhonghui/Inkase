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
import type {
  BacklinkItem,
  IndexStatus,
  KnowledgeQuery,
  LinkRef,
  SearchHit,
  TagNote
} from '../../shared/knowledge/types'
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
