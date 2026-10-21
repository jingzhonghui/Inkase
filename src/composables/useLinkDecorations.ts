/**
 * `[[链接]]` 装饰与跳转（IR / 源码模式共用）
 *
 * 两个编辑器对「哪些区间是链接、什么状态、点了往哪跳」必须给出一致答案，
 * 因此解析结果的获取、缓存与跳转行为都收敛在这里，编辑器只负责把
 * `decorations` 翻译成自己的装饰类型。
 *
 * 解析语义在主进程（设计文档 §5.2），这里只做缓存与去重：
 * 目标集合变化时才发起一次批量请求。
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { LinkResolution, NoteEntry } from '../../shared/knowledge/types'
import { useFileStore } from '../stores/file'
import { useKnowledgeStore } from '../stores/knowledge'
import { requestDialog } from '../utils/dialog'
import { collectLinkDecorations, type LinkDecoration } from '../utils/prosemirror/link-decorations'

/** 歧义链接最多列出的候选数（避免对话框被撑爆） */
const MAX_CANDIDATES = 5

export interface LinkDecorationsApi {
  /** 当前文档的全部链接区间 */
  decorations: ComputedRef<LinkDecoration[]>
  /** 同步取解析结果；未知目标按正常色显示，避免每次输入闪烁 */
  resolve: (target: string) => LinkResolution
  /** 跳转到链接目标（歧义时让用户选，绝不静默取第一个） */
  openLink: (target: string) => Promise<void>
  /** `[[` 自动补全候选 */
  candidates: ComputedRef<NoteEntry[]>
  /** 索引变化后清空解析缓存，强制重新解析 */
  invalidate: () => void
  /** 解析结果缓存（IR 模式据此重建 doc 位置上的装饰） */
  resolutionCache: Ref<Record<string, LinkResolution>>
}

/**
 * @param text 当前文档文本（响应式）
 */
export function useLinkDecorations(text: Ref<string>): LinkDecorationsApi {
  const knowledge = useKnowledgeStore()
  const fileStore = useFileStore()

  const resolutions = ref<Record<string, LinkResolution>>({})

  const resolve = (target: string): LinkResolution =>
    resolutions.value[target] ?? { status: 'resolved' }

  const decorations = computed<LinkDecoration[]>(() => collectLinkDecorations(text.value, resolve))

  /** 去重后的目标集合，作为「是否需要重新解析」的判据 */
  const targetKey = computed(() => {
    const set = new Set<string>()
    for (const deco of decorations.value) {
      if (deco.target !== '') set.add(deco.target)
    }
    return [...set].sort().join('\n')
  })

  async function resolveMissing(targets: string[]): Promise<void> {
    const missing = targets.filter((target) => resolutions.value[target] === undefined)
    if (missing.length === 0) return

    const result = await knowledge.resolveTargets(missing, knowledge.activeRelPath ?? undefined)
    resolutions.value = { ...resolutions.value, ...result }
  }

  watch(
    targetKey,
    (key) => {
      if (key === '') return
      void resolveMissing(key.split('\n'))
    },
    { immediate: true }
  )

  // 索引重建/库内容变化后，之前的解析结果可能已经过期
  watch(
    () => knowledge.status.fileCount,
    () => {
      resolutions.value = {}
    }
  )

  const candidates = computed<NoteEntry[]>(() => knowledge.notes)

  function openPath(relPath: string): void {
    const absolute = knowledge.resolveAbsolute(relPath)
    if (absolute === null) return
    void fileStore.openFile(absolute, { addToRecent: false })
  }

  async function openLink(target: string): Promise<void> {
    if (target === '') return

    let resolution = resolutions.value[target]
    if (resolution === undefined) {
      const result = await knowledge.resolveTargets([target], knowledge.activeRelPath ?? undefined)
      resolutions.value = { ...resolutions.value, ...result }
      resolution = result[target]
    }

    if (resolution === undefined || resolution.status === 'missing') {
      await requestDialog({
        title: '链接目标不存在',
        message: `[[${target}]] 在库内找不到对应笔记`,
        detail: '断链会以警示色标出。可以改成已有笔记名，或新建同名笔记后再试。',
        buttons: [{ label: '知道了', value: 0, primary: true }]
      })
      return
    }

    if (resolution.status === 'ambiguous') {
      const shown = resolution.candidates.slice(0, MAX_CANDIDATES)
      const choice = await requestDialog({
        title: '链接有多个候选',
        message: `[[${target}]] 匹配到 ${resolution.candidates.length} 篇笔记`,
        detail: '请选择要打开的一篇。建议把链接改写为完整路径以消除歧义。',
        buttons: [
          ...shown.map((candidate, index) => ({ label: candidate, value: index })),
          { label: '取消', value: -1 }
        ]
      })
      const picked = shown[choice]
      if (picked !== undefined) openPath(picked)
      return
    }

    openPath(resolution.targetPath)
  }

  return {
    decorations,
    resolve,
    openLink,
    candidates,
    resolutionCache: resolutions,
    invalidate: () => {
      resolutions.value = {}
    }
  }
}
