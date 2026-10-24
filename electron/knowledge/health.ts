/**
 * 库健康巡检
 *
 * 从内存索引派生四类问题：孤立笔记、断链、重复标题、未链接提及。
 * 纯函数，不碰文件系统；计数完整，列表按上限截断，避免整库推给渲染层。
 */

import type {
  DuplicateTitleGroup,
  KnowledgeHealth,
  KnowledgeIndex,
  LinkRef,
  UnlinkedMention
} from '../../shared/knowledge/types'
import { buildGraph } from './graph-service'

/** 每类问题最多返回的条数 */
export const HEALTH_LIST_LIMIT = 200

/** 重复标题组上限 */
export const HEALTH_DUPLICATE_LIMIT = 100

/** 空报告（索引未构建时使用） */
export function emptyHealth(): KnowledgeHealth {
  return {
    counts: { isolated: 0, broken: 0, duplicateTitles: 0, unlinkedMentions: 0 },
    isolated: [],
    broken: [],
    duplicates: [],
    unlinked: [],
    truncated: false
  }
}

function isNote(kind: string): boolean {
  return kind === 'md' || kind === 'mdx'
}

function baseTitle(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return base.replace(/\.[^./]+$/, '')
}

/** frontmatter title 优先，否则用文件名 */
function displayTitle(index: KnowledgeIndex, path: string): string {
  const declared = index.files[path]?.props?.title?.trim()
  return declared && declared !== '' ? declared : baseTitle(path)
}

function collectDuplicates(index: KnowledgeIndex): DuplicateTitleGroup[] {
  const groups = new Map<string, DuplicateTitleGroup>()
  for (const [path, entry] of Object.entries(index.files)) {
    if (!isNote(entry.kind)) continue
    const title = displayTitle(index, path)
    if (title === '') continue
    const key = title.toLowerCase()
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { title, paths: [path] })
    else existing.paths.push(path)
  }

  return [...groups.values()]
    .filter((group) => group.paths.length > 1)
    .map((group) => ({ title: group.title, paths: [...group.paths].sort() }))
    .sort((a, b) => b.paths.length - a.paths.length || a.title.localeCompare(b.title))
}

function collectUnlinked(index: KnowledgeIndex): UnlinkedMention[] {
  const items: UnlinkedMention[] = []
  for (const [from, mentions] of Object.entries(index.mentions)) {
    for (const mention of mentions) {
      items.push({
        from,
        targetPath: mention.targetPath,
        line: mention.line,
        column: mention.column,
        raw: mention.raw,
        text: mention.text
      })
    }
  }
  return items.sort(
    (a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.column - b.column
  )
}

/** 从索引构建健康报告 */
export function buildHealth(index: KnowledgeIndex): KnowledgeHealth {
  const isolated = buildGraph(index).isolated
    .filter((path) => {
      const entry = index.files[path]
      return entry !== undefined && isNote(entry.kind)
    })
    .sort()

  const duplicates = collectDuplicates(index)
  const unlinked = collectUnlinked(index)
  const broken: LinkRef[] = index.unresolved

  return {
    counts: {
      isolated: isolated.length,
      broken: broken.length,
      duplicateTitles: duplicates.length,
      unlinkedMentions: unlinked.length
    },
    isolated: isolated.slice(0, HEALTH_LIST_LIMIT),
    broken: broken.slice(0, HEALTH_LIST_LIMIT),
    duplicates: duplicates.slice(0, HEALTH_DUPLICATE_LIMIT),
    unlinked: unlinked.slice(0, HEALTH_LIST_LIMIT),
    truncated:
      isolated.length > HEALTH_LIST_LIMIT
      || broken.length > HEALTH_LIST_LIMIT
      || duplicates.length > HEALTH_DUPLICATE_LIMIT
      || unlinked.length > HEALTH_LIST_LIMIT
  }
}
