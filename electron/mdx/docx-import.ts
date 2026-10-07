/**
 * Word (.docx) 文件导入模块
 *
 * 将 .docx 文件转换为 .mdx 格式，包括：
 * - 提取正文并转换为 Markdown
 * - 提取内嵌图片并注册为 MDX 资源
 */

import * as fs from 'fs'
import * as path from 'path'
import * as mammoth from 'mammoth'
import type { MdxDocument, MdxResult, MdxImageAsset } from './schema'
import { createMdxDocument } from './schema'
import { addImageAsset } from './writer'
import { htmlToMarkdown } from './html-to-md'

/** docx 导入结果 */
export interface DocxImportResult {
  document: MdxDocument
  importedImages: string[]
  failedImages: string[]
  assetsData: Map<string, Buffer>
}

/** 待处理的内嵌图片 */
interface PendingImage {
  filename: string
  mimeType: string
  data: Buffer
}

/**
 * 获取内容类型对应的文件扩展名
 */
function extensionForContentType(contentType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'image/x-emf': '.emf',
    'image/x-wmf': '.wmf'
  }
  return map[contentType.toLowerCase()] || '.png'
}

/**
 * 从 .docx 文件导入并转换为 MDX 文档
 */
export async function importFromDocx(docxFilePath: string): Promise<MdxResult<DocxImportResult>> {
  try {
    if (!fs.existsSync(docxFilePath)) {
      return { success: false, error: 'Word 文件不存在' }
    }

    if (path.extname(docxFilePath).toLowerCase() !== '.docx') {
      return { success: false, error: '仅支持 .docx 格式（旧版 .doc 请先用 Word 另存为 .docx）' }
    }

    const buffer = fs.readFileSync(docxFilePath)
    const fileName = path.basename(docxFilePath, path.extname(docxFilePath))

    // 收集内嵌图片
    const pendingImages: PendingImage[] = []
    const imageMap = new Map<string, string>()
    let imageIndex = 0

    const convertImage = mammoth.images.imgElement(async (image) => {
      const data = await image.readAsBuffer()
      const ext = extensionForContentType(image.contentType)
      const filename = `image-${Date.now()}-${imageIndex++}${ext}`

      pendingImages.push({
        filename,
        mimeType: image.contentType,
        data
      })

      // 使用临时 src 作为 key，后续替换
      const placeholder = `__DOCX_IMG_${imageIndex - 1}__`
      imageMap.set(placeholder, placeholder)
      return { src: placeholder }
    })

    // 转换为 HTML
    const result = await mammoth.convertToHtml({ buffer }, { convertImage })

    // 将 HTML 转换为 Markdown
    const markdown = htmlToMarkdown(result.value, { imageMap })

    // 创建 MDX 文档
    const document = createMdxDocument(fileName, markdown)

    // 导入图片到 MDX
    const assetsData = new Map<string, Buffer>()
    const importedImages: string[] = []
    const failedImages: string[] = []
    const pathReplacements = new Map<string, string>()

    for (let i = 0; i < pendingImages.length; i++) {
      const img = pendingImages[i]
      const placeholder = `__DOCX_IMG_${i}__`

      try {
        const assetResult: { asset: MdxImageAsset; relativePath: string } | null = addImageAsset(
          document,
          img.filename,
          img.mimeType,
          img.data
        )

        if (assetResult) {
          pathReplacements.set(placeholder, assetResult.relativePath)
          assetsData.set(assetResult.relativePath, img.data)
          importedImages.push(img.filename)
        } else {
          failedImages.push(img.filename)
        }
      } catch {
        failedImages.push(img.filename)
      }
    }

    // 替换 Markdown 中的图片占位符
    for (const [placeholder, newPath] of pathReplacements) {
      document.content = document.content.split(placeholder).join(newPath)
    }

    return {
      success: true,
      data: {
        document,
        importedImages,
        failedImages,
        assetsData
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    return { success: false, error: `导入 Word 文档失败: ${errorMessage}` }
  }
}

/**
 * 将导入的 docx 保存为 .mdx 文件
 */
export async function importDocxAndSaveAsMdx(
  targetPath: string,
  docxFilePath: string
): Promise<MdxResult<{ document: MdxDocument; tempDir: string }>> {
  // 导入 docx
  const importResult = await importFromDocx(docxFilePath)
  if (!importResult.success) {
    return { success: false, error: importResult.error }
  }

  const { document, assetsData } = importResult.data!

  // 保存为 MDX
  const { saveMdx } = await import('./writer')
  const saveResult = await saveMdx(targetPath, document, assetsData)

  if (!saveResult.success) {
    return { success: false, error: saveResult.error }
  }

  // 重新打开以获取临时目录
  const { openMdx } = await import('./reader')
  return openMdx(targetPath)
}

/**
 * 获取 Word 导入报告
 */
export function generateDocxImportReport(importedImages: string[], failedImages: string[]): string {
  let report = 'Word 文档导入报告\n'
  report += '='.repeat(40) + '\n\n'

  report += `成功导入: ${importedImages.length} 个图片\n`
  for (const img of importedImages) {
    report += `  ✓ ${img}\n`
  }

  if (failedImages.length > 0) {
    report += `\n导入失败: ${failedImages.length} 个图片\n`
    for (const img of failedImages) {
      report += `  ✗ ${img}\n`
    }
  }

  return report
}
