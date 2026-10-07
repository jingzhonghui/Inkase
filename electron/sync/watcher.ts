import * as fs from 'fs'
import * as path from 'path'
import chokidar from 'chokidar'

export interface WorkspaceWatcherHandle {
  dispose(): void
}

const DEFAULT_DEBOUNCE_MS = 2000

const IGNORED_SEGMENTS = new Set(['.git', '.inkase', 'node_modules'])

function isIgnored(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized === '') return true
  return normalized.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))
}

/**
 * Windows/macOS 使用 Node 原生递归 fs.watch：仅对工作区根目录建立一个句柄，
 * 即可监听整棵子树，避免对每个子目录单独建立句柄（chokidar 行为会锁定子目录，
 * 导致重命名被 Windows 拒绝 EPERM）。
 */
function createRecursiveFsWatcher(
  workspacePath: string,
  onChanges: (files: string[]) => void,
  debounceMs: number
): WorkspaceWatcherHandle {
  const root = path.resolve(workspacePath)
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = new Set<string>()

  const fire = (): void => {
    timer = null
    if (pending.size === 0) return
    const files = [...pending]
    pending = new Set()
    onChanges(files)
  }

  const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
    if (!filename) return
    const relative = String(filename).replace(/\\/g, '/')
    if (isIgnored(relative)) return
    const absolute = path.isAbsolute(String(filename)) ? String(filename) : path.join(root, String(filename))
    pending.add(absolute)
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, debounceMs)
  })

  watcher.on('error', () => {
    // 监听错误（如目录临时不可达）不中断应用，交由后续事件恢复
  })

  return {
    dispose(): void {
      if (timer) clearTimeout(timer)
      timer = null
      watcher.close()
    }
  }
}

/** Linux 不支持递归 fs.watch，回退 chokidar（Linux 上目录重命名不因监听句柄失败）。 */
function createChokidarWatcher(
  workspacePath: string,
  onChanges: (files: string[]) => void,
  debounceMs: number
): WorkspaceWatcherHandle {
  const root = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = new Set<string>()

  const fire = (): void => {
    timer = null
    if (pending.size === 0) return
    const files = [...pending]
    pending = new Set()
    onChanges(files)
  }

  const watcher = chokidar.watch(workspacePath, {
    ignoreInitial: true,
    depth: 20,
    ignored: (p: string): boolean => {
      const normalized = p.replace(/\\/g, '/')
      if (normalized === root) return false
      return /[\\/](\.git|\.inkase|node_modules)([\\/]|$)/.test(normalized)
    }
  })

  watcher.on('all', (_event, filePath) => {
    pending.add(String(filePath))
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, debounceMs)
  })

  return {
    dispose(): void {
      if (timer) clearTimeout(timer)
      timer = null
      void watcher.close()
    }
  }
}

/**
 * 监听工作区文件变化，防抖合并后一次性回调变更文件绝对路径。
 * 忽略 .git / .inkase / node_modules。
 */
export function createWorkspaceWatcher(
  workspacePath: string,
  onChanges: (files: string[]) => void,
  options?: { debounceMs?: number }
): WorkspaceWatcherHandle {
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      return createRecursiveFsWatcher(workspacePath, onChanges, debounceMs)
    } catch {
      // 递归 fs.watch 不可用时回退 chokidar
    }
  }
  return createChokidarWatcher(workspacePath, onChanges, debounceMs)
}
