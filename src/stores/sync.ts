import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { EnableSyncOptions, SyncConfig, SyncStatus, SyncStatusView } from '../../shared/sync/types'
import { useFileStore } from './file'
import { requestDialog } from '../utils/dialog'

/**
 * 同步状态 Store。
 * 监听打开文件夹变化，向主进程 attach/detach 同步引擎；展示状态、触发拉取/推送、处理文件变化。
 */
export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatus>('uninitialized')
  const error = ref<string | null>(null)
  const configured = ref(false)
  const isGitRepo = ref(false)
  const branch = ref<string | null>(null)
  const upstream = ref<string | null>(null)
  const conflictedFiles = ref<string[]>([])
  const inRebase = ref(false)
  const panelOpen = ref(false)
  const autoCommit = ref(true)
  const autoPull = ref(true)
  const autoPush = ref(false)
  const syncing = ref(false)

  async function openConflictFiles(): Promise<void> {
    const fileStore = useFileStore()
    for (const filePath of conflictedFiles.value) {
      await fileStore.openFile(filePath, { addToRecent: false, silentLimit: true })
    }
  }

  function applyView(view: SyncStatusView): void {
    const becameConflict =
      view.status === 'conflict' && status.value !== 'conflict' && (view.conflictedFiles?.length ?? 0) > 0
    status.value = view.status
    error.value = view.error
    configured.value = view.configured
    isGitRepo.value = view.isGitRepo
    branch.value = view.branch
    upstream.value = view.upstream
    conflictedFiles.value = view.conflictedFiles ?? []
    inRebase.value = view.inRebase ?? false
    syncing.value = view.status === 'syncing'
    // 进入冲突状态即自动打开冲突文件，不依赖 FILE_CHANGED 事件（该事件仅在 pull/push 失败后发出）
    if (becameConflict) {
      void openConflictFiles()
    }
  }

  async function refresh(): Promise<void> {
    const res = await window.electronAPI.getSyncStatus()
    if (res.success && res.data) applyView(res.data)
  }

  async function handleFileChanged(files: string[]): Promise<void> {
    const fileStore = useFileStore()
    if (fileStore.openedFolderPath) {
      await fileStore.readFolder(fileStore.openedFolderPath)
    }
    if (status.value === 'conflict') {
      // 只打开真正冲突的文件（watcher 会因 git rebase 更新上报大量文件，不能全开）
      await openConflictFiles()
      // 其余被远端更新的已打开文件重载
      const conflictedSet = new Set(conflictedFiles.value)
      for (const filePath of files) {
        if (conflictedSet.has(filePath)) continue
        const tab = fileStore.tabs.find((t) => t.fileInfo?.path === filePath)
        if (tab && !tab.fileInfo?.modified) {
          await fileStore.reloadFile(filePath)
        }
      }
      return
    }
    for (const filePath of files) {
      const tab = fileStore.tabs.find((t) => t.fileInfo?.path === filePath)
      if (tab && !tab.fileInfo?.modified) {
        await fileStore.reloadFile(filePath)
      }
    }
  }

  async function pull(): Promise<{ success: boolean; error?: string }> {
    const res = await window.electronAPI.syncPull()
    if (res.success && res.data?.changedFiles?.length) {
      await handleExternalChanges(res.data.changedFiles)
    }
    await refresh()
    return res
  }

  async function handleExternalChanges(files: string[]): Promise<void> {
    const fileStore = useFileStore()
    if (fileStore.openedFolderPath) {
      await fileStore.readFolder(fileStore.openedFolderPath)
    }
    for (const filePath of files) {
      const tab = fileStore.tabs.find((t) => t.fileInfo?.path === filePath)
      if (!tab) continue
      if (tab.fileInfo?.modified) {
        fileStore.markExternalHandled(filePath)
        const choice = await requestDialog({
          title: '文件已被同步更新',
          message: `"${tab.fileInfo.name}" 在远端有更新，但本地有未保存的修改。`,
          detail: '选择「加载远端」将丢弃本地未保存修改。',
          buttons: [
            { label: '取消', value: 2 },
            { label: '保留本地', value: 0, primary: true },
            { label: '加载远端', value: 1 }
          ]
        })
        if (choice === 1) await fileStore.reloadFile(filePath)
      } else {
        await fileStore.reloadFile(filePath)
      }
    }
  }

  async function push(): Promise<{ success: boolean; error?: string }> {
    const res = await window.electronAPI.syncPush()
    await refresh()
    return res
  }

  async function continueRebase(): Promise<{ success: boolean; error?: string }> {
    const res = await window.electronAPI.syncContinueRebase()
    await refresh()
    return res
  }

  async function abortRebase(): Promise<{ success: boolean; error?: string }> {
    const res = await window.electronAPI.syncAbortRebase()
    await refresh()
    return res
  }

  /** 从主进程读取持久化配置，同步三个自动开关的勾选框状态（未配置时保持默认） */
  async function loadConfigFlags(): Promise<void> {
    const cfg = await window.electronAPI.getSyncConfig()
    if (cfg.success && cfg.data) {
      autoCommit.value = cfg.data.autoCommit
      autoPull.value = cfg.data.autoPull
      autoPush.value = cfg.data.autoPush
    }
  }

  async function enable(options: EnableSyncOptions): Promise<{ success: boolean; error?: string }> {
    const fileStore = useFileStore()
    if (!fileStore.openedFolderPath) return { success: false, error: '请先打开工作区文件夹' }
    const res = await window.electronAPI.enableSync(fileStore.openedFolderPath, options)
    if (res.success) {
      await refresh()
      await loadConfigFlags()
    }
    return res
  }

  async function disable(): Promise<void> {
    await window.electronAPI.disableSync()
    await refresh()
  }

  async function setConfig(patch: Partial<Omit<SyncConfig, 'version' | 'provider'>>): Promise<void> {
    const res = await window.electronAPI.setSyncConfig(patch)
    if (res.success && res.data) {
      autoCommit.value = res.data.autoCommit
      autoPull.value = res.data.autoPull
      autoPush.value = res.data.autoPush
    }
  }

  function openPanel(): void {
    panelOpen.value = true
  }

  function closePanel(): void {
    panelOpen.value = false
  }

  function init(): void {
    const fileStore = useFileStore()
    watch(
      () => fileStore.openedFolderPath,
      async (path) => {
        if (path) {
          await window.electronAPI.syncAttachFolder(path)
          // attach 后同步持久化的自动开关状态，避免重启后勾选框与引擎配置脱节
          await loadConfigFlags()
        } else {
          await window.electronAPI.syncDetachFolder()
        }
        await refresh()
      },
      { immediate: true }
    )
    window.electronAPI.onSyncEvent(applyView)
    window.electronAPI.onSyncFileChanged((files) => {
      void handleFileChanged(files)
    })
  }

  return {
    status,
    error,
    configured,
    isGitRepo,
    branch,
    upstream,
    conflictedFiles,
    inRebase,
    panelOpen,
    autoCommit,
    autoPull,
    autoPush,
    syncing,
    init,
    refresh,
    pull,
    push,
    continueRebase,
    abortRebase,
    enable,
    disable,
    setConfig,
    openPanel,
    closePanel
  }
})
