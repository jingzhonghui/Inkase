import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  SnapshotBundleFile,
  SnapshotCreateInput,
  SnapshotFileRecord,
  SnapshotManifest,
  SnapshotRestoreResult,
  SnapshotSummary
} from '../../shared/ai/snapshots'
import { snapshotFileKey } from '../../shared/ai/snapshots'

const SNAPSHOT_DIR = path.join('.inkase', 'snapshots')
const DEFAULT_MAX_RUNS = 20
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export interface SnapshotServiceOptions {
  maxRuns?: number
  maxBytes?: number
}

interface PreparedFile {
  content: string
  record: SnapshotFileRecord
}

/**
 * AI 写前快照。
 *
 * 快照按 run 目录组织：`<库>/.inkase/snapshots/<runId>/manifest.json` +
 * `files/NNNN.txt`。同一 run 内同一文档只保留第一次（即运行开始前）的内容，
 * 避免多步修改把回滚目标覆盖成中间态。
 */
export class SnapshotService {
  private readonly maxRuns: number
  private readonly maxBytes: number

  constructor(options: SnapshotServiceOptions = {}) {
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  async create(root: string, input: SnapshotCreateInput): Promise<SnapshotManifest> {
    const workspaceRoot = await this.resolveRoot(root)
    this.assertRunId(input.runId)
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new Error('快照缺少文件')
    }

    const runDir = this.runDir(workspaceRoot, input.runId)
    const existing = await this.readManifest(runDir).catch(() => null)
    const manifest: SnapshotManifest = existing ?? {
      version: 1,
      runId: input.runId,
      conversationId: input.conversationId,
      toolName: input.toolName,
      createdAt: Date.now(),
      files: []
    }

    const known = new Set(manifest.files.map(snapshotFileKey))
    const prepared: PreparedFile[] = []
    for (const file of input.files) {
      const relativePath = this.relativePath(workspaceRoot, file.path)
      if (file.scope === 'disk' && relativePath === null) {
        throw new Error('磁盘快照缺少文件路径')
      }
      const key = snapshotFileKey({ ...file, path: relativePath })
      if (known.has(key)) continue
      known.add(key)

      const content = String(file.content ?? '')
      const index = manifest.files.length + prepared.length + 1
      prepared.push({
        content,
        record: {
          path: relativePath,
          documentId: file.documentId,
          title: file.title,
          scope: file.scope,
          existed: file.existed ?? true,
          storageName: `files/${String(index).padStart(4, '0')}.txt`,
          contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
          size: Buffer.byteLength(content, 'utf8')
        }
      })
    }

    if (prepared.length === 0) return manifest

    const filesDir = path.join(runDir, 'files')
    await mkdir(filesDir, { recursive: true })
    for (const item of prepared) {
      await writeFile(path.join(runDir, item.record.storageName), item.content, 'utf8')
      manifest.files.push(item.record)
    }
    await this.writeManifest(runDir, manifest)
    await this.prune(workspaceRoot, input.runId)
    return manifest
  }

