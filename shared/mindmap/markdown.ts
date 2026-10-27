/**
 * Markdown 大纲 → 思维导图
 *
 * 用途：把已经写好的笔记（标题层级 + 列表缩进）转成一张导图，省掉重新敲一遍。
 * 解析策略刻意「宽松而可预期」：
 * - `#`~`######` 按层级嵌套，`#` 是一级子主题，不是中心主题（中心主题取文件名/首标题）；
 * - `-` `*` `+` `1.` 按缩进嵌套，一个缩进层级（2 空格或 1 个 Tab）就是一层；
 * - 列表默认挂在最近一个标题下面，符合「标题是章节、列表是条目」的直觉；
 * - 没有任何结构（纯段落）时，每行变成一个子主题，至少不会丢内容。
 *
 * 只输出 `.inkmind` 的落盘文本，不碰渲染层，主进程与渲染进程都能用。
 */

import { MINDMAP_FILE_SCHEMA, MINDMAP_VERSION } from './document'

export interface MindMapFromMarkdownOptions {
  /** 中心主题文案（通常传文件名）；缺省时用首个标题或「中心主题」 */
  title?: string
  /** nodes：每个节点的 text 从哪来 */
  maxNodes?: number
}

interface DraftNode {
  id: string
  text: string
  children: DraftNode[]
}

const DEFAULT_MAX_NODES = 20000
/** 一个缩进层级对应的空格数；Tab 记 2 个 */
const INDENT_UNIT = 2

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/
const BULLET_RE = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/

function stripInlineMarks(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]+/g, '')
    .trim()
}

export function markdownToMindMapJson(
  markdown: string,
  options: MindMapFromMarkdownOptions = {}
): string {
  const source = typeof markdown === 'string' ? markdown : ''
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES

  let counter = 0
  const makeNode = (text: string): DraftNode => {
    counter += 1
    return { id: `n_${counter}`, text, children: [] }
  }

  const lines = source.split(/\r?\n/)
  // 先扫一遍标题，拿到中心主题候选（第一个标题）
  let rootText = options.title?.trim() ?? ''
  if (!rootText) {
    for (const line of lines) {
      const heading = HEADING_RE.exec(line)
      if (heading && stripInlineMarks(heading[2])) {
        rootText = stripInlineMarks(heading[2])
        break
      }
    }
  }
  const root = makeNode(rootText || '中心主题')

  /** 标题栈：level → 该层最近的节点（level 从 1 开始） */
  const headingStack: Array<{ level: number; node: DraftNode }> = []
  /** 列表栈：indent → 节点 */
  const bulletStack: Array<{ indent: number; node: DraftNode }> = []
  /** 是否处于 ``` / ~~~ 围栏代码块内 */
  let inFence = false
  let count = 1

  const pushChild = (parent: DraftNode, text: string): DraftNode | null => {
    if (count >= maxNodes) return null
    const node = makeNode(text)
    parent.children.push(node)
    count += 1
    return node
  }

  const addHeading = (level: number, text: string): void => {
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop()
    }
    // 标题属于文档结构：一级标题直接挂中心主题，否则挂上一层标题
    const parent = headingStack.length > 0 ? headingStack[headingStack.length - 1].node : root
    const node = pushChild(parent, text)
    headingStack.push({ level, node: node ?? parent })
    // 换标题意味着列表层级重新开始
    bulletStack.length = 0
  }

  const addBullet = (indent: number, text: string): void => {
    while (bulletStack.length > 0 && bulletStack[bulletStack.length - 1].indent >= indent) {
      bulletStack.pop()
    }
    const fallbackHeading =
      headingStack.length > 0 ? headingStack[headingStack.length - 1].node : root
    const parent = bulletStack.length > 0 ? bulletStack[bulletStack.length - 1].node : fallbackHeading
    const node = pushChild(parent, text)
    bulletStack.push({ indent, node: node ?? parent })
  }

  for (const line of lines) {
    if (count >= maxNodes) break

    // 围栏代码块整块跳过：代码行里的 `-`、`#` 都不是大纲结构
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!line.trim()) continue

    const heading = HEADING_RE.exec(line)
    if (heading) {
      const text = stripInlineMarks(heading[2])
      if (!text) continue
      addHeading(heading[1].length, text)
      continue
    }

    const bullet = BULLET_RE.exec(line)
    if (bullet) {
      const text = stripInlineMarks(bullet[2])
      if (!text) continue
      const rawIndent = bullet[1].replace(/\t/g, ' '.repeat(INDENT_UNIT))
      addBullet(Math.floor(rawIndent.length / INDENT_UNIT), text)
      continue
    }

    // 普通段落：跳过引用块与分割线，其余当作中心主题的直接子主题
    const trimmed = line.trim()
    if (trimmed.startsWith('>')) continue
    if (/^[-*_]{3,}$/.test(trimmed)) continue
    const text = stripInlineMarks(trimmed)
    if (!text) continue
    bulletStack.length = 0
    pushChild(root, text)
  }

  const document = {
    schema: MINDMAP_FILE_SCHEMA,
    version: MINDMAP_VERSION,
    root
  }
  return `${JSON.stringify(document, null, 2)}\n`
}
