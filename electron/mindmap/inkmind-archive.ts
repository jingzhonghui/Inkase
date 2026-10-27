/**
 * `.inkmind` 单文件容器的读写
 *
 * 格式（见 docs/superpowers/specs/2026-10-27-inkmind-container-design.md）：
 *
 * ```
 * map.inkmind (ZIP)
 * ├── map.json          导图结构，内容与旧的纯文本版本完全一致
 * └── assets/
 *     ├── images/       节点图片
 *     └── files/        其他附件
 * ```
 *
 * 约定：**编辑器只看见 `map.json` 的文本**，图片与附件由这里解到临时目录，
 * 保存时再打回包。这样上层（解析、序列化、撤销、AI 大纲）全都不用知道 ZIP 的存在。
 *
 * 外部文件是不可信输入，读之前先卡包体积、条目数、解压总量——
 * 一个几百 KB 的包可以解出几 GB，不设上限就是给内存挖坑。
 */

import AdmZip from 'adm-zip'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 容器内的导图文件名 */
export const MINDMAP_ENTRY = 'map.json'
/** 资源根目录（包内路径前缀） */
export const MINDMAP_ASSETS_DIR = 'assets'
/** 图片子目录 */
export const MINDMAP_IMAGES_DIR = 'assets/images'
/** 附件子目录 */
export const MINDMAP_FILES_DIR = 'assets/files'

/** 包本体上限 */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
/** 解压后总字节上限（防 ZIP 炸弹） */
const MAX_UNPACKED_BYTES = 400 * 1024 * 1024
/** 条目数上限 */
const MAX_ENTRIES = 2000

/** 单个附件字节上限。与渲染层 `MAX_ATTACHMENT_BYTES` 保持一致 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
/** 单张图片字节上限。与渲染层 `MAX_IMAGE_SRC` 对齐 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024

export type ArchiveReadResult =
  | {
      ok: true
      /** `map.json` 的文本 */
      content: string
      /** 解压目录 */
      tempDir: string
      /** 包内路径 → 解压后的绝对路径，供渲染层拼接可加载 URL */
      assetMap: Record<string, string>
    }
  | { ok: false; error: string }

export type ArchiveWriteResult = { ok: true } | { ok: false; error: string }

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** 解压目录：每次打开用一个独立目录，避免多个标签互相覆盖 */
export function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-mindmap-'))
}

/**
 * 判断条目的包内路径是否属于资源目录。
 *
 * 只认 `assets/<images|files>/<文件名>`，且文件名不能是 `.`/`..`。
 * 用逐段比较而不是一条正则：`assets/../a.png` 这类写法能骗过
 * `^assets/[^/]+/[^/]+$`，而它正是解包时最该挡住的东西。
 */
export function isAssetEntry(entryName: string): boolean {
  const parts = entryName.split('/')
  if (parts.length !== 3) return false
  if (parts[0] !== MINDMAP_ASSETS_DIR) return false
  if (parts[1] !== 'images' && parts[1] !== 'files') return false
  const name = parts[2]
  return name !== '' && name !== '.' && name !== '..' && !name.includes('\\')
}

/**
 * 解包到临时目录。
 *
 * 调用方负责在关闭标签时删除 `tempDir`（与 `.mdx` 的临时目录同一套生命周期）。
 */
export function readArchive(filePath: string): ArchiveReadResult {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { ok: false, error: '文件不存在或无法读取' }
  }
  if (!stat.isFile()) return { ok: false, error: '目标不是一个文件' }
  if (stat.size > MAX_ARCHIVE_BYTES) {
    return { ok: false, error: '思维导图文件过大（超过 200MB）' }
  }

  let zip: AdmZip
  let entries: AdmZip.IZipEntry[]
  try {
    zip = new AdmZip(filePath)
    entries = zip.getEntries()
  } catch {
    return { ok: false, error: '文件已损坏或不是 Inkase 思维导图' }
  }
  if (entries.length > MAX_ENTRIES) {
    return { ok: false, error: `思维导图条目过多（${entries.length} 个），已停止解析` }
  }
  const unpacked = entries.reduce((sum, entry) => sum + (entry.header.size || 0), 0)
  if (unpacked > MAX_UNPACKED_BYTES) {
    return { ok: false, error: '思维导图解压后体积过大，已停止解析' }
  }

  const mapEntry = entries.find((entry) => entry.entryName === MINDMAP_ENTRY)
  if (!mapEntry) {
    return { ok: false, error: '文件已损坏或不是 Inkase 思维导图（缺少 map.json）' }
  }

  let content: string
  try {
    content = mapEntry.getData().toString('utf8')
  } catch (error) {
    return { ok: false, error: errorMessage(error, '读取导图内容失败') }
  }

  const tempDir = createTempDir()
  const assetMap: Record<string, string> = {}
  try {
    fs.writeFileSync(path.join(tempDir, MINDMAP_ENTRY), content, 'utf8')
    for (const entry of entries) {
      if (!isAssetEntry(entry.entryName)) continue
      const target = path.join(tempDir, ...entry.entryName.split('/'))
      // 再校验一次落点，防止条目名里藏着 `..`
      if (!target.startsWith(tempDir + path.sep)) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, entry.getData())
      assetMap[entry.entryName] = target
    }
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true })
    return { ok: false, error: errorMessage(error, '解压思维导图失败') }
  }

  return { ok: true, content, tempDir, assetMap }
}

