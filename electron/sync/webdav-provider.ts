import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { createClient } from 'webdav'
import type { ConflictChoice, SyncConfig, SyncProvider, SyncResult, SyncStatus } from './types'
import {
  compareFile,
  emptySyncState,
  isSuspiciousEmptyRemote,
  loadSyncState,
  saveSyncState,
  type FileAction,
  type FileSide,
  type SyncStateEntry
} from './sync-state'

/** 远端文件条目；`path` 为相对 `remoteRoot`、以 `/` 分隔的未编码原始路径 */
export interface RemoteEntry {
  path: string
  etag: string | null
  size: number
  mtime: number
}

/**
 * 拼接远端根与相对路径，并对每个路径段做 `encodeURIComponent`（Review Focus #1）。
 * `RemoteEntry.path` 与清单 key 一律保持未编码原始路径。
 *
 * ⚠️ 生产代码路径中**不会**调用本函数：真实客户端见 `createWebdavClient()`，它把未编码
 * 原始路径直接交给 `webdav` 包，由该包在内部完成 URL 编码。
 * **`toRemotePath()` 的结果不得再传入 webdav 客户端**，否则会双重编码
 * （`%20` → `%2520`）导致 404。本函数仅供需要显式编码的调用方使用。
 */
export function toRemotePath(remoteRoot: string, relative: string): string {
  const segments = `${remoteRoot}/${relative}`.split('/').filter((segment) => segment !== '')
  return `/${segments.map(encodeURIComponent).join('/')}`
}

/**
 * WebDAV 客户端抽象。真实实现见 Task 7 的 `createWebdavClient()`；
 * 通过注入解耦，使 provider 可在 vitest（纯 Node）下用 fake client 测试。
 */
export interface WebdavClient {
  ensureDir(remotePath: string): Promise<void>
  list(remotePath: string): Promise<RemoteEntry[]>
  readFile(remotePath: string): Promise<Buffer>
  writeFile(remotePath: string, data: Buffer, etag: string | null): Promise<string | null>
  delete(remotePath: string): Promise<void>
}

/** 远端 ETag 与基准不一致（乐观锁冲突） */
export class WebdavConflictError extends Error {
  constructor(remotePath: string) {
    super(`远端文件已被他人修改：${remotePath}`)
    this.name = 'WebdavConflictError'
  }
}

/** 本地扫描结果；key 为相对工作区、以 `/` 分隔的路径 */
type LocalEntry = { hash: string; size: number; mtime: number }

/** 三向比对结果 */
interface DiffResult {
  actions: Map<string, FileAction>
  local: Map<string, LocalEntry>
  remote: Map<string, RemoteEntry>
  base: Record<string, SyncStateEntry>
  /** 首次绑定对齐出的清单条目（base 为 null 且两侧同名同内容），成功同步时并入清单 */
  aligned: Record<string, SyncStateEntry>
  suspiciousEmptyRemote: boolean
}

/** 同步时硬排除的目录名（不上传、不下载，也不传播删除） */
const EXCLUDED_DIRS = new Set(['.git', '.inkase', 'node_modules'])

/** 计算内容的 `sha1:<hex>` 指纹 */
function sha1Hex(data: Buffer): string {
  return `sha1:${crypto.createHash('sha1').update(data).digest('hex')}`
}

/** 把抛出的未知错误转成可读文案 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * WebDAV 同步提供者。
 * 以 `<工作区>/.inkase/sync-state.json`（上次同步基准）做三向比对，实现镜像语义：
 * 增删改双向传播，冲突整文件选边（不自动合并）。
 */
export class WebdavSyncProvider implements SyncProvider {
  readonly kind = 'webdav' as const

  constructor(
    readonly workspacePath: string,
    private readonly config: SyncConfig,
    private readonly client: WebdavClient
  ) {}

  /** 远端根目录 */
  private get remoteRoot(): string {
    return this.config.remoteRoot ?? ''
  }

  /** 远端完整路径（`remoteRoot` 与相对路径拼接） */
  private remotePath(relative: string): string {
    const root = this.remoteRoot.replace(/\/+$/, '')
    return root === '' ? relative : `${root}/${relative}`
  }

