/**
 * 节点富内容的校验与归一化
 *
 * 这一层只做「值合不合法、要不要保留」，既不碰渲染库也不碰文件系统，
 * 所以解析（打开文件）和编辑（右键菜单写入）可以共用同一套规则——
 * 否则同一条规则会在两处各写一遍，然后慢慢分叉。
 *
 * 所有校验函数都遵循同一个约定：**非法就给 undefined / 空数组，绝不抛错**。
 * 一个坏标签不该让整张导图打不开。
 */

import type { MindMapAttachment, MindMapIcon, MindMapImage, MindMapTag } from '../../types/mindmap'
import { MINDMAP_PRIORITIES } from '../../../shared/mindmap/document'

/** 允许的图标名；渲染层按名字映射成具体图形 */
export const MINDMAP_ICONS: readonly MindMapIcon[] = [
  'star',
  'flag',
  'question',
  'exclamation',
  'check'
]

/** 图标的中文名，用于右键菜单与属性栏 */
export const MINDMAP_ICON_LABELS: Record<MindMapIcon, string> = {
  star: '星标',
  flag: '旗帜',
  question: '疑问',
  exclamation: '重点',
  check: '已完成'
}

/**
 * 图标在画布上的字形。
 *
 * 渲染库把 `icons` 数组里的字符串**当纯文本**直接塞进 `<span>`，
 * 所以这里必须给字形而不是名字：否则节点上会显示「star」这个单词。
 * 文件里仍然存语义化的名字（可校验、可移植），字形只在渲染层出现。
 */
export const MINDMAP_ICON_GLYPHS: Record<MindMapIcon, string> = {
  star: '⭐',
  flag: '🚩',
  question: '❓',
  exclamation: '❗',
  check: '✅'
}

/** 字形 → 图标名，回读时把画布上的字形还原成语义名 */
export const MINDMAP_GLYPH_TO_ICON: Record<string, MindMapIcon> = Object.fromEntries(
  (Object.keys(MINDMAP_ICON_GLYPHS) as MindMapIcon[]).map((name) => [
    MINDMAP_ICON_GLYPHS[name],
    name
  ])
) as Record<string, MindMapIcon>

/**
 * 优先级预设：名字固定，颜色跟着名字走，避免同一优先级出现两种红。
 * 实际定义在 `shared/mindmap/document.ts`，XMind 导入要共用同一份。
 */
export { MINDMAP_PRIORITIES }

/** 单节点标签数上限 */
export const MAX_TAGS = 8
/** 单条标签文字上限 */
export const MAX_TAG_TEXT = 32
/** 文档内连线数上限 */
export const MAX_ARROWS = 500
/** 文档内概要数上限 */
export const MAX_SUMMARIES = 200
/** 图片路径/数据 URL 的字符串上限（12MB 的 base64 约等于 9MB 原图） */
export const MAX_IMAGE_SRC = 12 * 1024 * 1024
/** 图片显示尺寸的合理区间 */
const MIN_IMAGE_SIZE = 16
const MAX_IMAGE_SIZE = 4000

const HEX_COLOR = /^#[0-9a-f]{6}$/i
/** 只认 http/https：`javascript:` / `file:` 之类不该出现在导图里 */
const SAFE_LINK = /^https?:\/\/[^\s]+$/i
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i

/** 归一化颜色；非法值返回 undefined */
export function normalizeRichColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return HEX_COLOR.test(trimmed) ? trimmed.toLowerCase() : undefined
}

/** 校验图标名，未知图标丢弃（渲染库拿到不存在的名字会画空白） */
export function normalizeIcons(value: unknown): MindMapIcon[] {
  if (!Array.isArray(value)) return []
  const result: MindMapIcon[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim() as MindMapIcon
    if (MINDMAP_ICONS.includes(name) && !result.includes(name)) result.push(name)
  }
  return result.slice(0, MINDMAP_ICONS.length)
}

/**
 * 归一化标签。
 *
 * 既接受 `"P1"` 这种裸字符串（手写文件最省事），也接受 `{ text, color }`；
 * 空白标签丢弃，超长截断，数量封顶。
 */
