/**
 * 文件操作 IPC Handlers
 *
 * 处理文件对话框、最近文件列表等操作
 */

import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC_CHANNELS } from './channels'
import { readClipboardFilePaths, writeClipboardFilePaths, type ClipboardMode } from '../clipboard/file-clipboard'
import { dedupeTopLevelPaths } from '../../shared/fs/dedupe'

/** 最近文件列表上限 */
const MAX_RECENT_FILES = 20

/** 最近文件列表项类型 */
export type RecentItemType = 'file' | 'folder'

/** 最近文件列表项 */
export interface RecentItem {
  path: string
  type: RecentItemType
}

/** 最近文件列表持久化文件路径 */
function getRecentFilesPath(): string {
  return path.join(app.getPath('userData'), 'recent-files.json')
}

const CJK_NUM: Record<string, number> = {
  '〇': 0, '零': 0,
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
}

function compareEntryNames(a: string, b: string): number {
  const aL = a.toLowerCase()
  const bL = b.toLowerCase()
  let i = 0, j = 0
  while (i < aL.length && j < bL.length) {
    const aD = aL[i] >= '0' && aL[i] <= '9'
    const bD = bL[j] >= '0' && bL[j] <= '9'
    if (aD && bD) {
      let an = 0
      while (i < aL.length && aL[i] >= '0' && aL[i] <= '9') an = an * 10 + +aL[i++]
      let bn = 0
      while (j < bL.length && bL[j] >= '0' && bL[j] <= '9') bn = bn * 10 + +bL[j++]
      if (an !== bn) return an - bn
    } else if (aD) return -1
    else if (bD) return 1
    else {
      const aN = CJK_NUM[aL[i]]
      const bN = CJK_NUM[bL[j]]
      if (aN !== undefined && bN !== undefined) {
        if (aN !== bN) return aN - bN
      } else if (aN !== undefined) return -1
      else if (bN !== undefined) return 1
      else if (aL[i] !== bL[j]) return aL[i] < bL[j] ? -1 : 1
      i++
      j++
    }
  }
  if (i < aL.length) return 1
  if (j < bL.length) return -1
  return 0
}

function compareFolderEntries(
  a: { name: string; isDirectory: boolean },
  b: { name: string; isDirectory: boolean }
): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  return compareEntryNames(a.name, b.name)
}

/**
 * 在目录中递归搜索文件名
 */
function searchFileInDir(dir: string, fileName: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = searchFileInDir(fullPath, fileName)
        if (found) return found
      } else if (entry.isFile() && entry.name === fileName) {
        return fullPath
      }
    }
  } catch {
    // 跳过无权限目录
  }
  return null
}

/**
 * 从磁盘读取最近文件列表（兼容旧版 string[] 数据，视为文件类型）
 */
function loadRecentFilesFromDisk(): RecentItem[] {
  try {
    const filePath = getRecentFilesPath()
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8')
      const raw = JSON.parse(data)
      if (!Array.isArray(raw)) return []
      const items: RecentItem[] = raw
        .map((entry): RecentItem | null => {
          if (typeof entry === 'string') return { path: entry, type: 'file' }
          if (entry && typeof entry.path === 'string') {
            return { path: entry.path, type: entry.type === 'folder' ? 'folder' : 'file' }
          }
          return null
        })
        .filter((item): item is RecentItem => item !== null)
      // 过滤掉已不存在的文件或文件夹
      return items.filter((item) => fs.existsSync(item.path))
    }
  } catch {
    // 读取失败返回空列表
  }
  return []
}

/**
 * 将最近文件列表写入磁盘
 */
function saveRecentFilesToDisk(files: RecentItem[]): void {
  try {
    const filePath = getRecentFilesPath()
    fs.writeFileSync(filePath, JSON.stringify(files, null, 2), 'utf-8')
  } catch {
    // 写入失败忽略
  }
}

/**
 * 获取最近文件列表
 */
function getRecentFiles(): RecentItem[] {
  return loadRecentFilesFromDisk()
}

/**
 * 添加文件/文件夹到最近列表
 * 每次写前从磁盘重读最新列表，避免多实例并发覆盖
 */
