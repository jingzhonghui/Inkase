import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSyncStore } from '../sync'

vi.mock('../../utils/dialog', () => ({
  dialogState: { visible: false, title: '', message: '', detail: '', buttons: [] },
  requestDialog: vi.fn(async () => 0),
  resolveDialogRequest: vi.fn()
}))

function createMockElectronAPI(overrides: Record<string, unknown> = {}) {
  return {
    syncAttachFolder: vi.fn(async () => ({ success: true, data: { status: 'upToDate', error: null, configured: true, isGitRepo: true, branch: 'main', upstream: 'origin/main' } })),
    syncDetachFolder: vi.fn(async () => ({ success: true })),
    getSyncStatus: vi.fn(async () => ({ success: true, data: { status: 'upToDate', error: null, configured: true, isGitRepo: true, branch: 'main', upstream: 'origin/main' } })),
    syncPull: vi.fn(async () => ({ success: true })),
    syncPush: vi.fn(async () => ({ success: true })),
    syncContinueRebase: vi.fn(async () => ({ success: true })),
    syncAbortRebase: vi.fn(async () => ({ success: true })),
    syncResolveConflicts: vi.fn(async () => ({ success: true })),
    enableSync: vi.fn(async () => ({ success: true })),
    disableSync: vi.fn(async () => ({ success: true })),
    getSyncConfig: vi.fn(async () => ({ success: true, data: { version: 1, provider: 'git', autoCommit: true, autoPull: true, autoPush: false } })),
    setSyncConfig: vi.fn(async (_patch: unknown) => ({ success: true, data: { version: 1, provider: 'git', autoCommit: true, autoPull: true, autoPush: false } })),
    onSyncEvent: vi.fn(() => () => {}),
    onSyncFileChanged: vi.fn(() => () => {}),
    readFolder: vi.fn(async () => ({ success: true, data: [] })),
    openFile: vi.fn(),
    ...overrides
  }
}

