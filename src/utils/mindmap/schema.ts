/**
 * 思维导图 JSON 的解析 / 校验 / 序列化
 *
 * 职责边界：只处理「文本 ↔ 内存模型」，不接触渲染库。
 * 解析必须对用户手改过的文件足够宽容——宁可修好能打开，也不要白屏。
 */

import {
  MINDMAP_FILE_SCHEMA,
  MINDMAP_VERSION,
  createMindMapNode,
  type MindMapArrow,
  type MindMapDocument,
  type MindMapNode,
  type MindMapSummary
} from '../../types/mindmap'
import {
  MAX_ARROWS,
  MAX_SUMMARIES,
  createRichId,
  normalizeAttachments,
  normalizeIcons,
  normalizeImage,
  normalizeLink,
  normalizeRichColor,
  normalizeTags
} from './rich-content'

/** 允许的最大嵌套深度（防止病态文件把渲染层拖死） */
const MAX_DEPTH = 128
/** 允许的最大节点数 */
const MAX_NODES = 20000

/** 合法的分支颜色：`#rrggbb`（渲染库直接写进 CSS，必须严格校验，避免注入） */
const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** 归一化分支颜色；非法值返回 undefined（丢弃而不是猜一个） */
function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return HEX_COLOR.test(trimmed) ? trimmed.toLowerCase() : undefined
}

export type MindMapParseResult =
  { ok: true; document: MindMapDocument; repaired: string[] } | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface NormalizeState {
  count: number
  repaired: string[]
  seenIds: Set<string>
}

/**
 * 归一化单个节点：补齐缺省字段、重建缺失或重复的 id、丢弃非法子节点。
 * 返回 null 表示该节点不可用（例如 children 里混进了字符串）。
 */
function normalizeNode(raw: unknown, depth: number, state: NormalizeState): MindMapNode | null {
  if (!isPlainObject(raw)) return null
  if (depth > MAX_DEPTH) {
    state.repaired.push(`嵌套层级超过 ${MAX_DEPTH}，已截断`)
    return null
  }
  state.count += 1
  if (state.count > MAX_NODES) {
    state.repaired.push(`节点数超过 ${MAX_NODES}，已截断`)
    return null
  }

  const rawText = raw.text
  const text = typeof rawText === 'string' ? rawText : rawText == null ? '' : String(rawText)

  let id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id || state.seenIds.has(id)) {
    if (id) state.repaired.push('发现重复节点 id，已重新生成')
    id = createMindMapNode().id
  }
  state.seenIds.add(id)

  const node: MindMapNode = { id, text, children: [] }

  if (typeof raw.note === 'string' && raw.note.length > 0) node.note = raw.note
  if (raw.collapsed === true) node.collapsed = true
  if (raw.direction === 'left' || raw.direction === 'right') node.direction = raw.direction
  const color = normalizeColor(raw.color)
  if (color) node.color = color
  else if (raw.color != null) state.repaired.push('分支颜色格式不合法（需 #rrggbb），已忽略')

  // 富内容：图片 / 附件 / 图标 / 标签 / 链接。校验规则与右键菜单共用 rich-content
  const image = normalizeImage(raw.image)
  if (image) node.image = image
  else if (raw.image != null) state.repaired.push('图片只支持包内路径或 data:image，已忽略')

  const attachments = normalizeAttachments(raw.attachments)
  if (attachments.length > 0) node.attachments = attachments
  else if (raw.attachments != null) state.repaired.push('附件路径不合法或超出限额，已忽略')

  const icons = normalizeIcons(raw.icons)
  if (icons.length > 0) node.icons = icons
  else if (raw.icons != null) state.repaired.push('节点图标不在支持范围内，已忽略')

  const tags = normalizeTags(raw.tags)
  if (tags.length > 0) node.tags = tags

  const href = normalizeLink(raw.href)
  if (href) node.href = href
  else if (raw.href != null) state.repaired.push('链接只支持 http/https，已忽略')

  if (Array.isArray(raw.children)) {
    for (const child of raw.children) {
      const normalized = normalizeNode(child, depth + 1, state)
      if (normalized) node.children.push(normalized)
    }
  } else if (raw.children != null) {
    state.repaired.push('children 不是数组，已忽略')
  }

  return node
}

