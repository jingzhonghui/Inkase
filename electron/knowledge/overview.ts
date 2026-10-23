/**
 * 知识库概览
 *
 * 首屏只需要一组计数与最近修改，没必要把整张图或整个索引推给渲染层。
 * 这里用纯函数从索引派生，**不碰文件系统、不引入 electron API**。
 *
 * 口径：
 * - 笔记只算 Markdown / MDX（PDF、图片、Office 不算笔记）；
 * - 孤立与断链都来自整库索引（孤立用 L1–L5 全量边判定，与图谱当前过滤无关）。
 */

import type { KnowledgeIndex, KnowledgeOverview, RecentNote } from '../../shared/knowledge/types'
import { buildGraph } from './graph-service'

/** 首屏「最近修改」的默认条数 */
export const OVERVIEW_RECENT_LIMIT = 5

/** 空概览（索引尚未构建或不可用时使用） */
export function emptyOverview(): KnowledgeOverview {
  return { noteCount: 0, tagCount: 0, isolatedCount: 0, brokenCount: 0, recent: [] }
}

function isNoteKind(kind: string): boolean {
  return kind === 'md' || kind === 'mdx'
}

/**
 * 从索引构建概览
 *
 * @param limit 最近修改条数，负数按 0 处理
 */
export function buildOverview(
  index: KnowledgeIndex,
  limit = OVERVIEW_RECENT_LIMIT
): KnowledgeOverview {
  const notes = Object.entries(index.files).filter(([, entry]) => isNoteKind(entry.kind))

  const recent: RecentNote[] = notes
    .map(([path, entry]) => ({ path, mtime: entry.mtime }))
    .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, limit))

  const isolatedCount = buildGraph(index).isolated.filter((id) => {
    const entry = index.files[id]
    return entry !== undefined && isNoteKind(entry.kind)
  }).length

  return {
    noteCount: notes.length,
    tagCount: Object.keys(index.tags).length,
    isolatedCount,
    brokenCount: index.unresolved.length,
    recent
  }
}
