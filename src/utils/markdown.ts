import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import katex from 'katex'
import type { MdxImageAsset } from '../types/mdx'
import { applyAdjacentOrderedListSplit } from './prosemirror/markdown'

// Markdown-it 实例
let md: MarkdownIt | null = null

/**
 * 渲染数学公式为 HTML
 * @param content LaTeX 内容
 * @param displayMode 是否为块级显示
 */
function renderMath(content: string, displayMode: boolean): string {
  try {
    return katex.renderToString(content.trim(), {
      displayMode,
      throwOnError: false,
      strict: false
    })
  } catch {
    // 渲染失败时返回原始内容
    return displayMode
      ? `<div class="katex-error">$$${escapeHtml(content)}$$</div>`
      : `<span class="katex-error">$${escapeHtml(content)}$</span>`
  }
}

/**
 * markdown-it 数学公式插件
 * 支持行内 $...$ 和块级 $$...$$
 */
function mathPlugin(markdownIt: MarkdownIt): void {
  // 行内数学公式规则
  markdownIt.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    // 检查是否以 $ 开头且不是 $$
    if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) return false
    if (state.src.charCodeAt(state.pos + 1) === 0x24 /* $ */) return false

    const start = state.pos + 1
    const end = state.src.indexOf('$', start)

    // 找不到闭合 $，或内容为空
    if (end === -1 || end === start) return false

    // 检查 $ 前是否有转义符
    if (state.src.charCodeAt(end - 1) === 0x5C /* \ */) return false

    // 内容不能包含换行
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

  // 块级数学公式规则
  markdownIt.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]

    // 检查行首是否是 $$
    if (pos + 2 > max || state.src.slice(pos, pos + 2) !== '$$') return false

    // 查找闭合 $$
    let nextLine = startLine + 1
    let endLineNum = -1

    while (nextLine < endLine) {
      const linePos = state.bMarks[nextLine] + state.tShift[nextLine]
      const lineMax = state.eMarks[nextLine]
      const lineContent = state.src.slice(linePos, lineMax).trim()

      if (lineContent === '$$') {
        endLineNum = nextLine
        break
      }
      nextLine++
    }

    // 没找到闭合标记
    if (endLineNum === -1) return false

    if (!silent) {
      const token = state.push('math_block', 'math', 0)
      // 收集 $$ 之间的所有内容
      const contentLines: string[] = []
      for (let i = startLine + 1; i < endLineNum; i++) {
        const linePos = state.bMarks[i] + state.tShift[i]
        const lineMax = state.eMarks[i]
        contentLines.push(state.src.slice(linePos, lineMax))
      }
      token.content = contentLines.join('\n')
      token.markup = '$$'
      token.map = [startLine, endLineNum + 1]
      token.block = true
    }

    state.line = endLineNum + 1
    return true
  })

  // 渲染规则
  markdownIt.renderer.rules.math_inline = (tokens, idx) => {
    return renderMath(tokens[idx].content, false)
  }

  markdownIt.renderer.rules.math_block = (tokens, idx) => {
    return renderMath(tokens[idx].content, true) + '\n'
  }
}

/**
 * GFM 任务列表标记：`[ ]` / `[x]` / `[X]`，后接空白（空任务项则到行尾）。
 * 只在列表项的第一个文本块开头匹配，避免把正文中间的方括号当勾选框。
 */
const TASK_MARKER_RE = /^\[( |x|X)\](?:[ \t]+|$)/

/** 列表开/闭 token 的类型判定（bullet_list / ordered_list 都算）。 */
function isListOpen(type: string): boolean {
  return type === 'bullet_list_open' || type === 'ordered_list_open'
}

function isListClose(type: string): boolean {
  return type === 'bullet_list_close' || type === 'ordered_list_close'
}

/**
 * 在列表项范围内找第一个顶层 inline token（跳过嵌套列表里的）。
 * 任务标记必须落在项的首个文本块上，嵌套子列表的文本不算。
 */
