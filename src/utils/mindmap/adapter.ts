/**
 * 自有模型 ↔ mind-elixir 渲染层数据的转换
 *
 * 这是整个功能里**唯一**接触 mind-elixir 数据结构的文件。
 * 上游升级只需要改这里，用户文件不受影响。
 */

import type { MindElixirData, NodeObj } from 'mind-elixir'

/**
 * 渲染库只从顶层导出 `NodeObj` / `MindElixirData`，`Arrow` / `Summary` / `TagObj`
 * 没有对外导出（只出现在数据结构里）。这里从数据结构反推，
 * 比深引 `mind-elixir/dist/types/arrow` 更抗升级。
 */
type ElixirArrow = NonNullable<MindElixirData['arrows']>[number]
type ElixirSummary = NonNullable<MindElixirData['summaries']>[number]
type ElixirTag = NonNullable<NodeObj['tags']>[number]

import {
  MINDMAP_FILE_SCHEMA,
  MINDMAP_VERSION,
  createNodeId,
  type MindMapArrow,
  type MindMapDocument,
  type MindMapNode,
  type MindMapSummary
} from '../../types/mindmap'
import {
  MINDMAP_GLYPH_TO_ICON,
  MINDMAP_ICON_GLYPHS,
  normalizeAttachments,
  normalizeIcons,
  normalizeLink,
  normalizeRichColor,
  normalizeTags
} from './rich-content'
import type { MindMapIcon } from '../../types/mindmap'

/** 图片缺省显示尺寸（文件里没写 width/height 时用） */
const DEFAULT_IMAGE_WIDTH = 200
const DEFAULT_IMAGE_HEIGHT = 140

/**
 * 渲染层节点上挂的自定义元数据键。
 *
 * mind-elixir 的 `image.url` 是**给浏览器加载用的 URL**，可能是 `file://` 或自定义协议，
 * 而文件里要存的是相对路径。因此把原始 src 塞进 metadata 里带一圈，
 * 回读时优先用它，避免「打开又保存一次，图片路径被改写成绝对路径」。
 */
export const MINDMAP_IMAGE_META_KEY = 'inkaseImageSrc'

/**
 * 节点附件在渲染库节点上的暂存键。
 *
 * mind-elixir 没有「附件」这个概念，`NodeObj` 上也没有对应字段；
 * 但它的 `metadata` 会被原样带在节点上，于是借用它存一份，
 * 序列化时再从 `metadata` 里取回来写进 `attachments`。
 * 与图片同理：不这么做，保存一次附件就没了。
 */
export const MINDMAP_ATTACHMENTS_META_KEY = 'inkaseAttachments'

/**
 * 渲染层节点上的图标 → 图标名。
 *
 * 渲染库把 `icons` 里的字符串当纯文本塞进 `<span>`，所以画布上存的是**字形**，
 * 文件里存的是名字。两边来回转换必须走这一对函数：
 * 曾经的 bug 就是编辑时把名字 `star` 直接 push 进字形数组，
 * 结果画布上多出一个单词「star」，取消勾选也永远删不掉。
 */
export function iconsFromElixir(node: { icons?: unknown } | null | undefined): MindMapIcon[] {
  if (!Array.isArray(node?.icons)) return []
  return normalizeIcons(node.icons.map((raw) => MINDMAP_GLYPH_TO_ICON[raw] ?? raw))
}

/** 图标名 → 渲染层字形；空列表时把键删掉，避免留下 `icons: []` */
export function writeIconsToElixir(
  node: { icons?: string[] } | null | undefined,
  names: readonly MindMapIcon[]
): void {
  if (!node) return
  if (names.length === 0) {
    delete node.icons
    return
  }
  node.icons = names.map((name) => MINDMAP_ICON_GLYPHS[name] ?? name)
}

/** 画布朝向 → mind-elixir direction 常量（0=LEFT 1=RIGHT 2=SIDE 3=DOWN） */
const DIRECTION_TO_ELIXIR: Record<NonNullable<MindMapDocument['direction']>, 0 | 1 | 2 | 3> = {
  left: 0,
  right: 1,
  side: 2,
  down: 3
}

