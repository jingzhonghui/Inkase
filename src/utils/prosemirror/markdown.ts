/**
 * ProseMirror ↔ Markdown 双向转换
 * 基于 prosemirror-markdown，扩展支持 GFM 特性
 */
import { Schema, Node as ProseMirrorNode, Mark, Fragment } from 'prosemirror-model'
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import { MarkdownParser, MarkdownSerializer, MarkdownSerializerState } from 'prosemirror-markdown'
import { markdownSchema } from './schema'

/**
 * markdown-it 规则：把相邻的、marker 重新开始的有序列表拆分为独立列表。
 * CommonMark 会把 `1. a\n2. b\n\n1. c\n2. d` 合并为一个列表，导致第二个列表
 * 的起始序号丢失（显示 3、4）。该规则根据 list_item 的 marker 数字判断：
 * 当后一项的 marker 数字 ≤ 前一项时（如 2 后面的 1），视为新列表开始。
 */
export function applyAdjacentOrderedListSplit(md: MarkdownIt): void {
  md.core.ruler.push('split_adjacent_ordered_lists', (state) => {
    const lines = state.src.split('\n')
    const tokens = state.tokens
    const result: typeof tokens = []
    let i = 0
    while (i < tokens.length) {
      const token = tokens[i]
      if (token.type !== 'ordered_list_open') {
        result.push(token)
        i++
        continue
      }

      // 收集整个列表 token 组
      const group = [token]
      let level = 1
      let j = i + 1
      while (j < tokens.length && level > 0) {
        const cur = tokens[j]
        group.push(cur)
        if (cur.type === 'ordered_list_open' || cur.type === 'bullet_list_open') level++
        if (cur.type === 'ordered_list_close' || cur.type === 'bullet_list_close') level--
        j++
      }

      // 提取顶层 list_item 的 marker 数字
      let lvl = 0
      const items: Array<{ gi: number; marker: number }> = []
      for (let k = 0; k < group.length; k++) {
        const g = group[k]
        if (g.type === 'ordered_list_open' || g.type === 'bullet_list_open') lvl++
        if (g.type === 'list_item_open' && lvl === 1) {
          const m = /^\s*(\d+)[.)]/.exec(lines[g.map?.[0] ?? 0] || '')
          items.push({ gi: k, marker: m ? parseInt(m[1], 10) : 0 })
        }
        if (g.type === 'ordered_list_close' || g.type === 'bullet_list_close') lvl--
      }

      // 拆分点：marker 重新开始
      const splits: number[] = []
      for (let k = 1; k < items.length; k++) {
        if (items[k].marker <= items[k - 1].marker) splits.push(items[k].gi)
      }

      let start = 0
      for (const sg of splits) {
        result.push(...group.slice(start, sg))
        const close = new state.Token('ordered_list_close', 'ol', -1)
        result.push(close)
        const open = new state.Token('ordered_list_open', 'ol', 1)
        const first = group[sg]
        open.map = first.map ? [first.map[0], first.map[1]] : null
        open.attrSet('start', String(items.find((x) => x.gi === sg)?.marker ?? 1))
        result.push(open)
        start = sg
      }
      result.push(...group.slice(start))
      i = j
    }
    state.tokens = result
  })
}

/**
 * markdown-it 规则：把「每个列表项都以 [ ] / [x] 开头」的无序列表识别为任务列表。
 * CommonMark/GFM 的 markdown-it 默认不产出任务列表 token，这里在 core 阶段直接改写 token：
 * bullet_list → task_list，list_item → task_item，同时剥离文本前缀并写入 checked 属性。
 */
export function applyTaskListRule(md: MarkdownIt): void {
  md.core.ruler.push('task_lists', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'bullet_list_open') continue

      let depth = 0
      let closeIndex = -1
      const items: Array<{ open: number; close: number }> = []
      let current: { open: number; close: number } | null = null
      for (let j = i; j < tokens.length; j++) {
        const t = tokens[j]
        if (t.type === 'bullet_list_open') depth++
        else if (t.type === 'bullet_list_close') {
          depth--
          if (depth === 0) {
            closeIndex = j
            break
          }
        } else if (depth === 1 && t.type === 'list_item_open') {
          current = { open: j, close: -1 }
          items.push(current)
        } else if (depth === 1 && t.type === 'list_item_close' && current) {
          current.close = j
          current = null
        }
      }
      if (closeIndex === -1 || items.length === 0) continue

      // 每个列表项的首个 inline 都必须以任务标记开头，否则保持普通无序列表
      const checks = items.map((it) => {
        for (let k = it.open + 1; k < it.close; k++) {
          if (tokens[k].type === 'inline') {
            const m = /^\[( |x|X)\]\s+/.exec(tokens[k].content)
            return m ? { checked: m[1].toLowerCase() === 'x', inlineIndex: k } : null
          }
        }
        return null
      })
      if (checks.some((c) => c === null)) continue

      tokens[i].type = 'task_list_open'
      tokens[closeIndex].type = 'task_list_close'
      for (let n = 0; n < items.length; n++) {
        const it = items[n]
        const check = checks[n] as { checked: boolean; inlineIndex: number }
        tokens[it.open].type = 'task_item_open'
        tokens[it.close].type = 'task_item_close'
        tokens[it.open].attrSet('checked', check.checked ? 'true' : 'false')
        const inlineTok = tokens[check.inlineIndex]
        inlineTok.content = inlineTok.content.replace(/^\[( |x|X)\]\s+/, '')
        const firstText = inlineTok.children?.find((c) => c.type === 'text')
        if (firstText) firstText.content = firstText.content.replace(/^\[( |x|X)\]\s+/, '')
      }
    }
  })
}

