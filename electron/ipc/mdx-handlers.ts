/**
 * MDX 文件操作 IPC Handlers
 *
 * 处理 .mdx 文件的打开、保存、导入、导出等操作。
 * 主进程不持有文档状态——所有 state 由渲染进程的 Pinia store 管理。
 * 主进程仅负责文件 I/O 和临时目录生命周期。
 */

import { ipcMain, BrowserWindow } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { IPC_CHANNELS } from './channels'
import type { MdxDocument } from '../mdx/schema'
import { createMdxDocument, toMdxJson } from '../mdx/schema'
import { openMdx, createTempDirForFile, cleanupTempDir, cleanupAllTempDirs } from '../mdx/reader'
import { saveMdx, validateFilePath } from '../mdx/writer'
import { importAndSaveAsMdx } from '../mdx/import'
import { exportMdxFile } from '../mdx/export'
import { addRecentFile as addRecent } from './file-handlers'
import { clearRecoveryData } from '../recovery'
import type { RecoverySnapshot } from '../recovery'

// 文件路径 → 临时目录的映射（主进程唯一持有的状态）
const tempDirsByFile = new Map<string, string>()

export function attachRecoveryAssetData(snapshot: RecoverySnapshot): RecoverySnapshot {
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => {
      if (!tab.filePath || tab.format !== 'mdx') return tab
      const tempDir = tempDirsByFile.get(normalizeFilePath(tab.filePath))
      const document = tab.document as MdxDocument | null
      if (!tempDir || !document?.assets) return tab

      const assetData: Record<string, string> = {}
      for (const asset of [...document.assets.images, ...(document.assets.attachments || [])]) {
        const fullPath = path.resolve(tempDir, asset.path)
        const relativePath = path.relative(tempDir, fullPath)
        if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath) && fs.existsSync(fullPath)) {
          assetData[asset.path] = fs.readFileSync(fullPath).toString('base64')
        }
      }
      return Object.keys(assetData).length > 0 ? { ...tab, assetData } : tab
    })
  }
}

function normalizeFilePath(filePath: string): string {
  return path.normalize(path.resolve(filePath))
}

/** 图片扩展名 → MIME 类型映射；非图片返回 null */
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}

function getImageMimeType(filePath: string): string | null {
  return IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? null
}

function registerTempDir(filePath: string, tempDir: string): void {
  tempDirsByFile.set(normalizeFilePath(filePath), tempDir)
}

function unregisterTempDir(filePath: string): void {
  tempDirsByFile.delete(normalizeFilePath(filePath))
}

/** 从临时目录重新读取当前文档状态（assets 等可能已被资源类 handler 修改） */
function readDocumentFromTempDir(tempDir: string): MdxDocument {
  const mdxJsonPath = path.join(tempDir, 'mdx.json')
  const raw = JSON.parse(fs.readFileSync(mdxJsonPath, 'utf-8'))
  const contentPath = path.join(tempDir, raw.content_file || 'content.md')
  const content = fs.readFileSync(contentPath, 'utf-8')
  return {
    metadata: {
      version: raw.version,
      created_at: raw.created_at,
      modified_at: raw.modified_at,
      author: raw.author,
      title: raw.title,
      encoding: raw.encoding || 'UTF-8',
      content_file: raw.content_file || 'content.md'
    },
    content,
    assets: raw.assets || { images: [] },
    settings: raw.settings || {}
  }
}

/** 将更新后的 mdx.json 写回临时目录 */
function writeMdxJsonToTempDir(tempDir: string, document: MdxDocument): void {
  const mdxJson = toMdxJson(document)
  const mdxJsonPath = path.join(tempDir, 'mdx.json')
  fs.writeFileSync(mdxJsonPath, JSON.stringify(mdxJson, null, 2), 'utf-8')
}

/**
 * 注册 MDX 操作 IPC handlers
 */
