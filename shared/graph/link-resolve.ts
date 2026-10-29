import { basenameOf, graphFormatForPath, normalizeGraphId, type GraphNodeFormat } from './types'

/**
 * 链接目标解析。
 *
 * 这一层必须与现有的 `Ctrl+Click`（`electron/ipc/file-handlers.ts` 的
 * `LINK.OPEN`）语义一致，否则会出现「图谱说断了、点一下却能打开」的矛盾。
 * 为了让索引构建（主进程）与脏标签重算（渲染层）共用同一套规则，
 * 这里刻意不碰 `node:fs`：所有判断都基于「已发现文件的集合」。
 */

export type IgnoreReason = 'external' | 'anchor' | 'not-indexed' | 'escape'

export type Resolution =
  | { kind: 'edge'; targetId: string; ambiguous?: boolean }
  /**
   * 目标是非文档文件（不在扩展名白名单内）但磁盘上真实存在。
   *
   * 它只作为叶子节点存在，不参与出链解析。
   */
  | { kind: 'attachment'; targetId: string; targetPath: string }
  | { kind: 'unresolved'; ghostId: string; display: string; targetPath: string }
  | { kind: 'ignore'; reason: IgnoreReason }

export interface ResolveContext {
  /** 源文件的节点 id（已规范化） */
  fromId: string
  /** 源文件的工作区相对 POSIX 路径（保留原始大小写，用于算相对基准） */
  fromPath: string
  /** 已成功成为节点的文件 id 集合 */
  indexed: ReadonlySet<string>
  /**
   * 磁盘上发现、带白名单扩展名、但没有成为节点的路径（限额跳过 / 读取失败）。
   *
   * 缺省时退化为「白名单扩展名未命中即断链」——渲染层重算脏标签时拿不到这份集合。
   */
  known?: ReadonlySet<string>
  /**
   * 磁盘上存在的**非文档**文件：规范化 id → 磁盘上的真实相对路径（任意扩展名）。
   *
   * 命中即解析成 `attachment`；缺省表示「不知道磁盘上有什么」，这时一律按
   * `not-indexed` 忽略——否则点开头的目录、`.gitignore` 这类被遍历排除的
   * 目标会被误判成断链。用 Map 而不是 Set 是为了保留真实大小写。
   */
  attachments?: ReadonlyMap<string, string>
  /** basename（小写）→ 规范化 id 列表，用于兜底查找 */
  basenames: ReadonlyMap<string, readonly string[]>
  /** 文件系统是否大小写不敏感 */
  caseInsensitive: boolean
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/
const UNC_PREFIX_RE = /^\\\\/

/**
 * 判断 href 是否为外部协议（http / https / mailto / tel / data …）。
 *
 * 返回协议名，不是外链则返回 null。单字母 scheme 一律按 Windows 盘符处理
 * （`C:\notes\a.md` 会被 `SCHEME_RE` 误认成协议 `c`），否则库内绝对路径
 * 全都会被当成外链丢掉。
 */
export function externalSchemeOf(href: string): string | null {
  const match = SCHEME_RE.exec(href)
  if (!match) return null
  if (WINDOWS_DRIVE_RE.test(href)) return null
  const scheme = match[1].toLowerCase()
  // 单字母一律按 Windows 盘符处理：现实中不存在单字母协议
  if (scheme.length === 1) return null
  if (scheme === 'file') return null
  return scheme
}

/** 去掉 fragment 与 query。返回去掉后的路径部分，以及是否只有 fragment。 */
export function stripHrefSuffix(href: string): { path: string; fragmentOnly: boolean } {
  const hashIndex = href.indexOf('#')
  const queryIndex = href.indexOf('?')
  let cut = -1
  if (hashIndex !== -1) cut = hashIndex
  if (queryIndex !== -1 && (cut === -1 || queryIndex < cut)) cut = queryIndex
  if (cut === -1) return { path: href, fragmentOnly: false }
  return { path: href.slice(0, cut), fragmentOnly: cut === hashIndex && hashIndex === 0 }
}

/** `decodeURIComponent` 的安全版本：非法转义序列保留原串 */
export function decodeHref(href: string): string {
  if (!href.includes('%')) return href
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/** 是否形如绝对路径（POSIX 根、Windows 盘符、UNC） */
export function isAbsoluteLike(target: string): boolean {
  return (
    target.startsWith('/') ||
    WINDOWS_DRIVE_RE.test(target) ||
    UNC_PREFIX_RE.test(target)
  )
}

/**
 * 以 `baseDir` 为基准拼接 `relative`，并归一化 `.` / `..`。
 *
 * 越出工作区根（`..` 把栈弹空）时返回 null —— 调用方据此判 `escape`。
 * `baseDir` 为空表示源文件位于工作区根。
 */
export function resolveRelativePath(baseDir: string, relative: string): string | null {
  const stack = baseDir ? baseDir.split('/').filter((segment) => segment.length > 0) : []
  const segments = relative.replace(/\\/g, '/').split('/')

  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(segment)
  }

  return stack.join('/')
}

/** 源文件所在目录（POSIX 相对路径）；根目录文档返回 '' */
export function dirnameOf(relativePath: string): string {
  const posix = relativePath.replace(/\\/g, '/')
  const slash = posix.lastIndexOf('/')
  return slash === -1 ? '' : posix.slice(0, slash)
}

/**
 * 构建 basename 兜底索引。
 *
 * 键是 `basename.toLowerCase()`，值是规范化后的节点 id 列表。
 * 对应 `LINK.OPEN` 里 `searchFileInDir` 那一步：路径算错了但文件名对得上时，
 * 点击仍然能打开文件，图谱必须给出同样的结论。
 */
export function buildBasenameIndex(
  entries: Iterable<{ id: string; path: string }>
): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const entry of entries) {
    const key = basenameOf(entry.path).toLowerCase()
    const bucket = index.get(key)
    if (bucket) bucket.push(entry.id)
    else index.set(key, [entry.id])
  }
  for (const bucket of index.values()) bucket.sort()
  return index
}

