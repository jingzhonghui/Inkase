/**
 * MDX 文件读取模块
 *
 * 提供 .mdx 文件的解压、解析和读取功能
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as os from 'os'
import AdmZip from 'adm-zip'
import type { MdxDocument, MdxJson, MdxAssets, MdxResult } from './schema'
import { validateMdxJson, createDefaultSettings, createDefaultAssets } from './schema'

/** 临时目录前缀 */
const TEMP_PREFIX = 'mdx_'
const MAX_INFLATED_ENTRY_BYTES = 50 * 1024 * 1024

/**
 * 当前进程的实例 ID，用于隔离多实例的临时目录。
 * 同一文件的确定性临时目录只在各自实例根下复用，避免多实例互相清理。
 */
const INSTANCE_ID = `${process.pid}_${crypto.randomBytes(4).toString('hex')}`

/** 临时目录根路径（本实例专属） */
let tempRoot: string

/**
 * 获取本实例的临时目录根路径
 */
function getTempRoot(): string {
  if (!tempRoot) {
    tempRoot = path.join(os.tmpdir(), 'inkase', INSTANCE_ID)
    if (!fs.existsSync(tempRoot)) {
      fs.mkdirSync(tempRoot, { recursive: true })
    }
  }
  return tempRoot
}

/**
 * 生成唯一的临时目录名（通用，用于保存等临时操作）
 */
function generateTempDirName(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)
  return `${TEMP_PREFIX}${timestamp}_${random}`
}

/**
 * 基于文件路径生成确定性临时目录名
 * 同一文件路径始终对应同一个目录名
 */
function generateTempDirNameForFile(filePath: string): string {
  const hash = crypto.createHash('sha256').update(filePath).digest('hex').substring(0, 16)
  return `${TEMP_PREFIX}${hash}`
}

/**
 * 创建临时目录（通用）
 * @returns 临时目录路径
 */
export function createTempDir(): string {
  const tempDir = path.join(getTempRoot(), generateTempDirName())
  fs.mkdirSync(tempDir, { recursive: true })
  return tempDir
}

/**
 * 为指定文件创建或重建临时目录
 * 同一文件路径复用同一目录，避免产生重复的临时目录
 * @param filePath 文件绝对路径
 * @returns 临时目录路径
 */
export function createTempDirForFile(filePath: string): string {
  const dirName = generateTempDirNameForFile(filePath)
  const tempDir = path.join(getTempRoot(), dirName)

  // 若已存在则先清理，确保解压内容是最新的
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  fs.mkdirSync(tempDir, { recursive: true })
  return tempDir
}

/**
 * 清理单个临时目录
 * @param tempDir 临时目录路径
 */