export function addRecentFile(filePath: string, type: RecentItemType = 'file'): void {
  // 规范化路径
  const normalized = path.resolve(filePath)
  // 重读磁盘，移除已存在的相同路径
  let items = loadRecentFilesFromDisk().filter((p) => p.path !== normalized)
  // 添加到开头
  items.unshift({ path: normalized, type })
  // 限制数量
  if (items.length > MAX_RECENT_FILES) {
    items = items.slice(0, MAX_RECENT_FILES)
  }
  // 持久化
  saveRecentFilesToDisk(items)
}

/**
 * 从最近列表中移除文件
 */
function removeRecentFile(filePath: string): void {
  const normalized = path.resolve(filePath)
  const items = loadRecentFilesFromDisk().filter((p) => p.path !== normalized)
  saveRecentFilesToDisk(items)
}

/**
 * 清空最近文件列表
 */
function clearRecentFiles(): void {
  saveRecentFilesToDisk([])
}

type ConflictAction = 'skip' | 'overwrite' | 'keep'

/** 生成目标目录下不冲突的路径：重名时追加 (1)、(2)… */
function uniqueTargetPath(targetDir: string, baseName: string, isDirectory: boolean): string {
  const ext = isDirectory ? '' : path.extname(baseName)
  const stem = isDirectory ? baseName : path.basename(baseName, ext)
  let candidate = path.join(targetDir, baseName)
  let i = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(targetDir, `${stem} (${i})${ext}`)
    i++
  }
  return candidate
}

function hasTargetConflict(targetDir: string, baseName: string): boolean {
  return fs.existsSync(path.join(targetDir, baseName))
}

function removeTarget(targetPath: string): void {
  const stat = fs.statSync(targetPath)
  fs.rmSync(targetPath, { recursive: stat.isDirectory(), force: true })
}

function copyOrMovePath(source: string, target: string, mode: ClipboardMode, sourceIsDirectory: boolean): void {
  if (mode === 'copy') {
    fs.cpSync(source, target, { recursive: sourceIsDirectory })
    return
  }
  try {
    fs.renameSync(source, target)
  } catch (renameError) {
    if ((renameError as NodeJS.ErrnoException)?.code !== 'EXDEV') throw renameError
    fs.cpSync(source, target, { recursive: sourceIsDirectory })
    if (sourceIsDirectory) fs.rmSync(source, { recursive: true, force: true })
    else fs.unlinkSync(source)
  }
}

/**
 * 注册文件操作 IPC handlers
 */
