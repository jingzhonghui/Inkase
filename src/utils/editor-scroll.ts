/**
 * 编辑器滚动位置工具。
 *
 * 源码 / 即时渲染 / 分屏三种模式在切换时组件会整体卸载重建（EditorPanel 用 v-if 分支），
 * 而各模式的滚动像素值不可直接复用：行高、换行宽度、代码块与图片高度都不同。
 *
 * 因此恢复位置优先用「文档行号」锚点（见 anchorLine），只有拿不到锚点时才退回
 * 滚动比例；比例在同宽布局下可用，跨布局会随换行宽度漂移。
 */

import type { EditorMode, TabInfo } from '../stores/file/types'

/** 读取容器的滚动进度；容器没有可滚动空间（或尚未布局）时返回 null。 */
export function readScrollRatio(element: HTMLElement | null | undefined): number | null {
  if (!element) return null
  const max = element.scrollHeight - element.clientHeight
  if (max <= 0) return null
  return Math.min(Math.max(element.scrollTop / max, 0), 1)
}

/**
 * 把容器当前滚动状态写进标签的 savedEditorPosition。
 * 同时记录像素与比例：同一模式用像素（精确），跨模式用比例兜底；
 * 真正的跨模式定位靠 anchorLine（由各编辑器另行写入）。
 */
export function saveScrollPosition(
  tab: TabInfo | null | undefined,
  element: HTMLElement | null | undefined,
  mode: EditorMode
): void {
  if (!tab || !element) return
  const ratio = readScrollRatio(element)
  const prev = tab.savedEditorPosition
  if (ratio == null && !prev) return
  tab.savedEditorPosition = {
    scrollTop: element.scrollTop > 0 ? element.scrollTop : (prev?.scrollTop ?? 0),
    scrollRatio: ratio ?? prev?.scrollRatio,
    anchorLine: prev?.anchorLine,
    anchorOffsetPx: prev?.anchorOffsetPx,
    mode,
    // 选区偏移由 IrEditor 以 ProseMirror 位置维护，其它编辑器不覆盖，避免两套坐标混用
    from: prev?.from ?? 0,
    to: prev?.to ?? 0
  }
}

/** 计算兜底恢复目标：同模式用像素，跨模式用比例。 */
export function scrollRestoreTarget(
  saved: TabInfo['savedEditorPosition'],
  mode: EditorMode
): ScrollRestoreTarget | null {
  if (!saved) return null
  if (saved.mode === mode && saved.scrollTop > 0) return { top: saved.scrollTop }
  if (saved.scrollRatio != null) return { ratio: saved.scrollRatio }
  return { top: saved.scrollTop }
}

/** Markdown 文本偏移 → 行号（1 基）。 */
export function lineFromOffset(content: string, offset: number): number {
  const clamped = Math.min(Math.max(offset, 0), content.length)
  let line = 1
  for (let i = 0; i < clamped; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++
  }
  return line
}

/** 行号（1 基）→ 该行行首的 Markdown 文本偏移；越界时夹到首/末行。 */
export function offsetForLine(content: string, line: number): number {
  const lines = content.split('\n')
  const target = Math.min(Math.max(1, Math.floor(line)), lines.length) - 1
  let offset = 0
  for (let i = 0; i < target; i++) offset += lines[i].length + 1
  return offset
}

export interface ScrollRestoreTarget {
  /** 进度比例（0..1），兜底用 */
  ratio?: number
  /** 像素偏移，同模式恢复用 */
  top?: number
  /**
   * 动态解析目标像素（例如按行号找块元素）。返回 null 表示布局还没就绪，稍后重试；
   * 优先于 ratio / top。
   */
  resolve?: () => number | null
}

export interface ScrollRestoreOptions {
  /** 重试次数（组件刚重建时布局可能尚未就绪，scrollHeight/clientHeight 为 0） */
  attempts?: number
  /** 每次重试间隔（ms） */
  interval?: number
  /** 恢复结束（到位、次数用尽或被取消）时回调；用于解除期间的滚动同步抑制 */
  onDone?: () => void
}

/**
 * 把容器滚动到指定位置；布局未就绪时按 interval 重试，直到真正生效或次数用尽。
 * 返回取消函数：用户主动滚动、切换内容或组件卸载时应调用。
 */
export function restoreScroll(
  element: HTMLElement | null | undefined,
  target: ScrollRestoreTarget,
  options: ScrollRestoreOptions = {}
): () => void {
  const attempts = options.attempts ?? 40
  const interval = options.interval ?? 50
  let remaining = attempts
  let cancelled = false
  let finished = false

  const finish = (): void => {
    if (finished) return
    finished = true
    options.onDone?.()
  }

  const tick = (): void => {
    if (cancelled || !element) return finish()
    const max = Math.max(0, element.scrollHeight - element.clientHeight)

    let desired: number | null
    if (target.resolve) {
      desired = target.resolve()
      if (desired == null) {
        if (remaining > 0) {
          remaining -= 1
          setTimeout(tick, interval)
        } else {
          finish()
        }
        return
      }
    } else if (target.ratio != null) {
      desired = Math.min(Math.max(target.ratio, 0), 1) * max
    } else {
      desired = Math.max(0, target.top ?? 0)
    }

    const clamped = Math.min(desired, max)
    element.scrollTop = clamped

    const settled = max > 0 && Math.abs(element.scrollTop - clamped) < 1
    if (settled || remaining <= 0) {
      finish()
      return
    }
    remaining -= 1
    setTimeout(tick, interval)
  }

  tick()
  return () => {
    cancelled = true
    finish()
  }
}

/**
 * 恢复滚动位置：把 element 的**顶边**放回它在保存时的屏幕位置（offsetPx 为当时的
 * elementRect.top - containerRect.top，可为负）。
 *
 * 锚点取「视口里最下面那个文本块」，所以对齐顶边就能把你正在读的那句留在原处；
 * 它上方的内容高度怎么变（图片缩放、段落换行）都不影响这句。
 */
export function scrollTargetForViewportOffset(
  container: HTMLElement,
  element: HTMLElement,
  offsetPx: number
): number | null {
  const contentTop = elementTopWithin(container, element)
  if (contentTop == null) return null
  return Math.max(0, contentTop - offsetPx)
}

/**
 * 元素的顶部相对滚动容器内容起点（可直接赋给 scrollTop）的像素距离。
 * 布局未就绪（元素没有高度）时返回 null，让恢复循环稍后重试。
 */
export function elementTopWithin(
  container: HTMLElement | null | undefined,
  element: HTMLElement | null | undefined
): number | null {
  if (!container || !element) return null
  const elementRect = element.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  if (elementRect.height <= 0 && elementRect.top === 0 && containerRect.top === 0) return null
  return elementRect.top - containerRect.top + container.scrollTop
}
