/**
 * XMind（`.xmind`）与 Inkase 思维导图（`.inkmind`）互转
 *
 * 为什么放在 `shared/`：导入要在主进程解析外部文件，导出要先拿到渲染层的文档再打包，
 * 两边都得用同一套映射规则。这里刻意保持「文本进、文本出」——不导入任何渲染层类型，
 * 也不依赖 Electron，因此主进程与渲染进程都能直接用，测试也只需要 JSON。
 *
 * 只支持新版 XMind（Zen / 2020 及以后）的 `content.json`。
 * 旧版 XMind 8 用的是 `content.xml`（XML），本模块不认；调用方据此给出明确提示，
 * 让用户用新版 XMind 打开后另存，而不是丢一个「格式不支持」让用户猜。
 *
 * 无法表达的内容（关系线、概要、边界、图片、游离主题、多余画布）一律**计数**返回，
 * 由调用方汇总成一次提示——导图里可能有上百个对象，逐条弹窗不可用。
 *
 * 标记（markers）、标签（labels）、超链接（href）已能表达，分别映射到
 * 节点的 `tags` 与 `href`，因此不再计入提示。
 */

import { MINDMAP_FILE_SCHEMA, MINDMAP_PRIORITIES, MINDMAP_VERSION } from './document'

/** ZIP 内的文件内容：条目名 → 文本（由调用方编码成字节写入压缩包） */
export type XmindArchiveFiles = Record<string, string>

/** XMind 画布数组里的一张画布（只描述本模块用到的字段） */
export interface XmindSheet {
  id?: string
  class?: string
  title?: string
  rootTopic?: unknown
  relationships?: unknown[]
  summaries?: unknown[]
  boundaries?: unknown[]
  [key: string]: unknown
}

/** 导入时被丢弃的内容计数 */
export interface XmindImportWarnings {
  /** 关系线 */
  relationships: number
  /** 概要 */
  summaries: number
  /** 边界 */
  boundaries: number
  /** 图片 */
  images: number
  /** 游离主题（`children.detached`） */
  detachedTopics: number
  /** 除第一张以外的画布 */
  extraSheets: number
  /** 因超出深度/节点上限被截断的主题 */
  truncatedTopics: number
}

export type XmindImportResult =
  { ok: true; text: string; warnings: XmindImportWarnings } | { ok: false; error: string }

export type XmindExportResult =
  { ok: true; files: XmindArchiveFiles } | { ok: false; error: string }

const MAX_DEPTH = 128
const MAX_NODES = 20000
/** 单节点标题上限，防止一个畸形文件把渲染层拖死 */
const MAX_TITLE_LENGTH = 10000

const SCHEMA = MINDMAP_FILE_SCHEMA
/** 必须跟随共享定义：写死会让「导入后保存」把文件版本改回旧值 */
const VERSION = MINDMAP_VERSION

/**
 * 画布朝向 ↔ XMind 结构类。
 * 取值来自 XMind 的结构命名空间：`map.unbalanced` 是默认的左右发散，
 * `logic.*` 是单向逻辑图，`org-chart.down` 是自上而下的组织结构图。
 */
const STRUCTURE_BY_DIRECTION: Record<string, string> = {
  side: 'org.xmind.ui.map.unbalanced',
  right: 'org.xmind.ui.logic.right',
  left: 'org.xmind.ui.logic.left',
  down: 'org.xmind.ui.org-chart.down'
}

const DIRECTION_BY_STRUCTURE: Record<string, 'side' | 'right' | 'left' | 'down'> = {
  'org.xmind.ui.map.unbalanced': 'side',
  'org.xmind.ui.logic.right': 'right',
  'org.xmind.ui.logic.left': 'left',
  'org.xmind.ui.org-chart.down': 'down'
}

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 标题清洗：非字符串按空处理，超长截断（顺序与数量都要可预期） */
function toTitle(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.length > MAX_TITLE_LENGTH ? value.slice(0, MAX_TITLE_LENGTH) : value
  return trimmed === '' ? fallback : trimmed
}

function toColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : undefined
}

function emptyWarnings(): XmindImportWarnings {
  return {
    relationships: 0,
    summaries: 0,
    boundaries: 0,
    images: 0,
    detachedTopics: 0,
    extraSheets: 0,
    truncatedTopics: 0
  }
}

/* ------------------------------ 导出 ------------------------------ */