/**
 * 创建 MarkdownIt 实例
 */
function createMarkdownIt(): MarkdownIt {
  const md = MarkdownIt('commonmark', {
    html: false,
    // 与预览（utils/markdown.ts）保持一致：单个换行按硬换行处理、裸 URL 自动识别为链接
    breaks: true,
    linkify: true
  })
  // commonmark preset 不含 GFM 扩展，需显式启用表格、删除线与自动链接
  md.enable(['table', 'strikethrough', 'linkify'])
  applyAdjacentOrderedListSplit(md)
  applyTaskListRule(md)

  // 下划线 <u>...</u>（Markdown 无原生下划线语法，沿用 HTML 标签与预览保持一致）
  md.inline.ruler.before('html_inline', 'underline', (state, silent) => {
    if (state.src.startsWith('<u>', state.pos)) {
      // 无闭合标签时按普通文本处理，避免产生未配对的下划线 mark
      if (state.src.indexOf('</u>', state.pos + 3) === -1) return false
      if (!silent) {
        state.push('u_open', 'u', 1).markup = '<u>'
      }
      state.pos += 3
      return true
    }
    if (state.src.startsWith('</u>', state.pos)) {
      if (!silent) {
        state.push('u_close', 'u', -1).markup = '</u>'
      }
      state.pos += 4
      return true
    }
    return false
  })

  // 行内数学公式规则 $...$
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) return false
    if (state.src.charCodeAt(state.pos + 1) === 0x24 /* $ */) return false
    const start = state.pos + 1
    const end = state.src.indexOf('$', start)
    if (end === -1 || end === start) return false
    if (state.src.charCodeAt(end - 1) === 0x5c /* \ */) return false
    const content = state.src.slice(start, end)
    if (content.includes('\n')) return false
    if (!silent) {
      const token = state.push('math_inline', 'math', 0)
      token.content = content
      token.markup = '$'
    }
    state.pos = end + 1
    return true
  })

  // 块级数学公式规则 $$...$$
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    if (pos + 2 > max || state.src.slice(pos, pos + 2) !== '$$') return false
    let endLineNum = -1
    for (let i = startLine + 1; i < endLine; i++) {
      const lp = state.bMarks[i] + state.tShift[i]
      const lm = state.eMarks[i]
      if (state.src.slice(lp, lm).trim() === '$$') {
        endLineNum = i
        break
      }
    }
    if (endLineNum === -1) return false
    if (!silent) {
      const token = state.push('math_block', 'math', 0)
      const lines: string[] = []
      for (let i = startLine + 1; i < endLineNum; i++) {
        const lp = state.bMarks[i] + state.tShift[i]
        const lm = state.eMarks[i]
        lines.push(state.src.slice(lp, lm))
      }
      token.content = lines.join('\n')
      token.markup = '$$'
      token.map = [startLine, endLineNum + 1]
      token.block = true
    }
    state.line = endLineNum + 1
    return true
  })

  return md
}