describe('sync store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('window', { electronAPI: createMockElectronAPI() })
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() })
    vi.stubGlobal('navigator', { userAgent: 'Windows', clipboard: { writeText: vi.fn() } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('init attaches to the opened folder and loads status', async () => {
    const store = useSyncStore()
    await store.init()
    await vi.waitFor(() => expect(store.configured).toBe(true))
    expect(store.status).toBe('upToDate')
  })

  it('pull refreshes status and reports success', async () => {
    const store = useSyncStore()
    await store.init()
    const res = await store.pull()
    expect(res.success).toBe(true)
  })

  it('pull surfaces SYNC_NOT_CONFIGURED from the main process', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.syncPull.mockResolvedValueOnce({ success: false, error: 'SYNC_NOT_CONFIGURED' })
    const store = useSyncStore()
    await store.init()
    const res = await store.pull()
    expect(res.success).toBe(false)
    expect(res.error).toBe('SYNC_NOT_CONFIGURED')
  })

  it('enableSync forwards workspace path and options', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    const { useFileStore } = await import('../file')
    useFileStore().openedFolderPath = 'C:/ws'
    const store = useSyncStore()
    await store.init()
    await store.enable({ remoteUrl: 'https://x.git', autoPush: true })
    expect(api.enableSync).toHaveBeenCalledWith('C:/ws', { remoteUrl: 'https://x.git', autoPush: true })
  })

  it('enable returns friendly error when no workspace folder is open', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    const store = useSyncStore()
    await store.init()
    const res = await store.enable({ remoteUrl: 'https://x.git' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('请先打开工作区文件夹')
    expect(api.enableSync).not.toHaveBeenCalled()
  })

  it('setConfig forwards patch to main process', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    const store = useSyncStore()
    await store.init()
    await store.setConfig({ autoPush: true })
    expect(api.setSyncConfig).toHaveBeenCalledWith({ autoPush: true })
  })

  it('syncs checkbox flags from persisted config when attaching a folder', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.getSyncConfig.mockResolvedValue({
      success: true,
      data: { version: 1, provider: 'git', autoCommit: false, autoPull: false, autoPush: true }
    })
    const { useFileStore } = await import('../file')
    useFileStore().openedFolderPath = 'C:/ws'
    const store = useSyncStore()
    expect(store.autoCommit).toBe(true)
    await store.init()
    await vi.waitFor(() => expect(api.syncAttachFolder).toHaveBeenCalledWith('C:/ws'))
    expect(store.autoCommit).toBe(false)
    expect(store.autoPull).toBe(false)
    expect(store.autoPush).toBe(true)
  })

  it('keeps default flags when no persisted config exists', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.getSyncConfig.mockResolvedValue({ success: true, data: null })
    const { useFileStore } = await import('../file')
    useFileStore().openedFolderPath = 'C:/ws'
    const store = useSyncStore()
    await store.init()
    await vi.waitFor(() => expect(api.syncAttachFolder).toHaveBeenCalledWith('C:/ws'))
    expect(store.autoCommit).toBe(true)
    expect(store.autoPull).toBe(true)
    expect(store.autoPush).toBe(false)
  })

  it('handleFileChanged refreshes the file tree', async () => {
    const { useFileStore } = await import('../file')
    const fs = useFileStore()
    fs.openedFolderPath = 'C:/ws'
    const store = useSyncStore()
    await store.init()
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.readFolder.mockClear()
    const cb = (api.onSyncFileChanged as ReturnType<typeof vi.fn>).mock.calls[0][0] as (files: string[]) => void
    cb(['C:/ws/a.md'])
    await vi.waitFor(() => expect(api.readFolder).toHaveBeenCalledWith('C:/ws'))
  })

  it('auto-opens conflict files when in conflict state', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: null,
        upstream: null,
        conflictedFiles: ['C:/ws/docs/a.md'],
        inRebase: true
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    expect(store.status).toBe('conflict')
    const cb = (api.onSyncFileChanged as ReturnType<typeof vi.fn>).mock.calls[0][0] as (files: string[]) => void
    cb(['C:/ws/docs/a.md'])
    await vi.waitFor(() => expect(api.openFile).toHaveBeenCalledWith('C:/ws/docs/a.md', false))
  })

  it('opens conflict files directly when entering conflict, without FILE_CHANGED event', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: null,
        upstream: null,
        conflictedFiles: ['C:/ws/docs/a.md'],
        inRebase: true
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    await vi.waitFor(() => expect(api.openFile).toHaveBeenCalledWith('C:/ws/docs/a.md', false))
  })

  it('does not re-open conflict files on repeated conflict status views', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: null,
        upstream: null,
        conflictedFiles: ['C:/ws/docs/a.md'],
        inRebase: true
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    await vi.waitFor(() => expect(api.openFile).toHaveBeenCalled())
    const callsAfterEnter = (api.openFile as ReturnType<typeof vi.fn>).mock.calls.length
    await store.refresh()
    await store.refresh()
    expect((api.openFile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterEnter)
  })

  it('does not open non-conflict files when in conflict state', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: null,
        upstream: null,
        conflictedFiles: ['C:/ws/docs/a.md'],
        inRebase: true
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    const cb = (api.onSyncFileChanged as ReturnType<typeof vi.fn>).mock.calls[0][0] as (files: string[]) => void
    cb(['C:/ws/docs/a.md', 'C:/ws/other.md', 'C:/ws/notes/b.mdx'])
    await vi.waitFor(() => expect(api.openFile).toHaveBeenCalledWith('C:/ws/docs/a.md', false))
    expect(api.openFile).not.toHaveBeenCalledWith('C:/ws/other.md', false)
    expect(api.openFile).not.toHaveBeenCalledWith('C:/ws/notes/b.mdx', false)
  })

  it('applyView syncs conflicted files and rebase flag', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: null,
        upstream: null,
        conflictedFiles: ['C:/ws/docs/a.md'],
        inRebase: true
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    expect(store.status).toBe('conflict')
    expect(store.conflictedFiles).toEqual(['C:/ws/docs/a.md'])
    expect(store.inRebase).toBe(true)
  })

  it('continueRebase forwards to main process and refreshes', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    const store = useSyncStore()
    await store.init()
    const res = await store.continueRebase()
    expect(res.success).toBe(true)
    expect(api.syncContinueRebase).toHaveBeenCalled()
  })

  it('abortRebase forwards to main process and refreshes', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    const store = useSyncStore()
    await store.init()
    const res = await store.abortRebase()
    expect(res.success).toBe(true)
    expect(api.syncAbortRebase).toHaveBeenCalled()
  })

  it('defaults provider to git before any status view arrives', () => {
    const store = useSyncStore()
    expect(store.provider).toBe('git')
  })

  it('applyView writes the provider from the status view into the store', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'upToDate',
        error: null,
        configured: true,
        isGitRepo: false,
        branch: null,
        upstream: null,
        provider: 'webdav'
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    expect(store.provider).toBe('webdav')
  })

  it('applyView keeps provider as git when the view reports git', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'upToDate',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: 'main',
        upstream: 'origin/main',
        provider: 'git'
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    expect(store.provider).toBe('git')
  })

  it('falls back to git when a status view omits the provider', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'upToDate',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: 'main',
        upstream: 'origin/main'
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    expect(store.provider).toBe('git')
  })

  it('enable forwards provider and webdav options untouched', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    const { useFileStore } = await import('../file')
    useFileStore().openedFolderPath = 'C:/ws'
    const store = useSyncStore()
    await store.init()
    const options = {
      provider: 'webdav' as const,
      url: 'https://dav.example.com/remote.php/dav',
      username: 'alice',
      password: 'secret',
      remoteRoot: '/inkase'
    }
    await store.enable(options)
    expect(api.enableSync).toHaveBeenCalledWith('C:/ws', options)
  })

  it('resolveConflicts forwards the choices to the main process', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    const store = useSyncStore()
    const choices = [
      { path: 'C:/ws/a.md', choice: 'local' as const },
      { path: 'C:/ws/b.md', choice: 'remote' as const }
    ]
    await store.resolveConflicts(choices)
    expect(api.syncResolveConflicts).toHaveBeenCalledWith(choices)
  })

  it('resolveConflicts refreshes and returns success when resolution succeeds', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    const store = useSyncStore()
    const res = await store.resolveConflicts([{ path: 'C:/ws/a.md', choice: 'local' as const }])
    expect(res).toEqual({ success: true })
    expect(api.getSyncStatus).toHaveBeenCalledTimes(1)
  })

  it('resolveConflicts surfaces the error and skips refresh when resolution fails', async () => {
    const api = window.electronAPI as unknown as ReturnType<typeof createMockElectronAPI>
    api.syncResolveConflicts.mockResolvedValueOnce({ success: false, error: 'RESOLVE_FAILED' })
    const store = useSyncStore()
    const res = await store.resolveConflicts([{ path: 'C:/ws/a.md', choice: 'remote' as const }])
    expect(res).toEqual({ success: false, error: 'RESOLVE_FAILED' })
    expect(api.getSyncStatus).not.toHaveBeenCalled()
  })
})
