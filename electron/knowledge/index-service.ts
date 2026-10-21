/**
 * 知识索引服务
 *
 * 职责（见设计文档 §5.4）：
 * - 扫描库内文件，解析 frontmatter / 链接 / 标签 / 未链接提及；
 * - 解析链接目标，产出反链所需的正向索引与断链清单；
 * - 增量更新（mtime + size 未变且解析器版本一致则复用旧结果）；
 * - 落盘到 `<库>/.inkase/index/`，并维护抽取正文缓存。
 *
 * 设计约束：
 * - 索引是纯派生物，任何一步失败都不阻塞编辑；整体失败时 `state = 'degraded'`；
 * - 单个文件失败只记入 `errors` 并继续；
 * - 非文本节点（pdf/image/other）不读正文，正文抽取仅在需要时进行（`extractText` 注入）。
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import {
  KNOWLEDGE_PARSER_VERSION,
  type BacklinkItem,
  type FileEntry,
  type IndexError,
  type IndexProgress,
  type IndexStatus,
  type KnowledgeIndex,
  type LinkRef,
  type MentionItem,
  type NodeKind
} from '../../shared/knowledge/types'
import { parseFrontmatter, readList } from './frontmatter'
import { emptyIndex, isIndexStale, loadIndex, removeIndex, saveIndex, writeTextCache } from './index-store'
import { parseLinks, parseMarkdownLinkSpans, parseWikiLinks } from './link-parser'
import { buildLinkIndex, normalizeName, resolveLink } from './link-resolver'
import { isInsideRanges, lineOf, scanVisibleLines, visibleSegments } from './text-scan'
import { walkVault } from './vault-walk'

const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.rtf'
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.ico'])

/** 未链接提及候选名称数量上限，超过则跳过提及扫描（避免超大正则） */
const MAX_MENTION_NAMES = 4000

/** 单文件参与提及扫描的正文上限（字符），避免大文件常驻内存 */
const MENTION_TEXT_LIMIT = 512 * 1024

/** 抽取正文的落盘上限（字符） */
const DEFAULT_MAX_TEXT_CHARS = 2_000_000

/** 反链上下文展示长度 */
const CONTEXT_MAX = 200

/** 按扩展名判定节点类型 */
export function classifyKind(filePath: string): NodeKind {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.md') return 'md'
  if (ext === '.mdx') return 'mdx'
  if (ext === '.pdf') return 'pdf'
  if (OFFICE_EXTENSIONS.has(ext)) return 'office'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return 'other'
}

/**
 * 抽取正文中的行内标签（`#tag`）
 *
 * 跳过围栏代码块与行内代码；`#` 前必须是行首或非词字符，
 * 因此 Markdown 标题（`# 空格`）与 URL 片段（`x#y`）不会被误判。
 */
export function parseInlineTags(text: string): Array<{ tag: string; line: number }> {
  const found: Array<{ tag: string; line: number }> = []
  const pattern = /(?:^|[^\w#/])#([^\s#[\]()`,.;:!?'"<>|\\]+)/g

  for (const segment of visibleSegments(text)) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(segment.text)) !== null) {
      found.push({ tag: match[1], line: segment.line })
    }
  }

  return found
}

/** 库内文件的一次扫描结果 */
interface ScannedFile {
  /** 库内相对路径，'/' 分隔 */
  rel: string
  abs: string
  mtime: number
  size: number
  kind: NodeKind
}

/** 单个文件的解析产物 */
interface ParsedFile {
  rel: string
  entry: FileEntry
  /** 目标已填、解析状态待补 */
  outgoing: LinkRef[]
  tags: string[]
  /** 供第二阶段（提及扫描）使用的正文；超限为 null */
  mentionText: string | null
  /** 正文中已有链接的字符区间（相对 mentionText） */
  linkSpans: Array<[number, number]>
  /** 正文起始行偏移（frontmatter 占用的行数） */
  bodyLineOffset: number
}

/** 服务依赖注入 */
export interface IndexServiceDeps {
  /** 抽取非 `.md` 文本（`.mdx` 解包 / Office 转换）；由调用方注入以避免服务层依赖具体实现 */
  extractText?: (absPath: string, kind: NodeKind) => Promise<string>
  onProgress?: (progress: IndexProgress) => void
  /** 抽取正文落盘上限（字符） */
  maxTextChars?: number
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function basenameOf(rel: string): string {
  const at = rel.lastIndexOf('/')
  return at === -1 ? rel : rel.slice(at + 1)
}

function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '')
}