export function normalizeTags(value: unknown): MindMapTag[] {
  if (!Array.isArray(value)) return []
  const result: MindMapTag[] = []
  for (const item of value) {
    let text = ''
    let color: string | undefined
    if (typeof item === 'string') {
      text = item.trim()
    } else if (item && typeof item === 'object') {
      const raw = item as { text?: unknown; color?: unknown }
      text = typeof raw.text === 'string' ? raw.text.trim() : ''
      color = normalizeRichColor(raw.color)
    }
    if (text === '') continue
    if (text.length > MAX_TAG_TEXT) text = text.slice(0, MAX_TAG_TEXT)
    if (result.some((tag) => tag.text === text)) continue
    result.push(color ? { text, color } : { text })
    if (result.length >= MAX_TAGS) break
  }
  return result
}

/** 校验超链接；只放行 http/https */
export function normalizeLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return SAFE_LINK.test(trimmed) ? trimmed : undefined
}

/**
 * 归一化图片。
 *
 * `src` 首选包内路径 `assets/images/<文件名>`：`.inkmind` 是 ZIP 容器，
 * 图片就在包里，不存在"图片找不到"这种状态。
 * `data:image/...;base64,` 仍接受——旧文件与手写文件不该直接打不开。
 */
export function normalizeImage(value: unknown): MindMapImage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { src?: unknown; width?: unknown; height?: unknown }
  if (typeof raw.src !== 'string') return undefined
  const src = raw.src.trim()
  if (src === '' || src.length > MAX_IMAGE_SRC) return undefined
  if (!DATA_IMAGE.test(src) && !isPackagedAsset(src, 'images')) return undefined

  const image: MindMapImage = { src }
  const width = toImageSize(raw.width)
  const height = toImageSize(raw.height)
  if (width) image.width = width
  if (height) image.height = height
  return image
}

/**
 * 校验包内资源路径：`assets/<images|files>/<文件名>`。
 *
 * 只允许一层、不允许 `.`/`..`、不允许反斜杠与冒号。
 * 这条规则同时守住解包（写盘）与解析（读文件）两头——
 * 一个手写的 `.inkmind` 不该有办法把文件写到包目录之外。
 */
export function isPackagedAsset(src: string, kind: 'images' | 'files'): boolean {
  const parts = src.split('/')
  if (parts.length !== 3) return false
  if (parts[0] !== 'assets' || parts[1] !== kind) return false
  const name = parts[2]
  if (name === '' || name === '.' || name === '..') return false
  return !/[\\:]/.test(name)
}

/** 单节点附件数上限 */
export const MAX_ATTACHMENTS = 10
/** 单个附件字节上限 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

const SAFE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

/**
 * 归一化附件。
 *
 * 附件是「外部文件的替身」，坏数据不该让整张图打不开，
 * 所以任何一项不合法就整条丢弃，而不是试图修补成半条。
 */
export function normalizeAttachments(value: unknown): MindMapAttachment[] {
  if (!Array.isArray(value)) return []
  const result: MindMapAttachment[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as {
      id?: unknown
      name?: unknown
      src?: unknown
      mime?: unknown
      size?: unknown
    }
    if (typeof raw.src !== 'string' || !isPackagedAsset(raw.src.trim(), 'files')) continue
    const src = raw.src.trim()
    if (seen.has(src)) continue
    if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0) continue
    if (raw.size > MAX_ATTACHMENT_BYTES) continue

    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : src
    const mimeRaw = typeof raw.mime === 'string' ? raw.mime.trim() : ''
    result.push({
      id,
      name: name === '' ? src.split('/').pop()! : name,
      src,
      mime: SAFE_MIME.test(mimeRaw) ? mimeRaw.toLowerCase() : 'application/octet-stream',
      size: Math.round(raw.size)
    })
    seen.add(src)
    if (result.length >= MAX_ATTACHMENTS) break
  }
  return result
}

function toImageSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  if (rounded < MIN_IMAGE_SIZE || rounded > MAX_IMAGE_SIZE) return undefined
  return rounded
}

/**
 * XMind 标记 id → 标签。
 *
 * 实现放在 `shared/mindmap/xmind.ts`：导入时主进程用同一份规则做映射，
 * 这里只是给渲染层一个入口，避免两处各写一套优先级映射。
 */
export { markerToTag as tagFromXmindMarker } from '../../../shared/mindmap/xmind'

/**
 * 生成一个文档内唯一的 id（连线、概要共用）。
 *
 * 用前缀区分类型，用户手改文件时一眼能看出这是连线还是概要。
 */
export function createRichId(prefix: string, existing: Set<string>): string {
  let index = existing.size + 1
  let candidate = `${prefix}${index}`
  while (existing.has(candidate)) {
    index += 1
    candidate = `${prefix}${index}`
  }
  existing.add(candidate)
  return candidate
}
