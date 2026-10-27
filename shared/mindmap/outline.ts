/**
 * 思维导图 → 纯文本大纲
 *
 * `.inkmind` 是给人看的 JSON，但对「送进模型」这类消费方来说全是噪声：
 * 花括号、引号、节点 id 会占掉大量 token，模型还得自己重建层级。
 * 这里把导图摊平成缩进大纲，层级用两个空格表示，备注跟在主题后面。
 *
 * 只依赖文本，不 import 渲染层/Electron，主进程与渲染进程都能用。
 */

export interface MindMapOutlineOptions {
  /** 每层缩进，默认两个空格 */
  indent?: string
  /** 备注前缀，默认「（备注：…）」 */
  notePrefix?: string
  /** 备注后缀 */
  noteSuffix?: string
  /** 最大节点数，防止病态文件把调用方拖死 */
  maxNodes?: number
}

const DEFAULT_MAX_NODES = 20000
const DEFAULT_MAX_DEPTH = 128

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把导图 JSON 文本摊平成大纲。
 *
 * 解析失败或结构不合法时返回空字符串，由调用方决定是报错还是回退到原文——
 * 这里不做策略决定，只做转换，避免在主进程里吞掉错误细节。
 */
export function extractMindMapOutline(
  json: string,
  options: MindMapOutlineOptions = {}
): string {
  if (typeof json !== 'string' || json.trim() === '') return ''

  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return ''
  }
  if (!isObject(data)) return ''
  const root = data.root
  if (!isObject(root)) return ''

  const indent = options.indent ?? '  '
  const notePrefix = options.notePrefix ?? '（备注：'
  const noteSuffix = options.noteSuffix ?? '）'
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES

  const lines: string[] = []
  let count = 0

  const walk = (node: Record<string, unknown>, depth: number): void => {
    if (count >= maxNodes || depth > DEFAULT_MAX_DEPTH) return
    count += 1

    const text = typeof node.text === 'string' ? node.text.trim() : ''
    const note = typeof node.note === 'string' ? node.note.trim() : ''
    const line = text || '（未命名主题）'
    const withNote = note ? `${line}${notePrefix}${note}${noteSuffix}` : line
    lines.push(indent.repeat(depth) + withNote)

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (isObject(child)) walk(child, depth + 1)
      }
    }
  }

  walk(root, 0)
  return lines.join('\n')
}

/** 大纲是否包含可读内容（用于「导图读不出东西」这类判断） */
export function hasReadableOutline(outline: string): boolean {
  return typeof outline === 'string' && outline.trim() !== ''
}