const ELIXIR_TO_DIRECTION: Record<number, NonNullable<MindMapDocument['direction']>> = {
  0: 'left',
  1: 'right',
  2: 'side',
  3: 'down'
}

function directionToElixir(direction: MindMapDocument['direction']): 0 | 1 | 2 | 3 | undefined {
  if (!direction) return undefined
  return DIRECTION_TO_ELIXIR[direction]
}

function directionFromElixir(value: unknown): MindMapDocument['direction'] {
  if (typeof value !== 'number') return undefined
  return ELIXIR_TO_DIRECTION[value]
}

/**
 * 自有节点 → 渲染层节点（保留 id，保证一一对应）。
 *
 * 根节点不写 `expanded=false`：渲染库布局根节点时并不看这个字段，
 * 但「折叠全部」之类的批量操作会给根节点也置 false，若原样落盘，
 * 文件里就会出现一个语义无效又容易误导人的 `collapsed: true`。
 */
function nodeToElixir(
  node: MindMapNode,
  resolveImageSrc: (src: string) => string,
  isRoot = false
): NodeObj {
  const result: NodeObj = {
    id: node.id,
    topic: node.text
  }
  if (node.note) result.note = node.note
  if (node.collapsed && !isRoot) result.expanded = false
  if (node.direction) result.direction = node.direction === 'left' ? 0 : 1
  if (node.color) result.branchColor = node.color
  if (node.href) result.hyperLink = node.href
  if (node.icons && node.icons.length > 0) {
    // 画布要字形而不是名字：渲染库把 icons 当纯文本输出，给名字就会显示「star」这个单词
    result.icons = node.icons.map((name) => MINDMAP_ICON_GLYPHS[name] ?? name)
  }
  if (node.tags && node.tags.length > 0) result.tags = node.tags.map(tagToElixir)
  if (node.image) {
    result.image = {
      url: resolveImageSrc(node.image.src),
      width: node.image.width ?? DEFAULT_IMAGE_WIDTH,
      height: node.image.height ?? DEFAULT_IMAGE_HEIGHT
    }
    result.metadata = { [MINDMAP_IMAGE_META_KEY]: node.image.src }
  }
  if (node.attachments && node.attachments.length > 0) {
    // 渲染库不认 attachments，借 metadata 带一圈；回读时再取出来
    result.metadata = {
      ...(result.metadata ?? {}),
      [MINDMAP_ATTACHMENTS_META_KEY]: node.attachments
    }
  }
  if (node.children.length > 0) {
    result.children = node.children.map((child) => nodeToElixir(child, resolveImageSrc, false))
  }
  return result
}

/** 标签 → 渲染层的彩色徽章；没有颜色就用默认徽章样式 */
function tagToElixir(tag: { text: string; color?: string }): string | ElixirTag {
  if (!tag.color) return tag.text
  return {
    text: tag.text,
    style: { backgroundColor: tag.color, color: '#ffffff', borderColor: tag.color }
  }
}

/** 渲染层的徽章 → 标签；颜色从内联样式里取回 */
function tagFromElixir(tag: ElixirTag): { text: string; color?: string } | null {
  if (typeof tag === 'string') {
    return tag.trim() === '' ? null : { text: tag }
  }
  if (!tag || typeof tag !== 'object') return null
  const text = typeof tag.text === 'string' ? tag.text : ''
  if (text.trim() === '') return null
  const style = tag.style as Record<string, unknown> | undefined
  const rawColor = style?.backgroundColor ?? style?.['background-color'] ?? style?.background
  const color = normalizeRichColor(rawColor)
  return color ? { text, color } : { text }
}

/**
 * 渲染层节点 → 自有节点。
 * 根节点上的 `expanded` 一律忽略（见 nodeToElixir 的说明）。
 */