  async list(root: string): Promise<SnapshotSummary[]> {
    const workspaceRoot = await this.resolveRoot(root)
    const snapshotsRoot = path.join(workspaceRoot, SNAPSHOT_DIR)
    let entries
    try {
      entries = await readdir(snapshotsRoot, { withFileTypes: true })
    } catch {
      return []
    }

    const summaries: SnapshotSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue
      try {
        const manifest = await this.readManifest(path.join(snapshotsRoot, entry.name))
        summaries.push(toSummary(manifest))
      } catch {
        // 损坏或写到一半的快照不阻塞列表
      }
    }
    return summaries.sort((a, b) => b.createdAt - a.createdAt)
  }

  async read(root: string, runId: string): Promise<SnapshotRestoreResult> {
    const workspaceRoot = await this.resolveRoot(root)
    this.assertRunId(runId)
    const runDir = this.runDir(workspaceRoot, runId)
    const manifest = await this.readManifest(runDir)
    if (manifest.runId !== runId) throw new Error('快照清单与 runId 不匹配')
    const files: SnapshotBundleFile[] = []
    for (const record of manifest.files) {
      const content = await readFile(this.snapshotFilePath(runDir, record.storageName), 'utf8')
      files.push({ record, content })
    }
    return { manifest, files, restoredDisk: [], skippedDisk: [] }
  }

  async restore(root: string, runId: string, keys?: string[]): Promise<SnapshotRestoreResult> {
    const bundle = await this.read(root, runId)
    const workspaceRoot = path.resolve(root)
    const wanted = keys ? new Set(keys) : null
    const files = wanted
      ? bundle.files.filter((file) => wanted.has(snapshotFileKey(file.record)))
      : bundle.files
    const restoredDisk: string[] = []
    const skippedDisk: string[] = []

    for (const file of files) {
      const record = file.record
      if (record.scope !== 'disk') continue

      const relativePath = this.relativePath(workspaceRoot, record.path)
      if (relativePath === null) {
        skippedDisk.push(record.title)
        continue
      }
      const absolutePath = path.join(workspaceRoot, relativePath)
      try {
        if (record.existed === false) {
          await unlink(absolutePath)
          restoredDisk.push(relativePath)
          continue
        }
        await mkdir(path.dirname(absolutePath), { recursive: true })
        await writeFile(absolutePath, file.content, 'utf8')
        restoredDisk.push(relativePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // 已经不存在的文件无需再删
          continue
        }
        skippedDisk.push(relativePath)
      }
    }

    return { manifest: bundle.manifest, files, restoredDisk, skippedDisk }
  }

  private async resolveRoot(root: string): Promise<string> {
    if (!root || typeof root !== 'string') throw new Error('没有打开工作区')
    const resolved = path.resolve(root)
    const info = await stat(resolved)
    if (!info.isDirectory()) throw new Error('工作区路径不是目录')
    return resolved
  }

  private assertRunId(runId: string): void {
    if (!RUN_ID_RE.test(runId)) throw new Error('无效的快照 runId')
  }

  private runDir(root: string, runId: string): string {
    return path.join(root, SNAPSHOT_DIR, runId)
  }

  /**
   * 把绝对/相对路径收敛为工作区内的相对路径。
   * 拒绝 `..`、绝对路径逃逸与 `.inkase` 下的内部文件。
   */
  private relativePath(root: string, inputPath: string | null): string | null {
    if (inputPath === null || inputPath === '') return null
    const normalizedInput = inputPath.replace(/\\/g, '/')
    const relative = path.isAbsolute(inputPath)
      ? path.relative(root, inputPath).replace(/\\/g, '/')
      : normalizedInput.replace(/^\.?\//, '')

    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('快照路径不在工作区内')
    }
    const segments = relative.split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error('快照路径不合法')
    }
    if (segments.some((segment) => segment.toLowerCase() === '.inkase')) {
      throw new Error('不能快照内部目录')
    }
    return relative
  }

  private async readManifest(runDir: string): Promise<SnapshotManifest> {
    const raw = await readFile(path.join(runDir, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(raw) as SnapshotManifest
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) {
      throw new Error('快照清单损坏')
    }
    return manifest
  }

  private snapshotFilePath(runDir: string, storageName: string): string {
    const normalized = storageName.replace(/\\/g, '/')
    if (!normalized.startsWith('files/') || normalized.includes('..') || path.isAbsolute(normalized)) {
      throw new Error('快照文件路径损坏')
    }
    return path.join(runDir, normalized)
  }

  private async writeManifest(runDir: string, manifest: SnapshotManifest): Promise<void> {
    await mkdir(runDir, { recursive: true })
    const target = path.join(runDir, 'manifest.json')
    const temporary = `${target}.tmp`
    await writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8')
    await rename(temporary, target)
  }

  private async prune(root: string, keepRunId: string): Promise<void> {
    const summaries = (await this.list(root)).sort((a, b) => a.createdAt - b.createdAt)
    const remaining = [...summaries]
    while (remaining.length > this.maxRuns) {
      const oldest = remaining.shift()
      if (!oldest || oldest.runId === keepRunId) continue
      await rm(this.runDir(root, oldest.runId), { recursive: true, force: true })
    }

    let totalBytes = remaining.reduce((sum, item) => sum + item.totalBytes, 0)
    while (totalBytes > this.maxBytes && remaining.length > 1) {
      const oldest = remaining.shift()
      if (!oldest || oldest.runId === keepRunId) continue
      totalBytes -= oldest.totalBytes
      await rm(this.runDir(root, oldest.runId), { recursive: true, force: true })
    }
  }
}

function toSummary(manifest: SnapshotManifest): SnapshotSummary {
  return {
    runId: manifest.runId,
    conversationId: manifest.conversationId,
    toolName: manifest.toolName,
    createdAt: manifest.createdAt,
    fileCount: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    paths: manifest.files.map((file) => file.path),
    scopes: [...new Set(manifest.files.map((file) => file.scope))],
    rolledBackAt: manifest.rolledBackAt
  }
}