interface ElixirDraft {
  id: string
  text: string
  note?: string
  collapsed?: boolean
  color?: string
  direction?: string
  tags?: string[]
  href?: string
  children: ElixirDraft[]
}

/** 把 `.inkmind` 的节点树读成内部草稿；结构非法时返回 null */
function readRoot(raw: unknown): ElixirDraft | null {
  if (!isObject(raw)) return null
  const root = buildDraft(raw, { count: 0 }, 0, true)
  return root
}

/**
 * 逐层读取节点。
 * `state.count` 跨递归累加，用于全局节点上限；返回 null 表示该节点被丢弃。
 */
function buildDraft(
  raw: Record<string, unknown>,
  state: { count: number },
  depth: number,
  isRoot: boolean
): ElixirDraft | null {
  if (depth > MAX_DEPTH || state.count >= MAX_NODES) return null
  state.count += 1

  const draft: ElixirDraft = {
    id:
      typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : `n_${state.count.toString(36)}`,
    text: toTitle(raw.text, isRoot ? '中心主题' : ''),
    children: []
  }
  if (typeof raw.note === 'string' && raw.note !== '') draft.note = raw.note
  if (raw.collapsed === true && !isRoot) draft.collapsed = true
  const color = toColor(raw.color)
  if (color) draft.color = color
  if (typeof raw.direction === 'string' && raw.direction in STRUCTURE_BY_DIRECTION) {
    draft.direction = raw.direction
  }

  // 标签写成 XMind 的 labels（纯文本即可，颜色 XMind 侧不保留）
  if (Array.isArray(raw.tags)) {
    const texts: string[] = []
    for (const tag of raw.tags) {
      const text = typeof tag === 'string' ? tag : isObject(tag) ? tag.text : undefined
      if (typeof text === 'string' && text.trim() !== '') texts.push(text.trim())
    }
    const unique = [...new Set(texts)].slice(0, MAX_TAGS)
    if (unique.length > 0) draft.tags = unique
  }
  if (typeof raw.href === 'string' && /^https?:\/\//i.test(raw.href.trim())) {
    draft.href = raw.href.trim()
  }

  if (Array.isArray(raw.children)) {
    for (const child of raw.children) {
      if (!isObject(child)) continue
      const built = buildDraft(child, state, depth + 1, false)
      if (built) draft.children.push(built)
    }
  }
  return draft
}

/** 草稿 → XMind 主题节点 */
function draftToTopic(node: ElixirDraft): Record<string, unknown> {
  const topic: Record<string, unknown> = {
    id: node.id,
    class: 'topic',
    title: node.text
  }
  if (node.note) topic.notes = { plain: { content: node.note } }
  if (node.collapsed) topic.branch = 'folded'
  if (node.color) topic.style = { 'svg:fill': node.color }
  if (node.tags && node.tags.length > 0) topic.labels = node.tags
  if (node.href) topic.href = node.href
  // 子主题挂在自己身上（不是根）时才有 direction 语义，XMind 侧忽略即可
  if (node.children.length > 0) {
    topic.children = { attached: node.children.map(draftToTopic) }
  }
  return topic
}

/**
 * `.inkmind` 文本 → XMind 压缩包内的三个文件。
 *
 * 返回的是「条目名 → 文本」，编码与压缩由调用方负责；
 * 这样测试可以直接断言 JSON 内容，不必解压。
 */
export function mindMapToXmind(inkmindText: string): XmindExportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(inkmindText)
  } catch {
    return { ok: false, error: '思维导图内容不是合法的 JSON，无法导出' }
  }
  if (!isObject(parsed)) {
    return { ok: false, error: '思维导图内容结构不正确，无法导出' }
  }

  const root = readRoot(parsed.root)
  if (!root) {
    return { ok: false, error: '思维导图中没有可导出的根主题' }
  }

  const direction = typeof parsed.direction === 'string' ? parsed.direction : 'side'
  const structureClass = STRUCTURE_BY_DIRECTION[direction] ?? STRUCTURE_BY_DIRECTION.side

  const sheetId = `sheet_${root.id || 'root'}`
  const sheet: XmindSheet = {
    id: sheetId,
    class: 'sheet',
    title: root.text,
    rootTopic: { ...draftToTopic(root), structureClass }
  }
  const content = [sheet]

  const metadata = {
    creator: { name: 'Inkase' },
    activeSheetId: sheetId
  }
  const manifest = {
    'file-entries': {
      'content.json': {},
      'metadata.json': {}
    }
  }

  return {
    ok: true,
    files: {
      'content.json': `${JSON.stringify(content, null, 2)}\n`,
      'metadata.json': `${JSON.stringify(metadata, null, 2)}\n`,
      'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`
    }
  }
}

