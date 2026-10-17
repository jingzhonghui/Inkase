import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './channels'
import type { SyncEngine } from '../sync/engine'
import type { SyncStatusView } from '../sync/types'

/**
 * 注册同步 IPC handlers，并把 engine 的事件推送到渲染进程。
 */
export function registerSyncHandlers(engine: SyncEngine, getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }

  engine.onEvent((view: SyncStatusView) => {
    send(IPC_CHANNELS.SYNC.EVENT, view)
  })
  engine.onFileChanged((files: string[]) => {
    send(IPC_CHANNELS.SYNC.FILE_CHANGED, files)
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.ATTACH_FOLDER, async (_, workspacePath: string) => {
    await engine.attach(workspacePath)
    return { success: true, data: engine.getStatusView() }
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.DETACH_FOLDER, () => {
    engine.detach()
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.STATUS, () => {
    return { success: true, data: engine.getStatusView() }
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.PULL, async () => {
    return await engine.pull()
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.PUSH, async () => {
    return await engine.push()
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.CONTINUE_REBASE, async () => {
    return await engine.continueRebase()
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.ABORT_REBASE, async () => {
    return await engine.abortRebase()
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.RESOLVE_CONFLICTS, async (_, choices) => {
    return await engine.resolveConflicts(choices ?? [])
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.ENABLE, async (_, workspacePath: string, options) => {
    return await engine.enable(workspacePath, options || {})
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.DISABLE, () => {
    engine.disable()
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.CONFIG.GET, () => {
    const config = engine.getConfig()
    return { success: true, data: config }
  })

  ipcMain.handle(IPC_CHANNELS.SYNC.CONFIG.SET, (_, patch) => {
    const config = engine.setConfig(patch || {})
    if (!config) return { success: false, error: '同步未配置' }
    return { success: true, data: config }
  })
}