function findFirstInline(tokens: Token[], start: number, end: number): Token | null {
  let depth = 0
  for (let i = start + 1; i < end; i++) {
    const token = tokens[i]
    if (isListOpen(token.type)) depth++
    else if (isListClose(token.type)) depth--
    else if (depth === 0 && token.type === 'inline') return token
  }
  return null
}

/**
 * markdown-it 插件：渲染 GFM 任务列表。
 *
 * markdown-it 本身没有任务列表语法，而行内 token 的可见文本来自 children（不是
 * content），所以只在 renderer 的 list_item_open 里改 content 不会生效——这也是旧实现
 * 会在预览里留下 `[x]` 字样的原因。这里在 core 阶段直接改写 token：
 * 给列表/列表项加 class 与 data-checked，剥离 `[x] ` 前缀，并在行内 token 的 children
 * 头部插入真正的 <input type="checkbox">，让预览与 PDF 导出共用同一套结构。
 *
 * 逐项判定（与 GFM 一致）：列表里只要某一项以标记开头就是任务项，其余项保持普通列表项。
 */
function applyTaskListRule(markdownIt: MarkdownIt): void {
  markdownIt.core.ruler.push('task_lists', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      const listOpen = tokens[i]
      if (!isListOpen(listOpen.type)) continue

      // 先收集这一层的列表项（深度 1），嵌套列表由外层循环自行处理
      let depth = 0
      let closeIndex = -1
      const items: Array<{ open: number; close: number }> = []
      let current: { open: number; close: number } | null = null
      for (let j = i; j < tokens.length; j++) {
        const token = tokens[j]
        if (isListOpen(token.type)) {
          depth++
        } else if (isListClose(token.type)) {
          depth--
          if (depth === 0) {
            closeIndex = j
            break
          }
        } else if (depth === 1 && token.type === 'list_item_open') {
          current = { open: j, close: -1 }
          items.push(current)
        } else if (depth === 1 && token.type === 'list_item_close' && current) {
          current.close = j
          current = null
        }
      }
      if (closeIndex === -1 || items.length === 0) continue

      let containsTask = false
      for (const item of items) {
        const inline = findFirstInline(tokens, item.open, item.close)
        if (!inline) continue
        const match = TASK_MARKER_RE.exec(inline.content)
        if (!match) continue

        containsTask = true
        const checked = match[1].toLowerCase() === 'x'
        const itemToken = tokens[item.open]
        itemToken.attrJoin('class', 'task-list-item')
        itemToken.attrSet('data-checked', checked ? 'true' : 'false')

        // 剥掉 `[x] ` 前缀：content 供后续规则/插件读取，children 才是渲染时真正使用的文本
        inline.content = inline.content.slice(match[0].length)
        const firstText = inline.children?.find((child) => child.type === 'text')
        if (firstText) {
          const childMatch = TASK_MARKER_RE.exec(firstText.content)
          if (childMatch) firstText.content = firstText.content.slice(childMatch[0].length)
        }

        // 勾选框插在行内内容最前面（html: true 下按原样输出），阅读态与 GitHub 一致；
        // 文本再用 .task-text 包一层，已勾选时的删除线只作用于本项文字，不外溢到嵌套子列表。
        const checkbox = new state.Token('html_inline', '', 0)
        checkbox.content = `<input type="checkbox" class="task-checkbox"${checked ? ' checked' : ''} disabled>`
        const textOpen = new state.Token('html_inline', '', 0)
        textOpen.content = '<span class="task-text">'
        const textClose = new state.Token('html_inline', '', 0)
        textClose.content = '</span>'
        if (!inline.children) inline.children = []
        inline.children.unshift(checkbox, textOpen)
        inline.children.push(textClose)
      }

      if (containsTask) listOpen.attrJoin('class', 'contains-task-list')
    }
  })
}