function nodeFromElixir(node: NodeObj, isRoot = false): MindMapNode {
  const result: MindMapNode = {
    id: typeof node.id === 'string' && node.id.trim() !== '' ? node.id : createNodeId(),
    text: typeof node.topic === 'string' ? node.topic : '',
    children: []
  }
  if (typeof node.note === 'string' && node.note.length > 0) result.note = node.note
  if (!isRoot && node.expanded === false) result.collapsed = true
  if (node.direction === 0 || node.direction === 1) {
    result.direction = node.direction === 0 ? 'left' : 'right'
  }
  if (typeof node.branchColor === 'string' && node.branchColor.trim() !== '') {
    result.color = node.branchColor.trim().toLowerCase()
  }

  const href = normalizeLink(node.hyperLink)
  if (href) result.href = href

  if (Array.isArray(node.icons)) {
    // 画布上是字形，文件里存名字；手写文件里直接写名字也认
    const icons = iconsFromElixir(node)
    if (icons.length > 0) result.icons = icons
  }

  if (Array.isArray(node.tags)) {
    const tags = normalizeTags(node.tags.map(tagFromElixir).filter((tag) => tag !== null))
    if (tags.length > 0) result.tags = tags
  }

  const image = imageFromElixir(node)
  if (image) result.image = image

  const attachments = attachmentsFromElixir(node)
  if (attachments.length > 0) result.attachments = attachments

  if (Array.isArray(node.children)) {
    result.children = node.children.map((child) => nodeFromElixir(child, false))
  }
  return result
}

/** 从渲染层节点取回附件（它们只是暂存在 metadata 里） */
function attachmentsFromElixir(node: NodeObj): NonNullable<MindMapNode['attachments']> {
  const meta = node.metadata as Record<string, unknown> | undefined
  return normalizeAttachments(meta?.[MINDMAP_ATTACHMENTS_META_KEY])
}

/** 从渲染层节点取回图片：优先用 metadata 里保留的原始相对路径 */
function imageFromElixir(node: NodeObj): MindMapNode['image'] {
  const raw = node.image
  if (!raw || typeof raw.url !== 'string') return undefined
  const meta = node.metadata as Record<string, unknown> | undefined
  const stored = meta?.[MINDMAP_IMAGE_META_KEY]
  const src = typeof stored === 'string' && stored.trim() !== '' ? stored.trim() : raw.url.trim()
  if (src === '') return undefined
  const image: NonNullable<MindMapNode['image']> = { src }
  if (typeof raw.width === 'number' && Number.isFinite(raw.width)) {
    image.width = Math.round(raw.width)
  }
  if (typeof raw.height === 'number' && Number.isFinite(raw.height)) {
    image.height = Math.round(raw.height)
  }
  return image
}

/** 自有连线 → 渲染层连线（id 与节点 id 同一套） */
function arrowToElixir(arrow: MindMapArrow): ElixirArrow {
  const result: ElixirArrow = {
    id: arrow.id,
    label: arrow.label ?? '',
    from: arrow.from,
    to: arrow.to
  }
  if (arrow.bidirectional) result.bidirectional = true
  if (arrow.color) result.style = { stroke: arrow.color }
  return result
}

/** 自有概要 → 渲染层概要 */
function summaryToElixir(summary: MindMapSummary): ElixirSummary {
  const result: ElixirSummary = {
    id: summary.id,
    label: summary.label ?? '',
    parent: summary.parent,
    start: summary.start,
    end: summary.end
  }
  if (summary.color) result.style = { stroke: summary.color }
  return result
}

function arrowFromElixir(arrow: ElixirArrow): MindMapArrow | null {
  if (!arrow || typeof arrow.from !== 'string' || typeof arrow.to !== 'string') return null
  const id = typeof arrow.id === 'string' && arrow.id.trim() !== '' ? arrow.id.trim() : ''
  if (id === '' || arrow.from === arrow.to) return null
  const result: MindMapArrow = { id, from: arrow.from, to: arrow.to }
  if (typeof arrow.label === 'string' && arrow.label.trim() !== '') {
    result.label = arrow.label.trim()
  }
  if (arrow.bidirectional === true) result.bidirectional = true
  const color = normalizeRichColor(arrow.style?.stroke)
  if (color) result.color = color
  return result
}