/* ------------------------------ 导入 ------------------------------ */

interface ImportDraft {
  id: string
  text: string
  note?: string
  collapsed?: boolean
  color?: string
  tags?: string[]
  href?: string
  children: ImportDraft[]
}

/** 标签数上限：与渲染层的 `normalizeTags` 保持一致，避免导入后又被裁掉 */
const MAX_TAGS = 8

const PRIORITY_MARKER = /^priority-(\d+)$/

/**
 * XMind 标记 id → 标签。
 *
 * 优先级（`priority-1`…）映射成 P1/P2/P3 预设，颜色与手动输入的优先级一致；
 * 其它标记取 id 的末段（`flag-red` → `red`、`task-done` → `done`），
 * 至少让用户在导图里看到「这里有东西」，而不是静默丢掉。
 */
export function markerToTag(raw: unknown): { text: string; color?: string } | undefined {
  if (typeof raw !== 'string') return undefined
  const id = raw.trim()
  if (id === '') return undefined

  const priority = PRIORITY_MARKER.exec(id)
  if (priority) {
    const text = `P${Number(priority[1])}`
    const preset = MINDMAP_PRIORITIES.find((item) => item.text === text)
    return preset ? { text: preset.text, color: preset.color } : { text }
  }

  const segments = id.split('-').filter((part) => part !== '')
  const name = segments.length > 0 ? segments[segments.length - 1] : ''
  return name === '' ? undefined : { text: name }
}

interface ImportState {
  warnings: XmindImportWarnings
  ids: Set<string>
  count: number
  truncated: boolean
}

/** 生成一个文档内唯一的节点 id */
function uniqueId(state: ImportState, candidate: unknown): string {
  let base = typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : ''
  if (base === '') base = `n_${(state.count + 1).toString(36)}`
  let id = base
  let suffix = 2
  while (state.ids.has(id)) {
    id = `${base}_${suffix}`
    suffix += 1
  }
  state.ids.add(id)
  return id
}

/**
 * XMind 主题 → 草稿。
 *
 * 所有「读不懂」的情况都退回默认值而不是抛错：一张图里混进一个畸形主题，
 * 不该让整次导入失败。
 */
function readTopic(
  raw: unknown,
  state: ImportState,
  depth: number,
  isRoot: boolean
): ImportDraft | null {
  if (!isObject(raw)) return null
  if (depth > MAX_DEPTH || state.count >= MAX_NODES) {
    state.warnings.truncatedTopics += 1
    return null
  }
  state.count += 1

  const draft: ImportDraft = {
    id: uniqueId(state, raw.id),
    text: toTitle(raw.title, isRoot ? '中心主题' : '新节点'),
    children: []
  }

  const notes = raw.notes
  if (isObject(notes)) {
    const plain = notes.plain
    if (isObject(plain) && typeof plain.content === 'string' && plain.content !== '') {
      draft.note = plain.content
    }
  }

  if (raw.branch === 'folded' && !isRoot) draft.collapsed = true

  const style = raw.style
  if (isObject(style)) {
    const color = toColor(style['svg:fill'] ?? style.fill)
    if (color) draft.color = color
  }

  // 标记与标签都收进 `tags`：XMind 里两者语义相近，Inkase 只有一个标签位
  const marks: string[] = []
  if (Array.isArray(raw.markers)) {
    for (const marker of raw.markers) {
      // 新版写 `{ markerId }`，旧版直接写字符串
      const tag = markerToTag(isObject(marker) ? (marker.markerId ?? marker.id) : marker)
      if (tag) marks.push(tag.text)
    }
  }
  if (Array.isArray(raw.labels)) {
    for (const label of raw.labels) {
      if (typeof label === 'string' && label.trim() !== '') marks.push(label.trim())
    }
  }
  const tags = [...new Set(marks)].slice(0, MAX_TAGS)
  if (tags.length > 0) draft.tags = tags
  if (typeof raw.href === 'string' && /^https?:\/\//i.test(raw.href.trim())) {
    draft.href = raw.href.trim()
  }

  if (raw.image !== undefined || raw.src !== undefined) state.warnings.images += 1

  const children = raw.children
  if (isObject(children)) {
    if (Array.isArray(children.detached)) state.warnings.detachedTopics += children.detached.length
    if (Array.isArray(children.attached)) {
      for (const child of children.attached) {
        const built = readTopic(child, state, depth + 1, false)
        if (built) draft.children.push(built)
      }
    }
  }

  return draft
}