/**
 * 把临时目录打回 `.inkmind`。
 *
 * 先写临时文件再改名：中途失败时用户的原文件必须保持可用，
 * 不能出现「存了一半」的损坏包。
 */
export function writeArchiveFromDir(tempDir: string, targetPath: string): ArchiveWriteResult {
  const mapPath = path.join(tempDir, MINDMAP_ENTRY)
  if (!fs.existsSync(mapPath)) {
    return { ok: false, error: '临时目录里没有 map.json' }
  }

  const zip = new AdmZip()
  try {
    zip.addLocalFile(mapPath, '', MINDMAP_ENTRY)
    for (const dirName of ['images', 'files']) {
      const absolute = path.join(tempDir, MINDMAP_ASSETS_DIR, dirName)
      if (!fs.existsSync(absolute)) continue
      for (const fileName of fs.readdirSync(absolute)) {
        const filePath = path.join(absolute, fileName)
        if (!fs.statSync(filePath).isFile()) continue
        zip.addLocalFile(filePath, `${MINDMAP_ASSETS_DIR}/${dirName}`)
      }
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error, '打包思维导图失败') }
  }

  const dir = path.dirname(targetPath)
  const temp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}.zip`)
  try {
    zip.writeZip(temp)
    fs.renameSync(temp, targetPath)
    return { ok: true }
  } catch (error) {
    fs.rmSync(temp, { force: true })
    return { ok: false, error: errorMessage(error, '写入思维导图失败') }
  }
}

/** 直接写一个只含 `map.json` 的新容器（新建空白导图用） */
export function writeArchive(targetPath: string, content: string): ArchiveWriteResult {
  const tempDir = createTempDir()
  try {
    fs.writeFileSync(path.join(tempDir, MINDMAP_ENTRY), content, 'utf8')
    return writeArchiveFromDir(tempDir, targetPath)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

/** 文件名清洗：只留安全字符，避免把目录结构带进包内 */
export function sanitizeAssetName(name: string): string {
  const ext = path.extname(name)
  const base = path
    .basename(name, ext)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
  return `${base === '' ? 'file' : base}${ext.toLowerCase()}`
}

/**
 * 生成包内资源文件名：名字前缀 + 内容哈希。
 *
 * 用哈希而不是序号，有两个直接好处：同一张图重复插入天然去重；
 * 不同内容即使同名也不会互相覆盖。
 */
export function assetFileName(originalName: string, data: Buffer): string {
  const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 8)
  const safe = sanitizeAssetName(originalName)
  const ext = path.extname(safe)
  return `${path.basename(safe, ext)}_${hash}${ext}`
}

export interface StoredAsset {
  /** 包内路径，如 assets/images/hero_9f2a1c.png */
  src: string
  /** 临时目录里的绝对路径，供渲染层立即显示 */
  absolutePath: string
  /** 原始文件名 */
  name: string
  size: number
}

export type StoreAssetResult = { ok: true; data: StoredAsset } | { ok: false; error: string }

/**
 * 把一个外部文件放进解压目录的 `assets/{images,files}/`。
 *
 * 只写临时目录，不碰原包——保存时才由 `writeArchiveFromDir` 打进去，
 * 这样「插入后没保存就撤销」不会在磁盘上留下垃圾。
 */
export function storeAsset(
  tempDir: string,
  sourcePath: string,
  kind: 'image' | 'file',
  maxBytes: number
): StoreAssetResult {
  let stat: fs.Stats
  try {
    stat = fs.statSync(sourcePath)
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  if (!stat.isFile()) return { ok: false, error: '选中的不是文件' }
  if (stat.size > maxBytes) {
    const limitMb = Math.round(maxBytes / (1024 * 1024))
    return { ok: false, error: `文件超过 ${limitMb}MB，请先压缩后再插入` }
  }

  let data: Buffer
  try {
    data = fs.readFileSync(sourcePath)
  } catch (error) {
    return { ok: false, error: errorMessage(error, '读取文件失败') }
  }

  const dirName = kind === 'image' ? 'images' : 'files'
  const targetDir = path.join(tempDir, MINDMAP_ASSETS_DIR, dirName)
  try {
    fs.mkdirSync(targetDir, { recursive: true })
  } catch {
    return { ok: false, error: '无法创建资源目录' }
  }

  const fileName = assetFileName(path.basename(sourcePath), data)
  const absolutePath = path.join(targetDir, fileName)
  try {
    // 同内容已存在时不必重写：文件名里带哈希，内容必然相同
    if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, data)
  } catch (error) {
    return { ok: false, error: errorMessage(error, '写入文件失败') }
  }

  return {
    ok: true,
    data: {
      src: `${MINDMAP_ASSETS_DIR}/${dirName}/${fileName}`,
      absolutePath,
      name: path.basename(sourcePath),
      size: stat.size
    }
  }
}