function summaryFromElixir(summary: ElixirSummary): MindMapSummary | null {
  if (!summary || typeof summary.parent !== 'string') return null
  if (!Number.isInteger(summary.start) || !Number.isInteger(summary.end)) return null
  if (summary.start > summary.end) return null
  const id = typeof summary.id === 'string' && summary.id.trim() !== '' ? summary.id.trim() : ''
  if (id === '') return null
  const result: MindMapSummary = {
    id,
    parent: summary.parent,
    start: summary.start,
    end: summary.end
  }
  if (typeof summary.label === 'string' && summary.label.trim() !== '') {
    result.label = summary.label.trim()
  }
  const color = normalizeRichColor(summary.style?.stroke)
  if (color) result.color = color
  return result
}

export interface ToElixirOptions {
  /** 把文件里的相对路径解析成渲染层可加载的 URL；缺省原样返回（便于测试） */
  resolveImageSrc?: (src: string) => string
}

/**
 * 自有模型 → 渲染层数据。
 * `theme` 由组件在 init 时通过 options 传入，这里不处理主题。
 */
export function toElixirData(
  document: MindMapDocument,
  options: ToElixirOptions = {}
): MindElixirData {
  const resolveImageSrc = options.resolveImageSrc ?? ((src: string) => src)
  const data: MindElixirData = {
    nodeData: nodeToElixir(document.root, resolveImageSrc, true)
  }
  const direction = directionToElixir(document.direction)
  if (direction !== undefined) data.direction = direction
  if (document.arrows && document.arrows.length > 0) {
    data.arrows = document.arrows.map(arrowToElixir)
  }
  if (document.summaries && document.summaries.length > 0) {
    data.summaries = document.summaries.map(summaryToElixir)
  }
  return data
}

/**
 * 渲染层数据 → 自有模型。
 * 渲染层在导出时可能带上 `parent` 反指，这里不复用，避免把环写进文件。
 *
 * `rainbowBranches` 不属于渲染层数据，由调用方通过 options 传入（组件持有该视图设置）。
 */
export function fromElixirData(
  data: MindElixirData,
  options: Pick<MindMapDocument, 'rainbowBranches'> = {}
): MindMapDocument {
  const root = nodeFromElixir(data.nodeData, true)
  const document: MindMapDocument = {
    schema: MINDMAP_FILE_SCHEMA,
    version: MINDMAP_VERSION,
    root
  }
  const direction = directionFromElixir(data.direction)
  if (direction) document.direction = direction
  if (options.rainbowBranches === false) document.rainbowBranches = false

  // 连线的两端必须是活着的节点：渲染层在删节点后可能留下悬空箭头
  const ids = new Set<string>()
  const walk = (node: MindMapNode): void => {
    ids.add(node.id)
    node.children.forEach(walk)
  }
  walk(root)

  if (Array.isArray(data.arrows)) {
    const arrows = data.arrows
      .map(arrowFromElixir)
      .filter((arrow): arrow is MindMapArrow => arrow !== null)
      .filter((arrow) => ids.has(arrow.from) && ids.has(arrow.to))
    if (arrows.length > 0) document.arrows = arrows
  }

  if (Array.isArray(data.summaries)) {
    const childCount = new Map<string, number>()
    const count = (node: MindMapNode): void => {
      childCount.set(node.id, node.children.length)
      node.children.forEach(count)
    }
    count(root)
    const summaries = data.summaries
      .map(summaryFromElixir)
      .filter((summary): summary is MindMapSummary => summary !== null)
      .filter((summary) => (childCount.get(summary.parent) ?? 0) > 0)
    if (summaries.length > 0) document.summaries = summaries
  }

  return document
}