const DIRECTIONS = ['side', 'left', 'right', 'down'] as const
type MindMapDirectionValue = (typeof DIRECTIONS)[number]

function normalizeDirection(value: unknown): MindMapDirectionValue | undefined {
  return DIRECTIONS.includes(value as MindMapDirectionValue)
    ? (value as MindMapDirectionValue)
    : undefined
}

/** 收集「节点 id → 子主题数」，用于校验连线与概要引用的节点是否存在 */
function collectNodeIndex(root: MindMapNode): Map<string, number> {
  const index = new Map<string, number>()
  const walk = (node: MindMapNode): void => {
    index.set(node.id, node.children.length)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return index
}

/**
 * 归一化关系线。
 *
 * 悬空的连线（指向已删除的节点、或自己连自己）直接丢弃：
 * 留着一根画不出来的线，比丢一条更让人困惑。
 */
function normalizeArrows(
  raw: unknown,
  index: Map<string, number>,
  repaired: string[]
): MindMapArrow[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) {
    repaired.push('arrows 不是数组，已忽略')
    return []
  }

  const result: MindMapArrow[] = []
  const ids = new Set<string>()
  const pairs = new Set<string>()

  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const from = typeof item.from === 'string' ? item.from.trim() : ''
    const to = typeof item.to === 'string' ? item.to.trim() : ''
    if (!index.has(from) || !index.has(to) || from === to) {
      repaired.push('关系线指向不存在的节点，已丢弃')
      continue
    }
    const pair = `${from}→${to}`
    if (pairs.has(pair)) continue
    pairs.add(pair)

    let id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || ids.has(id)) id = createRichId('ar', ids)
    else ids.add(id)

    const arrow: MindMapArrow = { id, from, to }
    if (typeof item.label === 'string' && item.label.trim() !== '') {
      arrow.label = item.label.trim().slice(0, 64)
    }
    if (item.bidirectional === true) arrow.bidirectional = true
    const color = normalizeRichColor(item.color)
    if (color) arrow.color = color

    result.push(arrow)
    if (result.length >= MAX_ARROWS) {
      repaired.push(`关系线超过 ${MAX_ARROWS} 条，已截断`)
      break
    }
  }
  return result
}

/**
 * 归一化概要。
 *
 * `start` / `end` 是父节点子主题的下标：文件被手改过之后很容易越界，
 * 这里夹到合法区间而不是丢弃整条——概要文字往往比区间更重要。
 */
function normalizeSummaries(
  raw: unknown,
  index: Map<string, number>,
  repaired: string[]
): MindMapSummary[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) {
    repaired.push('summaries 不是数组，已忽略')
    return []
  }

  const result: MindMapSummary[] = []
  const ids = new Set<string>()

  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const parent = typeof item.parent === 'string' ? item.parent.trim() : ''
    const childCount = index.get(parent)
    if (childCount === undefined || childCount === 0) {
      repaired.push('概要挂在不存在的节点（或没有子主题）上，已丢弃')
      continue
    }
    if (!Number.isInteger(item.start) || !Number.isInteger(item.end)) {
      repaired.push('概要的区间不是整数，已丢弃')
      continue
    }
    let start = item.start as number
    let end = item.end as number
    if (start < 0) start = 0
    if (end > childCount - 1) end = childCount - 1
    if (start > end) {
      repaired.push('概要的区间为空，已丢弃')
      continue
    }

    let id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || ids.has(id)) id = createRichId('sm', ids)
    else ids.add(id)

    const summary: MindMapSummary = { id, parent, start, end }
    if (typeof item.label === 'string' && item.label.trim() !== '') {
      summary.label = item.label.trim().slice(0, 64)
    }
    const color = normalizeRichColor(item.color)
    if (color) summary.color = color

    result.push(summary)
    if (result.length >= MAX_SUMMARIES) {
      repaired.push(`概要超过 ${MAX_SUMMARIES} 条，已截断`)
      break
    }
  }
  return result
}