  /**
   * 递归遍历工作区，跳过 `.git`/`.inkase`/`node_modules`。
   *
   * 扫描失败（目录 `readdir` 抛错、普通文件读失败）**一律上抛**，绝不静默跳过：
   * 被跳过的文件在比对中等同「本地已删」，会产出 `deleteRemote` 并删掉远端文件
   * （设计 §5.4 第三条护栏「本地扫描失败同理，不执行批量远端删除」）。
   * 上抛后 `status()` 归为 `error`、`push()`/`pull()` 直接失败，从而中止删除传播。
   * 非普通文件（符号链接等）仍按既有语义跳过（它们不参与镜像）。
   */
  private async scanLocal(): Promise<Map<string, LocalEntry>> {
    const out = new Map<string, LocalEntry>()
    const walk = (dir: string, rel: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (err) {
        throw new Error(`扫描本地目录失败：${rel === '' ? '.' : rel}（${errorMessage(err)}）`)
      }
      for (const entry of entries) {
        if (EXCLUDED_DIRS.has(entry.name)) continue
        const abs = path.join(dir, entry.name)
        const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          walk(abs, relPath)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const data = fs.readFileSync(abs)
          const stat = fs.statSync(abs)
          out.set(relPath, { hash: sha1Hex(data), size: stat.size, mtime: stat.mtimeMs })
        } catch (err) {
          throw new Error(`读取本地文件失败：${relPath}（${errorMessage(err)}）`)
        }
      }
    }
    walk(this.workspacePath, '')
    return out
  }

  /**
   * 计算某文件远端一侧的 `FileSide`；首次绑定（base 为 `null`）时按内容对齐。
   *
   * `RemoteEntry` 只有 `etag`/`size`、**没有内容 hash**，因此 base 为 `null` 且两侧同名时
   * 不得用 `size`/`etag` 猜测相等，必须下载远端内容算 hash 与本地比对（设计 §5.1 认可的额外下载），
   * 否则「同名但内容不同」会被误判为 `upload` 而静默覆盖远端（设计 §5.6「首次不自动覆盖任何一方」）。
   * 同名同内容 → `none`，并产出一条对齐基准（`aligned`）供 push/pull 写入清单。
   */
  private async resolveRemote(
    key: string,
    entry: RemoteEntry | null,
    base: SyncStateEntry | null,
    localEntry: LocalEntry | null
  ): Promise<{ side: FileSide; aligned: SyncStateEntry | null }> {
    if (entry === null) return { side: null, aligned: null }

    if (base === null) {
      // 仅远端有 → 远端新增（合成值 → download）
      if (localEntry === null) {
        return { side: { hash: `remote:${entry.etag ?? entry.size}` }, aligned: null }
      }
      // 两侧同名：取远端内容算 hash 与本地比对
      const remoteHash = sha1Hex(await this.client.readFile(this.remotePath(key)))
      if (remoteHash !== localEntry.hash) return { side: { hash: remoteHash }, aligned: null }
      // 同名同内容 → none，并记入清单（§5.6）
      return {
        side: { hash: localEntry.hash },
        aligned: { etag: entry.etag, hash: localEntry.hash, size: localEntry.size, mtime: localEntry.mtime }
      }
    }

    // 有基准：ETag 相等视为远端未变
    if (entry.etag !== null && base.etag !== null && entry.etag === base.etag) {
      return { side: { hash: base.hash }, aligned: null }
    }
    // ETag 缺失（任一侧）→ 回退 size 比较；仍无法判定视为未变
    if (entry.etag === null || base.etag === null) {
      return {
        side: entry.size === base.size ? { hash: base.hash } : { hash: `remote:size:${entry.size}` },
        aligned: null
      }
    }
    // ETag 明确不同 → 合成值（与本地 sha1 空间不重叠 → 视为已变）
    return { side: { hash: `remote:${entry.etag}` }, aligned: null }
  }

  /** 读取基准清单、扫描本地、列举远端，逐 key 做三向比对 */
  private async diff(): Promise<DiffResult> {
    const base = loadSyncState(this.workspacePath)?.files ?? {}
    const local = await this.scanLocal()
    // 设计 §10.1 步骤 2：远端根不存在时（用户新建目录、或远端目录被删）先 MKCOL 建根，
    // 否则 list() 的 PROPFIND 会 404，导致 push() 整体失败（零 PUT、零 MKCOL）。
    // 建根是幂等的非破坏操作，不改变空远端护栏与首绑并集语义。
    await this.client.ensureDir(this.remoteRoot)
    const remote = new Map((await this.client.list(this.remoteRoot)).map((e) => [e.path, e]))
    const keys = new Set([...Object.keys(base), ...local.keys(), ...remote.keys()])
    const actions = new Map<string, FileAction>()
    const aligned: Record<string, SyncStateEntry> = {}
    for (const key of keys) {
      const baseEntry = base[key] ?? null
      const localEntry = local.get(key) ?? null
      const localSide: FileSide = localEntry ? { hash: localEntry.hash } : null
      const { side: remoteSide, aligned: alignedEntry } = await this.resolveRemote(
        key,
        remote.get(key) ?? null,
        baseEntry,
        localEntry
      )
      if (alignedEntry) aligned[key] = alignedEntry
      actions.set(key, compareFile(baseEntry, localSide, remoteSide))
    }
    return {
      actions,
      local,
      remote,
      base,
      aligned,
      suspiciousEmptyRemote: isSuspiciousEmptyRemote(Object.keys(base).length, remote.size)
    }
  }

  /** 按三向比对汇总状态；远端列举失败或疑似被清空时按 `error` 处理 */
  async status(): Promise<SyncStatus> {
    let result: DiffResult
    try {
      result = await this.diff()
    } catch {
      return 'error'
    }
    if (result.suspiciousEmptyRemote) return 'error'
    // 首绑对齐（同名同内容、base 缺失）也必须落盘，否则后续本地改动会因 base 仍缺失而误报 conflict，
    // 且每次 status() 都要重复下载远端内容。冲突项不在 aligned 中，其基准保持缺失直到用户选边。
    if (Object.keys(result.aligned).length > 0) {
      saveSyncState(this.workspacePath, {
        ...emptySyncState(this.remoteRoot),
        files: { ...result.base, ...result.aligned }
      })
    }
    let hasPush = false
    let hasPull = false
    for (const action of result.actions.values()) {
      if (action === 'conflict') return 'conflict'
      if (action === 'upload' || action === 'deleteRemote') hasPush = true
      else if (action === 'download' || action === 'deleteLocal') hasPull = true
    }
    if (hasPush) return 'pendingPush'
    if (hasPull) return 'pendingPull'
    return 'upToDate'
  }

  /** WebDAV 无提交概念，空实现 */
  async commit(_message: string): Promise<void> {
    /* WebDAV 无提交概念 */
  }

  /**
   * 拉取：只处理 `download` 与 `deleteLocal`，**绝不触碰 `conflict` 与 `upload`**。
   * 单个文件失败不中断，收集错误信息返回；已成功的文件仍写入清单（可续传）。
   * 远端疑似被清空时中止，绝不批量删除本地（设计 §5.4）。
   */
  async pull(): Promise<SyncResult> {
    let result: DiffResult
    try {
      result = await this.diff()
    } catch (err) {
      return { success: false, error: errorMessage(err) }
    }
    if (result.suspiciousEmptyRemote) {
      return { success: false, error: '远端目录为空但本地记录非空，已中止以避免误删本地文件' }
    }
    const files: Record<string, SyncStateEntry> = { ...result.base, ...result.aligned }
    const changedFiles: string[] = []
    const failures: string[] = []
    for (const [key, action] of result.actions) {
      if (action !== 'download' && action !== 'deleteLocal') continue
      const abs = path.join(this.workspacePath, key)
      try {
        if (action === 'download') {
          const data = await this.client.readFile(this.remotePath(key))
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          fs.writeFileSync(abs, data)
          const stat = fs.statSync(abs)
          files[key] = {
            etag: result.remote.get(key)?.etag ?? null,
            hash: sha1Hex(data),
            size: stat.size,
            mtime: stat.mtimeMs
          }
        } else {
          fs.rmSync(abs, { force: true })
          delete files[key]
        }
        changedFiles.push(abs)
      } catch (err) {
        failures.push(`${key}: ${errorMessage(err)}`)
      }
    }
    saveSyncState(this.workspacePath, { ...emptySyncState(this.remoteRoot), files })
    if (failures.length > 0) return { success: false, error: failures.join('; ') }
    return { success: true, changedFiles }
  }

  /**
   * 推送：只处理 `upload` 与 `deleteRemote`，**绝不触碰 `conflict` 与 `download`**。
   * 单个文件失败不中断，收集错误信息返回；已成功的文件仍写入清单（可续传）。
   */
  async push(): Promise<SyncResult> {
    let result: DiffResult
    try {
      result = await this.diff()
    } catch (err) {
      return { success: false, error: errorMessage(err) }
    }
    const files: Record<string, SyncStateEntry> = { ...result.base, ...result.aligned }
    const changedFiles: string[] = []
    const failures: string[] = []
    for (const [key, action] of result.actions) {
      if (action !== 'upload' && action !== 'deleteRemote') continue
      const abs = path.join(this.workspacePath, key)
      try {
        if (action === 'upload') {
          const local = result.local.get(key)
          if (!local) continue
          const data = fs.readFileSync(abs)
          const etag = await this.client.writeFile(this.remotePath(key), data, files[key]?.etag ?? null)
          files[key] = { etag, hash: local.hash, size: local.size, mtime: local.mtime }
        } else {
          await this.client.delete(this.remotePath(key))
          delete files[key]
        }
        changedFiles.push(abs)
      } catch (err) {
        failures.push(`${key}: ${errorMessage(err)}`)
      }
    }
    saveSyncState(this.workspacePath, { ...emptySyncState(this.remoteRoot), files })
    if (failures.length > 0) return { success: false, error: failures.join('; ') }
    return { success: true, changedFiles }
  }

  /** 冲突文件绝对路径列表 */
  async conflictedFiles(): Promise<string[]> {
    const result = await this.diff()
    return [...result.actions.entries()]
      .filter(([, action]) => action === 'conflict')
      .map(([key]) => path.join(this.workspacePath, key))
  }

  /**
   * 冲突文件的人工裁决：`local` 用本地内容覆盖远端，`remote` 用远端内容覆盖本地。
   * 冲突文件只能由此方法处理（`pull()`/`push()` 均跳过）。
   * `local` 以远端当前 ETag 做乐观锁（`If-Match`），期间远端被改动则记为该文件失败；
   * 一侧已删除时按镜像语义让该侧胜出（`local` 删远端 / `remote` 删本地）。
   * 单个文件失败不中断，收集错误信息返回；已成功的文件仍写入清单（可续传）。
   */
  async resolveConflicts(choices: ConflictChoice[]): Promise<SyncResult> {
    let result: DiffResult
    try {
      result = await this.diff()
    } catch (err) {
      return { success: false, error: errorMessage(err) }
    }
    if (result.suspiciousEmptyRemote) {
      return { success: false, error: '远端目录为空但本地记录非空，已中止以避免误删本地文件' }
    }
    const files: Record<string, SyncStateEntry> = { ...result.base, ...result.aligned }
    const changedFiles: string[] = []
    const failures: string[] = []
    for (const { path: absPath, choice } of choices) {
      const key = this.relativeKey(absPath)
      if (key === null) {
        failures.push(`${absPath}: 不在同步工作区内`)
        continue
      }
      if (result.actions.get(key) !== 'conflict') {
        failures.push(`${key}: 不是冲突文件`)
        continue
      }
      const remote = result.remote.get(key) ?? null
      try {
        if (choice === 'local') {
          const local = result.local.get(key) ?? null
          if (local) {
            const data = fs.readFileSync(absPath)
            const etag = await this.client.writeFile(this.remotePath(key), data, remote?.etag ?? null)
            files[key] = { etag, hash: local.hash, size: local.size, mtime: local.mtime }
          } else {
            await this.client.delete(this.remotePath(key))
            delete files[key]
          }
        } else if (remote) {
          const data = await this.client.readFile(this.remotePath(key))
          fs.mkdirSync(path.dirname(absPath), { recursive: true })
          fs.writeFileSync(absPath, data)
          const stat = fs.statSync(absPath)
          files[key] = { etag: remote.etag, hash: sha1Hex(data), size: stat.size, mtime: stat.mtimeMs }
        } else {
          fs.rmSync(absPath, { force: true })
          delete files[key]
        }
        changedFiles.push(absPath)
      } catch (err) {
        failures.push(`${key}: ${errorMessage(err)}`)
      }
    }
    saveSyncState(this.workspacePath, { ...emptySyncState(this.remoteRoot), files })
    if (failures.length > 0) return { success: false, error: failures.join('; ') }
    return { success: true, changedFiles }
  }

  /** 绝对路径 → 清单 key（相对工作区、`/` 分隔）；工作区外返回 null */
  private relativeKey(absPath: string): string | null {
    const rel = path.relative(this.workspacePath, absPath)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join('/')
  }

  dispose(): void {
    /* 客户端资源由构造方持有，provider 无需释放 */
  }
}