/** 由「标签 → 文件」倒推「文件 → 标签」，供增量复用时还原单文件标签 */
function invertTags(tags: Record<string, string[]>): Map<string, string[]> {
  const byFile = new Map<string, string[]>()
  for (const [tag, files] of Object.entries(tags)) {
    for (const file of files) {
      const list = byFile.get(file)
      if (list) list.push(tag)
      else byFile.set(file, [tag])
    }
  }
  return byFile
}

/** 知识索引服务 */
export class KnowledgeIndexService {
  private readonly root: string
  private readonly deps: IndexServiceDeps
  private index: KnowledgeIndex | null = null
  private inFlight: Promise<KnowledgeIndex> | null = null
  private state: IndexStatus['state'] = 'idle'
  private progress: IndexProgress = { phase: 'idle', done: 0, total: 0 }

  constructor(root: string, deps: IndexServiceDeps = {}) {
    this.root = root
    this.deps = deps
  }

  /** 当前状态快照 */
  getStatus(): IndexStatus {
    return {
      state: this.state,
      progress: { ...this.progress },
      fileCount: this.index?.meta.fileCount ?? 0
    }
  }

  /** 内存中的索引（可能尚未构建或加载） */
  getIndex(): KnowledgeIndex | null {
    return this.index
  }

  /**
   * 从磁盘加载索引（不重建）
   *
   * 供启动时快速可用；索引缺失或解析器版本不一致时返回 null，由调用方决定何时 `build()`。
   */
  load(): KnowledgeIndex | null {
    if (this.index) return this.index
    const loaded = loadIndex(this.root)
    if (loaded === null || isIndexStale(loaded, KNOWLEDGE_PARSER_VERSION)) return null
    this.index = loaded
    this.state = 'ready'
    return loaded
  }

