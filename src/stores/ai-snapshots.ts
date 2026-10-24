import { ref } from 'vue'
import { defineStore } from 'pinia'
import { rollbackAiSnapshot } from '../utils/ai/snapshot'

/**
 * 可回滚的 AI 运行列表。
 *
 * 列表来自 `.inkase/snapshots` 的 manifest；只在需要显示「回滚」入口时懒加载。
 */
export const useSnapshotStore = defineStore('ai-snapshots', () => {
  const availableRuns = ref<string[]>([])
  const error = ref<string | null>(null)
  let loaded = false
  let loading = false

  function has(runId: string): boolean {
    return availableRuns.value.includes(runId)
  }

  function markAvailable(runId: string): void {
    if (!availableRuns.value.includes(runId)) availableRuns.value.push(runId)
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded || loading) return
    if (!window.electronAPI) {
      loaded = true
      return
    }
    loading = true
    try {
      const response = await window.electronAPI.listAiSnapshots()
      if (response.success && response.data) {
        const runs = new Set(availableRuns.value)
        for (const summary of response.data) {
          if (!summary.rolledBackAt) runs.add(summary.runId)
        }
        availableRuns.value = [...runs]
      } else if (!response.success) {
        error.value = response.error || '读取 AI 快照失败'
      }
      loaded = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '读取 AI 快照失败'
    } finally {
      loading = false
    }
  }

  async function rollback(runId: string): Promise<number> {
    error.value = null
    try {
      const restored = await rollbackAiSnapshot(runId)
      if (restored > 0) availableRuns.value = availableRuns.value.filter((id) => id !== runId)
      return restored
    } catch (err) {
      error.value = err instanceof Error ? err.message : '回滚失败'
      return 0
    }
  }

  function reset(): void {
    availableRuns.value = []
    error.value = null
    loaded = false
    loading = false
  }

  return { availableRuns, error, has, markAvailable, ensureLoaded, rollback, reset }
})