/**
 * 获取 Markdown-it 实例（单例）
 */
export function getMarkdownIt(): MarkdownIt {
  if (!md) {
    md = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: true,
      breaks: true,
      highlight: (str: string, lang: string) => {
        // 代码高亮由 Shiki 处理，这里只返回原始代码
        return `<pre class="shiki"><code class="language-${lang || 'text'}">${escapeHtml(str)}</code></pre>`
      }
    })

    // 添加 GFM 支持
    md.enable(['table', 'strikethrough'])

    // 相邻的有序列表拆分为独立列表
    applyAdjacentOrderedListSplit(md)

    // 数学公式支持
    md.use(mathPlugin)

    // 自定义链接渲染，为文件链接添加 data-link-href 和 class 属性
    const defaultLinkOpen = md.renderer.rules.link_open || function(tokens, idx, options, _env, self) {
      return self.renderToken(tokens, idx, options)
    }

    md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
      const href = tokens[idx].attrGet('href') || ''
      if (href.startsWith('#')) {
        return defaultLinkOpen(tokens, idx, options, env, self)
      }
      tokens[idx].attrSet('class', 'md-link')
      tokens[idx].attrSet('data-link-href', href)
      return self.renderToken(tokens, idx, options)
    }

    // GFM 任务列表（`- [ ]` / `- [x]`）
    applyTaskListRule(md)

    // 块级元素标注源码起始行：分屏切换编辑模式时按行号恢复阅读位置
    applySourceLineRule(md)
  }

  return md
}

/**
 * 给块级 open token 写入 `data-source-line`（Markdown 行号，1 基）。
 * markdown-it 的 block token 带 `map`（[起始行, 结束行)），预览据此把 DOM 块映射回源码行。
 */
function applySourceLineRule(markdownIt: MarkdownIt): void {
  markdownIt.core.ruler.push('source_lines', (state) => {
    for (const token of state.tokens) {
      if (token.nesting !== 1 || !token.map) continue
      token.attrSet('data-source-line', String(token.map[0] + 1))
    }
  })

  // 代码块走自定义 <pre>（高亮由 Shiki 负责），默认 renderToken 不会输出属性
  markdownIt.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]
    const line = token.map ? token.map[0] + 1 : null
    const language = token.info.trim().split(/\s+/)[0] || 'text'
    const attr = line ? ` data-source-line="${line}"` : ''
    return `<pre class="shiki"${attr}><code class="language-${language}">${escapeHtml(token.content)}</code></pre>\n`
  }

  markdownIt.renderer.rules.code_block = (tokens, idx) => {
    const token = tokens[idx]
    const line = token.map ? token.map[0] + 1 : null
    const attr = line ? ` data-source-line="${line}"` : ''
    return `<pre${attr}><code>${escapeHtml(token.content)}</code></pre>\n`
  }
}

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * 渲染 Markdown 为 HTML
 * @param content Markdown 内容
 * @param imageAssets 图片资源列表，用于替换路径
 * @returns HTML 字符串
 */
export function renderMarkdown(content: string, imageAssets: MdxImageAsset[] = []): string {
  const markdown = getMarkdownIt()

  // 处理图片路径替换
  let processedContent = content
  imageAssets.forEach(asset => {
    // 替换图片引用路径
    const escapedPath = asset.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`!\\[([^\\]]*)\\]\\(${escapedPath}\\)`, 'g')
    processedContent = processedContent.replace(regex, (_match, alt) => {
      // 使用 data URL 或 blob URL（这里先用路径占位）
      return `![${alt}](${asset.path})`
    })
  })

  return markdown.render(processedContent)
}

/**
 * 提取 Markdown 中的标题结构（用于大纲视图）
 */
export interface HeadingItem {
  level: number
  text: string
  line: number
}

