import * as fs from 'node:fs'
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../ipc/channels'
import { appendLinkToFile, LinkWriteError } from './link-write'
import { getGraphService, GraphBuildCancelledError } from './service'

/**
 * 知识图谱 IPC。
 *
 * 沿用既有约定：handler 统一返回 `{ success, data?, error? }`；
 * 进度用 `webContents.send` 单向推送，不占 invoke 通道。
 */

interface GraphProgress {
  scanned: number
  total: number
}

/** 每个 webContents 只保留一个进行中的构建，新的构建会取消旧的 */
const runningBuilds = new Map<number, AbortController>()

function cancelBuildFor(senderId: number): void {
  const controller = runningBuilds.get(senderId)
  if (controller) {
    controller.abort()
    runningBuilds.delete(senderId)
  }
}

function requireRoot(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('工作区路径无效')
  const resolved = value
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new Error('工作区不存在')
  }
  if (!stat.isDirectory()) throw new Error('工作区不是文件夹')
  return resolved
}

function requireRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}路径无效`)
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) throw new Error(`${label}路径必须是工作区相对路径`)
  return value
}

export function registerGraphHandlers(): void {
  const service = getGraphService()

  ipcMain.handle(IPC_CHANNELS.GRAPH.BUILD, async (event: IpcMainInvokeEvent, root: unknown) => {
    const senderId = event.sender.id
    let resolvedRoot: string
    try {
      resolvedRoot = requireRoot(root)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '工作区路径无效' }
    }

    cancelBuildFor(senderId)
    const controller = new AbortController()
    runningBuilds.set(senderId, controller)

    try {
      const payload = await service.build(resolvedRoot, {
        signal: controller.signal,
        onProgress: (scanned, total) => {
          if (event.sender.isDestroyed()) return
          const progress: GraphProgress = { scanned, total }
          event.sender.send(IPC_CHANNELS.GRAPH.PROGRESS, progress)
        }
      })
      return { success: true, data: payload }
    } catch (error) {
      // 取消是正常路径（切换文件夹 / 重新构建），渲染层会静默忽略
      if (error instanceof GraphBuildCancelledError) {
        return { success: false, error: '已取消' }
      }
      const message = error instanceof Error ? error.message : '构建图谱失败'
      return { success: false, error: message }
    } finally {
      if (runningBuilds.get(senderId) === controller) runningBuilds.delete(senderId)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.GRAPH.REFRESH_FILE,
    async (_event, root: unknown, relativePath: unknown) => {
      try {
        const resolvedRoot = requireRoot(root)
        const relPath = requireRelativePath(relativePath, '文件')
        const record = await service.refreshFile(resolvedRoot, relPath)
        if (!record) return { success: false, error: '无法读取该文件' }
        return { success: true, data: record }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : '重算失败' }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.GRAPH.CREATE_LINK,
    async (
      _event,
      input: { root?: unknown; from?: unknown; to?: unknown; title?: unknown } | undefined
    ) => {
      try {
        const resolvedRoot = requireRoot(input?.root)
        const from = requireRelativePath(input?.from, '源文件')
        const to = requireRelativePath(input?.to, '目标文件')
        const title = typeof input?.title === 'string' && input.title.trim() ? input.title : undefined

        const result = await appendLinkToFile({ root: resolvedRoot, from, to, title })
        // 文件变了，缓存里的出链已过期
        service.invalidate(resolvedRoot)
        return { success: true, data: result }
      } catch (error) {
        if (error instanceof LinkWriteError) return { success: false, error: error.message }
        return { success: false, error: error instanceof Error ? error.message : '写入链接失败' }
      }
    }
  )
}

/** 进程退出前丢弃全部缓存（测试与主进程重启路径可用） */
export function disposeGraphHandlers(): void {
  for (const controller of runningBuilds.values()) controller.abort()
  runningBuilds.clear()
  getGraphService().invalidate()
}
