/**
 * 库内非 Markdown 文件的正文抽取
 *
 * 索引服务不直接依赖具体文件格式，抽取逻辑集中在这里：
 * - `.mdx`：复用 `workspace/mdx-content-search` 的安全解包（限制条目数、压缩比、体积，
 *   拒绝路径穿越与加密条目），**仅在内存中解压 `content.md`，不落盘**
 * - `.docx`：mammoth 抽取纯文本；其它 Office 格式暂不支持（返回空串，仅作为可链接节点）
 * - pdf / image / other：按设计不抽取正文，由 AI 按需读取
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as mammoth from 'mammoth'
import type { NodeKind } from '../../shared/knowledge/types'
import { cleanupTempDir, openMdx } from '../mdx/reader'
import { prepareAssetsData, saveMdx } from '../mdx/writer'
import { DEFAULT_MDX_SEARCH_LIMITS, extractMdxContentText } from '../workspace/mdx-content-search'

/** `.mdx`：安全解包并取出 `content.md` 文本 */
export async function extractMdxText(absPath: string): Promise<string> {
  const bytes = await fs.promises.readFile(absPath)
  return extractMdxContentText(bytes, DEFAULT_MDX_SEARCH_LIMITS)
}

/** `.docx`：抽取纯文本；其它 Office 扩展名返回空串 */
export async function extractOfficeText(absPath: string): Promise<string> {
  if (path.extname(absPath).toLowerCase() !== '.docx') return ''
  const buffer = await fs.promises.readFile(absPath)
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

/** 索引服务的正文抽取适配器 */
export async function extractVaultText(absPath: string, kind: NodeKind): Promise<string> {
  if (kind === 'mdx') return extractMdxText(absPath)
  if (kind === 'office') return extractOfficeText(absPath)
  return ''
}

/**
 * 引用重写用：读取可改写的正文
 *
 * `.md` 直接读；`.mdx` 复用安全解包（只读 `content.md`，不落盘）；
 * 其余类型返回 null（不参与改写）。
 */
export async function readVaultText(absPath: string, relPath: string): Promise<string | null> {
  const ext = path.extname(relPath).toLowerCase()
  if (ext === '.md') return fs.promises.readFile(absPath, 'utf-8')
  if (ext === '.mdx') return extractMdxText(absPath)
  return null
}

/**
 * 引用重写用：写回正文
 *
 * `.mdx` 走 `openMdx` → 改 `document.content` → `saveMdx`，**资源原样保留**。
 */
export async function writeVaultText(absPath: string, relPath: string, text: string): Promise<void> {
  const ext = path.extname(relPath).toLowerCase()

  if (ext === '.md') {
    await fs.promises.writeFile(absPath, text, 'utf-8')
    return
  }
  if (ext !== '.mdx') {
    throw new Error(`不支持改写 ${relPath}`)
  }

  const opened = openMdx(absPath)
  if (!opened.success || !opened.data) {
    throw new Error(opened.error ?? 'MDX 打开失败')
  }

  const { document, tempDir } = opened.data
  try {
    document.content = text
    const saved = await saveMdx(absPath, document, prepareAssetsData(tempDir, document))
    if (!saved.success) throw new Error(saved.error ?? 'MDX 保存失败')
  } finally {
    cleanupTempDir(tempDir)
  }
}