/** 行首 ATX 标题：1~6 个 `#` + 空格 + 文本，可选的行尾闭合 `#`。 */
const ATX_HEADING_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
/** 围栏代码块起始/结束（``` 或 ~~~）。 */
const FENCE_RE = /^\s*(```|~~~)/

/**
 * 提取 Markdown 标题（顶层 ATX 标题，1~6 级）。
 * 跳过围栏代码块内的行；忽略引用块等前缀行；剥离行尾闭合的 `#`。
 * @param content Markdown 内容
 * @returns 标题列表，line 为 1 起始的行号
 */
export function extractHeadings(content: string): HeadingItem[] {
  const headings: HeadingItem[] = []
  const lines = content.split('\n')
  let inFence = false

  lines.forEach((line, index) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return

    const match = ATX_HEADING_RE.exec(line)
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        line: index + 1
      })
    }
  })

  return headings
}

/**
 * 提取第一张图片作为封面
 */
export function extractFirstImage(content: string): string | null {
  const match = content.match(/!\[([^\]]*)\]\(([^)]+)\)/)
  return match ? match[2] : null
}

/**
 * 统计 Markdown 字数（不含标记符号）
 */
export function countWords(content: string): number {
  // 移除 Markdown 标记
  const plainText = content
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/>\s+/g, '')
    .replace(/[-*]\s+/g, '')
    .replace(/\d+\.\s+/g, '')
    .replace(/---+/g, '')
    .replace(/\s+/g, '')

  return plainText.length
}

/**
 * 规范化图片路径
 * @param src 原始路径
 * @returns 规范化后的路径
 */
export function normalizeImagePath(src: string): string {
  // 移除开头的 ./ 或 ../
  return src.replace(/^(\.\.?\/)+/, '')
}

/**
 * 检查是否是外部链接
 */
export function isExternalLink(url: string): boolean {
  return /^https?:\/\//.test(url)
}

/**
 * Markdown 代码块语言映射
 */
export const CODE_LANGUAGES: Record<string, string> = {
  'js': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'rb': 'ruby',
  'go': 'go',
  'rs': 'rust',
  'java': 'java',
  'cpp': 'cpp',
  'c': 'c',
  'cs': 'csharp',
  'php': 'php',
  'swift': 'swift',
  'kt': 'kotlin',
  'scala': 'scala',
  'r': 'r',
  'sql': 'sql',
  'sh': 'bash',
  'bash': 'bash',
  'zsh': 'bash',
  'fish': 'bash',
  'ps1': 'powershell',
  'powershell': 'powershell',
  'cmd': 'batch',
  'bat': 'batch',
  'yaml': 'yaml',
  'yml': 'yaml',
  'toml': 'toml',
  'ini': 'ini',
  'cfg': 'ini',
  'json': 'json',
  'xml': 'xml',
  'html': 'html',
  'htm': 'html',
  'css': 'css',
  'scss': 'scss',
  'sass': 'sass',
  'less': 'less',
  'styl': 'stylus',
  'vue': 'vue',
  'svelte': 'svelte',
  'astro': 'astro',
  'md': 'markdown',
  'mdx': 'markdown',
  'tex': 'latex',
  'latex': 'latex',
  'dockerfile': 'dockerfile',
  'docker': 'dockerfile',
  'nginx': 'nginx',
  'graphql': 'graphql',
  'gql': 'graphql',
  'regex': 'regex',
  'vim': 'vim',
  'lua': 'lua',
  'perl': 'perl',
  'pl': 'perl',
  'haskell': 'haskell',
  'hs': 'haskell',
  'clojure': 'clojure',
  'cljs': 'clojure',
  'erlang': 'erlang',
  'erl': 'erlang',
  'elixir': 'elixir',
  'ex': 'elixir',
  'exs': 'elixir',
  'dart': 'dart',
  'flutter': 'dart'
}

/**
 * 获取代码块的语言标识符
 */
export function getCodeLanguage(lang: string): string {
  return CODE_LANGUAGES[lang.toLowerCase()] || lang || 'text'
}
