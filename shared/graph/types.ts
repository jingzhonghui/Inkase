/**
 * 知识图谱数据模型。
 *
 * 这一层是主进程与渲染层共用的纯数据定义：没有任何 fs / DOM 依赖，
 * 因此索引构建（主进程）与脏标签重算（渲染层）能共用同一套类型。
 */

/**
 * 可作为图谱节点的格式。
 *
 * `attachment` 与前四种有本质区别：它**不在扩展名白名单里**，不会被遍历、
 * 不会被读取、永远没有出链；只有当某个文档链接指向了磁盘上真实存在的
 * 非文档文件（`.txt` / `.sh` / `.pdf` / 图片…）时，才会为那个目标补一个叶子节点。
 * 这样既不把 `assets/` 里成百上千的图片灌进图里，也不会让「链接到一个脚本」
 * 这件事在图谱上凭空消失。
 */
export type GraphNodeFormat = 'mdx' | 'markdown' | 'mindmap' | 'diagram' | 'attachment'

/** 扩展名 → 格式。键一律小写，比对前先 `toLowerCase()`。附件不在此表内 */
export const GRAPH_EXTENSION_FORMATS: Readonly<Record<string, GraphNodeFormat>> = {
  '.mdx': 'mdx',
  '.md': 'markdown',
  '.inkmind': 'mindmap',
  '.drawio': 'diagram'
}

/**
 * 能产出出链的格式。
 *
 * `.inkmind` / `.drawio` 只作为链接目标（叶子节点）：导图内部 href 与
 * 图表内部跳转都不参与图谱，见设计文档 §2.1。
 */
export const GRAPH_LINK_SOURCE_FORMATS: ReadonlySet<GraphNodeFormat> = new Set<GraphNodeFormat>([
  'mdx',
  'markdown'
])

export const GRAPH_FORMAT_LABELS: Readonly<Record<GraphNodeFormat, string>> = {
  mdx: 'MDX 文档',
  markdown: 'Markdown',
  mindmap: '思维导图',
  diagram: '图表',
  attachment: '其他文件'
}

/** 从路径取格式；不在白名单内返回 null */
export function graphFormatForPath(filePath: string): GraphNodeFormat | null {
  const lowered = filePath.toLowerCase()
  const dot = lowered.lastIndexOf('.')
  if (dot <= 0) return null
  return GRAPH_EXTENSION_FORMATS[lowered.slice(dot)] ?? null
}

/**
 * 规范化节点 id：统一 `/` 分隔、去掉开头的 `./`。
 *
 * Windows（以及 macOS 的默认卷）文件系统不区分大小写，同一文件被写成
 * `Notes/A.mdx` 与 `notes/a.mdx` 时必须折叠成同一个节点，否则会出现两个
 * 互不相连的「同名」节点。折叠只作用于 id，`GraphNode.path` 保留原写法。
 */
export function normalizeGraphId(relPath: string, caseInsensitive: boolean): string {
  let posix = relPath.replace(/\\/g, '/')
  while (posix.startsWith('./')) posix = posix.slice(2)
  posix = posix.replace(/\/{2,}/g, '/')
  return caseInsensitive ? posix.toLowerCase() : posix
}

/** 取顶层目录名；根目录文档返回 '' */
export function folderOf(relPath: string): string {
  const posix = relPath.replace(/\\/g, '/')
  const slash = posix.indexOf('/')
  return slash === -1 ? '' : posix.slice(0, slash)
}

/** 文件名去扩展名，作为默认展示名 */
export function baseLabelOf(relPath: string): string {
  const posix = relPath.replace(/\\/g, '/')
  const name = posix.slice(posix.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** 文件 basename 的小写形式，供兜底查找 */
export function basenameOf(relPath: string): string {
  const posix = relPath.replace(/\\/g, '/')
  return posix.slice(posix.lastIndexOf('/') + 1)
}

export interface GraphNode {
  /** 节点标识：工作区相对 POSIX 路径；Windows 下大小写折叠。断链节点为 `!<规范化目标>` */
  id: string
  /** 真实相对路径（POSIX）；断链节点为 null */
  path: string | null
  /** 展示名：文件名去扩展名；断链节点为链接原文 */
  label: string
  format: GraphNodeFormat
  /** 顶层目录名；根目录文档为 '' */
  folder: string
  inDegree: number
  outDegree: number
  /** 是否为断链幽灵节点 */
  unresolved: boolean
}

export interface GraphEdge {
  source: string
  target: string
  /** 同一对文件之间的链接条数（>= 1），用于边权重与视觉区分 */
  count: number
  /** 目标未解析（指向幽灵节点） */
  unresolved: boolean
}

export interface GraphStats {
  nodeCount: number
  edgeCount: number
  unresolvedCount: number
  orphanCount: number
  filesScanned: number
  elapsedMs: number
  /** 是否因限额截断 */
  truncated: boolean
}

/**
 * 解析上下文。
 *
 * 渲染层拿到 payload 后要重算脏标签的出链（见设计文档 §5.9），
 * 因此解析所需的目标集合必须随 payload 一起带回来。
 */
export interface GraphResolutionContext {
  /** 文件系统是否大小写不敏感（Windows / macOS 默认卷） */
  caseInsensitive: boolean
  /**
   * 磁盘上发现、带白名单扩展名、但未能成为节点的路径（限额跳过 / 读取失败）。
   *
   * 有它才能区分「文件真的不存在」（断链）与「文件在、只是没进索引」（ignore）。
   * 允许缺省：渲染层的脏标签重算拿不到这份集合，退化为「一律按断链处理」。
   */
  knownPaths?: string[]
  /**
   * 磁盘上存在的非文档文件（任意扩展名）。
   *
   * 只用于判断「链接目标是不是一个真实文件」：命中就为它补一个附件叶子节点。
   * 缺省时退化为把非白名单目标一律忽略，与加入本字段之前的行为一致。
   */
  attachmentPaths?: string[]
}

export interface GraphPayload {
  root: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
  warnings: string[]
  resolution: GraphResolutionContext
  /**
   * 问题清单。
   *
   * 断链条目必须带上「来源文件 + 原文 + 行号」，而这些信息在 nodes/edges
   * 里已经被压缩掉了（只留计数），所以在构建期算好一并带回来，
   * 渲染层不必再摸一遍索引。
   */
  issues: GraphIssues
}

/** 单文件出链记录的中间态 */
export interface FileLinkRecord {
  path: string
  format: GraphNodeFormat
  links: RawLink[]
}

export interface RawLink {
  /** 原始 href（未解码） */
  href: string
  /** 正文行号（1 起），供问题清单跳转 */
  line: number
}

/** 断链清单条目 */
export interface GraphIssue {
  /** 来源文件相对路径（孤儿项为自己的路径） */
  path: string
  /** 展示名 */
  label: string
  /** 断链原始 href；孤儿项为 null */
  href: string | null
  /** 断链所在行号；孤儿项为 null */
  line: number | null
}

export interface GraphIssues {
  /** 断链：按来源文件 + 行号排序 */
  unresolved: GraphIssue[]
  /** 孤儿笔记：度为 0 的真实节点 */
  orphans: GraphIssue[]
}

/** 自环（文件链接到自己）不计入边，但抽取阶段仍保留，便于统计与去重 */