/** 草稿 → `.inkmind` 的节点（字段顺序与序列化一致，便于 diff） */
function draftToNode(node: ImportDraft): Record<string, unknown> {
  const result: Record<string, unknown> = { id: node.id, text: node.text }
  if (node.note) result.note = node.note
  if (node.collapsed) result.collapsed = true
  if (node.color) result.color = node.color
  if (node.tags && node.tags.length > 0) {
    result.tags = node.tags.map((text) => {
      const preset = MINDMAP_PRIORITIES.find((item) => item.text === text)
      return preset ? { text: preset.text, color: preset.color } : { text }
    })
  }
  if (node.href) result.href = node.href
  result.children = node.children.map(draftToNode)
  return result
}

/**
 * XMind `content.json` → `.inkmind` 文本。
 *
 * `content.json` 顶层是画布数组，只取第一张；多出来的计入 `extraSheets`。
 * 也接受单张画布对象（有些工具写出的文件不是数组），避免不必要的失败。
 */
export function xmindToMindMap(content: unknown): XmindImportResult {
  let sheets: unknown[]
  if (Array.isArray(content)) {
    sheets = content
  } else if (isObject(content)) {
    sheets = [content]
  } else {
    return { ok: false, error: 'XMind 内容不是有效的 JSON 结构' }
  }

  if (sheets.length === 0) {
    return { ok: false, error: 'XMind 文件里没有任何画布' }
  }

  const warnings = emptyWarnings()
  if (sheets.length > 1) warnings.extraSheets = sheets.length - 1

  const first = sheets[0]
  if (!isObject(first)) {
    return { ok: false, error: 'XMind 第一张画布结构不正确' }
  }

  // 画布级的不支持内容
  if (Array.isArray(first.relationships)) warnings.relationships += first.relationships.length
  if (Array.isArray(first.summaries)) warnings.summaries += first.summaries.length
  if (Array.isArray(first.boundaries)) warnings.boundaries += first.boundaries.length

  const state: ImportState = { warnings, ids: new Set(), count: 0, truncated: false }
  const rootDraft = readTopic(first.rootTopic, state, 0, true)
  if (!rootDraft) {
    return { ok: false, error: 'XMind 文件里没有可识别的根主题' }
  }

  const structureClass = isObject(first.rootTopic) ? first.rootTopic.structureClass : undefined
  const direction =
    typeof structureClass === 'string' ? DIRECTION_BY_STRUCTURE[structureClass] : undefined

  const document: Record<string, unknown> = {
    schema: SCHEMA,
    version: VERSION,
    root: draftToNode(rootDraft)
  }
  // side 是默认朝向，不落盘（与渲染层序列化的行为一致）
  if (direction && direction !== 'side') document.direction = direction

  return {
    ok: true,
    text: `${JSON.stringify(document, null, 2)}\n`,
    warnings
  }
}

/* ------------------------------ 提示文案 ------------------------------ */

/** 是否有任何被丢弃的内容 */
export function hasXmindWarnings(warnings: XmindImportWarnings): boolean {
  return Object.values(warnings).some((count) => count > 0)
}

/**
 * 把计数翻成人话。
 *
 * 返回的是「一行一条」，由调用方决定塞进对话框还是通知条；
 * 顺序固定（结构类在前、样式类在后），便于测试与用户略读。
 */
export function describeXmindWarnings(warnings: XmindImportWarnings): string[] {
  const lines: string[] = []
  const push = (count: number, label: string): void => {
    if (count > 0) lines.push(`${label} ${count} 处`)
  }
  push(warnings.relationships, '关系线')
  push(warnings.summaries, '概要')
  push(warnings.boundaries, '边界')
  push(warnings.images, '图片')
  push(warnings.detachedTopics, '游离主题')
  if (warnings.extraSheets > 0) lines.push(`其余画布 ${warnings.extraSheets} 张（只导入第一张）`)
  push(warnings.truncatedTopics, '超出层级/数量上限的主题')
  return lines
}
