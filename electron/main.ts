import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import * as fs from 'fs'
import { join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC_CHANNELS } from './ipc/channels'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerMdxHandlers, cleanupAll, isCloseConfirmed, setCloseConfirmed, attachRecoveryAssetData } from './ipc/mdx-handlers'
import { registerPdfHandlers } from './ipc/pdf-handlers'
import { registerPreviewProtocol, registerPreviewSchemePrivileges } from './ipc/preview-protocol'
import { hadAbnormalExit, markAppRunning, readRecoverySnapshot, writeRecoverySnapshot, clearRecoverySnapshot } from './recovery'
import { resolveExistingUserGuidePath } from './user-guide'
import { registerAiHandlers, disposeAiServices } from './ai/ipc-handlers'
import { findRecentAliveInstance, sendTargetsToInstance, startInstanceService, stopInstanceService, touchHeartbeat } from './instance-broker'
import { initUpdater, checkForUpdates, openReleasesPage } from './updater'
import { inspectLaunchTarget, parseLaunchTargets, type LaunchTarget } from './launch-target'
import { SyncEngine } from './sync/engine'
import { GitSyncProvider } from './sync/git-provider'
import { createWorkspaceWatcher } from './sync/watcher'
import { registerSyncHandlers } from './ipc/sync-handlers'
import { registerExternalWatchHandlers } from './ipc/watch-handlers'
import { loadWindowState, resolveWindowState, saveWindowState, type WindowState } from './window-state'

// AppImage is mounted via FUSE where the setuid bit cannot take effect, so the
// SUID sandbox helper is unusable. Disable the Chromium sandbox for AppImage
// runs (deb keeps the SUID sandbox configured by the after-install script).
if (process.env.APPIMAGE) {
  app.commandLine.appendSwitch('no-sandbox')
}

// privileged scheme 注册必须在 app ready 之前（协议处理器在 whenReady 中注册）
registerPreviewSchemePrivileges()

let mainWindow: BrowserWindow | null = null
const pendingOpenTargets: LaunchTarget[] = []
let rendererReady = false

const syncEngine = new SyncEngine({
  createProvider: (workspacePath, _config) => new GitSyncProvider(workspacePath),
  createWatcher: (workspacePath, onChanges) => createWorkspaceWatcher(workspacePath, onChanges),
  runGit: async (args, cwd) => {
    const { runGit } = await import('./sync/git-provider')
    return runGit(args, cwd)
  }
})

function flushOpenTargets(): void {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed() || pendingOpenTargets.length === 0) return
  mainWindow.webContents.send(IPC_CHANNELS.APP.OPEN_TARGETS, pendingOpenTargets.splice(0))
}

function queueOpenTargets(targets: LaunchTarget[]): void {
  const existing = new Set(pendingOpenTargets.map((target) => target.path.toLowerCase()))
  for (const target of targets) {
    const key = target.path.toLowerCase()
    if (!existing.has(key)) {
      existing.add(key)
      pendingOpenTargets.push(target)
    }
  }
  flushOpenTargets()
}

function initialLaunchPaths(): string[] {
  if (!app.isPackaged) return []
  return parseLaunchTargets(process.argv)
}

function focusMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

/**
 * 创建主窗口
 */