export function registerFileHandlers(): void {
  // 显示打开文件对话框
  ipcMain.handle(IPC_CHANNELS.DIALOG.SHOW_OPEN, async (_, options) => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) {
      return { success: false, error: '没有活动的窗口' }
    }

    const defaultOptions = {
      properties: ['openFile'],
      filters: [
        { name: 'Inkase 文档', extensions: ['mdx'] },
        { name: 'Markdown 文件', extensions: ['md'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }

    const result = await dialog.showOpenDialog(window, { ...defaultOptions, ...(options || {}) })

    if (result.canceled) {
      return { success: false, error: '用户取消' }
    }

    return {
      success: true,
      data: result.filePaths
    }
  })

  // 显示保存文件对话框
  ipcMain.handle(IPC_CHANNELS.DIALOG.SHOW_SAVE, async (_, options) => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) {
      return { success: false, error: '没有活动的窗口' }
    }

    const defaultOptions = {
      filters: [
        { name: 'Inkase 文档', extensions: ['mdx'] },
        { name: 'Markdown 文件', extensions: ['md'] }
      ]
    }

    const result = await dialog.showSaveDialog(window, { ...defaultOptions, ...(options || {}) })

    if (result.canceled) {
      return { success: false, error: '用户取消' }
    }

    return {
      success: true,
      data: result.filePath
    }
  })

  // 显示消息对话框
  ipcMain.handle(IPC_CHANNELS.DIALOG.SHOW_MESSAGE, async (_, options) => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) {
      return { success: false, error: '没有活动的窗口' }
    }

    const result = await dialog.showMessageBox(window, options || {})

    return {
      success: true,
      data: result.response
    }
  })

  // 获取最近文件列表
  ipcMain.handle(IPC_CHANNELS.FILE.RECENT, async () => {
    try {
      const recentFiles = getRecentFiles()
      return {
        success: true,
        data: recentFiles
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 添加到最近文件
  ipcMain.handle(IPC_CHANNELS.FILE.RECENT_ADD, async (_, filePath: string, type?: RecentItemType) => {
    try {
      addRecentFile(filePath, type)
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 从最近文件中移除
  ipcMain.handle(IPC_CHANNELS.FILE.RECENT_REMOVE, async (_, filePath: string) => {
    try {
      removeRecentFile(filePath)
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 清空最近文件列表
  ipcMain.handle(IPC_CHANNELS.FILE.RECENT_CLEAR, async () => {
    try {
      clearRecentFiles()
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 读取文件夹内容
  ipcMain.handle(IPC_CHANNELS.FOLDER.READ, async (_, dirPath: string) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      const items: Array<{ name: string; path: string; isDirectory: boolean }> = []

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) {
          items.push({ name: entry.name, path: fullPath, isDirectory: true })
        } else if (entry.isFile()) {
          items.push({ name: entry.name, path: fullPath, isDirectory: false })
        }
      }

      // 排序：文件夹在前，文件在后，各自按名称升序（不区分大小写，数字按数值）
      items.sort(compareFolderEntries)

      return { success: true, data: items }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 创建新文件
  ipcMain.handle(IPC_CHANNELS.FILE.CREATE, async (_, { dirPath, name }: { dirPath: string; name: string }) => {
    try {
      const fullPath = path.join(dirPath, name)
      if (fs.existsSync(fullPath)) {
        return { success: false, error: '文件已存在' }
      }
      const ext = path.extname(fullPath).toLowerCase()
      if (ext === '.mdx') {
        // 创建空的 .mdx 文件（简单的 ZIP 结构）
        const AdmZip = await import('adm-zip')
        const zip = new AdmZip.default()
        const mdxJson = JSON.stringify({
          version: '1.0',
          created_at: new Date().toISOString(),
          modified_at: new Date().toISOString(),
          title: name.replace(/\.mdx$/i, ''),
          encoding: 'UTF-8',
          content_file: 'content.md',
          assets: { images: [] },
          settings: { editor_theme: 'default', preview_style: 'github' }
        }, null, 2)
        zip.addFile('mdx.json', Buffer.from(mdxJson, 'utf-8'))
        zip.addFile('content.md', Buffer.from('', 'utf-8'))
        zip.writeZip(fullPath)
      } else {
        // 普通的 .md 文件
        fs.writeFileSync(fullPath, '', 'utf-8')
      }
      return { success: true, data: { path: fullPath } }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 创建新文件夹
  ipcMain.handle(IPC_CHANNELS.FOLDER.CREATE, async (_, { parentPath, name }: { parentPath: string; name: string }) => {
    try {
      const fullPath = path.join(parentPath, name)
      if (fs.existsSync(fullPath)) {
        return { success: false, error: '文件夹已存在' }
      }
      fs.mkdirSync(fullPath, { recursive: true })
      return { success: true, data: { path: fullPath } }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 递归枚举目录下所有文件（跳过点前缀目录），供快速打开面板模糊搜索
  ipcMain.handle(IPC_CHANNELS.FILE.SEARCH, async (_, dirPath: string, limit?: number) => {
    try {
      const maxFiles = typeof limit === 'number' && limit > 0 ? limit : 10000
      const files: Array<{ name: string; path: string }> = []
      const isIgnoredDir = (name: string): boolean => name.startsWith('.') || name === 'node_modules'

      const walk = (dir: string): boolean => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (files.length >= maxFiles) return false
          if (entry.isDirectory() ? isIgnoredDir(entry.name) : entry.name.startsWith('.')) continue
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!walk(fullPath)) return false
          } else if (entry.isFile()) {
            files.push({ name: entry.name, path: fullPath })
          }
        }
        return true
      }

      walk(dirPath)
      return { success: true, data: files }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 在系统文件管理器中打开文件所在位置
  ipcMain.handle(IPC_CHANNELS.FILE.REVEAL_IN_EXPLORER, async (_, filePath: string) => {
    try {
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 重命名文件/文件夹
  ipcMain.handle(IPC_CHANNELS.FILE.RENAME, async (_, { oldPath, newName }: { oldPath: string; newName: string }) => {
    try {
      const dir = path.dirname(oldPath)
      const newPath = path.join(dir, newName)
      if (fs.existsSync(newPath)) {
        // Windows NTFS 不区分大小写：新旧路径仅大小写不同时指向同一路径，允许仅大小写重命名
        if (process.platform === 'win32' && fs.existsSync(oldPath)) {
          const oldReal = path.normalize(fs.realpathSync(oldPath))
          const newReal = path.normalize(fs.realpathSync(newPath))
          if (oldReal.toLowerCase() === newReal.toLowerCase()) {
            fs.renameSync(oldPath, newPath)
            return { success: true, data: { path: newPath } }
          }
        }
        return { success: false, error: '目标已存在' }
      }
      fs.renameSync(oldPath, newPath)
      return { success: true, data: { path: newPath } }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 移动文件/文件夹到其他目录
  ipcMain.handle(IPC_CHANNELS.FILE.MOVE, async (_, { sourcePath, targetDir }: { sourcePath: string; targetDir: string }) => {
    try {
      const sourceStat = fs.statSync(sourcePath)
      const targetDirStat = fs.statSync(targetDir)
      if (!targetDirStat.isDirectory()) {
        return { success: false, error: '目标不是文件夹' }
      }
      const targetPath = path.join(targetDir, path.basename(sourcePath))
      if (fs.existsSync(targetPath)) {
        return { success: false, error: '目标已存在' }
      }
      // 禁止把文件夹移入自身或其子目录
      if (sourceStat.isDirectory()) {
        const normalizedSource = path.resolve(sourcePath).replace(/[\\/]+$/, '')
        const normalizedTarget = path.resolve(targetDir).replace(/[\\/]+$/, '')
        if (normalizedTarget === normalizedSource || normalizedTarget.startsWith(normalizedSource + path.sep)) {
          return { success: false, error: '不能移动到自身或其子目录' }
        }
      }
      try {
        fs.renameSync(sourcePath, targetPath)
      } catch (renameError) {
        // 跨盘符（EXDEV）时回退为复制 + 删除
        if ((renameError as NodeJS.ErrnoException)?.code !== 'EXDEV') throw renameError
        fs.cpSync(sourcePath, targetPath, { recursive: true })
        if (sourceStat.isDirectory()) {
          fs.rmSync(sourcePath, { recursive: true, force: true })
        } else {
          fs.unlinkSync(sourcePath)
        }
      }
      return { success: true, data: { path: targetPath } }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 删除文件/文件夹
  ipcMain.handle(IPC_CHANNELS.FILE.DELETE, async (_, { targetPath }: { targetPath: string }) => {
    try {
      const stat = fs.statSync(targetPath)
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true })
      } else {
        fs.unlinkSync(targetPath)
      }
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 导入外部文件到指定目录（复制，保留源文件，可多选）
  ipcMain.handle(IPC_CHANNELS.FOLDER.IMPORT_FILES, async (_, targetDir: string, sourcePaths?: string[], conflictAction?: ConflictAction) => {
    try {
      const window = BrowserWindow.getFocusedWindow()
      if (!window) return { success: false, error: '没有活动的窗口' }
      const dialogResult = sourcePaths ? { canceled: false, filePaths: sourcePaths } : await dialog.showOpenDialog(window, {
        title: '选择要导入的文件',
        properties: ['openFile', 'multiSelections']
      })
      if (dialogResult.canceled) {
        return { success: true, data: { imported: [], failed: [], canceled: true } }
      }
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return { success: false, error: '目标不是文件夹' }
      }
      const imported: Array<{ source: string; target: string }> = []
      const failed: Array<{ source: string; error: string }> = []
      const selectedAction = conflictAction
      const conflicts = dialogResult.filePaths.filter((source) => hasTargetConflict(targetDir, path.basename(source)))
      if (conflicts.length > 0 && !selectedAction) {
        return { success: true, data: { imported: [], failed: [], canceled: false, needsResolution: true, sources: dialogResult.filePaths, conflicts: conflicts.map((item) => path.basename(item)) } }
      }
      for (const source of dialogResult.filePaths) {
        try {
          if (fs.statSync(source).isDirectory()) {
            failed.push({ source, error: '不支持导入文件夹' })
            continue
          }
          const baseName = path.basename(source)
          const conflict = hasTargetConflict(targetDir, baseName)
          if (conflict && selectedAction === 'skip') continue
          const target = conflict && selectedAction === 'keep'
            ? uniqueTargetPath(targetDir, baseName, false)
            : path.join(targetDir, baseName)
          if (conflict && selectedAction === 'overwrite') removeTarget(target)
          copyOrMovePath(source, target, 'copy', false)
          imported.push({ source, target })
        } catch (error) {
          failed.push({ source, error: error instanceof Error ? error.message : '未知错误' })
        }
      }
      return { success: true, data: { imported, failed, canceled: false } }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: `导入文件失败: ${errorMessage}` }
    }
  })

  // 导入外部文件夹到指定目录（整个目录复制为其子目录，保留源文件夹）
  ipcMain.handle(IPC_CHANNELS.FOLDER.IMPORT_DIRECTORY, async (_, targetDir: string, sourcePath?: string, conflictAction?: ConflictAction) => {
    try {
      const window = BrowserWindow.getFocusedWindow()
      if (!window) return { success: false, error: '没有活动的窗口' }
      const dialogResult = sourcePath ? { canceled: false, filePaths: [sourcePath] } : await dialog.showOpenDialog(window, {
        title: '选择要导入的文件夹',
        properties: ['openDirectory']
      })
      if (dialogResult.canceled) {
        return { success: true, data: { imported: [], failed: [], canceled: true } }
      }
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return { success: false, error: '目标不是文件夹' }
      }
      const source = dialogResult.filePaths[0]
      if (!source) {
        return { success: true, data: { imported: [], failed: [], canceled: true } }
      }
      // 禁止把目录导入到自身或其子目录内部
      const normalizedSource = path.resolve(source).replace(/[\\/]+$/, '')
      const normalizedTarget = path.resolve(targetDir).replace(/[\\/]+$/, '')
      if (normalizedTarget === normalizedSource || normalizedTarget.startsWith(normalizedSource + path.sep)) {
        return { success: false, error: '不能导入到自身或其子目录' }
      }
      const baseName = path.basename(source)
      const conflict = hasTargetConflict(targetDir, baseName)
      if (conflict && !conflictAction) {
        return { success: true, data: { imported: [], failed: [], canceled: false, needsResolution: true, sources: [source], conflicts: [baseName] } }
      }
      if (conflict && conflictAction === 'skip') {
        return { success: true, data: { imported: [], failed: [], canceled: false } }
      }
      const target = conflict && conflictAction === 'keep'
        ? uniqueTargetPath(targetDir, baseName, true)
        : path.join(targetDir, baseName)
      if (conflict && conflictAction === 'overwrite') removeTarget(target)
      copyOrMovePath(source, target, 'copy', true)
      return { success: true, data: { imported: [{ source, target }], failed: [], canceled: false } }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: `导入文件夹失败: ${errorMessage}` }
    }
  })

  // 读取系统剪贴板中的文件列表
  ipcMain.handle(IPC_CHANNELS.FILE.CLIPBOARD_READ_FILES, async () => {
    try {
      return { success: true, data: await readClipboardFilePaths() }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 将文件列表写入系统剪贴板
  ipcMain.handle(
    IPC_CHANNELS.FILE.CLIPBOARD_WRITE_FILES,
    async (_, { paths, mode }: { paths: string[]; mode: ClipboardMode }) => {
      try {
        await writeClipboardFilePaths(paths, mode)
        return { success: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: errorMessage }
      }
    }
  )

  // 链接打开处理
  ipcMain.handle(IPC_CHANNELS.LINK.OPEN, async (_, { linkHref, currentFilePath, openedFolderPath }: { linkHref: string; currentFilePath?: string; openedFolderPath?: string }) => {
    try {
      if (linkHref.startsWith('#')) {
        return { success: false }
      }

      if (linkHref.startsWith('http://') || linkHref.startsWith('https://')) {
        await shell.openExternal(linkHref)
        return { success: true }
      }

      let resolvedPath: string | null = null

      if (linkHref.startsWith('file://')) {
        resolvedPath = decodeURIComponent(linkHref.replace(/^file:\/\//, ''))
      } else {
        const decodedHref = decodeURIComponent(linkHref)
        const baseDir = currentFilePath
          ? path.dirname(path.resolve(currentFilePath))
          : openedFolderPath
            ? path.resolve(openedFolderPath)
            : null
        if (baseDir) {
          resolvedPath = path.resolve(baseDir, decodedHref)
        } else {
          resolvedPath = path.resolve(decodedHref)
        }
      }

      if (resolvedPath && fs.existsSync(resolvedPath)) {
        return { success: true, data: resolvedPath }
      }

      if (resolvedPath && openedFolderPath) {
        const fileName = path.basename(resolvedPath)
        const foundFile = searchFileInDir(openedFolderPath, fileName)
        if (foundFile) {
          return { success: true, data: foundFile }
        }
      }

      return { success: false, error: `文件不存在: ${linkHref}` }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMessage }
    }
  })

  // 将剪贴板中的文件复制或移动到目标目录
  ipcMain.handle(
    IPC_CHANNELS.FILE.COPY_INTO,
    async (
      _,
      { sources, targetDir, mode, conflictAction }: { sources: string[]; targetDir: string; mode: ClipboardMode; conflictAction?: ConflictAction }
    ) => {
      try {
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
          return { success: false, error: '目标不是文件夹' }
        }
        const normalize = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '')
        const normalizedTarget = normalize(targetDir)
        const items: Array<{ source: string; target: string }> = []
        const failed: Array<{ source: string; error: string }> = []
        const uniqueSources = dedupeTopLevelPaths(sources)
        const selectedAction = conflictAction
        const conflicts = uniqueSources.filter((source) =>
          !(mode === 'cut' && normalize(path.dirname(source)) === normalizedTarget) &&
          hasTargetConflict(targetDir, path.basename(source))
        )
        if (conflicts.length > 0 && !selectedAction) {
          return { success: true, data: { items: [], failed: [], needsResolution: true, sources: uniqueSources, conflicts: conflicts.map((item) => path.basename(item)) } }
        }

        for (const source of uniqueSources) {
          try {
            if (!fs.existsSync(source)) {
              failed.push({ source, error: '源文件不存在' })
              continue
            }
            const sourceStat = fs.statSync(source)
            const normalizedSource = normalize(source)

            if (sourceStat.isDirectory()) {
              if (normalizedTarget === normalizedSource || normalizedTarget.startsWith(normalizedSource + path.sep)) {
                failed.push({ source, error: '不能复制到自身或其子目录' })
                continue
              }
            }

            // 剪切到同一父目录：原地移动无意义，跳过
            if (mode === 'cut' && normalize(path.dirname(source)) === normalizedTarget) {
              continue
            }

            const baseName = path.basename(source)
            const conflict = hasTargetConflict(targetDir, baseName)
            if (conflict && selectedAction === 'skip') continue
            const target = conflict && selectedAction === 'keep'
              ? uniqueTargetPath(targetDir, baseName, sourceStat.isDirectory())
              : path.join(targetDir, baseName)
            if (conflict && selectedAction === 'overwrite') removeTarget(target)
            copyOrMovePath(source, target, mode, sourceStat.isDirectory())
            items.push({ source, target })
          } catch (error) {
            failed.push({ source, error: error instanceof Error ? error.message : '未知错误' })
          }
        }
        return { success: true, data: { items, failed } }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误'
        return { success: false, error: errorMessage }
      }
    }
  )
}