export function registerMdxHandlers(): void {
  // 渲染进程完成所有标签页的保存确认后，允许窗口继续关闭。
  ipcMain.handle(IPC_CHANNELS.APP.CLOSE_CONFIRMED, () => {
    clearRecoveryData()
    setCloseConfirmed(true)
    const window = BrowserWindow.getFocusedWindow()
    if (window) window.close()
    return { success: true }
  })

  // ─── 新建文件 ───
  ipcMain.handle(IPC_CHANNELS.FILE.NEW, async () => {
    try {
      const document = createMdxDocument('未命名文档', '')
      const tempDir = createTempDirForFile(`__unsaved_${Date.now()}.mdx`)
      writeMdxJsonToTempDir(tempDir, document)
      fs.mkdirSync(path.join(tempDir, 'assets', 'images'), { recursive: true })
      return {
        success: true,
        data: { document, isNew: true, tempDir }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // ─── 打开文件 ───
  ipcMain.handle(IPC_CHANNELS.FILE.OPEN, async (_, filePath?: string, addToRecent: boolean = true) => {
    try {
      let targetPath = filePath

      if (!targetPath) {
        const { dialog } = await import('electron')
        const window = BrowserWindow.getFocusedWindow()
        const result = await dialog.showOpenDialog(window!, {
          properties: ['openFile'],
          filters: [
            { name: 'Inkase 文档', extensions: ['mdx'] },
            { name: 'Markdown 文件', extensions: ['md'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: '用户取消' }
        }
        targetPath = result.filePaths[0]
      }

      const isMdx = path.extname(targetPath).toLowerCase() === '.mdx'
      const imageMime = getImageMimeType(targetPath)
      const isPdf = path.extname(targetPath).toLowerCase() === '.pdf'

      const MAX_FILE_SIZE = 500 * 1024 * 1024
      const WARN_FILE_SIZE = 50 * 1024 * 1024
      const fileSize = fs.statSync(targetPath).size
      if (fileSize > MAX_FILE_SIZE) {
        return { success: false, error: '文件过大（超过 500 MB），无法打开' }
      }
      const largeFileWarning = fileSize > WARN_FILE_SIZE

      if (isMdx) {
        const result = openMdx(targetPath)
        if (!result.success || !result.data) return result

        const { document, tempDir } = result.data
        registerTempDir(targetPath, tempDir)
        if (addToRecent) addRecent(targetPath)

        return {
          success: true,
          data: { document, filePath: targetPath, format: 'mdx', isNew: false, largeFileWarning }
        }
      }

      // PDF 文件：以 base64 形式返回，由渲染进程只读查看
      if (isPdf) {
        const buf = fs.readFileSync(targetPath)
        if (buf.subarray(0, 5).toString('ascii') !== '%PDF-') {
          return { success: false, error: '无效的 PDF 文件（缺少 %PDF 头）' }
        }
        const document = createMdxDocument(path.basename(targetPath, path.extname(targetPath)), '')
        if (addToRecent) addRecent(targetPath)
        return {
          success: true,
          data: { document, filePath: targetPath, format: 'pdf', isNew: false, largeFileWarning, pdfBase64: buf.toString('base64') }
        }
      }

      // 图片文件：以 Data URL 形式返回，由渲染进程只读查看
      if (imageMime) {
        const buf = fs.readFileSync(targetPath)
        const imageDataUrl = `data:${imageMime};base64,${buf.toString('base64')}`
        const document = createMdxDocument(path.basename(targetPath, path.extname(targetPath)), '')
        if (addToRecent) addRecent(targetPath)
        return {
          success: true,
          data: { document, filePath: targetPath, format: 'image', isNew: false, largeFileWarning, imageDataUrl }
        }
      }

      // 其余（.md 与任意文本文件，如冲突文件 .gitignore）按纯文本打开
      const buf = fs.readFileSync(targetPath)
      if (buf.includes(0)) {
        return { success: false, error: '二进制文件无法在编辑器中打开' }
      }
      const content = buf.toString('utf-8')
      const document = createMdxDocument(path.basename(targetPath, path.extname(targetPath)), content)
      if (addToRecent) addRecent(targetPath)
      return {
        success: true,
        data: { document, filePath: targetPath, format: 'markdown', isNew: false, largeFileWarning }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // ─── 保存文件 ───
  ipcMain.handle(
    IPC_CHANNELS.FILE.SAVE,
    async (_, content: string, title?: string, filePath?: string, addToRecent: boolean = true) => {
      try {
      if (!filePath) return { success: false, error: 'NEW_FILE' }

      const isMdx = path.extname(filePath).toLowerCase() === '.mdx'
      if (!isMdx) {
        fs.writeFileSync(filePath, content, 'utf-8')
        if (addToRecent) addRecent(filePath)
        return { success: true, data: filePath }
      }

        const normalized = normalizeFilePath(filePath)
        const tempDir = tempDirsByFile.get(normalized)
        if (!tempDir) return { success: false, error: '找不到文件的临时目录' }

        const document = readDocumentFromTempDir(tempDir)
        document.content = content
        if (title) document.metadata.title = title

        const { prepareAssetsData } = await import('../mdx/writer')
        const assetsData = prepareAssetsData(tempDir, document)

        const result = await saveMdx(filePath, document, assetsData)
        if (result.success) {
          // 将更新后的文档写回临时目录（保持与磁盘一致）
          writeMdxJsonToTempDir(tempDir, document)
          fs.writeFileSync(path.join(tempDir, document.metadata.content_file), content, 'utf-8')
          if (addToRecent) addRecent(filePath)
        }

        return result
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: errorMessage }
      }
    }
  )

  // ─── 另存为 ───
  ipcMain.handle(
    IPC_CHANNELS.FILE.SAVE_AS,
    async (_, content?: string, title?: string, sourcePath?: string, addToRecent: boolean = true) => {
      try {
        const { dialog } = await import('electron')
        const window = BrowserWindow.getFocusedWindow()
        const sourceExtension = sourcePath && path.extname(sourcePath).toLowerCase() === '.md' ? '.md' : '.mdx'
        const defaultName = (title || path.basename(sourcePath || '', path.extname(sourcePath || '')) || '未命名文档') + sourceExtension
        const result = await dialog.showSaveDialog(window!, {
          defaultPath: defaultName,
          filters: [
            { name: 'Inkase 文档', extensions: ['mdx'] },
            { name: 'Markdown 文件', extensions: ['md'] }
          ]
        })

        if (result.canceled || !result.filePath) {
          return { success: false, error: '用户取消' }
        }
        let targetPath = result.filePath

        const targetIsMarkdown = path.extname(targetPath).toLowerCase() === '.md'
        if (!targetIsMarkdown && !targetPath.toLowerCase().endsWith('.mdx')) targetPath += '.mdx'

        const validation = targetIsMarkdown
          ? { valid: !/[<>:"|?*]/.test(path.basename(targetPath)), error: '文件名包含非法字符' }
          : validateFilePath(targetPath)
        if (!validation.valid) return { success: false, error: validation.error }

        let document: MdxDocument
        let assetsData: Map<string, Buffer> | undefined

        if (sourcePath) {
          const normalized = normalizeFilePath(sourcePath)
          const sourceTempDir = tempDirsByFile.get(normalized)
          if (sourceTempDir) {
            document = readDocumentFromTempDir(sourceTempDir)
            document.content = content || document.content
            if (title) document.metadata.title = title
            const { prepareAssetsData } = await import('../mdx/writer')
            assetsData = prepareAssetsData(sourceTempDir, document)
          } else {
            document = createMdxDocument(title || path.basename(sourcePath, '.mdx'), content || '')
          }
        } else {
          document = createMdxDocument(title || '未命名文档', content || '')
        }

        if (targetIsMarkdown) {
          fs.writeFileSync(targetPath, document.content, 'utf-8')
          if (addToRecent) addRecent(targetPath)
          return { success: true, data: targetPath }
        }

        const saveResult = await saveMdx(targetPath, document, assetsData)
        if (saveResult.success) {
          const { tempDir } = (await openMdx(targetPath)).data!
          registerTempDir(targetPath, tempDir)
          if (addToRecent) addRecent(targetPath)
        }

        return saveResult.success ? { ...saveResult, data: targetPath } : saveResult
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: errorMessage }
      }
    }
  )

  // ─── 关闭文件 ───
  ipcMain.handle(IPC_CHANNELS.FILE.CLOSE, async (_, filePath?: string) => {
    try {
      if (filePath) {
        const normalized = normalizeFilePath(filePath)
        const tempDir = tempDirsByFile.get(normalized)
        if (tempDir) {
          cleanupTempDir(tempDir)
          unregisterTempDir(filePath)
        }
      }
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // ─── MDX 读取（供前端直接调用） ───
  ipcMain.handle(IPC_CHANNELS.MDX.READ, async (_, filePath: string) => {
    return openMdx(filePath)
  })

  // ─── MDX 写入（供前端直接调用） ───
  ipcMain.handle(IPC_CHANNELS.MDX.WRITE, async (_, filePath: string, document: MdxDocument) => {
    return saveMdx(filePath, document)
  })

  // ─── 批量导入文件夹 ───
  ipcMain.handle(
    IPC_CHANNELS.MDX.IMPORT_FOLDER,
    async (_, sourceFolder?: string, targetFolder?: string) => {
      try {
        let sourceDir = sourceFolder
        let targetDir = targetFolder

        if (!sourceDir) {
          const { dialog } = await import('electron')
          const window = BrowserWindow.getFocusedWindow()
          const result = await dialog.showOpenDialog(window!, {
            properties: ['openDirectory'],
            title: '选择要导入的 Markdown 文件夹'
          })
          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: '用户取消' }
          }
          sourceDir = result.filePaths[0]
        }

        if (!targetDir) {
          const { dialog } = await import('electron')
          const window = BrowserWindow.getFocusedWindow()
          const result = await dialog.showOpenDialog(window!, {
            properties: ['openDirectory'],
            title: '选择保存 .mdx 文件的目标文件夹'
          })
          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: '用户取消' }
          }
          targetDir = result.filePaths[0]
        }

        function findMarkdownFiles(
          dir: string,
          baseDir: string
        ): Array<{ relativePath: string; fullPath: string }> {
          const results: Array<{ relativePath: string; fullPath: string }> = []
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              results.push(...findMarkdownFiles(fullPath, baseDir))
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
              results.push({ relativePath: path.relative(baseDir, fullPath), fullPath })
            }
          }
          return results
        }

        const mdFiles = findMarkdownFiles(sourceDir, sourceDir)
        if (mdFiles.length === 0) {
          return { success: false, error: '所选文件夹中没有找到 Markdown 文件' }
        }

        const imported: Array<{ source: string; target: string }> = []
        const failed: Array<{ source: string; error: string }> = []

        for (const { relativePath, fullPath } of mdFiles) {
          const relativeDir = path.dirname(relativePath)
          const baseName = path.basename(relativePath, '.md')
          const targetSubDir = path.join(targetDir, relativeDir)
          let targetFilePath = path.join(targetSubDir, `${baseName}.mdx`)
          fs.mkdirSync(targetSubDir, { recursive: true })

          if (fs.existsSync(targetFilePath)) {
            let counter = 1
            while (fs.existsSync(path.join(targetSubDir, `${baseName}_${counter}.mdx`))) {
              counter++
            }
            targetFilePath = path.join(targetSubDir, `${baseName}_${counter}.mdx`)
          }

          const importResult = await importAndSaveAsMdx(targetFilePath, fullPath)
          if (importResult.success) {
            imported.push({ source: fullPath, target: targetFilePath })
          } else {
            failed.push({ source: fullPath, error: importResult.error || '导入失败' })
          }
        }

        return { success: true, data: { imported, failed, sourceDir, targetDir } }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: `批量导入失败: ${errorMessage}` }
      }
    }
  )

  // ─── 导入 Word 文档 ───
  ipcMain.handle(
    IPC_CHANNELS.MDX.IMPORT_DOCX,
    async (_, docxFilePath?: string, targetFolder?: string) => {
      try {
        let sourcePath = docxFilePath

        if (!sourcePath) {
          const { dialog } = await import('electron')
          const window = BrowserWindow.getFocusedWindow()
          const result = await dialog.showOpenDialog(window!, {
            properties: ['openFile'],
            filters: [{ name: 'Word 文档 (*.docx)', extensions: ['docx'] }]
          })
          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: '用户取消' }
          }
          sourcePath = result.filePaths[0]
        }

        if (path.extname(sourcePath!).toLowerCase() !== '.docx') {
          return { success: false, error: '仅支持 .docx 格式（旧版 .doc 请先用 Word 另存为 .docx）' }
        }

        let savePath: string

        if (targetFolder) {
          const baseName = path.basename(sourcePath!, path.extname(sourcePath!))
          let candidatePath = path.join(targetFolder, `${baseName}.mdx`)
          if (fs.existsSync(candidatePath)) {
            let counter = 1
            while (fs.existsSync(path.join(targetFolder, `${baseName}_${counter}.mdx`))) counter++
            candidatePath = path.join(targetFolder, `${baseName}_${counter}.mdx`)
          }
          savePath = candidatePath
        } else {
          const { dialog } = await import('electron')
          const window = BrowserWindow.getFocusedWindow()
          const defaultName =
            sourcePath!.split(/[/\\]/).pop()?.replace(/\.docx$/i, '.mdx') || '未命名文档.mdx'
          const result = await dialog.showSaveDialog(window!, {
            defaultPath: defaultName,
            filters: [{ name: 'Inkase 文档', extensions: ['mdx'] }]
          })
          if (result.canceled || !result.filePath) {
            return { success: false, error: '用户取消' }
          }
          savePath = result.filePath
        }

        if (!savePath.toLowerCase().endsWith('.mdx')) savePath += '.mdx'

        const { importDocxAndSaveAsMdx } = await import('../mdx/docx-import')
        const importResult = await importDocxAndSaveAsMdx(savePath, sourcePath!)

        if (importResult.success && importResult.data) {
          registerTempDir(savePath, importResult.data.tempDir)
          addRecent(savePath)
          return {
            success: true,
            data: { document: importResult.data.document, filePath: savePath }
          }
        }

        return importResult
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: errorMessage }
      }
    }
  )

  // ─── 导入 Markdown ───
  ipcMain.handle(
    IPC_CHANNELS.MDX.IMPORT_MD,
    async (_, mdFilePath?: string, targetFolder?: string) => {
      try {
        let sourcePath = mdFilePath

        if (!sourcePath) {
          const { dialog } = await import('electron')
          const window = BrowserWindow.getFocusedWindow()
          const result = await dialog.showOpenDialog(window!, {
            properties: ['openFile'],
            filters: [
              { name: 'Markdown 文件', extensions: ['md'] },
              { name: '所有文件', extensions: ['*'] }
            ]
          })
          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: '用户取消' }
          }
          sourcePath = result.filePaths[0]
        }

        let savePath: string

        if (targetFolder) {
          const baseName = path.basename(sourcePath!, '.md')
          let candidatePath = path.join(targetFolder, `${baseName}.mdx`)
          if (fs.existsSync(candidatePath)) {
            let counter = 1
            while (fs.existsSync(path.join(targetFolder, `${baseName}_${counter}.mdx`))) counter++
            candidatePath = path.join(targetFolder, `${baseName}_${counter}.mdx`)
          }
          savePath = candidatePath
        } else {
          const { dialog } = await import('electron')
          const window = BrowserWindow.getFocusedWindow()
          const defaultName =
            sourcePath!.split(/[/\\]/).pop()?.replace('.md', '.mdx') || '未命名文档.mdx'
          const result = await dialog.showSaveDialog(window!, {
            defaultPath: defaultName,
            filters: [{ name: 'Inkase 文档', extensions: ['mdx'] }]
          })
          if (result.canceled || !result.filePath) {
            return { success: false, error: '用户取消' }
          }
          savePath = result.filePath
        }

        if (!savePath.toLowerCase().endsWith('.mdx')) savePath += '.mdx'

        const importResult = await importAndSaveAsMdx(savePath, sourcePath)

        if (importResult.success && importResult.data) {
          registerTempDir(savePath, importResult.data.tempDir)
          addRecent(savePath)
          return {
            success: true,
            data: { document: importResult.data.document, filePath: savePath }
          }
        }

        return importResult
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: errorMessage }
      }
    }
  )

  // ─── 导出为 Markdown ───
  ipcMain.handle(
    IPC_CHANNELS.MDX.EXPORT_MD,
    async (_, mdxFilePath: string, outputDir?: string) => {
      try {
        let targetDir = outputDir
        if (!targetDir) {
          const { dialog } = await import('electron')
          const window = BrowserWindow.getFocusedWindow()
          const result = await dialog.showOpenDialog(window!, {
            properties: ['openDirectory'],
            title: '选择导出目录'
          })
          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: '用户取消' }
          }
          targetDir = result.filePaths[0]
        }
        return await exportMdxFile(mdxFilePath, targetDir)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: errorMessage }
      }
    }
  )

  // ─── 添加图片资源 ───
  ipcMain.handle(
    IPC_CHANNELS.MDX.ADD_IMAGE,
    async (
      _,
      filename: string,
      mimeType: string,
      data: ArrayBuffer,
      options?: { compress?: boolean; quality?: number; maxWidth?: number; maxHeight?: number },
      filePath?: string
    ) => {
      try {
        if (!filePath) {
          return { success: false, error: '请先保存文件后再添加图片' }
        }

        const normalized = normalizeFilePath(filePath)
        const isMarkdown = path.extname(filePath).toLowerCase() === '.md'
        const tempDir = tempDirsByFile.get(normalized)

        if (!tempDir && !isMarkdown) {
          return { success: false, error: '找不到文件的临时目录' }
        }

        let buffer: Buffer = Buffer.from(data)

        if (options?.compress) {
          try {
            const sharp = await import('sharp')
            let sharpInstance = sharp.default(buffer)
            if (options.maxWidth || options.maxHeight) {
              sharpInstance = sharpInstance.resize(options.maxWidth, options.maxHeight, {
                fit: 'inside',
                withoutEnlargement: true
              })
            }
            const quality = options.quality ?? 85
            if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
              buffer = await sharpInstance.jpeg({ quality }).toBuffer()
            } else if (mimeType === 'image/png') {
              buffer = await sharpInstance.png({ quality }).toBuffer()
            } else if (mimeType === 'image/webp') {
              buffer = await sharpInstance.webp({ quality }).toBuffer()
            }
          } catch {
            console.warn('图片压缩失败，使用原始数据')
          }
        }

        const safeFilename =
          path.basename(filename).replace(/[<>:"|?*]/g, '_') || `image-${Date.now()}.png`

        const markdownPath =
          filePath && isMarkdown ? filePath : null
        const assetsDir = markdownPath
          ? path.join(
              path.dirname(markdownPath),
              `${path.basename(markdownPath, path.extname(markdownPath))}.assets`
            )
          : null

        let markdownFilename = safeFilename
        if (assetsDir) {
          const extension = path.extname(safeFilename)
          const baseName = path.basename(safeFilename, extension)
          let counter = 1
          while (fs.existsSync(path.join(assetsDir, markdownFilename))) {
            markdownFilename = `${baseName}-${counter++}${extension}`
          }
        }

        if (assetsDir) {
          fs.mkdirSync(assetsDir, { recursive: true })
          const imagePath = path.join(assetsDir, markdownFilename)
          fs.writeFileSync(imagePath, buffer)
          const relativePath = path.relative(path.dirname(markdownPath!), imagePath).replace(/\\/g, '/')
          return { success: true, data: { relativePath } }
        }

        // MDX: 从临时目录读取文档，添加资源，写回
        const document = readDocumentFromTempDir(tempDir!)
        const { addImageAsset } = await import('../mdx/writer')
        const result = addImageAsset(document, safeFilename, mimeType, buffer)

        const imagePath = path.join(tempDir!, result.relativePath)
        fs.mkdirSync(path.dirname(imagePath), { recursive: true })
        fs.writeFileSync(imagePath, buffer)

        writeMdxJsonToTempDir(tempDir!, document)

        return { success: true, data: { asset: result.asset, relativePath: result.asset.path } }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: errorMessage }
      }
    }
  )

  // ─── 获取图片数据 ───
  ipcMain.handle(
    IPC_CHANNELS.MDX.GET_IMAGE,
    async (_, imagePath: string, filePath?: string) => {
      try {
        if (!filePath) return { success: false, error: '未指定文件路径' }

        const isMarkdown = path.extname(filePath).toLowerCase() === '.md'
        const normalized = normalizeFilePath(filePath)
        const tempDir = tempDirsByFile.get(normalized)
        const baseDir = path.dirname(filePath)

        if (!tempDir && !isMarkdown) {
          return { success: false, error: '找不到文件的临时目录' }
        }

        const fullPath = isMarkdown
          ? path.resolve(baseDir, imagePath)
          : path.join(tempDir!, imagePath)

        if (!fs.existsSync(fullPath)) {
          return { success: false, error: '图片不存在' }
        }

        const fileData = fs.readFileSync(fullPath)
        const ext = path.extname(fullPath).toLowerCase()
        const mimeTypeMap: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp',
          '.ico': 'image/x-icon'
        }
        return {
          success: true,
          data: { buffer: fileData, mimeType: mimeTypeMap[ext] || 'image/png' }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: errorMessage }
      }
    }
  )

  // ─── 添加附件资源 ───
  ipcMain.handle(
    IPC_CHANNELS.MDX.ADD_ATTACHMENT,
    async (_, filename: string, mimeType: string, data: ArrayBuffer, filePath?: string) => {
      try {
        if (!filePath) return { success: false, error: '请先保存文件后再添加附件' }

        const normalized = normalizeFilePath(filePath)
        const tempDir = tempDirsByFile.get(normalized)
        if (!tempDir) return { success: false, error: '找不到文件的临时目录' }

        const buffer = Buffer.from(data)
        const document = readDocumentFromTempDir(tempDir)
        const { addAttachmentAsset } = await import('../mdx/writer')
        const result = addAttachmentAsset(document, filename, mimeType, buffer)

        const fullPath = path.join(tempDir, result.relativePath)
        fs.mkdirSync(path.dirname(fullPath), { recursive: true })
        fs.writeFileSync(fullPath, buffer)

        writeMdxJsonToTempDir(tempDir, document)

        return { success: true, data: { asset: result.asset, relativePath: result.relativePath } }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: errorMessage }
      }
    }
  )

  // ─── 获取附件数据 ───
  ipcMain.handle(IPC_CHANNELS.MDX.GET_ATTACHMENT, async (_, attachmentPath: string, filePath?: string) => {
    try {
      if (!filePath) return { success: false, error: '未指定文件路径' }

      const normalized = normalizeFilePath(filePath)
      const tempDir = tempDirsByFile.get(normalized)
      if (!tempDir) return { success: false, error: '找不到文件的临时目录' }

      const fullPath = path.join(tempDir, attachmentPath)
      if (!fs.existsSync(fullPath)) return { success: false, error: '附件不存在' }

      const fileData = fs.readFileSync(fullPath)
      const ext = path.extname(fullPath).toLowerCase()
      const mimeTypeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json',
        '.zip': 'application/zip'
      }

      return {
        success: true,
        data: { buffer: fileData, mimeType: mimeTypeMap[ext] || 'application/octet-stream' }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // ─── 删除资源 ───
  ipcMain.handle(IPC_CHANNELS.MDX.REMOVE_ASSET, async (_, assetId: string, filePath?: string) => {
    try {
      if (!filePath) return { success: false, error: '未指定文件路径' }

      const normalized = normalizeFilePath(filePath)
      const tempDir = tempDirsByFile.get(normalized)
      if (!tempDir) return { success: false, error: '找不到文件的临时目录' }

      const document = readDocumentFromTempDir(tempDir)
      const { removeAsset } = await import('../mdx/writer')
      const asset = [...document.assets.images, ...(document.assets.attachments || [])]
        .find((item) => item.id === assetId)
      const removed = removeAsset(document, assetId)

      if (removed) {
        if (asset) {
          const assetPath = path.resolve(tempDir, asset.path)
          const relativeAssetPath = path.relative(tempDir, assetPath)
          if (relativeAssetPath && !relativeAssetPath.startsWith('..') && !path.isAbsolute(relativeAssetPath)) {
            if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath)
          }
        }
        writeMdxJsonToTempDir(tempDir, document)
        return { success: true }
      }
      return { success: false, error: '资源不存在' }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // ─── 列出所有资源 ───
  ipcMain.handle(IPC_CHANNELS.MDX.LIST_ASSETS, async (_, filePath?: string) => {
    try {
      if (!filePath) return { success: false, error: '未指定文件路径' }

      const normalized = normalizeFilePath(filePath)
      const tempDir = tempDirsByFile.get(normalized)
      if (!tempDir) return { success: false, error: '找不到文件的临时目录' }

      const document = readDocumentFromTempDir(tempDir)
      return {
        success: true,
        data: {
          images: document.assets.images,
          attachments: document.assets.attachments || [],
          all: [...document.assets.images, ...(document.assets.attachments || [])]
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.MDX.RESTORE_RECOVERY_ASSETS,
    async (_, filePath: string, document: MdxDocument, assetData: Record<string, string>) => {
      try {
        const tempDir = tempDirsByFile.get(normalizeFilePath(filePath))
        if (!tempDir) return { success: false, error: '找不到文件的临时目录' }
        for (const [assetPath, base64] of Object.entries(assetData)) {
          const fullPath = path.resolve(tempDir, assetPath)
          const relativePath = path.relative(tempDir, fullPath)
          if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) continue
          fs.mkdirSync(path.dirname(fullPath), { recursive: true })
          fs.writeFileSync(fullPath, Buffer.from(base64, 'base64'))
        }
        writeMdxJsonToTempDir(tempDir, document)
        fs.writeFileSync(path.join(tempDir, document.metadata.content_file), document.content, 'utf-8')
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : '恢复资源失败' }
      }
    }
  )
}

// ─── 窗口关闭 ───

let closeConfirmed = false

export function setCloseConfirmed(value: boolean): void {
  closeConfirmed = value
}

export function isCloseConfirmed(): boolean {
  return closeConfirmed
}

/**
 * 清理所有临时资源
 */
export function cleanupAll(): void {
  cleanupAllTempDirs()
  tempDirsByFile.clear()
}