function createWindow(): void {
  // 开发模式用项目根目录，生产模式用 out 的上级目录
  const iconPath = is.dev
    ? resolve(__dirname, '../../resources/icon.png')
    : join(__dirname, '../resources/icon.png')

  const windowStatePath = join(app.getPath('userData'), 'window-state.json')
  const savedWindowState = loadWindowState(windowStatePath)
  const displays = screen.getAllDisplays().map((display) => ({
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height
  }))
  const restoredWindowState = resolveWindowState(savedWindowState, displays)

  const win = new BrowserWindow({
    ...restoredWindowState.bounds,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      sandbox: false,
      contextIsolation: true
    }
  })
  mainWindow = win

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const persistWindowState = (): void => {
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    const state: WindowState = {
      bounds,
      isMaximized: win.isMaximized()
    }
    saveWindowState(windowStatePath, state)
  }
  const scheduleWindowStateSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      persistWindowState()
    }, 150)
  }

  win.on('ready-to-show', () => {
    if (restoredWindowState.isMaximized) win.maximize()
    win.show()
  })

  win.on('move', scheduleWindowStateSave)
  win.on('resize', scheduleWindowStateSave)
  win.on('maximize', scheduleWindowStateSave)
  win.on('unmaximize', scheduleWindowStateSave)

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 拦截窗口关闭事件：始终通知渲染进程检查未保存的修改
  win.on('close', (e) => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    persistWindowState()
    if (isCloseConfirmed()) {
      setCloseConfirmed(false)
      return
    }
    e.preventDefault()
    win.webContents.send('app:confirm-close')
  })

  // 窗口控制 IPC handlers
  ipcMain.handle(IPC_CHANNELS.WINDOW.MINIMIZE, () => win.minimize())
  ipcMain.handle(IPC_CHANNELS.WINDOW.MAXIMIZE, () => {
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW.CLOSE, () => win.close())
  ipcMain.handle(IPC_CHANNELS.WINDOW.IS_MAXIMIZED, () => win.isMaximized())

  // 监听最大化状态变化，通知渲染进程
  win.on('focus', () => touchHeartbeat())
  win.on('maximize', () => {
    win.webContents.send(IPC_CHANNELS.WINDOW.MAXIMIZED)
  })
  win.on('unmaximize', () => {
    win.webContents.send(IPC_CHANNELS.WINDOW.UNMAXIMIZED)
  })

  // 根据开发/生产环境加载页面
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 应用生命周期管理
 *
 * 多开流程：新进程启动时寻找「最近使用」的存活实例，
 * 携带打开目标则转发并退出；否则自己成为实例继续运行。
 */
async function bootstrap(): Promise<void> {
  const launchPaths = initialLaunchPaths()
  const recent = await findRecentAliveInstance()

  if (recent && launchPaths.length > 0) {
    const forwarded = await sendTargetsToInstance(recent, launchPaths)
    if (forwarded) {
      app.quit()
      return
    }
  }

  if (recent) {
    // 已有实例在运行：隔离 sessionData，避免 Chromium localStorage(LevelDB)
    // 锁争抢；userData 保持共享（最近文件、AI 配置、恢复快照等）。
    app.setPath('sessionData', join(app.getPath('userData'), `session-${process.pid}`))
  }

  // 接收其他实例转发来的打开目标：解析校验后交给渲染进程打开，并聚焦窗口
  startInstanceService((paths) => {
    if (app.isPackaged) {
      queueOpenTargets(
        parseLaunchTargets(paths)
          .map((target) => inspectLaunchTarget(target))
          .filter((target): target is LaunchTarget => target !== null)
      )
    }
    focusMainWindow()
  })

  app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.inkase.app')

  // 默认打开或关闭开发者工具（仅开发环境）
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC 测试通道
  ipcMain.handle('ping', () => 'pong')
  ipcMain.handle(IPC_CHANNELS.APP.GET_VERSION, () => {
    if (is.dev) return ''
    return app.getVersion()
  })
  ipcMain.handle(IPC_CHANNELS.APP.GET_USER_GUIDE_PATH, () => {
    const guidePath = resolveExistingUserGuidePath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      existsSync: fs.existsSync
    })
    return guidePath ? { success: true, data: guidePath } : { success: false, error: '内置使用教程不存在，请重新安装 Inkase。' }
  })
  ipcMain.handle(IPC_CHANNELS.APP.RECOVERY_STATUS, () => ({ success: true, data: { available: hadAbnormalExit() } }))
  ipcMain.handle(IPC_CHANNELS.APP.RECOVERY_READ, () => ({ success: true, data: readRecoverySnapshot() }))
  ipcMain.handle(IPC_CHANNELS.APP.RECOVERY_WRITE, (_, snapshot) => {
    try {
      writeRecoverySnapshot(attachRecoveryAssetData(snapshot))
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '写入恢复快照失败' }
    }
  })
  ipcMain.handle(IPC_CHANNELS.APP.RECOVERY_CLEAR, () => {
    clearRecoverySnapshot()
    return { success: true }
  })
  ipcMain.handle(IPC_CHANNELS.APP.OPEN_TARGETS, () => {
    rendererReady = true
    const targets = pendingOpenTargets.splice(0)
    return targets
  })

  // 自动更新 handlers
  ipcMain.handle(IPC_CHANNELS.UPDATE.CHECK, () => checkForUpdates())
  ipcMain.handle(IPC_CHANNELS.UPDATE.OPEN_RELEASES, () => openReleasesPage())

  markAppRunning()

  // 注册文件操作 handlers
  registerFileHandlers()

  // 注册 MDX 操作 handlers
  registerMdxHandlers()

  // 注册 PDF 导出 handlers
  registerPdfHandlers()

  // 注册 HTML 预览协议 handlers
  registerPreviewProtocol()

  // 注册同步 IPC handlers
  registerSyncHandlers(syncEngine, () => mainWindow)

  // 注册外部变更监视 handlers
  registerExternalWatchHandlers(() => mainWindow)

  // 注册 AI 助手 handlers
  registerAiHandlers(() => mainWindow)

  createWindow()

  queueOpenTargets(
    launchPaths
      .map((target) => inspectLaunchTarget(target))
      .filter((target): target is LaunchTarget => target !== null)
  )

  // 初始化自动更新，并在启动后延迟静默检查一次
  initUpdater(() => mainWindow)
  if (app.isPackaged) {
    setTimeout(() => {
      void checkForUpdates()
    }, 3000)
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  })
}

void bootstrap()

app.on('window-all-closed', () => {
  // 清理临时资源
  cleanupAll()
  disposeAiServices()
  syncEngine.dispose()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // 应用退出前清理临时资源与实例注册信息
  stopInstanceService()
  cleanupAll()
  disposeAiServices()
  syncEngine.dispose()
})
