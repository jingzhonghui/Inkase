/**
 * frontmatter（YAML 头部）解析与保真写回
 *
 * 设计约束（见设计文档 §5.3）：
 * - 只识别文件**头部** `---` … `---` 之间的 YAML 子集；
 * - **未知字段、注释、字段顺序必须逐字节保留**——因此写回走「定位目标字段的行区间 → 原地替换」，
 *   绝不重新序列化整个 YAML；
 * - 不引入 YAML 依赖，只支持标量、行内数组 `[a, b]`、块数组 `- item`。
 *
 * 该模块为纯函数，不 import electron，保证可在 vitest 下直接测试。
 */

/** 解析结果 */
export interface Frontmatter {
  /** 已解析的字段（未知字段同样在列，值为原文去掉引号后的字符串） */
  data: Record<string, string | string[]>
  /** 头部原文，含首尾 `---` 与其后的换行；恒满足 `raw + text.slice(bodyOffset) === text` */
  raw: string
  /** 正文起始偏移（= raw.length） */
  bodyOffset: number
}

const DELIMITER = '---'

/** 拆行并保留每行的字符区间，便于做偏移精确的原地替换 */
interface Line {
  /** 行内容（不含行尾换行符） */
  content: string
  /** 行起始偏移 */
  start: number
  /** 行内容结束偏移 */
  end: number
  /** 下一行起始偏移（无换行符时等于 end） */
  next: number
}

function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let i = 0
  for (;;) {
    let j = i
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++
    let next = j
    if (next < text.length) {
      next += text[next] === '\r' && text[next + 1] === '\n' ? 2 : 1
    }
    lines.push({ content: text.slice(i, j), start: i, end: j, next })
    if (next >= text.length) break
    i = next
  }
  return lines
}

/** 去掉成对的单/双引号 */
function stripQuotes(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** 需要加引号才安全的 YAML 值（URL 不需要，保持 Obsidian 写法） */
const NEEDS_QUOTE = /^[\s[\]{}#&*!|>'"%@`,?:-]|:\s|\n/

function formatScalar(value: string): string {
  return NEEDS_QUOTE.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/** 探测文件自身的行尾风格，避免写回时混用行尾 */
function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** 生成 `key` 字段的整块文本（含行尾换行） */
function formatFieldBlock(key: string, value: string | string[], eol: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []${eol}`
    return `${key}:${eol}${value.map((item) => `  - ${formatScalar(item)}`).join(eol)}${eol}`
  }
  return `${key}: ${formatScalar(value)}${eol}`
}

/**
 * 解析文件头部的 frontmatter
 *
 * 无头部、头部未闭合、首行不是 `---` 时返回 `null`（调用方据此走"无元数据"分支）。
 * 兼容 BOM 与 CRLF。
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  if (!text) return null
  const lines = splitLines(text)
  if (lines.length === 0) return null

  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0
  if (lines[0].content.slice(bom).trim() !== DELIMITER) return null

  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].content.trim() === DELIMITER) {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) return null

  const bodyOffset = lines[closeIdx].next
  const data: Record<string, string | string[]> = {}

  let i = 1
  while (i < closeIdx) {
    const content = lines[i].content
    const trimmed = content.trim()
    // 空行与注释行：跳过，但它们仍在 raw 中原样保留
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++
      continue
    }

    const match = /^([^:\s][^:]*):(.*)$/.exec(content)
    if (!match) {
      i++
      continue
    }

    const key = match[1].trim()
    const inlineValue = match[2].trim()

    if (inlineValue === '') {
      // 可能是块数组：`key:` 后跟缩进的 `- item`
      const items: string[] = []
      let j = i + 1
      while (j < closeIdx) {
        const candidate = lines[j].content
        const candidateTrimmed = candidate.trim()
        if (candidateTrimmed === '') {
          j++
          continue
        }
        if (candidateTrimmed === '-' || candidateTrimmed.startsWith('- ')) {
          items.push(stripQuotes(candidateTrimmed.slice(1)))
          j++
          continue
        }
        break
      }
      data[key] = items.length > 0 ? items : ''
      i = items.length > 0 ? j : i + 1
      continue
    }

    if (inlineValue.startsWith('[') && inlineValue.endsWith(']')) {
      const inner = inlineValue.slice(1, -1).trim()
      data[key] =
        inner === ''
          ? []
          : inner
              .split(',')
              .map((part) => stripQuotes(part))
              .filter((part) => part !== '')
      i++
      continue
    }

    data[key] = stripQuotes(inlineValue)
    i++
  }

  return { data, raw: text.slice(0, bodyOffset), bodyOffset }
}

/** 读取字段原值 */
export function readField(fm: Frontmatter, key: string): string | string[] | undefined {
  return fm.data[key]
}

/** 读取字段为数组（标量视为单元素数组，缺失或空值视为空数组） */
export function readList(fm: Frontmatter, key: string): string[] {
  const value = fm.data[key]
  if (value === undefined) return []
  if (Array.isArray(value)) return value
  return value === '' ? [] : [value]
}

/** 定位字段占用的字符区间（含其块数组的续行）；未找到返回 null */
function findFieldRange(lines: Line[], closeIdx: number, key: string): { start: number; end: number } | null {
  for (let i = 1; i < closeIdx; i++) {
    const content = lines[i].content
    const trimmed = content.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = /^([^:\s][^:]*):(.*)$/.exec(content)
    if (!match || match[1].trim() !== key) continue

    let end = lines[i].next
    let j = i + 1
    while (j < closeIdx) {
      const candidate = lines[j].content
      const candidateTrimmed = candidate.trim()
      if (candidateTrimmed === '-' || candidateTrimmed.startsWith('- ')) {
        end = lines[j].next
        j++
        continue
      }
      break
    }
    return { start: lines[i].start, end }
  }
  return null
}

/**
 * 设置 / 覆盖 / 删除一个 frontmatter 字段
 *
 * - `value === null` 表示删除该字段；
 * - 无头部时：`value` 非 null 则在文件头插入头部，为 null 时原样返回；
 * - 其余情况只替换目标字段所在的行区间，**其余内容（含注释、未知字段、顺序）逐字节保留**。
 */
export function setFrontmatterField(text: string, key: string, value: string | string[] | null): string {
  const fm = parseFrontmatter(text)
  const eol = detectEol(text)

  if (!fm) {
    if (value === null) return text
    return `---${eol}${formatFieldBlock(key, value, eol)}---${eol}${eol}${text}`
  }

  const lines = splitLines(text)
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].content.trim() === DELIMITER) {
      closeIdx = i
      break
    }
  }
  // parseFrontmatter 已保证能定位到闭合分隔符
  const range = findFieldRange(lines, closeIdx, key)
  const insertAt = range ? range.start : lines[closeIdx].start
  const removeTo = range ? range.end : insertAt

  const replacement = value === null ? '' : formatFieldBlock(key, value, eol)
  return text.slice(0, insertAt) + replacement + text.slice(removeTo)
}
