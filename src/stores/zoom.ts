import { reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { DocumentFormat } from '../types/mdx'
import { MINDMAP_ZOOM_MAX, MINDMAP_ZOOM_MIN } from '../utils/mindmap/viewport'

/**
 * 缩放（zoom）：一处定义范围、一处保存数值。
 *
 * 为什么要一个中央 store，而不是各视图自己存：
 * 缩放读数现在统一显示在底部状态栏的右下角，状态栏与视图是两棵互不相邻的组件树。
 * 若数值仍留在视图内部，切标签时视图被 `:key` 销毁重建，状态栏就会「闪一下再归位」，
 * 也读不到别的视图的开与关。所以：
 *
 * - **能力（范围 / 步进 / 档位）**是静态的，按「视图种类」查表（`ZOOM_PROFILES`）；
 * - **数值**按标签页保存在这里（`values`），不落盘——关闭标签即丢弃，重开回到 100%。
 *
 * 三类视图的语义差别是刻意的：
 * - 图片 / PDF 是真缩放（1 = 100%，PDF 的 1 不等于「适应宽度」）；
 * - 文本（`md` / `mdx` / `sh` / `txt`）是**相对基准字号的倍率**：100% 表示用设置中心里
 *   字号设置的那个值，不是固定的 16px。实际字号 = 基准 × 倍率（见 `EditorPanel.vue`）；
 * - 思维导图沿用渲染库的乘法步进（×1.2），因为它的范围窄（20%–300%），
 *   用 ±25% 加法会走出 20 → 45 → 70 这种不整齐的序列。
 */

export type ZoomKind = 'image' | 'pdf' | 'text' | 'mindmap'

export interface ZoomProfile {
  kind: ZoomKind
  /** 下限（含） */
  min: number
  /** 上限（含） */
  max: number
  /** 步进值：`add` 模式下是增量，`multiply` 模式下是倍率 */
  step: number
  /** 按钮的步进方式 */
  stepMode: 'add' | 'multiply'
  /** 下拉框里的快捷档位（**不含**「适应」那一项，它由视图注册的动作提供） */
  presets: readonly number[]
  /** 下拉框里「适应」项的名称；没有这一项时传 null */
  fitLabel: string | null
  /** 状态栏悬停提示 */
  hint: string
}

/** 图片：本体尺寸不可知，100% 表示「整图刚好放进窗口」 */
export const IMAGE_ZOOM_PROFILE: ZoomProfile = {
  kind: 'image',
  min: 0.25,
  max: 8,
  step: 0.25,
  stepMode: 'add',
  presets: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8],
  fitLabel: '适应窗口',
  hint: '图片缩放'
}

/** PDF：100% 是 PDF 的 1:1，打开时默认「适应宽度」，所以初始读数未必是 100% */
export const PDF_ZOOM_PROFILE: ZoomProfile = {
  kind: 'pdf',
  min: 0.25,
  max: 5,
  step: 0.25,
  stepMode: 'add',
  presets: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5],
  fitLabel: '适应宽度',
  hint: 'PDF 缩放'
}

/** 文本：100% = 设置中心里「编辑器 → 字号」的当前值，不是固定 16px */
export const TEXT_ZOOM_PROFILE: ZoomProfile = {
  kind: 'text',
  min: 0.5,
  max: 3,
  step: 0.25,
  stepMode: 'add',
  presets: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3],
  fitLabel: null,
  hint: '正文缩放（相对设置里的字号）'
}

/** 思维导图：步进是乘法，与渲染库的缩放手感一致；范围沿用渲染库构造时的那一对 */
export const MINDMAP_ZOOM_PROFILE: ZoomProfile = {
  kind: 'mindmap',
  min: MINDMAP_ZOOM_MIN,
  max: MINDMAP_ZOOM_MAX,
  step: 1.2,
  stepMode: 'multiply',
  presets: [0.2, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.2, 1.5, 2, 2.5, 3],
  fitLabel: '适应画布',
  hint: '导图缩放'
}

/** 视图种类 → 能力表 */
export const ZOOM_PROFILES: Record<ZoomKind, ZoomProfile> = {
  image: IMAGE_ZOOM_PROFILE,
  pdf: PDF_ZOOM_PROFILE,
  text: TEXT_ZOOM_PROFILE,
  mindmap: MINDMAP_ZOOM_PROFILE
}

/**
 * 按标签页推导应使用的缩放能力；不支持缩放的视图返回 null。
 *
 * 不支持的有两类：`.drawio` 图表的缩放活在 iframe 里（跨域拿不到），
 * HTML 预览是浏览器式渲染（不提供缩放）。注意 HTML 的**源码态**仍按文本处理。
 */
