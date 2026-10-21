/**
 * 结构化查询解释（主进程）
 *
 * 查询语义全部在此解释，渲染层只组装 `KnowledgeQuery` 并展示结果——
 * 这样渲染层永远不需要接触 fs 或 ripgrep。
 *
 * 组合规则：
 * - `tags` / `props` / `paths` 走索引，彼此取**交集**（各自内部也是 AND）；
 * - `text` / `regex` 走 `WorkspaceSearchService`（ripgrep，`.mdx` 由主进程解包搜索），
 *   结果再与索引筛选出的候选集取交集；
 * - 只有筛选条件、没有文本条件时，直接返回索引命中（每个文件一条）。
 */

import * as fs from 'node:fs'
import { spawn } from 'node:child_process'
import type {
  KnowledgeIndex,
  KnowledgeQuery,
  SearchHit
} from '../../shared/knowledge/types'
import { resolveRgPath } from '../workspace/rg-resolver'
import {
  DEFAULT_SEARCH_LIMITS,
  WorkspaceSearchService
} from '../workspace/workspace-search-service'

/** 默认结果上限（设计文档 §5.6） */
export const DEFAULT_QUERY_LIMIT = 200
/** 上限硬顶，防止渲染层请求过大结果集 */
export const MAX_QUERY_LIMIT = 500

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT
  return Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(limit)))
}

/**
 * 用索引条件筛出候选文件集
 *
 * @returns 候选路径集合；没有任何索引条件时返回 null（表示「全集」）
 */
export function matchIndexFilters(
  index: KnowledgeIndex,
  query: KnowledgeQuery
): Set<string> | null {
  let candidates: Set<string> | null = null

  const intersect = (next: Set<string>): void => {
    if (candidates === null) {
      candidates = next
      return
    }
    for (const path of [...candidates]) {
      if (!next.has(path)) candidates.delete(path)
    }
  }

  if (query.paths !== undefined && query.paths.length > 0) {
    const needles = query.paths.map((item) => item.toLowerCase())
    intersect(
      new Set(
        Object.keys(index.files).filter((file) =>
          needles.some((needle) => file.toLowerCase().includes(needle))
        )
      )
    )
  }

  if (query.tags !== undefined && query.tags.length > 0) {
    // 多标签为 AND：逐个与倒排表取交集
    for (const tag of query.tags) {
      intersect(new Set(index.tags[tag] ?? []))
    }
  }

  if (query.props !== undefined) {
    const entries = Object.entries(query.props)
    if (entries.length > 0) {
      intersect(
        new Set(
          Object.keys(index.files).filter((file) => {
            const props = index.files[file].props
            if (props === undefined) return false
            return entries.every(([key, value]) => props[key] === value)
          })
        )
      )
    }
  }

  return candidates
}

export interface SearchKnowledgeDeps {
  /** 可注入的搜索服务（测试用），默认构造一个放开结果上限的实例 */
  searchService?: WorkspaceSearchService
}

/**
 * 执行结构化查询
 *
 * @param root 已授权的库根目录（绝对路径）
 * @param query 渲染层组装好的查询
 * @param index 当前索引；为 null 时只能做文本搜索，索引条件将筛出空集
 */
export async function searchKnowledge(
  root: string,
  query: KnowledgeQuery,
  index: KnowledgeIndex | null,
  signal: AbortSignal,
  deps: SearchKnowledgeDeps = {}
): Promise<SearchHit[]> {
  const limit = clampLimit(query.limit)
  const candidates = index === null ? null : matchIndexFilters(index, query)
  const hasText = (query.regex ?? query.text ?? '') !== ''

  // 索引条件已判定为空集：无需再跑文本搜索
  if (candidates !== null && candidates.size === 0) return []

  if (!hasText) {
    if (candidates === null) return []
    return [...candidates]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, limit)
      .map((path) => ({ path, line: 1, column: 1, text: '', source: 'index' as const }))
  }

  const service = deps.searchService ?? defaultSearchService(limit)

  const result = await service.search(
    {
      query: query.regex ?? query.text ?? '',
      mode: 'content',
      match: query.regex !== undefined ? 'regex' : 'literal',
      caseSensitive: query.caseSensitive ?? false,
      maxResults: limit,
      contextLines: 0
    },
    root,
    signal
  )

  const hits: SearchHit[] = []
  for (const match of result.matches) {
    if (match.type !== 'content') continue
    if (candidates !== null && !candidates.has(match.path)) continue
    hits.push({
      path: match.path,
      line: match.line,
      column: match.column,
      text: match.preview,
      source: 'rg'
    })
    if (hits.length >= limit) break
  }
  return hits
}

/** 构造默认搜索服务；rg 不可用时 rgPath 为 null，调用时会以 RG_UNAVAILABLE 失败 */
function defaultSearchService(limit: number): WorkspaceSearchService {
  let rgPath: string | null = null
  try {
    rgPath = resolveRgPath()
  } catch {
    rgPath = null
  }
  return new WorkspaceSearchService({
    rgPath,
    spawn,
    realpathSync: fs.realpathSync,
    limits: { ...DEFAULT_SEARCH_LIMITS, maxResults: limit }
  })
}
