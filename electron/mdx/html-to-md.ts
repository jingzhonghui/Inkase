/**
 * HTML → Markdown 转换器
 *
 * 将 mammoth 生成的 HTML 转换为 Markdown 格式
 * 支持：标题、段落、粗体、斜体、行内代码、代码块、链接、图片、
 *       有序/无序列表、引用、水平线、表格
 */

import { parse, NodeType, type HTMLElement, type Node, type TextNode } from 'node-html-parser'

/** 转换选项 */
export interface HtmlToMdOptions {
  /** 图片路径映射（原始 src → 新路径） */
  imageMap?: Map<string, string>
}

/**
 * 将 HTML 转换为 Markdown
 */
export function htmlToMarkdown(html: string, options: HtmlToMdOptions = {}): string {
  const root = parse(html, { blockTextElements: { script: true, style: true } })
  const blocks: string[] = []

  for (const child of root.childNodes) {
    const block = convertBlock(child, options)
    if (block.trim()) {
      blocks.push(block.trim())
    }
  }

  return blocks.join('\n\n') + '\n'
}

/** 转换块级元素 */
function convertBlock(node: Node, options: HtmlToMdOptions): string {
  if (isTextNode(node)) {
    return escapeInline(node.text.trim())
  }

  if (!isElement(node)) {
    return ''
  }

  const tag = node.tagName.toLowerCase()

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tag[1])
      return '#'.repeat(level) + ' ' + convertInlineContent(node, options).trim()
    }

    case 'p':
      return convertInlineContent(node, options).trim()

    case 'pre': {
      let codeEl: HTMLElement | null = null
      for (const child of node.childNodes) {
        if (isElement(child) && child.tagName.toLowerCase() === 'code') {
          codeEl = child
          break
        }
      }
      const lang = codeEl?.getAttribute('class')?.replace(/^language-/, '') || ''
      const code = (codeEl ?? node).textContent.replace(/\n$/, '')
      return '```' + lang + '\n' + code + '\n```'
    }

    case 'blockquote': {
      const inner = node.childNodes
        .map((c) => convertBlock(c, options))
        .filter((s) => s.trim())
        .join('\n\n')
      return inner
        .split('\n')
        .map((line) => (line ? '> ' + line : '>'))
        .join('\n')
    }

    case 'ul':
    case 'ol':
      return convertList(node, tag === 'ol', 0, options)

    case 'hr':
      return '---'

    case 'table':
      return convertTable(node, options)

    case 'div':
    case 'section':
    case 'article':
    case 'body':
      return node.childNodes
        .map((c) => convertBlock(c, options))
        .filter((s) => s.trim())
        .join('\n\n')

    default:
      return convertInlineContent(node, options).trim()
  }
}

/** 转换列表 */
function convertList(el: HTMLElement, ordered: boolean, depth: number, options: HtmlToMdOptions): string {
  const lines: string[] = []
  let index = 1

  for (const li of el.children) {
    if (li.tagName.toLowerCase() !== 'li') continue

    const marker = ordered ? `${index++}. ` : '- '
    const indent = '  '.repeat(depth)

    const nestedLists: string[] = []
    const inlineParts: string[] = []

    for (const child of li.childNodes) {
      if (isElement(child) && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
        nestedLists.push(convertList(child, child.tagName.toLowerCase() === 'ol', depth + 1, options))
      } else if (isElement(child) && child.tagName.toLowerCase() === 'p') {
        inlineParts.push(convertInlineContent(child, options).trim())
      } else if (isTextNode(child)) {
        const t = child.text.trim()
        if (t) inlineParts.push(escapeInline(t))
      } else if (isElement(child)) {
        inlineParts.push(convertInlineContent(child, options).trim())
      }
    }

    lines.push(indent + marker + inlineParts.join(' ').trim())
    for (const nested of nestedLists) {
      lines.push(nested)
    }
  }

  return lines.join('\n')
}

/** 转换表格 */
function convertTable(el: HTMLElement, options: HtmlToMdOptions): string {
  const rows: string[][] = []

  const collectRows = (table: HTMLElement) => {
    for (const child of table.children) {
      const tag = child.tagName.toLowerCase()
      if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
        collectRows(child)
      } else if (tag === 'tr') {
        const cells: string[] = []
        for (const cell of child.children) {
          const cellTag = cell.tagName.toLowerCase()
          if (cellTag === 'th' || cellTag === 'td') {
            cells.push(convertInlineContent(cell, options).trim().replace(/\|/g, '\\|'))
          }
        }
        if (cells.length > 0) rows.push(cells)
      }
    }
  }

  collectRows(el)

  if (rows.length === 0) return ''

  const colCount = Math.max(...rows.map((r) => r.length))
  const padRow = (r: string[]) => {
    const copy = [...r]
    while (copy.length < colCount) copy.push('')
    return copy
  }

  const header = padRow(rows[0])
  const sep = Array.from({ length: colCount }, () => '---')
  const body = rows.slice(1).map(padRow)

  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + sep.join(' | ') + ' |',
    ...body.map((r) => '| ' + r.join(' | ') + ' |')
  ]

  return lines.join('\n')
}

/** 转换行内内容（递归） */
function convertInlineContent(node: Node, options: HtmlToMdOptions): string {
  if (isTextNode(node)) {
    return escapeInline(node.text)
  }

  if (!isElement(node)) return ''

  const tag = node.tagName.toLowerCase()
  const inner = node.childNodes.map((c) => convertInlineContent(c, options)).join('')

  switch (tag) {
    case 'strong':
    case 'b':
      return inner.trim() ? `**${inner.trim()}**` : ''
    case 'em':
    case 'i':
      return inner.trim() ? `*${inner.trim()}*` : ''
    case 'code':
      return inner.trim() ? `\`${inner.trim()}\`` : ''
    case 'a': {
      const href = node.getAttribute('href') || ''
      return href ? `[${inner.trim() || href}](${href})` : inner
    }
    case 'img': {
      const src = node.getAttribute('src') || ''
      const alt = node.getAttribute('alt') || ''
      const mapped = options.imageMap?.get(src) ?? src
      return `![${alt}](${mapped})`
    }
    case 'br':
      return '  \n'
    case 'span':
    case 'u':
    case 's':
    case 'del':
      return inner
    case 'sup':
      return inner.trim() ? `^${inner.trim()}^` : ''
    case 'sub':
      return inner.trim() ? `~${inner.trim()}~` : ''
    default:
      return inner
  }
}

/** 转义 Markdown 特殊字符（行内） */
function escapeInline(text: string): string {
  return text.replace(/([*_`[\]<>])/g, '\\$1')
}

/** 类型守卫：文本节点 */
function isTextNode(node: Node): node is TextNode {
  return node.nodeType === NodeType.TEXT_NODE
}

/** 类型守卫：元素节点 */
function isElement(node: Node): node is HTMLElement {
  return node.nodeType === NodeType.ELEMENT_NODE
}
