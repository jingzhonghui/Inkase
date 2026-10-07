import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import { IPC_CHANNELS } from '../channels'

type Handler = (...args: unknown[]) => unknown

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
})

const watcherMocks = vi.hoisted(() => ({
  createWorkspaceWatcher: vi.fn()
}))

const fsWatchMocks = vi.hoisted(() => ({
  watch: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler
  },
  BrowserWindow: class {}
}))

vi.mock('../../sync/watcher', () => ({
  createWorkspaceWatcher: watcherMocks.createWorkspaceWatcher
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: { ...actual, watch: fsWatchMocks.watch },
    watch: fsWatchMocks.watch
  }
})

function makeRootHandle(): void {
  watcherMocks.createWorkspaceWatcher.mockImplementation((_root, onChanges) => {
    void onChanges
    return { dispose: vi.fn() }
  })
}

function makeDirWatcher(): { close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(), on: vi.fn() }
}

describe('watch-handlers', () => {
  const send = vi.fn()
  const getWindow = () =>
    ({ isDestroyed: () => false, webContents: { send } }) as unknown as import('electron').BrowserWindow

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    electronMocks.handlers.clear()
    const mod = await import('../watch-handlers')
    mod.registerExternalWatchHandlers(getWindow)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const start = (root: string | null, extraFiles: string[] = []): { success: boolean } => {
    const handler = electronMocks.handlers.get(IPC_CHANNELS.EXTERNAL_WATCH.START)
    if (!handler) throw new Error('START handler 未注册')
    return handler({}, root, extraFiles) as { success: boolean }
  }

  it('START 创建根目录 watcher 并在防抖后推送变更', async () => {
    makeRootHandle()
    expect(start('C:/ws').success).toBe(true)
    expect(watcherMocks.createWorkspaceWatcher).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]ws$/),
      expect.any(Function),
      { debounceMs: 400 }
    )

    const onChanges = watcherMocks.createWorkspaceWatcher.mock.calls[0][1] as (files: string[]) => void
    onChanges(['C:/ws/a.md'])
    onChanges(['C:/ws/b.md', 'C:/ws/a.md'])
    await vi.advanceTimersByTimeAsync(400)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.EXTERNAL_WATCH.CHANGED, [
      'C:/ws/a.md',
      'C:/ws/b.md'
    ])
  })

  it('相同根目录重复 START 不重建 watcher', async () => {
    makeRootHandle()
    start('C:/ws')
    start('C:/ws')
    expect(watcherMocks.createWorkspaceWatcher).toHaveBeenCalledTimes(1)
  })

  it('切换根目录时释放旧 watcher', async () => {
    makeRootHandle()
    start('C:/ws')
    const firstHandle = watcherMocks.createWorkspaceWatcher.mock.results[0].value as {
      dispose: ReturnType<typeof vi.fn>
    }
    expect(firstHandle.dispose).not.toHaveBeenCalled()

    start('C:/other')
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1)
    expect(watcherMocks.createWorkspaceWatcher).toHaveBeenCalledTimes(2)
  })

  it('root 为 null 且无独立文件时全部释放', async () => {
    makeRootHandle()
    fsWatchMocks.watch.mockReturnValue(makeDirWatcher())
    start('C:/ws', ['C:/a/x.md'])
    start(null, [])
    const handle = watcherMocks.createWorkspaceWatcher.mock.results[0].value as {
      dispose: ReturnType<typeof vi.fn>
    }
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(fsWatchMocks.watch.mock.results[0].value.close).toHaveBeenCalledTimes(1)
  })

  it('独立文件按父目录监视并按文件名过滤', async () => {
    fsWatchMocks.watch.mockReturnValue(makeDirWatcher())
    start(null, ['C:/a/x.md', 'C:/a/y.mdx'])

    expect(fsWatchMocks.watch).toHaveBeenCalledTimes(1)
    expect(fsWatchMocks.watch).toHaveBeenCalledWith('C:/a', expect.any(Function))

    const onFsEvent = fsWatchMocks.watch.mock.calls[0][1] as (
      _event: string,
      filename: string | null
    ) => void
    onFsEvent('rename', 'other.md')
    onFsEvent('change', 'x.md')
    await vi.advanceTimersByTimeAsync(400)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.EXTERNAL_WATCH.CHANGED, [path.resolve('C:/a/x.md')])
  })

  it('相同的独立文件列表重复 START 不重建目录 watcher', async () => {
    fsWatchMocks.watch.mockReturnValue(makeDirWatcher())
    start(null, ['C:/a/x.md'])
    start(null, ['C:/a/x.md'])
    expect(fsWatchMocks.watch).toHaveBeenCalledTimes(1)
  })
})