  /**
   * 增量构建索引
   *
   * 并发调用共享同一次构建：两次构建交错会写坏内存状态与磁盘索引。
   */
  async build(): Promise<KnowledgeIndex> {
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.runBuild().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async runBuild(): Promise<KnowledgeIndex> {
    this.state = 'building'

    const previous = loadIndex(this.root)
    const reusable = isIndexStale(previous, KNOWLEDGE_PARSER_VERSION) ? null : previous
    const prevTagsByFile = reusable ? invertTags(reusable.tags) : new Map<string, string[]>()

    let scanned: ScannedFile[]
    try {
      this.setProgress('scan', 0, 0)
      scanned = this.scan()
    } catch (error) {
      // 根目录不可读：降级，但不阻塞编辑
      const degraded = emptyIndex(this.root)
      degraded.errors.push({ path: this.root, message: `扫描失败：${describeError(error)}` })
      this.index = degraded
      this.state = 'degraded'
      this.setProgress('idle', 0, 0)
      return degraded
    }

    const errors: IndexError[] = []
    const parsed = new Map<string, ParsedFile>()
    this.setProgress('parse', 0, scanned.length)

    for (let i = 0; i < scanned.length; i++) {
      const file = scanned[i]
      const prevEntry = reusable?.files[file.rel]

      // 增量：mtime / size / kind 全未变则复用旧结果，跳过读取与解析
      if (
        prevEntry !== undefined &&
        prevEntry.mtime === file.mtime &&
        prevEntry.size === file.size &&
        prevEntry.kind === file.kind
      ) {
        parsed.set(file.rel, {
          rel: file.rel,
          entry: prevEntry,
          outgoing: reusable?.outgoing[file.rel] ?? [],
          tags: prevTagsByFile.get(file.rel) ?? [],
          mentionText: null,
          linkSpans: [],
          bodyLineOffset: 0
        })
        this.setProgress('parse', i + 1, scanned.length)
        continue
      }

      try {
        parsed.set(file.rel, await this.parseFile(file))
      } catch (error) {
        errors.push({ path: file.rel, message: describeError(error) })
      }
      this.setProgress('parse', i + 1, scanned.length)
    }

    // 解析链接目标：需要全库文件名与别名，故统一在解析完所有文件后进行
    const aliasesByPath: Record<string, string[]> = {}
    for (const item of parsed.values()) {
      aliasesByPath[item.rel] = item.entry.aliases ?? []
    }
    const linkIndex = buildLinkIndex([...parsed.keys()], aliasesByPath)

    const outgoing: Record<string, LinkRef[]> = {}
    const unresolved: LinkRef[] = []

    for (const item of parsed.values()) {
      const resolvedRefs: LinkRef[] = []

      for (const ref of item.outgoing) {
        // 已有解析结果（增量复用）保持不变
        if (ref.status === 'resolved') {
          resolvedRefs.push(ref)
          continue
        }

        const resolution = resolveLink(ref.target ?? '', linkIndex, item.rel)
        const next: LinkRef = { ...ref, status: resolution.status }

        if (resolution.status === 'resolved') {
          next.to = resolution.targetPath
        } else {
          delete next.to
          if (resolution.status === 'ambiguous') next.candidates = resolution.candidates
          unresolved.push(next)
        }

        resolvedRefs.push(next)
      }

      outgoing[item.rel] = resolvedRefs
    }

    // 未链接提及：基于全库名称表，在正文中查找「提到但没链接」的笔记名
    const mentions: Record<string, MentionItem[]> = {}
    const mentionPattern = this.buildMentionPattern(linkIndex, aliasesByPath)

    for (const item of parsed.values()) {
      if (item.mentionText === null) {
        // 增量复用：沿用上次结果
        const cached = reusable?.mentions[item.rel]
        if (cached) mentions[item.rel] = cached
        continue
      }
      mentions[item.rel] = mentionPattern ? collectMentions(item, linkIndex, mentionPattern) : []
    }

    // 反转标签索引
    const tags: Record<string, string[]> = {}
    for (const item of parsed.values()) {
      for (const tag of new Set(item.tags)) {
        if (tag === '') continue
        const list = tags[tag]
        if (list) list.push(item.rel)
        else tags[tag] = [item.rel]
      }
    }
    for (const list of Object.values(tags)) list.sort()

    const files: Record<string, FileEntry> = {}
    for (const item of parsed.values()) files[item.rel] = item.entry

    const index: KnowledgeIndex = {
      meta: {
        version: 1,
        root: this.root,
        builtAt: Date.now(),
        fileCount: parsed.size,
        parserVersion: KNOWLEDGE_PARSER_VERSION
      },
      files,
      outgoing,
      unresolved,
      tags,
      mentions,
      errors
    }

    this.setProgress('write', parsed.size, parsed.size)
    try {
      saveIndex(this.root, index)
      this.state = 'ready'
    } catch (error) {
      // 落盘失败：内存索引仍可用于本次会话，但标记降级
      index.errors.push({ path: this.root, message: `索引写入失败：${describeError(error)}` })
      this.state = 'degraded'
    }

    this.index = index
    this.setProgress('idle', 0, 0)
    return index
  }

  /**
   * 强制全量重建
   *
   * 先等掉进行中的构建，再删除索引目录——否则 `runBuild` 仍会从磁盘上的旧索引复用条目。
   */
  async rebuild(): Promise<KnowledgeIndex> {
    if (this.inFlight !== null) {
      try {
        await this.inFlight
      } catch {
        /* 忽略：接下来会重新构建 */
      }
    }
    this.index = null
    removeIndex(this.root)
    return this.build()
  }

  /** 指定文件的反向链接（含未链接提及） */
  queryBacklinks(relPath: string): BacklinkItem[] {
    const index = this.index
    if (index === null) return []

    const items: BacklinkItem[] = []

    for (const [from, refs] of Object.entries(index.outgoing)) {
      for (const ref of refs) {
        if (ref.status === 'resolved' && ref.to === relPath) {
          items.push({ path: from, line: ref.line, text: ref.context ?? ref.raw, kind: 'linked' })
        }
      }
    }

    for (const [from, list] of Object.entries(index.mentions)) {
      for (const mention of list) {
        if (mention.targetPath === relPath) {
          items.push({ path: from, line: mention.line, text: mention.text, kind: 'unlinked' })
        }
      }
    }

    items.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    return items
  }

  /** 全部标签及计数，按出现次数降序 */
  queryTags(): Array<{ tag: string; count: number }> {
    const index = this.index
    if (index === null) return []

    return Object.entries(index.tags)
      .map(([tag, files]) => ({ tag, count: files.length }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  /** 某标签下的文件 */
  queryNotesByTag(tag: string): string[] {
    return this.index?.tags[tag] ?? []
  }

  /** 设置进度并向外广播 */
  private setProgress(phase: IndexProgress['phase'], done: number, total: number): void {
    this.progress = { phase, done, total }
    this.deps.onProgress?.({ ...this.progress })
  }

  /**
   * 递归扫描库内文件
   *
   * 遍历规则与引用重写共用 `walkVault`；根目录不可读时抛出，由 `build()` 转为降级。
   */
  private scan(): ScannedFile[] {
    return walkVault(this.root).map((file) => ({ ...file, kind: classifyKind(file.abs) }))
  }

  /** 读取并解析单个文件 */
  private async parseFile(file: ScannedFile): Promise<ParsedFile> {
    let text = ''

    if (file.kind === 'md') {
      text = fs.readFileSync(file.abs, 'utf-8')
    } else if (file.kind === 'mdx' || file.kind === 'office') {
      if (this.deps.extractText) {
        text = await this.deps.extractText(file.abs, file.kind)
      }
    }
    // pdf / image / other：不读正文，只作为可链接节点

    const fm = parseFrontmatter(text)
    const aliases = fm ? readList(fm, 'aliases') : []
    const body = fm ? text.slice(fm.bodyOffset) : text
    const bodyLineOffset = fm ? lineOf(text, fm.bodyOffset) - 1 : 0

    const lines = new Map<number, string>()
    for (const line of scanVisibleLines(text)) lines.set(line.line, line.content)

    const outgoing = parseLinks(text, file.rel)
    for (const ref of outgoing) {
      ref.context = truncate(lines.get(ref.line) ?? '', CONTEXT_MAX)
    }

    const inlineTags = parseInlineTags(body)
    const tags = [...(fm ? readList(fm, 'tags') : []), ...inlineTags.map((item) => item.tag)]

    const hash =
      file.kind === 'md'
        ? `sha1:${crypto.createHash('sha1').update(text, 'utf-8').digest('hex')}`
        : `stat:${file.size}:${file.mtime}`

    // 抽取正文落盘缓存：供搜索与 AI 工具按需读取，避免重复解包
    if ((file.kind === 'mdx' || file.kind === 'office') && text !== '') {
      try {
        const limit = this.deps.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
        writeTextCache(this.root, hash, text.length > limit ? text.slice(0, limit) : text)
      } catch {
        /* 缓存写入失败不影响索引 */
      }
    }

    const entry: FileEntry = { mtime: file.mtime, size: file.size, hash, kind: file.kind, aliases }

    const linkSpans: Array<[number, number]> = []
    if (body.length <= MENTION_TEXT_LIMIT) {
      for (const token of parseWikiLinks(body)) linkSpans.push([token.start, token.end])
      for (const span of parseMarkdownLinkSpans(body)) linkSpans.push(span)
    }

    return {
      rel: file.rel,
      entry,
      outgoing,
      tags,
      mentionText: body.length <= MENTION_TEXT_LIMIT ? body : null,
      linkSpans,
      bodyLineOffset
    }
  }

  /** 构造未链接提及的名称匹配正则；候选过多时返回 null（跳过提及扫描） */
  private buildMentionPattern(
    linkIndex: ReturnType<typeof buildLinkIndex>,
    aliasesByPath: Record<string, string[]>
  ): RegExp | null {
    const names = new Set<string>()

    for (const file of linkIndex.byPath) {
      const name = normalizeName(stripExtension(basenameOf(file)))
      if (name.length >= 2) names.add(name)
    }
    for (const list of Object.values(aliasesByPath)) {
      for (const alias of list) {
        const name = normalizeName(alias)
        if (name.length >= 2) names.add(name)
      }
    }

    if (names.size === 0 || names.size > MAX_MENTION_NAMES) return null

    // 长的名称优先匹配，避免「note」抢先命中「note-b」的前缀
    const alternatives = [...names]
      .sort((a, b) => b.length - a.length)
      .map((name) => {
        const escaped = escapeRegExp(name)
        const left = /^[a-z0-9_]/.test(name) ? '(?<![\\w])' : ''
        const right = /[a-z0-9_]$/.test(name) ? '(?![\\w])' : ''
        return `${left}${escaped}${right}`
      })

    try {
      return new RegExp(alternatives.join('|'), 'gi')
    } catch {
      return null
    }
  }
}

/** 在单个文件的正文中收集未链接提及 */
function collectMentions(
  item: ParsedFile,
  linkIndex: ReturnType<typeof buildLinkIndex>,
  pattern: RegExp
): MentionItem[] {
  const body = item.mentionText
  if (body === null) return []

  const lines = new Map<number, string>()
  for (const line of scanVisibleLines(body)) lines.set(line.line, line.content)

  const found: MentionItem[] = []
  const seen = new Set<string>()

  for (const segment of visibleSegments(body)) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(segment.text)) !== null) {
      const absolute = segment.start + match.index
      // 已经写成链接的位置不再算「未链接提及」
      if (isInsideRanges(absolute, item.linkSpans)) continue

      const name = normalizeName(match[0])
      const targets = mentionTargets(linkIndex, name)
      const line = segment.line + item.bodyLineOffset

      for (const target of targets) {
        if (target === item.rel) continue
        const key = `${target}:${line}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push({
          targetPath: target,
          line,
          text: truncate(lines.get(segment.line) ?? match[0], CONTEXT_MAX)
        })
      }
    }
  }

  return found
}

/** 名称 → 目标路径（文件 basename 与别名共同参与） */
function mentionTargets(linkIndex: ReturnType<typeof buildLinkIndex>, name: string): string[] {
  const targets = new Set<string>()
  for (const candidate of linkIndex.byBasename.get(name) ?? []) targets.add(candidate)
  for (const candidate of linkIndex.byAlias.get(name) ?? []) targets.add(candidate)
  return [...targets]
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