export function cleanupTempDir(tempDir: string): void {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

/**
 * 清理本实例的所有临时目录
 * 在应用退出时调用，只删除本实例专属根目录，避免误删其他实例正在使用的资源
 */
export function cleanupAllTempDirs(): void {
  const root = getTempRoot()
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  tempRoot = ''
}

/**
 * 计算文件的 SHA256 校验和
 * @param filePath 文件路径
 * @returns 校验和字符串
 */
export function calculateChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * 验证文件校验和
 * @param filePath 文件路径
 * @param expectedChecksum 预期的校验和
 * @returns 是否匹配
 */
export function verifyChecksum(filePath: string, expectedChecksum: string): boolean {
  try {
    const actualChecksum = calculateChecksum(filePath)
    return actualChecksum === expectedChecksum
  } catch {
    return false
  }
}

/**
 * 检查 ZIP 路径是否安全（防止路径穿越攻击）
 * @param entryPath ZIP 条目路径
 * @returns 是否安全
 */
function isSafePath(entryPath: string): boolean {
  // 规范化路径
  const normalized = path.normalize(entryPath)
  // 检查是否包含 .. 路径穿越
  if (normalized.startsWith('..') || normalized.includes('..')) {
    return false
  }
  // 检查是否以 / 开头（绝对路径）
  if (path.isAbsolute(normalized)) {
    return false
  }
  return true
}

/**
 * 读取 mdx.json 文件
 * @param jsonPath mdx.json 文件路径
 * @returns 解析后的 MdxJson 对象
 */
function readMdxJson(jsonPath: string): MdxJson {
  const content = fs.readFileSync(jsonPath, 'utf-8')
  const data = JSON.parse(content) as unknown

  const validation = validateMdxJson(data)
  if (!validation.valid) {
    throw new Error(`mdx.json 验证失败: ${validation.error}`)
  }

  return data as MdxJson
}

/**
 * 读取 content.md 文件
 * @param contentPath content.md 文件路径
 * @returns 文件内容
 */
function readContent(contentPath: string): string {
  if (!fs.existsSync(contentPath)) {
    throw new Error('content.md 文件不存在')
  }
  return fs.readFileSync(contentPath, 'utf-8')
}

/**
 * 读取资源文件列表
 * @param tempDir 临时目录路径
 * @param assets 资源元数据
 * @returns 资源数据映射（路径 -> Buffer）
 */
export function readAssets(tempDir: string, assets: MdxAssets): Map<string, Buffer> {
  const assetData = new Map<string, Buffer>()

  // 读取图片资源
  // 注意: image.path 已经是相对于 tempDir 的路径 (如 "assets/images/xxx.png")
  if (assets.images && Array.isArray(assets.images)) {
    for (const image of assets.images) {
      const imagePath = path.join(tempDir, image.path)
      if (fs.existsSync(imagePath)) {
        // 验证校验和
        if (verifyChecksum(imagePath, image.checksum)) {
          assetData.set(image.path, fs.readFileSync(imagePath))
        } else {
          console.warn(`图片校验和验证失败: ${image.path}`)
        }
      } else {
        console.warn(`图片文件不存在: ${imagePath}`)
      }
    }
  }

  // 读取附件资源
  if (assets.attachments && Array.isArray(assets.attachments)) {
    for (const attachment of assets.attachments) {
      const attachmentPath = path.join(tempDir, attachment.path)
      if (fs.existsSync(attachmentPath)) {
        if (verifyChecksum(attachmentPath, attachment.checksum)) {
          assetData.set(attachment.path, fs.readFileSync(attachmentPath))
        } else {
          console.warn(`附件校验和验证失败: ${attachment.path}`)
        }
      } else {
        console.warn(`附件文件不存在: ${attachmentPath}`)
      }
    }
  }

  return assetData
}

/**
 * 打开 MDX 文件
 * @param filePath .mdx 文件路径
 * @returns 包含 MdxDocument 和临时目录路径的结果
 */
export function openMdx(filePath: string): MdxResult<{ document: MdxDocument; tempDir: string }> {
  try {
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return { success: false, error: '文件不存在' }
    }

    // 检查文件扩展名
    if (!filePath.toLowerCase().endsWith('.mdx')) {
      return { success: false, error: '文件扩展名必须是 .mdx' }
    }

    // 创建基于文件路径的确定性临时目录
    const tempDir = createTempDirForFile(filePath)

    try {
      // 解压 ZIP 文件
      const zip = new AdmZip(filePath)
      const zipEntries = zip.getEntries()

      // 提取所有条目到临时目录
      for (const entry of zipEntries) {
        // 安全检查
        if (!isSafePath(entry.entryName)) {
          cleanupTempDir(tempDir)
          return { success: false, error: `不安全的 ZIP 条目路径: ${entry.entryName}` }
        }

        if (!entry.isDirectory && entry.header.size > MAX_INFLATED_ENTRY_BYTES) {
          cleanupTempDir(tempDir)
          return { success: false, error: `ZIP 条目解压后大小超过限制: ${entry.entryName}` }
        }

        const targetPath = path.join(tempDir, entry.entryName)

        if (entry.isDirectory) {
          fs.mkdirSync(targetPath, { recursive: true })
        } else {
          // 确保父目录存在
          const parentDir = path.dirname(targetPath)
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true })
          }
          fs.writeFileSync(targetPath, entry.getData())
        }
      }

      // 读取 mdx.json
      const mdxJsonPath = path.join(tempDir, 'mdx.json')
      if (!fs.existsSync(mdxJsonPath)) {
        cleanupTempDir(tempDir)
        return { success: false, error: 'mdx.json 文件不存在' }
      }

      const mdxJson = readMdxJson(mdxJsonPath)

      // 读取 content.md
      const contentPath = path.join(tempDir, mdxJson.content_file)
      const content = readContent(contentPath)

      // 构建 MdxDocument
      const document: MdxDocument = {
        metadata: {
          version: mdxJson.version,
          created_at: mdxJson.created_at,
          modified_at: mdxJson.modified_at,
          author: mdxJson.author,
          title: mdxJson.title,
          encoding: mdxJson.encoding,
          content_file: mdxJson.content_file
        },
        content,
        assets: mdxJson.assets || createDefaultAssets(),
        settings: mdxJson.settings || createDefaultSettings()
      }

      return {
        success: true,
        data: {
          document,
          tempDir
        }
      }
    } catch (error) {
      cleanupTempDir(tempDir)
      throw error
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    return { success: false, error: `打开文件失败: ${errorMessage}` }
  }
}

/**
 * 加载 MDX 文件资源到内存
 * @param tempDir 临时目录路径
 * @param assets 资源元数据
 * @returns 资源数据映射
 */
export function loadAssets(tempDir: string, assets: MdxAssets): Map<string, Buffer> {
  return readAssets(tempDir, assets)
}

/**
 * 获取资源文件的临时路径
 * @param tempDir 临时目录路径
 * @param assetPath 资源相对路径（如 assets/images/image.png）
 * @returns 完整的临时文件路径
 */
export function getAssetTempPath(tempDir: string, assetPath: string): string {
  return path.join(tempDir, assetPath)
}

/**
 * 列出所有可用的资源
 * @param document MdxDocument 对象
 * @returns 资源列表
 */
export function listAssets(document: MdxDocument): Array<{ type: 'image' | 'attachment'; id: string; filename: string; size: number }> {
  const result: Array<{ type: 'image' | 'attachment'; id: string; filename: string; size: number }> = []

  for (const image of document.assets.images) {
    result.push({
      type: 'image',
      id: image.id,
      filename: image.filename,
      size: image.size
    })
  }

  if (document.assets.attachments) {
    for (const attachment of document.assets.attachments) {
      result.push({
        type: 'attachment',
        id: attachment.id,
        filename: attachment.filename,
        size: attachment.size
      })
    }
  }

  return result
}