/** 同名兜底命中多个时的取舍：路径最短者优先，长度相同取字典序靠前者 */
function pickShortest(ids: readonly string[]): string {
  let best = ids[0]
  for (const id of ids) {
    if (id.length < best.length || (id.length === best.length && id < best)) best = id
  }
  return best
}

function ghostIdFor(targetPath: string, ctx: ResolveContext): string {
  return `!${normalizeGraphId(targetPath, ctx.caseInsensitive)}`
}

/** 依次尝试的原路径：无扩展名时补 `.mdx` / `.md`（与 LINK.OPEN 的既有行为一致） */
function candidatePaths(target: string): string[] {
  const extension = target.slice(target.lastIndexOf('.') + 1)
  const hasExtension = target.lastIndexOf('.') > target.lastIndexOf('/') && extension.length > 0
  if (hasExtension) return [target]
  return [`${target}.mdx`, `${target}.md`]
}

function lookupBasename(
  target: string,
  ctx: ResolveContext
): { kind: 'edge'; targetId: string; ambiguous?: true } | null {
  const key = basenameOf(target).toLowerCase()
  if (!key) return null
  const hits = ctx.basenames.get(key)
  if (!hits || hits.length === 0) return null
  // 只在真的歧义时才附带 `ambiguous`：设计 §5.4 的 Resolution 里没有这个字段，
  // 它是实现层给 warnings 用的附加信息，无歧义时不该出现在结果里（否则调用方
  // 用全等比对时会因为多一个 false 而失败）
  return hits.length > 1
    ? { kind: 'edge', targetId: pickShortest(hits), ambiguous: true }
    : { kind: 'edge', targetId: pickShortest(hits) }
}

/**
 * 解析一条链接。
 *
 * 顺序严格按设计文档 §5.4：剥 fragment/query → 解码 → `file://` →
 * 相对源文件目录解析 → 越界判定 → 无扩展名补全 → 精确命中 →
 * 非文档文件补叶子节点 → basename 兜底 → 断链。
 */