/**
 * Token 处理器定义
 * 使用 prosemirror-markdown 期望的标准格式
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createTokens(_schema: Schema): Record<string, any> {
  // 辅助函数：获取 token 属性
  const getAttr = (tok: Token, name: string): string | null => {
    return (
      (tok as any).attrGet?.(name) ??
      tok.attrs?.find((a: [string, string]) => a[0] === name)?.[1] ??
      null
    )
  }

  return {
    // 段落 - 块级
    paragraph: { block: 'paragraph' },

    // 标题 - 块级
    heading: {
      block: 'heading',
      getAttrs: (tok: Token) => ({ level: parseInt(tok.tag.slice(1), 10) })
    },

    // 引用块
    blockquote: { block: 'blockquote' },

    // 代码块（缩进式）
    code_block: {
      block: 'code_block',
      getAttrs: () => ({ language: '' }),
      noCloseToken: true
    },

    // 围栏代码块
    fence: {
      block: 'code_block',
      getAttrs: (tok: Token) => ({ language: tok.info || '' }),
      noCloseToken: true
    },

    // 有序列表
    ordered_list: {
      block: 'ordered_list',
      getAttrs: (tok: Token) => {
        const start = getAttr(tok, 'start')
        return { order: start ? parseInt(start, 10) : 1 }
      }
    },

    // 无序列表
    bullet_list: { block: 'bullet_list' },

    // 列表项
    list_item: { block: 'list_item' },

    // 任务列表（GFM，由 applyTaskListRule 改写 token 产生）
    task_list: { block: 'task_list' },
    task_item: {
      block: 'task_item',
      getAttrs: (tok: Token) => ({ checked: getAttr(tok, 'checked') === 'true' })
    },

    // 水平分割线 - 行内节点
    hr: { node: 'horizontal_rule' },

    // 硬换行
    hardbreak: { node: 'hard_break' },
    // breaks:true 语义：段落内的软换行也视作硬换行（与预览一致）
    softbreak: { node: 'hard_break' },

    // 图片
    image: {
      node: 'image',
      getAttrs: (tok: Token) => ({
        src: getAttr(tok, 'src') || '',
        alt: getAttr(tok, 'alt') || '',
        title: getAttr(tok, 'title') || ''
      })
    },

    // 表格 - 使用 ignore 跳过 tbody/thead
    // handler 名用基名，prosemirror-markdown 自动加 _open/_close 后缀
    table: { block: 'table' },
    tr: { block: 'table_row' },
    td: {
      block: 'table_cell',
      getAttrs: (tok: Token) => {
        const style = getAttr(tok, 'style') || ''
        const match = style.match(/text-align:(\w+)/)
        return { align: match ? match[1] : null }
      }
    },
    th: {
      block: 'table_header',
      getAttrs: (tok: Token) => {
        const style = getAttr(tok, 'style') || ''
        const match = style.match(/text-align:(\w+)/)
        return { align: match ? match[1] : null }
      }
    },
    thead: { ignore: true },
    tbody: { ignore: true },

    // 数学公式（叶子节点，源码存于 source 属性）
    math_inline: { node: 'math_inline', getAttrs: (tok: Token) => ({ source: tok.content }) },
    math_block: { node: 'math_block', getAttrs: (tok: Token) => ({ source: tok.content }) },

    // 行内标记
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strikethrough' },
    u: { mark: 'underline' },
    code_inline: { mark: 'code', noCloseToken: true },
    link: {
      mark: 'link',
      getAttrs: (tok: Token) => ({
        href: getAttr(tok, 'href') || '',
        title: getAttr(tok, 'title') || ''
      })
    }
  }
}

/**
 * 自定义 Markdown 解析器
 */
function createMarkdownParser(schema: Schema): MarkdownParser {
  const tokens = createTokens(schema)
  return new MarkdownParser(schema, createMarkdownIt(), tokens)
}

/**
 * 自定义 Markdown 序列化器
 */
