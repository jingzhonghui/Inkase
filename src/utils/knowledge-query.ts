/**
 * 搜索框查询语法解析（纯函数）
 *
 * 把侧栏搜索框里的一行输入转成 `KnowledgeQuery`。语义解释仍在主进程，
 * 这里只做「文本 → 结构化条件」的翻译，便于单测与后续扩展。
 *
 * 语法：
 * - `tag:foo`        标签筛选（多个为 AND）
 * - `path:dir/`      路径包含
 * - `prop:key=value` frontmatter 属性等值
 * - `/正则/`         正则搜索（首尾斜杠包裹且长度 > 2）
 * - 其余             字面量关键词（多个词以空格连接）
 *
 * 解析不出内容的筛选记号（如 `tag:`、`prop:=x`）按字面量关键词处理，
 * 而不是静默丢弃——用户敲进去的东西必须能被搜到或被看见。
 */

import type { KnowledgeQuery } from '../../shared/knowledge/types'

export interface ParsedQuery {
  query: KnowledgeQuery
  /** 输入为空等无法执行的情况；非 null 时调用方不应发起查询 */
  hint: string | null
}

export function parseQuery(raw: string): ParsedQuery {
  const tags: string[] = []
  const paths: string[] = []
  const props: Record<string, string> = {}
  const words: string[] = []

  for (const token of raw.split(/\s+/)) {
    if (token === '') continue

    if (token.startsWith('tag:')) {
      const tag = token.slice(4)
      if (tag !== '') tags.push(tag)
      else words.push(token)
      continue
    }

    if (token.startsWith('path:')) {
      const value = token.slice(5)
      if (value !== '') paths.push(value)
      else words.push(token)
      continue
    }

    if (token.startsWith('prop:')) {
      const body = token.slice(5)
      const at = body.indexOf('=')
      if (at > 0) props[body.slice(0, at)] = body.slice(at + 1)
      else words.push(token)
      continue
    }

    words.push(token)
  }

  const query: KnowledgeQuery = {}
  if (tags.length > 0) query.tags = tags
  if (paths.length > 0) query.paths = paths
  if (Object.keys(props).length > 0) query.props = props

  const text = words.join(' ')
  if (text !== '') {
    if (text.length > 2 && text.startsWith('/') && text.endsWith('/')) {
      query.regex = text.slice(1, -1)
    } else {
      query.text = text
    }
  }

  const empty =
    text === '' && tags.length === 0 && paths.length === 0 && Object.keys(props).length === 0
  return { query, hint: empty ? '输入关键词或 tag:/path:/prop: 条件' : null }
}