/**
 * 解析 `.inkmind` 文本。
 *
 * 宽容策略：
 * - 缺少 `schema` / `version` 时按当前版本处理（用户手写的最小文件也能开）；
 * - 缺少 `children` 视为叶子节点；
 * - 缺失或重复的节点 id 自动重建，并在 `repaired` 中记录；
 * - 结构性错误（不是 JSON、没有 root）直接失败，交由 UI 显示可读错误。
 */
export function parseMindMap(text: string): MindMapParseResult {
  const source = text.trim()
  if (source === '') {
    return {
      ok: true,
      document: {
        schema: MINDMAP_FILE_SCHEMA,
        version: MINDMAP_VERSION,
        root: createMindMapNode('中心主题')
      },
      repaired: ['文件为空，已创建空白导图']
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `不是合法的 JSON：${message}` }
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: '文件内容不是 JSON 对象' }
  }

  if (parsed.schema !== undefined && parsed.schema !== MINDMAP_FILE_SCHEMA) {
    return { ok: false, error: `不是 Inkase 思维导图文件（schema=${String(parsed.schema)}）` }
  }

  const state: NormalizeState = { count: 0, repaired: [], seenIds: new Set() }
  const rootRaw = parsed.root
  const root = normalizeNode(rootRaw, 0, state)
  if (!root) {
    return { ok: false, error: '文件缺少有效的 root 节点' }
  }

  if (typeof parsed.version === 'number' && parsed.version > MINDMAP_VERSION) {
    state.repaired.push(
      `文件版本 ${parsed.version} 高于当前支持版本 ${MINDMAP_VERSION}，已按当前版本读取`
    )
  }

  const document: MindMapDocument = {
    schema: MINDMAP_FILE_SCHEMA,
    version: MINDMAP_VERSION,
    root
  }
  const direction = normalizeDirection(parsed.direction)
  if (direction) document.direction = direction
  if (typeof parsed.rainbowBranches === 'boolean') {
    document.rainbowBranches = parsed.rainbowBranches
  }

  const index = collectNodeIndex(root)
  const arrows = normalizeArrows(parsed.arrows, index, state.repaired)
  if (arrows.length > 0) document.arrows = arrows
  const summaries = normalizeSummaries(parsed.summaries, index, state.repaired)
  if (summaries.length > 0) document.summaries = summaries

  return { ok: true, document, repaired: state.repaired }
}

/**
 * 序列化为落盘文本。
 * 使用 2 空格缩进：文件体积可接受，且 git diff 可读——这是纯文本方案的主要收益。
 *
 * `rainbowBranches` 只在「显式关闭」时落盘：默认开启，省略可以让文件更干净，
 * 也让手写的最小文件（只有 schema/root）依然能打开。
 */
export function serializeMindMap(document: MindMapDocument): string {
  const payload: MindMapDocument = {
    schema: MINDMAP_FILE_SCHEMA,
    version: MINDMAP_VERSION,
    root: document.root,
    ...(document.direction ? { direction: document.direction } : {}),
    ...(document.rainbowBranches === false ? { rainbowBranches: false } : {}),
    // 空数组不落盘：没有连线/概要的文件保持干净，也让最小文件依然能打开
    ...(document.arrows && document.arrows.length > 0 ? { arrows: document.arrows } : {}),
    ...(document.summaries && document.summaries.length > 0
      ? { summaries: document.summaries }
      : {})
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** 统计节点数（含根节点） */
export function countMindMapNodes(node: MindMapNode): number {
  let total = 1
  for (const child of node.children) total += countMindMapNodes(child)
  return total
}

/** 统计所有节点文本长度（用于状态栏字数） */
export function countMindMapText(node: MindMapNode): number {
  let total = node.text.trim().length
  for (const child of node.children) total += countMindMapText(child)
  return total
}

/** 展平为列表（深度优先），便于搜索/导出 */
export function flattenMindMap(node: MindMapNode): MindMapNode[] {
  const result: MindMapNode[] = [node]
  for (const child of node.children) result.push(...flattenMindMap(child))
  return result
}

/** 按 id 查找节点 */
export function findMindMapNode(root: MindMapNode, id: string): MindMapNode | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const found = findMindMapNode(child, id)
    if (found) return found
  }
  return null
}