function createMarkdownSerializer(_schema: Schema): MarkdownSerializer {
  const nodes: Record<string, (state: MarkdownSerializerState, node: ProseMirrorNode) => void> = {
    text(state, node) {
      state.text(node.text || '', false)
    },

    paragraph(state, node) {
      state.renderInline(node)
      state.closeBlock(node)
    },

    heading(state, node) {
      state.write(state.repeat('#', node.attrs.level as number) + ' ')
      state.renderInline(node)
      state.closeBlock(node)
    },

    blockquote(state, node) {
      state.wrapBlock('> ', null, node, () => state.renderContent(node))
    },

    code_block(state, node) {
      state.write('```' + (node.attrs.language || '') + '\n')
      state.text(node.textContent, false)
      state.ensureNewLine()
      state.write('```')
      state.closeBlock(node)
    },

    ordered_list(state, node) {
      const start = node.attrs.order || 1
      const maxW = String(start + node.childCount - 1).length
      const space = state.repeat(' ', maxW + 2)
      state.renderList(node, space, (i) => {
        const nStr = String(start + i)
        return state.repeat(' ', maxW - nStr.length) + nStr + '. '
      })
    },

    bullet_list(state, node) {
      state.renderList(node, '  ', () => '- ')
    },

    task_list(state, node) {
      // 标记由 renderList 的首行前缀统一输出，task_item 只渲染内容，避免重复写 '- [ ]'
      state.renderList(node, '  ', (i) => (node.child(i).attrs.checked ? '- [x] ' : '- [ ] '))
    },

    list_item(state, node) {
      state.renderContent(node)
    },

    task_item(state, node) {
      state.renderContent(node)
    },

    table(state, node) {
      node.forEach((row, _, i) => {
        state.render(row, node, i)
        // 首行若是表头，追加 GFM 分隔行
        if (i === 0 && row.firstChild?.type.name === 'table_header') {
            const aligns: string[] = []
            row.forEach((cell) => {
              const a = cell.attrs.align as string | null
              if (a === 'left') aligns.push(':---')
              else if (a === 'center') aligns.push(':---:')
              else if (a === 'right') aligns.push('---:')
              else aligns.push('---')
            })
          if (aligns.length > 0) {
            state.write('| ' + aligns.join(' | ') + ' |')
            state.ensureNewLine()
          }
        }
      })
      state.ensureNewLine()
    },

    table_row(state, node) {
      state.write('| ')
      node.forEach((cell) => {
        state.renderInline(cell)
        state.write(' | ')
      })
      state.ensureNewLine()
    },

    table_cell(state, node) {
      state.renderInline(node)
      state.write(' | ')
    },

    table_header(state, node) {
      state.renderInline(node)
      state.write(' | ')
    },

    horizontal_rule(state, node) {
      state.write('---')
      state.closeBlock(node)
    },

    hard_break(state) {
      // 解析器 breaks:true，普通换行即硬换行，写回 '\n' 可保证往返完全一致
      state.write('\n')
    },

    image(state, node) {
      state.write(
        '![' +
          state.esc((node.attrs.alt as string) || '') +
          '](' +
          state.esc((node.attrs.src as string) || '')
      )
      if (node.attrs.title) {
        state.write(' "' + node.attrs.title + '"')
      }
      state.write(')')
    },

    math_inline(state, node) {
      state.write('$' + (node.attrs.source || '') + '$')
    },

    math_block(state, node) {
      state.write('$$\n')
      state.text((node.attrs.source as string) || '', false)
      state.ensureNewLine()
      state.write('$$')
      state.closeBlock(node)
    }
  }

  const marks: Record<
    string,
    {
      open: string | ((_state: MarkdownSerializerState, mark: Mark) => string)
      close: string | ((_state: MarkdownSerializerState, mark: Mark) => string)
      mixable?: boolean
      expelEnclosingWhitespace?: boolean
      escape?: boolean
    }
  > = {
    bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
    italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
    strikethrough: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    underline: { open: '<u>', close: '</u>' },
    code: { open: '`', close: '`', escape: false },
    link: {
      open: '[',
      close: (_state, mark) =>
        '](' + mark.attrs.href + (mark.attrs.title ? ' "' + mark.attrs.title + '"' : '') + ')'
    }
  }

  return new MarkdownSerializer(nodes, marks)
}

// 创建解析器和序列化器实例
const markdownParser = createMarkdownParser(markdownSchema)
const markdownSerializer = createMarkdownSerializer(markdownSchema)

/**
 * Markdown → ProseMirror Node 解析
 * @param content Markdown 文本
 * @returns ProseMirror Node
 */
export function parseMarkdown(content: string): ProseMirrorNode {
  // 空文档也必须保留一个段落，否则 IR 模式没有可放置光标的编辑节点。
  if (!content.trim()) {
    return markdownSchema.node('doc', null, [markdownSchema.node('paragraph')])
  }

  const doc = (
    markdownParser.parse(content) ||
    markdownSchema.node('doc', null, [markdownSchema.node('paragraph')])
  )

  const lastType = doc.lastChild?.type.name
  // 代码块/表格都是"不透明"的块节点，末尾没有可继续输入/放置光标的段落；
  // 编辑器依赖末尾空段落（createPlugins 的 appendTransaction 也保证这一点）。
  // 若这里不补，首次任何 dispatch 都会触发 appendTransaction 追加段落，
  // 被 createDocumentChangePlugin 当作文档被修改回写 store，导致打开即"未保存"。
  if (lastType === 'code_block' || lastType === 'table') {
    return doc.copy(doc.content.append(Fragment.from(markdownSchema.node('paragraph'))))
  }

  return doc
}

/**
 * ProseMirror Node → Markdown 序列化
 * @param doc ProseMirror Node
 * @returns Markdown 文本
 */
export function serializeMarkdown(doc: ProseMirrorNode): string {
  // tightLists: true —— 默认按紧凑列表序列化，避免「打开紧凑列表→切换模式」后被插入空行
  return markdownSerializer.serialize(doc, { tightLists: true })
}

export { markdownParser, markdownSerializer, markdownSchema }
