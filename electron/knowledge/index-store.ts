/**
 * 知识索引持久化
 *
 * 落盘位置：`<库>/.inkase/index/`——该目录随同步排除、不上传（见设计文档 §5.4）。
 * 索引是**纯派生物**：删掉它应用仍可用，重建即可。
 *
 * 布局：
 * - `index.json`  索引主文件（原子写，损坏时备份为 `.bak`）
 * - `graph.json`  图谱缓存（由 Task 16 的 graph-service 写入）
 * - `text/`       非 `.md` 文件的抽取正文缓存（`.mdx` / Office）
 */

import * as fs from 'fs'
import * as path from 'path'
import { KNOWLEDGE_PARSER_VERSION, type KnowledgeIndex } from '../../shared/knowledge/types'

/** 库内私有目录（与同步配置同处，天然被 .gitignore 与同步排除） */
export const KNOWLEDGE_DIR = '.inkase'
/** 索引子目录 */
export const INDEX_DIR = 'index'
/** 索引主文件名 */
export const INDEX_FILE = 'index.json'
/** 图谱缓存文件名 */
export const GRAPH_FILE = 'graph.json'
/** 抽取正文缓存子目录 */
export const TEXT_CACHE_DIR = 'text'

/** 索引目录绝对路径 */
export function indexPath(root: string): string {
  return path.join(root, KNOWLEDGE_DIR, INDEX_DIR)
}

/** 索引目录下的文件绝对路径 */
export function indexFilePath(root: string, name: 'index' | 'graph'): string {
  return path.join(indexPath(root), name === 'index' ? INDEX_FILE : GRAPH_FILE)
}

/** 抽取正文缓存目录 */
export function textCacheDir(root: string): string {
  return path.join(indexPath(root), TEXT_CACHE_DIR)
}

/**
 * 把内容指纹转成安全的文件名
 *
 * 指纹形如 `sha1:ab12…`，其中 `:` 在 Windows 上是非法文件名字符，
 * 且指纹可能来自外部输入，必须剥离一切路径分隔符以防越权写入。
 */
export function safeHashName(hash: string): string {
  return hash.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** 单个文件的抽取正文缓存路径 */
export function textCachePath(root: string, hash: string): string {
  return path.join(textCacheDir(root), `${safeHashName(hash)}.txt`)
}

/** 读取抽取正文缓存；不存在或读取失败返回 null */
export function readTextCache(root: string, hash: string): string | null {
  const filePath = textCachePath(root, hash)
  try {
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/** 写入抽取正文缓存（原子写） */
export function writeTextCache(root: string, hash: string, text: string): void {
  const dirPath = textCacheDir(root)
  fs.mkdirSync(dirPath, { recursive: true })
  const filePath = textCachePath(root, hash)
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, text, 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

/** 清空抽取正文缓存目录 */
export function clearTextCache(root: string): void {
  fs.rmSync(textCacheDir(root), { recursive: true, force: true })
}

/** 构造一份空索引 */
export function emptyIndex(root: string): KnowledgeIndex {
  return {
    meta: {
      version: 1,
      root,
      builtAt: 0,
      fileCount: 0,
      parserVersion: KNOWLEDGE_PARSER_VERSION
    },
    files: {},
    outgoing: {},
    unresolved: [],
    tags: {},
    mentions: {},
    errors: []
  }
}

/**
 * 读取索引
 *
 * 文件不存在、结构不完整或 `version !== 1` 时返回 null；
 * JSON 损坏时备份为 `.bak` 并返回 null（与 `sync-state.ts` 的处理一致）。
 */
export function loadIndex(root: string): KnowledgeIndex | null {
  const filePath = indexFilePath(root, 'index')
  if (!fs.existsSync(filePath)) return null

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<KnowledgeIndex>
    if (raw.meta?.version !== 1) return null
    if (typeof raw.meta.parserVersion !== 'number') return null
    if (!raw.files || typeof raw.files !== 'object') return null
    if (!raw.outgoing || typeof raw.outgoing !== 'object') return null

    return {
      meta: {
        version: 1,
        root: typeof raw.meta.root === 'string' ? raw.meta.root : root,
        builtAt: typeof raw.meta.builtAt === 'number' ? raw.meta.builtAt : 0,
        fileCount: typeof raw.meta.fileCount === 'number' ? raw.meta.fileCount : 0,
        parserVersion: raw.meta.parserVersion
      },
      files: raw.files,
      outgoing: raw.outgoing,
      unresolved: Array.isArray(raw.unresolved) ? raw.unresolved : [],
      tags: raw.tags && typeof raw.tags === 'object' ? raw.tags : {},
      mentions: raw.mentions && typeof raw.mentions === 'object' ? raw.mentions : {},
      errors: Array.isArray(raw.errors) ? raw.errors : []
    }
  } catch {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`)
    } catch {
      /* 备份失败忽略 */
    }
    return null
  }
}

/** 写入索引（原子写：先写 .tmp 再 rename） */
export function saveIndex(root: string, index: KnowledgeIndex): void {
  const dirPath = indexPath(root)
  fs.mkdirSync(dirPath, { recursive: true })
  const filePath = indexFilePath(root, 'index')
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(index), 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

/** 删除索引目录（含图谱缓存与正文缓存） */
export function removeIndex(root: string): void {
  fs.rmSync(indexPath(root), { recursive: true, force: true })
}

/**
 * 索引是否已过期
 *
 * 索引缺失，或解析器版本与当前不一致时，需要全量重建。
 */
export function isIndexStale(index: KnowledgeIndex | null, parserVersion: number): boolean {
  if (index === null) return true
  return index.meta.parserVersion !== parserVersion
}