/** 真实 WebDAV 客户端连接参数；口令仅作入参，不落盘 */
export interface WebdavClientOptions {
  url: string
  username: string
  password: string
}

/** 取远端路径的父目录；`/a/b/c.mdx` → `/a/b`，顶层文件返回空串 */
function parentDir(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '' : trimmed.slice(0, idx)
}

/**
 * `If-Match` 要求 entity-tag 带引号，为未加引号的 ETag 补上。
 *
 * ⚠️ `webdav` 包的 `prepareFileFromProps()` 用 `etag.replace(/"/g, '')` 剥掉所有引号，
 * 因此服务器返回的弱 ETag `W/"abc"` 会以 `W/abc` 的形式到达这里。若不识别 `W/` 前缀，
 * 会拼成 `"W/abc"`（语义错误的强 ETag），对发弱 ETag 的服务器 `If-Match` 恒 412、
 * `push()` 永远失败。故此处必须把弱 ETag 还原为 `W/"abc"`。
 *
 * 导出仅为便于对该纯函数做单元测试（映射写错会导致 push() 永久失败）。
 */
export function quotedEtag(etag: string): string {
  const weak = etag.startsWith('W/')
  const opaque = weak ? etag.slice(2) : etag
  const quoted = opaque.length >= 2 && opaque.startsWith('"') && opaque.endsWith('"') ? opaque : `"${opaque}"`
  return weak ? `W/${quoted}` : quoted
}