export function resolveLink(href: string, ctx: ResolveContext): Resolution {
  const raw = href.trim()
  if (!raw) return { kind: 'ignore', reason: 'anchor' }

  if (externalSchemeOf(raw) !== null) return { kind: 'ignore', reason: 'external' }

  const { path: strippedPath, fragmentOnly } = stripHrefSuffix(raw)
  if (fragmentOnly || !strippedPath) return { kind: 'ignore', reason: 'anchor' }

  let decoded = decodeHref(strippedPath)

  // `file://` 是绝对路径的另一种写法；`file:///C:/ws/a.mdx` 解码后得到 `/C:/ws/a.mdx`
  if (/^file:\/\//i.test(decoded)) {
    decoded = decoded.replace(/^file:\/\//i, '')
    if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) decoded = decoded.slice(1)
  }

  decoded = decoded.replace(/\\/g, '/')
  if (!decoded) return { kind: 'ignore', reason: 'anchor' }

  // 绝对路径：纯函数无法访问磁盘，也无法可靠地与未知的工作区根做前缀比较。
  // 退回 basename 兜底——库内绝对路径的 basename 通常唯一，与 LINK.OPEN
  // 「绝对路径打不开就按文件名全库搜」的实际结果一致。
  if (isAbsoluteLike(decoded)) {
    const hit = lookupBasename(decoded, ctx)
    if (hit) return hit
    const base = basenameOf(decoded)
    return {
      kind: 'unresolved',
      ghostId: ghostIdFor(base, ctx),
      display: raw,
      targetPath: base
    }
  }

  const joined = resolveRelativePath(dirnameOf(ctx.fromPath), decoded)
  if (joined === null) return { kind: 'ignore', reason: 'escape' }
  const targetPath = joined

  const candidates = candidatePaths(targetPath)
  let firstMissing: string | null = null
  let sawKnownMiss = false

  for (const candidate of candidates) {
    const format: GraphNodeFormat | null = graphFormatForPath(candidate)
    if (!format) {
      // 白名单之外的扩展名：图片、PDF 附件、脚本…这些是资源不是文档，不产出出链。
      // 但它可能仍然值得在图里占一个位置——只要磁盘上真有这个文件。
      if (ctx.attachments) {
        const attachmentId = normalizeGraphId(candidate, ctx.caseInsensitive)
        const diskPath = ctx.attachments.get(attachmentId)
        if (diskPath !== undefined) {
          return { kind: 'attachment', targetId: attachmentId, targetPath: diskPath }
        }
      }
      return { kind: 'ignore', reason: 'not-indexed' }
    }
    const id = normalizeGraphId(candidate, ctx.caseInsensitive)
    if (ctx.indexed.has(id)) return { kind: 'edge', targetId: id }
    if (firstMissing === null) firstMissing = candidate
    if (ctx.known?.has(id)) sawKnownMiss = true
  }

  // 文件在磁盘上、只是没进索引（限额跳过 / 读取失败）：这是 ignore，不是断链
  if (sawKnownMiss) return { kind: 'ignore', reason: 'not-indexed' }

  const fallbackTarget = firstMissing ?? targetPath
  const hit = lookupBasename(fallbackTarget, ctx)
  if (hit) return hit

  return {
    kind: 'unresolved',
    ghostId: ghostIdFor(fallbackTarget, ctx),
    display: raw,
    targetPath: fallbackTarget
  }
}

/**
 * 生成写入正文的链接路径：以源文件所在目录为基准的相对路径。
 *
 * 与 `resolveLink` 互为逆运算——写进去的链接必须能被自己解析回来。
 *
 * 只转义会破坏 `[text](dest)` 语法的字符，其余保持原文：
 * - 空格 → `%20`（markdown-it 不认裸空格，这是唯一必须转的常规字符）；
 * - `%` → `%25`（否则文件名里本就写着 `%20` 时会被解码成空格）；
 * - `#` `?` → `%23`/`%3F`（否则会被当成 fragment / query 剥掉）；
 * - `<` `>` → `%3C`/`%3E`（尖括号目标语法）。
 *
 * **中文不转码**：`encodeURI` 会把整条路径变成 `%E7%AC%94%E8%AE%B0/...`，
 * 源码模式与 Git diff 里几乎不可读，而 markdown-it 本身认非 ASCII。
 * 设计 §4.6 要求「中文保留原文」，这里照办。
 */
export function encodeLinkTarget(fromPath: string, targetPath: string): string {
  const fromDir = dirnameOf(fromPath)
  const fromSegments = fromDir ? fromDir.split('/') : []
  const targetSegments = targetPath.replace(/\\/g, '/').split('/')

  let shared = 0
  while (
    shared < fromSegments.length &&
    shared < targetSegments.length &&
    fromSegments[shared] === targetSegments[shared]
  ) {
    shared++
  }

  const ups = new Array(fromSegments.length - shared).fill('..') as string[]
  const rest = targetSegments.slice(shared)
  const relative = [...ups, ...rest].join('/')

  // 逐字符替换而不是 encodeURI：顺序无关，也不会连带改掉中文
  return relative
    .replace(/%/g, '%25')
    .replace(/ /g, '%20')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
}
