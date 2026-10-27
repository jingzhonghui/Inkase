/**
 * 思维导图格式互通（XMind）的 IPC
 *
 * 两个动作：
 * - 导入：读外部 `.xmind` → 转成 `.inkmind` 落盘，返回路径与「被丢弃内容」的计数；
 * - 导出：把当前导图文本写成 `.xmind`。
 *
 * 为什么不复用 `MDX` 那组通道：那些通道的语义是「Inkase 文档格式之间的转换」，
 * 而这里是「与外部生态的格式转换」，失败提示、体积上限、错误文案都不一样，
 * 混在一起会让 mdx-handlers 越来越难读。
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import { describeXmindWarnings, hasXmindWarnings } from '../../shared/mindmap/xmind'
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, storeAsset } from '../mindmap/inkmind-archive'
import {
  exportMindMapToXmindFile,
  importXmindToFile,
  XMIND_EXTENSION
} from '../mindmap/xmind-archive'
import { MINDMAP_EXTENSION } from '../../shared/mindmap/document'
import { IPC_CHANNELS } from './channels'
import { getTempDirForFile } from './mdx-handlers'

/** 允许的图片扩展名（只做白名单，不做内容嗅探） */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']

/** 按扩展名给一个 MIME，卡片图标要按类型区分 */
function mimeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const table: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4'
  }
  return table[ext] ?? 'application/octet-stream'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function registerMindMapHandlers(): void {
  /**
   * 导入 XMind。
   *
   * `sourcePath` 由拖放或命令行传入时跳过选择框；`targetFolder` 为空则落在源文件旁边，
   * 与「导入 Markdown」的行为一致——用户刚选过的目录就是他想放的位置。
   */
  ipcMain.handle(
    IPC_CHANNELS.MINDMAP.IMPORT_XMIND,
    async (_, sourcePath?: string, targetFolder?: string) => {
      try {
        let from = sourcePath
        if (!from) {
          const window = BrowserWindow.getFocusedWindow()
          if (!window) return { success: false, error: '没有活动的窗口' }
          const result = await dialog.showOpenDialog(window, {
            properties: ['openFile'],
            filters: [
              { name: 'XMind 文件', extensions: ['xmind'] },
              { name: '所有文件', extensions: ['*'] }
            ]
          })
          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: '用户取消' }
          }
          from = result.filePaths[0]
        }

        if (!from.toLowerCase().endsWith(XMIND_EXTENSION)) {
          return { success: false, error: '只能导入 .xmind 文件' }
        }

        const targetDir = targetFolder || path.dirname(from)
        if (!fs.existsSync(targetDir)) {
          return { success: false, error: '目标目录不存在' }
        }

        const imported = importXmindToFile(from, targetDir)
        if (!imported.ok) return { success: false, error: imported.error }

        return {
          success: true,
          data: {
            filePath: imported.data.filePath,
            warnings: imported.data.warnings,
            warningsSummary: hasXmindWarnings(imported.data.warnings)
              ? describeXmindWarnings(imported.data.warnings)
              : []
          }
        }
      } catch (error) {
        return { success: false, error: errorMessage(error, '导入 XMind 失败') }
      }
    }
  )

  /**
   * 导出 XMind。
   *
   * 内容由渲染层给出（文档的真相在那边），主进程只负责转换与落盘；
   * 与图片导出一致：不登记最近文件，导出的产物不是当前编辑的文档。
   */
  ipcMain.handle(IPC_CHANNELS.MINDMAP.EXPORT_XMIND, async (_, title?: string, content?: string) => {
    try {
      if (typeof content !== 'string' || content.trim() === '') {
        return { success: false, error: '没有可导出的导图内容' }
      }

      const window = BrowserWindow.getFocusedWindow()
      if (!window) return { success: false, error: '没有活动的窗口' }

      const baseName = (title || '思维导图').replace(/\.[^.]+$/, '').trim() || '思维导图'
      const result = await dialog.showSaveDialog(window, {
        defaultPath: `${baseName}${XMIND_EXTENSION}`,
        filters: [
          { name: 'XMind 文件', extensions: ['xmind'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })

      if (result.canceled || !result.filePath) {
        return { success: false, error: '用户取消' }
      }

      let targetPath = result.filePath
      if (!targetPath.toLowerCase().endsWith(XMIND_EXTENSION)) {
        targetPath += XMIND_EXTENSION
      }

      const exported = exportMindMapToXmindFile(content, targetPath)
      if (!exported.ok) return { success: false, error: exported.error }

      return { success: true, data: exported.filePath }
    } catch (error) {
      return { success: false, error: errorMessage(error, '导出 XMind 失败') }
    }
  })

  /**
   * 插入节点资源（图片或附件）。
   *
   * 文件写进包解压后的临时目录，渲染层拿到「包内路径 + 绝对路径」：
   * 前者落盘进 map.json，后者用来立刻显示。真正的打包发生在保存时。
   */
  ipcMain.handle(
    IPC_CHANNELS.MINDMAP.ADD_ASSET,
    async (_, documentPath?: string, kind?: 'image' | 'file', sourcePath?: string) => {
      try {
        if (typeof documentPath !== 'string' || !documentPath) {
          return { success: false, error: '请先保存导图再插入资源' }
        }
        if (!documentPath.toLowerCase().endsWith(MINDMAP_EXTENSION)) {
          return { success: false, error: '只有 .inkmind 文件可以插入资源' }
        }
        const assetKind = kind === 'file' ? 'file' : 'image'
        const tempDir = getTempDirForFile(documentPath)
        if (!tempDir) {
          return { success: false, error: '导图尚未打开，请先重新打开文件' }
        }

        let from = sourcePath
        if (!from) {
          const window = BrowserWindow.getFocusedWindow()
          if (!window) return { success: false, error: '没有活动的窗口' }
          const result = await dialog.showOpenDialog(window, {
            properties: ['openFile'],
            filters:
              assetKind === 'image'
                ? [
                    {
                      name: '图片',
                      extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
                    },
                    { name: '所有文件', extensions: ['*'] }
                  ]
                : [{ name: '所有文件', extensions: ['*'] }]
          })
          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: '用户取消' }
          }
          from = result.filePaths[0]
        }

        if (assetKind === 'image' && !IMAGE_EXTENSIONS.includes(path.extname(from).toLowerCase())) {
          return { success: false, error: '这不是图片文件' }
        }

        const stored = storeAsset(
          tempDir,
          from,
          assetKind,
          assetKind === 'image' ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES
        )
        if (!stored.ok) return { success: false, error: stored.error }
        return {
          success: true,
          data: { ...stored.data, mime: mimeOf(from) }
        }
      } catch (error) {
        return { success: false, error: errorMessage(error, '插入资源失败') }
      }
    }
  )

  /**
   * 打开容器里的附件。
   *
   * 附件平时躺在临时解压目录里，路径由渲染层从 assetMap 取；
   * 这里只做一次存在性检查再交给系统默认程序——打不开时用户最需要的是
   * 一句「文件不在了」，而不是 shell 的原始报错。
   */
  ipcMain.handle(IPC_CHANNELS.MINDMAP.OPEN_ASSET, async (_, absolutePath?: string) => {
    try {
      if (typeof absolutePath !== 'string' || !absolutePath) {
        return { success: false, error: '附件路径为空' }
      }
      if (!fs.existsSync(absolutePath)) {
        return { success: false, error: '附件文件不存在，可能已被移除' }
      }
      const message = await shell.openPath(absolutePath)
      return message ? { success: false, error: message } : { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error, '打开附件失败') }
    }
  })

  /**
   * 把容器里的附件另存到用户选的位置。
   *
   * 不做「先解压再拷贝」：源文件本来就在临时目录里，直接 copy 即可；
   * 重名由用户在保存框里自行决定，我们只负责带上原始文件名。
   */
  ipcMain.handle(
    IPC_CHANNELS.MINDMAP.SAVE_ASSET_AS,
    async (_, absolutePath?: string, suggestedName?: string) => {
      try {
        if (typeof absolutePath !== 'string' || !absolutePath) {
          return { success: false, error: '附件路径为空' }
        }
        if (!fs.existsSync(absolutePath)) {
          return { success: false, error: '附件文件不存在，可能已被移除' }
        }
        const window = BrowserWindow.getFocusedWindow()
        if (!window) return { success: false, error: '没有活动的窗口' }

        const baseName = (suggestedName || path.basename(absolutePath)).replace(/[/\\]/g, '-')
        const result = await dialog.showSaveDialog(window, {
          defaultPath: baseName,
          filters: [{ name: '所有文件', extensions: ['*'] }]
        })
        if (result.canceled || !result.filePath) {
          return { success: false, error: '用户取消' }
        }
        fs.copyFileSync(absolutePath, result.filePath)
        return { success: true, data: result.filePath }
      } catch (error) {
        return { success: false, error: errorMessage(error, '另存附件失败') }
      }
    }
  )
}
