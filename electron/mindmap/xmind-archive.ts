/**
 * `.xmind` 压缩包的读写
 *
 * `.xmind` 就是个 ZIP，里面是 `content.json`（新版）或 `content.xml`（XMind 8 及更早）。
 * 这里只做「字节 ↔ 文本/JSON」，字段映射在 `shared/mindmap/xmind.ts`，两边职责分开：
 * 转换逻辑纯函数可测，文件操作集中在主进程。
 *
 * 外部文件属于不可信输入，所以读取前先卡体积、条目数、解压后总量——
 * 一个几百 KB 的压缩包可以解出几 GB，不设上限就是给内存挖坑。
 */

import AdmZip from 'adm-zip'
import fs from 'node:fs'
import path from 'node:path'

import {
  mindMapToXmind,
  xmindToMindMap,
  type XmindArchiveFiles,
  type XmindImportWarnings
} from '../../shared/mindmap/xmind'
import { writeArchive } from './inkmind-archive'

/** XMind 文件扩展名（含点） */
export const XMIND_EXTENSION = '.xmind'

/** 压缩包本体上限：正常的导图远小于这个数 */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
/** 解压后总字节上限（防 ZIP 炸弹） */
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024
/** 条目数上限（图片多的导图会有不少条目，但不会上千） */
const MAX_ENTRIES = 2000

export type XmindContentResult = { ok: true; content: unknown } | { ok: false; error: string }

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * 读出 `content.json` 并解析成对象。
 *
 * 只有 `content.json` 才算支持：遇到 XMind 8 的 `content.xml` 单独给提示，
 * 因为「升级 XMind 后另存」是用户能执行的动作，而「格式不支持」只会让人卡住。
 */
export function readXmindContent(filePath: string): XmindContentResult {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { ok: false, error: '文件不存在或无法读取' }
  }
  if (!stat.isFile()) return { ok: false, error: '目标不是一个文件' }
  if (stat.size > MAX_ARCHIVE_BYTES) {
    return { ok: false, error: 'XMind 文件过大（超过 50MB），暂不支持导入' }
  }

  let entries: AdmZip.IZipEntry[]
  try {
    const zip = new AdmZip(filePath)
    entries = zip.getEntries()
    if (entries.length > MAX_ENTRIES) {
      return { ok: false, error: `XMind 文件条目过多（${entries.length} 个），已停止解析` }
    }
    const unpacked = entries.reduce((sum, entry) => sum + (entry.header.size || 0), 0)
    if (unpacked > MAX_UNPACKED_BYTES) {
      return { ok: false, error: 'XMind 解压后体积过大，已停止解析' }
    }

    const contentEntry = entries.find((entry) => entry.entryName === 'content.json')
    if (!contentEntry) {
      const hasLegacy = entries.some((entry) => entry.entryName === 'content.xml')
      if (hasLegacy) {
        return {
          ok: false,
          error:
            '这是 XMind 8 及更早版本的格式（content.xml），暂不支持。请用新版 XMind 打开后另存，再导入。'
        }
      }
      const encrypted = entries.some(
        (entry) => entry.entryName === 'META-INF/manifest.xml' || entry.entryName === 'meta.xml'
      )
      if (encrypted) {
        return { ok: false, error: '这个 XMind 文件可能设置了密码，无法读取内容' }
      }
      return { ok: false, error: '这不是有效的 XMind 文件（缺少 content.json）' }
    }

    const raw = zip.readAsText(contentEntry, 'utf8')
    if (!raw.trim()) return { ok: false, error: 'XMind 内容为空' }

    let content: unknown
    try {
      content = JSON.parse(raw)
    } catch {
      return { ok: false, error: 'XMind 内容不是合法的 JSON' }
    }
    return { ok: true, content }
  } catch (error) {
    return { ok: false, error: `无法读取 XMind 文件：${errorMessage(error, '未知错误')}` }
  }
}

/** 先写临时文件再改名，避免中途失败留下半截文件 */
export function writeFileAtomicSync(targetPath: string, data: Buffer | string): void {
  const dir = path.dirname(targetPath)
  const temp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}`)
  fs.writeFileSync(temp, data)
  try {
    fs.renameSync(temp, targetPath)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

/** 把转换结果打成 `.xmind` 压缩包 */
export function writeXmindArchive(targetPath: string, files: XmindArchiveFiles): void {
  const zip = new AdmZip()
  for (const [entryName, text] of Object.entries(files)) {
    zip.addFile(entryName, Buffer.from(text, 'utf8'))
  }
  const dir = path.dirname(targetPath)
  const temp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}.zip`)
  zip.writeZip(temp)
  try {
    fs.renameSync(temp, targetPath)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

/**
 * 为导入结果挑一个不冲突的文件名。
 *
 * 与「导入 Markdown」保持一致：重名不覆盖，而是加 `_1`、`_2`。
 * 覆盖用户的既有文件是不可逆的，而多出一个副本最多是烦人。
 */
export function uniqueTargetPath(dir: string, baseName: string, extension: string): string {
  const safeBase = baseName.trim() || '思维导图'
  let candidate = path.join(dir, `${safeBase}${extension}`)
  let counter = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${safeBase}_${counter}${extension}`)
    counter += 1
  }
  return candidate
}

export interface XmindImportOutcome {
  filePath: string
  warnings: XmindImportWarnings
}

/**
 * 完整导入：`.xmind` → `.inkmind` 落盘。
 *
 * 返回落盘路径与被丢弃内容的计数，由调用方决定怎么提示；
 * 这里不做对话框，保持「文件操作」与「交互」分离，便于测试。
 */
export function importXmindToFile(
  sourcePath: string,
  targetDir: string,
  extension = '.inkmind'
): { ok: true; data: XmindImportOutcome } | { ok: false; error: string } {
  const read = readXmindContent(sourcePath)
  if (!read.ok) return { ok: false, error: read.error }

  const converted = xmindToMindMap(read.content)
  if (!converted.ok) return { ok: false, error: converted.error }

  const baseName = path.basename(sourcePath, path.extname(sourcePath))
  try {
    const targetPath = uniqueTargetPath(targetDir, baseName, extension)
    // `.inkmind` 是 ZIP 容器，不能直接把文本写进去——那样存出来的文件打不开
    if (extension === '.inkmind') {
      const written = writeArchive(targetPath, converted.text)
      if (!written.ok) return { ok: false, error: written.error }
    } else {
      writeFileAtomicSync(targetPath, converted.text)
    }
    return {
      ok: true,
      data: {
        filePath: targetPath,
        warnings: converted.warnings
      }
    }
  } catch (error) {
    return { ok: false, error: `写入文件失败：${errorMessage(error, '未知错误')}` }
  }
}

/**
 * 完整导出：`.inkmind` 文本 → `.xmind` 落盘。
 *
 * 路径由调用方给定（主进程先弹保存框），因此这里只管转换与写盘。
 */
export function exportMindMapToXmindFile(
  inkmindText: string,
  targetPath: string
): { ok: true; filePath: string } | { ok: false; error: string } {
  const converted = mindMapToXmind(inkmindText)
  if (!converted.ok) return { ok: false, error: converted.error }

  try {
    writeXmindArchive(targetPath, converted.files)
    return { ok: true, filePath: targetPath }
  } catch (error) {
    return { ok: false, error: `写入 XMind 文件失败：${errorMessage(error, '未知错误')}` }
  }
}
