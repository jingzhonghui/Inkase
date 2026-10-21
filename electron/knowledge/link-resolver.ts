/**
 * 链接目标解析与歧义检测
 *
 * 解析顺序（见设计文档 §5.2）：
 * 1. 精确相对路径（`dir/a.mdx`）
 * 2. 省略扩展名的相对路径（`dir/a`）
 * 3. 文件名 basename（`b`，忽略扩展名与大小写）
 * 4. frontmatter `aliases` 命中
 *
 * 任一环节命中多个候选即返回 `ambiguous` 并列出候选，**绝不静默取第一个**
 * （见设计文档 §2 反目标）。本模块为纯函数，不 import electron。
 */

import type { LinkResolution } from '../../shared/knowledge/types'

/** 解析用的索引：三张查找表 + 去扩展名路径表 */
export interface LinkIndex {
  /** 归一后的库内相对路径 */
  byPath: Set<string>
  /** 归一后的去扩展名相对路径 → 路径列表 */
  byPathNoExt: Map<string, string[]>
  /** 归一后的 basename（去扩展名）→ 路径列表 */
  byBasename: Map<string, string[]>
  /** 归一后的别名 → 路径列表 */
  byAlias: Map<string, string[]>
}

/**
 * 归一化名称
 *
 * 反斜杠转正斜杠、折叠空白、去首尾空白、转小写。
 * Windows 下路径大小写不敏感，故统一小写比较。
 */
export function normalizeName(value: string): string {
  return value.replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 去掉最后一级扩展名 */
function stripExtension(path: string): string {
  return path.replace(/\.[^./\\]+$/, '')
}

/** 取 basename（不含目录） */
function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const at = normalized.lastIndexOf('/')
  return at === -1 ? normalized : normalized.slice(at + 1)
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  if (key === '') return
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

/**
 * 构建解析索引
 *
 * @param files 库内相对路径列表（`/` 分隔）
 * @param aliases 路径 → 别名列表（来自 frontmatter）
 */
export function buildLinkIndex(files: string[], aliases: Record<string, string[]> = {}): LinkIndex {
  const index: LinkIndex = {
    byPath: new Set<string>(),
    byPathNoExt: new Map<string, string[]>(),
    byBasename: new Map<string, string[]>(),
    byAlias: new Map<string, string[]>()
  }

  for (const file of files) {
    const normalized = normalizeName(file)
    if (normalized === '') continue
    index.byPath.add(normalized)
    push(index.byPathNoExt, stripExtension(normalized), normalized)
    push(index.byBasename, stripExtension(basenameOf(normalized)), normalized)
  }

  for (const [path, list] of Object.entries(aliases)) {
    const normalizedPath = normalizeName(path)
    for (const alias of list) {
      push(index.byAlias, normalizeName(alias), normalizedPath)
    }
  }

  return index
}

function fromCandidates(candidates: string[]): LinkResolution {
  if (candidates.length === 1) {
    return { status: 'resolved', targetPath: candidates[0] }
  }
  return { status: 'ambiguous', candidates: [...candidates].sort() }
}

/**
 * 解析链接目标
 *
 * @param target 书写时的目标文本（可为空——表示同文件标题链接）
 * @param index 解析索引
 * @param from 当前文件（库内相对路径）；`target` 为空时解析到它
 */
export function resolveLink(target: string, index: LinkIndex, from?: string): LinkResolution {
  const normalized = normalizeName(target)

  if (normalized === '') {
    if (from !== undefined && from !== '' && index.byPath.has(normalizeName(from))) {
      return { status: 'resolved', targetPath: normalizeName(from) }
    }
    return { status: 'missing' }
  }

  if (index.byPath.has(normalized)) {
    return { status: 'resolved', targetPath: normalized }
  }

  const exactPathMatches = index.byPathNoExt.get(normalized)
  if (exactPathMatches && exactPathMatches.length > 0) return fromCandidates(exactPathMatches)

  const basenameMatches = index.byBasename.get(normalized)
  if (basenameMatches && basenameMatches.length > 0) return fromCandidates(basenameMatches)

  const aliasMatches = index.byAlias.get(normalized)
  if (aliasMatches && aliasMatches.length > 0) return fromCandidates(aliasMatches)

  return { status: 'missing' }
}
