import * as fs from 'fs'
import * as path from 'path'
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './channels'
import { createWorkspaceWatcher, type WorkspaceWatcherHandle } from '../sync/watcher'

/** 树/编辑器刷新希望比同步引擎（2s）更跟手 */
const WATCH_DEBOUNCE_MS = 400

interface WatchState {
  root: string | null
  rootHandle: WorkspaceWatcherHandle | null
  /** 独立打开文件的父目录 → fs.watch 句柄 */
  dirHandles: Map<string, fs.FSWatcher>
  /** 独立监视的文件绝对路径集合（小写化前用于精确匹配） */
  extraFiles: Set<string>
  pending: Set<string>
  timer: NodeJS.Timeout | null
}

/**
 * 外部变更监视：独立于同步引擎，始终监视当前打开的文件夹根目录
 * 以及不在根内的独立打开文件，变化合并去重后推送给渲染进程。
 */
export function registerExternalWatchHandlers(getWindow: () => BrowserWindow | null): void {
  const state: WatchState = {
    root: null,
    rootHandle: null,
    dirHandles: new Map(),
    extraFiles: new Set(),
    pending: new Set(),
    timer: null
  }

  const send = (files: string[]): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.EXTERNAL_WATCH.CHANGED, files)
    }
  }

  const flush = (): void => {
    state.timer = null
    if (state.pending.size === 0) return
    const files = [...state.pending]
    state.pending = new Set()
    send(files)
  }

  const schedule = (file: string): void => {
    state.pending.add(file)
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(flush, WATCH_DEBOUNCE_MS)
  }

  const closeDirHandles = (): void => {
    for (const handle of state.dirHandles.values()) {
      try {
        handle.close()
      } catch {
        // 忽略关闭错误
      }
    }
    state.dirHandles.clear()
  }

  const watchExtraFileDirs = (extraFiles: string[]): void => {
    closeDirHandles()
    // 统一 resolve，避免渲染进程的正斜杠路径与 fs.watch 事件的反斜杠路径不一致
    state.extraFiles = new Set(extraFiles.map((file) => path.resolve(file)))
    const dirs = new Set(extraFiles.map((file) => path.dirname(file)))
    for (const dir of dirs) {
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          if (!filename) return
          const absolute = path.isAbsolute(filename) ? path.resolve(filename) : path.resolve(dir, filename)
          if (state.extraFiles.has(absolute)) schedule(absolute)
        })
        watcher.on('error', () => {
          // 目录临时不可达时不中断，等待下一次重建
        })
        state.dirHandles.set(dir, watcher)
      } catch {
        // 目录不存在等错误忽略
      }
    }
  }

  const stopAll = (): void => {
    state.rootHandle?.dispose()
    state.rootHandle = null
    state.root = null
    closeDirHandles()
    state.extraFiles = new Set()
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    state.pending = new Set()
  }

  ipcMain.handle(IPC_CHANNELS.EXTERNAL_WATCH.START, (_event, root: string | null, extraFiles: string[]) => {
    const nextRoot = typeof root === 'string' && root ? path.resolve(root) : null
    const nextExtra = Array.isArray(extraFiles) ? extraFiles.filter((f) => typeof f === 'string' && f) : []

    if (state.root !== nextRoot) {
      state.rootHandle?.dispose()
      state.rootHandle = null
      state.root = nextRoot
      if (nextRoot) {
        try {
          state.rootHandle = createWorkspaceWatcher(nextRoot, (files) => files.forEach(schedule), {
            debounceMs: WATCH_DEBOUNCE_MS
          })
        } catch {
          state.rootHandle = null
        }
      }
    }

    const sameExtra =
      nextExtra.length === state.extraFiles.size &&
      nextExtra.every((f) => state.extraFiles.has(path.resolve(f)))
    if (!sameExtra) {
      watchExtraFileDirs(nextExtra)
    }

    return { success: true }
  })

  // 退出时清理（应用单窗口，进程退出由 Electron 生命周期管理）
  process.once('exit', stopAll)
}
