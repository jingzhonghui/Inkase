import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import { IPC_CHANNELS } from './ipc/channels'

/**
 * GitHub 发布页地址（更新提示中的下载按钮跳转到这里）
 */
export const RELEASE_PAGE_URL = 'https://github.com/jingzhonghui/Inkase/releases'

/**
 * 发送给渲染进程的更新信息（最小化字段，避免传递不可序列化对象）
 */
export interface UpdateInfoPayload {
  version: string
  releaseNotes?: string
  releaseDate?: string
}

/** 开发环境用于调试更新弹窗的固定数据，不会请求网络或下载文件。 */
const DEV_UPDATE_INFO: UpdateInfoPayload = {
  version: '1.0.1-debug',
  releaseNotes: '## 更新界面调试\n\n- 验证版本与更新日志展示\n- 验证“稍后”与“前往下载”操作',
  releaseDate: new Date().toISOString()
}

/**
 * 是否启用更新检查：
 * - 仅打包后的生产环境可用（开发模式跳过）
 * - Linux 下也启用（通过 GitHub Release 检测版本，用户手动下载安装包）
 */
export function shouldEnableUpdater(isPackaged: boolean): boolean {
  if (!isPackaged) return false
  return true
}

// 简单的日志适配器（后续可替换为 electron-log 等）
autoUpdater.logger = {
  info: (...args: unknown[]) => console.info('[updater]', ...args),
  warn: (...args: unknown[]) => console.warn('[updater]', ...args),
  error: (...args: unknown[]) => console.error('[updater]', ...args),
  debug: (...args: unknown[]) => console.debug('[updater]', ...args)
}

let enabled = false
let initialized = false
let getWindow: (() => BrowserWindow | null) | null = null

function send(channel: string, payload?: unknown): void {
  const win = getWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function toInfoPayload(info: UpdateInfo): UpdateInfoPayload {
  const releaseNotes =
    typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
  return {
    version: info.version,
    releaseNotes,
    releaseDate: info.releaseDate
  }
}

/**
 * 初始化更新检查：绑定事件并转发到渲染进程。
 * 仅检查更新，不自动下载，由用户点击按钮前往 GitHub 发布页手动下载。
 */
export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  enabled = shouldEnableUpdater(app.isPackaged)

  if (!enabled) {
    console.info('[updater] update check disabled (dev mode or unsupported platform)')
    return
  }
  if (initialized) return
  initialized = true

  autoUpdater.autoDownload = false

  autoUpdater.on('update-available', (info) => {
    send(IPC_CHANNELS.UPDATE.AVAILABLE, toInfoPayload(info))
  })
  autoUpdater.on('update-not-available', (info) => {
    send(IPC_CHANNELS.UPDATE.NOT_AVAILABLE, toInfoPayload(info))
  })
  autoUpdater.on('error', (error) => {
    send(IPC_CHANNELS.UPDATE.ERROR, {
      message: error instanceof Error ? error.message : String(error)
    })
  })
}

/**
 * 检查更新（手动或启动时调用）。开发模式返回固定数据以调试更新弹窗。
 */
export async function checkForUpdates(): Promise<{ success: boolean; error?: string }> {
  if (!enabled) {
    if (!app.isPackaged) {
      send(IPC_CHANNELS.UPDATE.AVAILABLE, DEV_UPDATE_INFO)
      return { success: true }
    }
    return { success: false, error: '当前环境不支持自动更新' }
  }
  try {
    await autoUpdater.checkForUpdates()
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '检查更新失败'
    }
  }
}

/**
 * 在系统浏览器中打开 GitHub 发布页（供用户手动下载安装包）。开发模式不打开外部页面。
 */
export async function openReleasesPage(): Promise<{ success: boolean; error?: string }> {
  if (!app.isPackaged) return { success: true }
  try {
    await shell.openExternal(RELEASE_PAGE_URL)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '打开发布页失败'
    }
  }
}
