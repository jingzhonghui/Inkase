/**
 * 知识库（Knowledge Base）共享类型
 *
 * 主进程（electron/knowledge/）与渲染层（src/stores/knowledge.ts）共用，
 * 保证 IPC 载荷与索引结构只有一处定义。
 *
 * 设计文档：docs/superpowers/specs/2026-10-21-knowledge-base-design.md
 */

/**
 * 索引解析器版本
 *
 * 解析逻辑发生不兼容变化时递增，用于让既有索引整体失效并全量重建。
 * 3：标签开始记录来源（行内 `#标签` / frontmatter `tags`）。
 * 4：链接解析结果保留原始路径大小写（此前统一小写，与 files 键不一致）。
 */
export const KNOWLEDGE_PARSER_VERSION = 4

/** 库内节点类型（决定如何抽取正文） */
export type NodeKind = 'md' | 'mdx' | 'office' | 'pdf' | 'image' | 'other'

/** 单条链接引用（从文本中解析出来的一次出现） */
export interface LinkRef {
  /** 来源文件：库内相对路径，'/' 分隔 */
  from: string
  /** 已解析的目标：库内相对路径；未解析时为 undefined */
  to?: string
  /** 书写时的目标文本（未解析），如 `笔记` 或 `dir/a.md` */
  target?: string
  /** 原始文本，如 `[[笔记|别名]]` 或 `[文本](dir/a.md)` */
  raw: string
  /** 链接或嵌入（`![[...]]`） */
  kind: 'link' | 'embed'
  /** 锚点：`#标题`、`#page=3`、`#L10-L20` */
  anchor?: string
  /** 1-based 行号 */
  line: number
  /** 1-based 列号 */
  column: number
  /** 解析结果状态；非 resolved 的引用会被收进 `unresolved` */
  status?: 'resolved' | 'ambiguous' | 'missing'
  /** `status === 'ambiguous'` 时的候选路径 */
  candidates?: string[]
  /** 所在行的上下文文本（已截断），供反链面板展示 */
  context?: string
}

/**
 * 链接目标的解析结果
 *
 * `ambiguous` 表示库内存在多个同名/同别名候选——必须交由用户选择，
 * 不得静默取第一个（见设计文档 §2 反目标）。
 */
export type LinkResolution =
  | { status: 'resolved'; targetPath: string; anchor?: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'missing' }

/** 索引中的单文件条目 */
export interface FileEntry {
  mtime: number
  size: number
  /** 内容指纹，用于增量判定 */
  hash: string
  kind: NodeKind
  /** frontmatter `aliases`，参与链接解析与未链接提及匹配 */
  aliases?: string[]
  /**
   * frontmatter 标量字段（供结构化查询按属性等值筛选）
   *
   * 数组字段以 `,` 连接；仅收短值，避免索引膨胀。
   */
  props?: Record<string, string>
}

/** 未链接提及：正文里出现了其它笔记的标题/别名，但没有建立链接 */
export interface MentionItem {
  targetPath: string
  line: number
  /** 提及所在列（1-based，用于精确改写为链接） */
  column: number
  /** 书写时实际出现的文本（如笔记名或别名） */
  raw: string
  text: string
}

/**
 * 把未链接提及改写为 `[[链接]]` 的请求
 *
 * `column` / `raw` 用于精确定位并在改写前校验索引是否已过期。
 */
export interface MentionConversion {
  /** 提及所在的来源文件（库内相对路径） */
  path: string
  line: number
  column: number
  raw: string
}

/** 提及转换结果 */
export interface MentionConversionResult {
  changed: boolean
  /** changed 为 false 时说明原因（索引过期、位置不匹配等） */
  reason?: string
}

/** 索引错误：单个文件解析失败不影响整体构建 */
export interface IndexError {
  path: string
  message: string
}

/**
 * 标签来源
 *
 * `inline` = 正文里的 `#标签`；`frontmatter` = 头部 `tags:` 列表。
 * 同一标签可能两种来源都有（同一文件内），面板需分别标注。
 */
export type TagSource = 'inline' | 'frontmatter'

/** 一次标签使用（文件 → 标签 + 来源） */
export interface TagUse {
  tag: string
  source: TagSource
}

/** 标签总览项（面板列表用） */
export interface TagSummary {
  tag: string
  /** 使用该标签的文件数 */
  count: number
  /** 来自行内 `#标签` 的文件数 */
  inline: number
  /** 来自 frontmatter `tags` 的文件数 */
  frontmatter: number
}

/** 某标签下的一个文件及其来源 */
export interface TagNote {
  /** 库内相对路径 */
  path: string
  /** 该文件使用此标签的来源（可能两种都有） */
  sources: TagSource[]
}

/**
 * 重命名 / 移动后自动改写引用的结果
 *
 * `changed` 为改写处数、`files` 为受影响文件数、`paths` 为被改写的文件；
 * `errors` 记录读写失败的文件（单个文件失败不阻断重命名本身）。
 */
export interface ReferenceRewriteResult {
  changed: number
  files: number
  paths: string[]
  errors: IndexError[]
}

