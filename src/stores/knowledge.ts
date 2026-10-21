import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  BacklinkItem,
  IndexStatus,
  KnowledgeQuery,
  LinkRef,
  SearchHit,
  TagNote,
  TagSummary
} from '../../shared/knowledge/types'
import { toAbsolutePath, toVaultRelativePath } from '../utils/knowledge-path'
import { useFileStore } from './file'

/** 标签及使用计数（含来源细分），供面板直接渲染 */
export type TagCount = TagSummary

/** 空闲状态常量（避免多处字面量漂移） */
function idleStatus(): IndexStatus {
  return { state: 'idle', progress: { phase: 'idle', done: 0, total: 0 }, fileCount: 0 }
}

/**
 * 知识库索引 Store
 *
 * 负责：随工作区打开/关闭初始化索引、转发构建进度、按当前笔记拉取反链与标签、
 * 维护断链清单。**所有对外路径都是库内相对路径**，组件需要绝对路径时用 `resolveAbsolute`。
 */
export const useKnowledgeStore = defineStore('knowledge', () => {
  const status = ref<IndexStatus>(idleStatus())
  const backlinks = ref<BacklinkItem[]>([])
  const backlinksPath = ref<string | null>(null)
  const tags = ref<TagCount[]>([])
  const unresolved = ref<LinkRef[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 进度事件退订函数 */
  let stopProgress: (() => void) | null = null

  /** 索引构建中 */
  const building = computed(() => status.value.state === 'building')
  /** 索引不可用（构建失败），此时 UI 必须降级而不是报错阻塞 */
  const degraded = computed(() => status.value.state === 'degraded')
  /** 断链数量 */
  const brokenCount = computed(() => unresolved.value.length)
  /** 工作区根目录 */
  const root = computed(() => useFileStore().openedFolderPath ?? null)

  /** 当前激活文件的库内相对路径；不在库内为 null */
  const activeRelPath = computed<string | null>(() => {
    const fileStore = useFileStore()
    const absPath = fileStore.activeTab?.fileInfo?.path
    if (!absPath || !fileStore.openedFolderPath) return null
    return toVaultRelativePath(fileStore.openedFolderPath, absPath)
  })

  /** 库内相对路径 → 绝对路径（供打开文件/跳转使用） */
  function resolveAbsolute(relPath: string): string | null {
    const base = root.value
    if (base === null) return null
    return toAbsolutePath(base, relPath)
  }

  /**
   * 知识库 API 句柄
   *
   * 该能力由 preload 暴露；缺失时（旧版本 preload、测试环境）整体降级为空态，
   * 而不是抛错拖垮应用外壳。
   */
  function api(): typeof window.electronAPI | null {
    return typeof window.electronAPI?.onKnowledgeProgress === 'function' ? window.electronAPI : null
  }

  async function refreshStatus(): Promise<void> {
    const bridge = api()
    if (bridge === null) return
    const res = await bridge.knowledgeStatus()
    if (res.success && res.data) status.value = res.data
  }

  /** 载入已有索引；缺失或过期时构建 */
  async function ensureIndex(): Promise<void> {
    const bridge = api()
    if (bridge === null) return
    loading.value = true
    error.value = null
    try {
      const res = await bridge.ensureKnowledgeIndex()
      if (res.success && res.data) status.value = res.data
      else error.value = res.error ?? '索引不可用'
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '索引不可用'
    } finally {
      loading.value = false
    }
  }

  /** 强制全量重建 */
  async function rebuildIndex(): Promise<void> {
    const bridge = api()
    if (bridge === null) return
    loading.value = true
    error.value = null
    try {
      const res = await bridge.rebuildKnowledgeIndex()
      if (res.success && res.data) status.value = res.data
      else error.value = res.error ?? '索引重建失败'
      await Promise.all([loadTags(), loadUnresolved()])
      if (backlinksPath.value !== null) await loadBacklinks(backlinksPath.value)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '索引重建失败'
    } finally {
      loading.value = false
    }
  }

  /** 拉取指定文件的反链（含未链接提及） */
  async function loadBacklinks(relPath: string): Promise<void> {
    backlinksPath.value = relPath
    const bridge = api()
    if (bridge === null) {
      backlinks.value = []
      return
    }
    const res = await bridge.getBacklinks(relPath)
    backlinks.value = res.success && res.data ? res.data : []
  }

  /** 拉取全部标签 */
  async function loadTags(): Promise<void> {
    const bridge = api()
    if (bridge === null) {
      tags.value = []
      return
    }
    const res = await bridge.getKnowledgeTags()
    tags.value = res.success && res.data ? res.data : []
  }

  /** 拉取断链清单 */
  async function loadUnresolved(): Promise<void> {
    const bridge = api()
    if (bridge === null) {
      unresolved.value = []
      return
    }
    const res = await bridge.getUnresolvedLinks()
    unresolved.value = res.success && res.data ? res.data : []
  }

  /** 某个标签下的笔记（含各自来源） */
  async function loadNotesByTag(tag: string): Promise<TagNote[]> {
    const bridge = api()
    if (bridge === null) return []
    const res = await bridge.getNotesByTag(tag)
    return res.success && res.data ? res.data : []
  }

  /**
   * 结构化查询
   *
   * 查询语义在主进程解释；渲染层只组装条件。索引未就绪时文本搜索仍可用。
   */
  async function search(query: KnowledgeQuery): Promise<SearchHit[]> {
    const bridge = api()
    if (bridge === null) return []
    const res = await bridge.searchKnowledge(query)
    if (!res.success) {
      error.value = res.error ?? '搜索失败'
      return []
    }
    error.value = null
    return res.data ?? []
  }

  /** 库内容发生变化（重命名/移动/外部修改）后刷新全部派生数据 */
  async function refreshAll(): Promise<void> {
    await refreshStatus()
    await Promise.all([loadTags(), loadUnresolved()])
    if (backlinksPath.value !== null) await loadBacklinks(backlinksPath.value)
  }

  function clear(): void {
    status.value = idleStatus()
    backlinks.value = []
    backlinksPath.value = null
    tags.value = []
    unresolved.value = []
    error.value = null
  }

  /** 应用启动时调用一次：绑定工作区与当前笔记 */
  function init(): void {
    // 未暴露知识库 API 时不做任何订阅，整个知识库功能静默降级
    if (api() === null) return

    const fileStore = useFileStore()

    watch(
      () => fileStore.openedFolderPath,
      async (folderPath) => {
        if (!folderPath) {
          clear()
          return
        }
        await ensureIndex()
        await Promise.all([loadTags(), loadUnresolved()])
      },
      { immediate: true }
    )

    stopProgress = window.electronAPI.onKnowledgeProgress((progress) => {
      status.value = {
        ...status.value,
        state: progress.phase === 'idle' ? status.value.state : 'building',
        progress
      }
      // 构建结束时回读一次权威状态（fileCount / degraded）
      if (progress.phase === 'idle') void refreshStatus()
    })

    watch(
      activeRelPath,
      async (relPath) => {
        if (relPath === null) {
          backlinks.value = []
          backlinksPath.value = null
          return
        }
        await loadBacklinks(relPath)
      },
      { immediate: true }
    )
  }

  /** 解除进度订阅（应用卸载时调用） */
  function dispose(): void {
    stopProgress?.()
    stopProgress = null
  }

  return {
    status,
    backlinks,
    backlinksPath,
    tags,
    unresolved,
    loading,
    error,
    building,
    degraded,
    brokenCount,
    root,
    activeRelPath,
    resolveAbsolute,
    refreshStatus,
    ensureIndex,
    rebuildIndex,
    loadBacklinks,
    loadTags,
    loadUnresolved,
    loadNotesByTag,
    search,
    refreshAll,
    clear,
    init,
    dispose
  }
})
