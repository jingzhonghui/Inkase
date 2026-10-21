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
 */
export const KNOWLEDGE_PARSER_VERSION = 1

/** 库内节点类型（决定如何抽取正文） */
export type NodeKind = 'md' | 'mdx' | 'office' | 'pdf' | 'image' | 'other'

/** 单条链接引用（从文本中解析出来的一次出现） */
export interface LinkRef {
  /** 来源文件：库内相对路径，'/' 分隔 */
  from: string
  /** 已解析的目标：库内相对路径；未解析时为 undefined */
  to?: string
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
}

/** 未链接提及：正文里出现了其它笔记的标题/别名，但没有建立链接 */
export interface MentionItem {
  targetPath: string
  line: number
  text: string
}

/** 索引错误：单个文件解析失败不影响整体构建 */
export interface IndexError {
  path: string
  message: string
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
}

/** 索引构建进度 */
export interface IndexProgress {
  phase: 'idle' | 'scan' | 'parse' | 'write'
  done: number
  total: number
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