/**
 * 知识索引（纯派生物，可随时删除重建）
 *
 * 落盘位置：`<库>/.inkase/index/index.json`（随同步排除）。
 */
export interface KnowledgeIndex {
  meta: {
    version: 1
    root: string
    builtAt: number
    fileCount: number
    parserVersion: number
  }
  /** 库内相对路径 → 文件条目 */
  files: Record<string, FileEntry>
  /** 库内相对路径 → 出链列表 */
  outgoing: Record<string, LinkRef[]>
  /** 所有未能解析的引用（断链清单） */
  unresolved: LinkRef[]
  /** 标签 → 笔记路径列表（倒排；含行内 #标签 与 frontmatter tags） */
  tags: Record<string, string[]>
  /** 库内相对路径 → 该文件的标签及来源（`tags` 倒排表由此派生） */
  tagUses: Record<string, TagUse[]>
  /** 库内相对路径 → 未链接提及 */
  mentions: Record<string, MentionItem[]>
  errors: IndexError[]
}

/** 反向链接面板的一项 */
export interface BacklinkItem {
  /** 来源文件（库内相对路径） */
  path: string
  line: number
  /** 上下文行文本（已截断） */
  text: string
  /** linked = 已建立链接；unlinked = 未链接提及 */
  kind: 'linked' | 'unlinked'
  /** 未链接提及的列号（1-based），已链接条目没有 */
  column?: number
  /** 未链接提及书写时的文本，已链接条目没有 */
  raw?: string
}

/** 索引构建进度 */
export interface IndexProgress {
  phase: 'idle' | 'scan' | 'parse' | 'write'
  done: number
  total: number
}

/**
 * 结构化查询
 *
 * 语义全部在主进程解释（渲染层只负责组装），避免渲染层接触 fs：
 * - `text` / `regex` 走 ripgrep（`.mdx` 由主进程解包后搜索）；
 * - `tags` / `props` / `paths` 走索引，并与文本结果取交集。
 */
export interface KnowledgeQuery {
  /** 全文关键词（字面量） */
  text?: string
  /** 全部命中（AND） */
  tags?: string[]
  /** 路径包含任一（大小写不敏感） */
  paths?: string[]
  /** frontmatter 属性等值匹配（AND） */
  props?: Record<string, string>
  /** 正则（与 `text` 互斥，优先 `regex`） */
  regex?: string
  caseSensitive?: boolean
  /** 结果上限，默认 200 */
  limit?: number
}

/** 一条搜索结果 */
export interface SearchHit {
  /** 库内相对路径 */
  path: string
  /** 1-based 行号 */
  line: number
  /** 1-based 列号 */
  column: number
  /** 命中行预览；索引命中时为空串 */
  text: string
  /** rg = ripgrep 正文命中；index = 仅由索引筛选命中 */
  source: 'rg' | 'index'
}

/**
 * `[[` 自动补全的候选笔记
 */
export interface NoteEntry {
  /** 库内相对路径 */
  path: string
  /** frontmatter 声明的别名 */
  aliases: string[]
}

/**
 * 索引状态
 *
 * `degraded` 表示索引不可用（构建失败/损坏），调用方必须降级显示，
 * 文件树与编辑功能不受影响。
 */
export interface IndexStatus {
  state: 'idle' | 'building' | 'ready' | 'degraded'
  progress: IndexProgress
  fileCount: number
}

/** 最近修改的一篇笔记（工作台首屏用） */
export interface RecentNote {
  /** 库内相对路径 */
  path: string
  /** 文件修改时间（毫秒时间戳） */
  mtime: number
}

/**
 * 知识库概览
 *
 * 首屏的「一行库状态」与「最近修改」由主进程一次算好，渲染层不做二次聚合。
 * 计数口径固定：笔记只算 Markdown / MDX，孤立与断链都来自整库索引。
 */
export interface KnowledgeOverview {
  noteCount: number
  tagCount: number
  isolatedCount: number
  brokenCount: number
  recent: RecentNote[]
}

/** 同名笔记（frontmatter title 优先，否则文件名） */
export interface DuplicateTitleGroup {
  /** 展示用标题（取组内第一条的原始大小写） */
  title: string
  /** 库内相对路径，按字典序排列 */
  paths: string[]
}

/** 一条未链接提及（来源 + 目标 + 精确位置） */
export interface UnlinkedMention {
  /** 提及所在的来源文件 */
  from: string
  /** 被提及但尚未建链的目标笔记 */
  targetPath: string
  line: number
  column: number
  /** 正文中实际出现的文本 */
  raw: string
  /** 所在行上下文（已截断） */
  text: string
}

/**
 * 库健康巡检报告
 *
 * 计数是完整值，列表有上限（避免整库推给渲染层）；
 * `truncated` 表示至少一个列表被截断。
 */
export interface KnowledgeHealth {
  counts: {
    isolated: number
    broken: number
    /** 重复标题的组数（不是笔记数） */
    duplicateTitles: number
    unlinkedMentions: number
  }
  isolated: string[]
  broken: LinkRef[]
  duplicates: DuplicateTitleGroup[]
  unlinked: UnlinkedMention[]
  truncated: boolean
}