/**
 * 用 `webdav` 包实现的真实客户端。
 * 路径参数一律为未编码原始路径：`webdav` 包内部自行做 URL 编码，
 * 这里再编码一次会把含空格/中文/`#` 的路径变成双重编码（404），
 * 故 `toRemotePath()` 仅供需要显式编码的调用方使用。
 * 列举时与 `scanLocal()` 一致硬排除 `.git`/`.inkase`/`node_modules`（不下载也不传播删除）。
 */
export function createWebdavClient(options: WebdavClientOptions): WebdavClient {
  const client = createClient(options.url, { username: options.username, password: options.password })
  /** 已确认存在的目录，避免同一目录重复 MKCOL */
  const ensuredDirs = new Set<string>()

  async function ensureDir(remotePath: string): Promise<void> {
    const dir = remotePath.replace(/\/+$/, '')
    if (dir === '' || dir === '/') return
    if (ensuredDirs.has(dir)) return
    await client.createDirectory(dir, { recursive: true })
    ensuredDirs.add(dir)
  }

  /** 递归列举；返回的 `path` 相对 `remotePath`、`/` 分隔、未编码 */
  async function list(remotePath: string): Promise<RemoteEntry[]> {
    const entries: RemoteEntry[] = []
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const item of await client.getDirectoryContents(dir)) {
        if (EXCLUDED_DIRS.has(item.basename)) continue
        const childRel = rel === '' ? item.basename : `${rel}/${item.basename}`
        const childPath = `${dir.replace(/\/+$/, '')}/${item.basename}`
        if (item.type === 'directory') {
          await walk(childPath, childRel)
        } else {
          entries.push({
            path: childRel,
            etag: item.etag,
            size: Number.isFinite(item.size) ? item.size : 0,
            mtime: Date.parse(item.lastmod) || 0
          })
        }
      }
    }
    await walk(remotePath, '')
    return entries
  }

  return {
    ensureDir,
    list,
    async readFile(remotePath: string): Promise<Buffer> {
      const body = await client.getFileContents(remotePath, { format: 'binary' })
      return Buffer.from(body as Uint8Array)
    },
    async writeFile(remotePath: string, data: Buffer, etag: string | null): Promise<string | null> {
      await ensureDir(parentDir(remotePath))
      const headers: Record<string, string> = {}
      if (etag !== null) headers['If-Match'] = quotedEtag(etag)
      try {
        await client.putFileContents(remotePath, data, { headers, contentLength: data.length })
      } catch (err) {
        // 412 Precondition Failed：`If-Match` 与远端当前 ETag 不符
        if ((err as { status?: number }).status === 412) throw new WebdavConflictError(remotePath)
        throw err
      }
      const info = await client.stat(remotePath)
      const newEtag = 'etag' in info ? info.etag : info.data.etag
      return newEtag ?? null
    },
    async delete(remotePath: string): Promise<void> {
      await client.deleteFile(remotePath)
    }
  }
}