export function resolveZoomProfile(input: {
  format: DocumentFormat | null | undefined
  isHtmlFile: boolean
  htmlPreviewActive: boolean
}): ZoomProfile | null {
  const { format, isHtmlFile, htmlPreviewActive } = input
  if (format === 'image') return IMAGE_ZOOM_PROFILE
  if (format === 'pdf') return PDF_ZOOM_PROFILE
  if (format === 'mindmap') return MINDMAP_ZOOM_PROFILE
  // 图表与 HTML 预览没有可控的缩放
  if (format === 'diagram') return null
  if (isHtmlFile && htmlPreviewActive) return null
  // 其余一律按文本处理（含 .txt / .sh 等纯文本）
  if (format === 'mdx' || format === 'markdown') return TEXT_ZOOM_PROFILE
  // 没有格式信息（空白标签）也按文本，避免缩放控件闪烁
  return format ? null : TEXT_ZOOM_PROFILE
}

/** 把数值夹到能力范围内，并归到 1% 精度（避免浮点累积出 128.00000001%） */
export function clampZoom(profile: ZoomProfile, value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const clamped = Math.min(profile.max, Math.max(profile.min, value))
  return Math.round(clamped * 100) / 100
}

/** 按能力表的步进方式走一档 */
export function stepZoom(profile: ZoomProfile, value: number, direction: 1 | -1): number {
  const current = Number.isFinite(value) && value > 0 ? value : 1
  const raw = profile.stepMode === 'multiply'
    ? (direction > 0 ? current * profile.step : current / profile.step)
    : current + direction * profile.step
  return clampZoom(profile, raw)
}

/** 缩放值 → 状态栏读数 */
export function formatZoomPercent(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 1
  return `${Math.round(safe * 100)}%`
}

/**
 * 「适应」动作的注册表。
 *
 * 「适应宽度 / 适应窗口 / 适应画布」与普通档位不同：它要拿到容器与内容的真实尺寸，
 * 只有视图自己算得出来。所以视图挂载时把自己的 `fit` 函数登记到这里的 tabId 上，
 * 状态栏点下拉里的那一项时回调过去。标签关闭或视图卸载即注销。
 */
export const useZoomStore = defineStore('zoom', () => {
  /** tabId → 缩放倍率；不落盘 */
  const values = reactive<Record<string, number>>({})
  /** tabId → 「适应」动作 */
  const fits = new Map<string, () => void>()
  /**
   * 「适应」动作的登记版本。
   *
   * `fits` 只是个普通 Map，本身不参与响应式；状态栏读 `hasFit` 决定下拉里要不要
   * 出「适应宽度」那一项，视图挂载得比状态栏首次渲染晚时就会一直读不到。
   * 用这个计数器把 Map 的变更也纳入依赖收集。
   */
  const fitRevision = ref(0)

  /** 读取某标签的倍率；没设过返回 undefined（视图据此判断是否需要初始化） */
  function raw(tabId: string | null | undefined): number | undefined {
    if (!tabId) return undefined
    return values[tabId]
  }

  /** 读取倍率，缺省按 100% */
  function valueOf(tabId: string | null | undefined): number {
    return raw(tabId) ?? 1
  }

  function set(tabId: string | null | undefined, value: number, profile: ZoomProfile): void {
    if (!tabId) return
    values[tabId] = clampZoom(profile, value)
  }

  /** 走一档，返回新值 */
  function step(tabId: string | null | undefined, profile: ZoomProfile, direction: 1 | -1): number {
    const next = stepZoom(profile, valueOf(tabId), direction)
    set(tabId, next, profile)
    return next
  }

  function reset(tabId: string | null | undefined, profile: ZoomProfile): void {
    set(tabId, 1, profile)
  }

  function clear(tabId: string): void {
    delete values[tabId]
    if (fits.delete(tabId)) fitRevision.value++
  }

  /** 清掉已经不在标签列表里的项 */
  function prune(activeIds: readonly string[]): void {
    const keep = new Set(activeIds)
    for (const key of Object.keys(values)) {
      if (!keep.has(key)) delete values[key]
    }
    let fitChanged = false
    for (const key of Array.from(fits.keys())) {
      if (!keep.has(key)) {
        fits.delete(key)
        fitChanged = true
      }
    }
    if (fitChanged) fitRevision.value++
  }

  /** 视图登记「适应」动作，返回注销函数 */
  function registerFit(tabId: string | null | undefined, fit: () => void): () => void {
    if (!tabId) return () => {}
    fits.set(tabId, fit)
    fitRevision.value++
    return () => {
      if (fits.get(tabId) === fit) {
        fits.delete(tabId)
        fitRevision.value++
      }
    }
  }

  /** 当前标签是否有可用的「适应」动作 */
  function hasFit(tabId: string | null | undefined): boolean {
    // 读一下计数器，让调用方的 computed 跟着登记变化更新
    fitRevision.value
    return !!tabId && fits.has(tabId)
  }

  /** 触发当前标签的「适应」动作 */
  function requestFit(tabId: string | null | undefined): void {
    if (!tabId) return
    fits.get(tabId)?.()
  }

  return {
    values,
    raw,
    valueOf,
    set,
    step,
    reset,
    clear,
    prune,
    registerFit,
    hasFit,
    requestFit
  }
})
