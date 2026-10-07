import { computed, watch, type Ref } from 'vue'
import { isEditableMarkdownFormat } from '../../types/mdx'
import { requestDialog } from '../../utils/dialog'
import type { TabInfo } from './types'

/** 同一文件的变更在该窗口期内只处理一次（避免与 sync:fileChanged 双路径重复弹窗/重载） */
const HANDLED_WINDOW_MS = 4000
/** 短时间内的多批变更事件合并后一次处理 */
const BATCH_DEBOUNCE_MS = 300
/** 去重表容量上限，超过时清理过期项 */
const HANDLED_MAX_ENTRIES = 500

export interface ExternalWatchDeps {
  tabs: Ref<TabInfo[]>
  openedFolderPath: Ref<string | null>
  readFolder: (dirPath: string) => Promise<boolean>
  reloadFile: (filePath: string) => Promise<boolean>
  isTabDirty: (tab: TabInfo) => boolean
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+/g, '/')
}

/** child 是否位于 root 目录内 */
function isUnderRoot(child: string, root: string): boolean {
  const normalizedChild = normalizePath(child)
  const normalizedRoot = normalizePath(root).replace(/\/+$/, '')
  return normalizedChild.startsWith(`${normalizedRoot}/`)
}

/**
 * 外部变更监视（独立于同步引擎）：
 * - 始终监视当前打开的文件夹根目录，磁盘上新增/删除/修改自动刷新文件树
 * - 不在根内的独立打开文件按其父目录监视
 * - 变更命中已打开的 md/mdx 标签时：无未保存修改直接重载，有则弹窗让用户选择
 */
export function createExternalWatch(deps: ExternalWatchDeps) {
  const handledAt = new Map<string, number>()
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  function pruneHandled(): void {
    const now = Date.now()
    for (const [filePath, ts] of handledAt) {
      if (now - ts >= HANDLED_WINDOW_MS) handledAt.delete(filePath)
    }
  }

  /** 标记某文件的外部变更已被处理（如自身保存、同步重载），窗口期内跳过 */
  function markExternalHandled(filePath: string): void {
    if (handledAt.size >= HANDLED_MAX_ENTRIES) pruneHandled()
    handledAt.set(filePath, Date.now())
  }

  function handledRecently(filePath: string): boolean {
    const ts = handledAt.get(filePath)
    return ts !== undefined && Date.now() - ts < HANDLED_WINDOW_MS
  }

  function canAutoReload(tab: TabInfo): boolean {
    return !!tab.document && !!tab.fileInfo?.path && isEditableMarkdownFormat(tab.fileInfo.format)
  }

  /** 处理一批外部变更：刷新文件树 + 重载/提示受影响的已打开标签 */
  async function handleExternalChanges(files: string[]): Promise<void> {
    const unique = [...new Set(files.filter((f) => typeof f === 'string' && f))]
    if (unique.length === 0) return

    const root = deps.openedFolderPath.value
    if (root && unique.some((filePath) => isUnderRoot(filePath, root))) {
      // readFolder 保留展开状态并递归刷新已展开的子目录
      await deps.readFolder(root)
    }

    for (const filePath of unique) {
      if (handledRecently(filePath)) continue
      const tab = deps.tabs.value.find((t) => t.fileInfo?.path === filePath)
      if (!tab || !canAutoReload(tab)) continue
      markExternalHandled(filePath)
      if (deps.isTabDirty(tab)) {
        const choice = await requestDialog({
          title: '文件已在磁盘上被修改',
          message: `"${tab.fileInfo?.name}" 在外部被修改，当前标签有未保存的修改。`,
          detail: '选择「重新加载」将丢弃本地未保存的修改。',
          buttons: [
            { label: '取消', value: 2 },
            { label: '保留本地', value: 0, primary: true },
            { label: '重新加载', value: 1 }
          ]
        })
        if (choice === 1) await deps.reloadFile(filePath)
      } else {
        await deps.reloadFile(filePath)
      }
    }
  }

  function queueExternalChanges(files: string[]): void {
    for (const filePath of files) pending.add(filePath)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (pending.size === 0) return
      const batch = [...pending]
      pending = new Set()
      void handleExternalChanges(batch)
    }, BATCH_DEBOUNCE_MS)
  }

  /** 注册 IPC 监听，并随打开文件夹/标签变化向主进程同步监视范围 */
  function setup(): void {
    if (typeof window === 'undefined') return
    window.electronAPI?.onExternalFileChanged?.((files) => queueExternalChanges(files))

    const extraWatchedFiles = computed(() => {
      const root = deps.openedFolderPath.value
      const list: string[] = []
      for (const tab of deps.tabs.value) {
        const filePath = tab.fileInfo?.path
        if (!filePath) continue
        if (root && isUnderRoot(filePath, root)) continue
        list.push(filePath)
      }
      return list
    })

    watch(
      [() => deps.openedFolderPath.value, extraWatchedFiles],
      ([root, extras]) => {
        if (typeof window === 'undefined') return
        void window.electronAPI?.watchExternalChanges?.(root, extras)
      },
      { immediate: true }
    )
  }

  return {
    setup,
    handleExternalChanges,
    queueExternalChanges,
    markExternalHandled
  }
}
