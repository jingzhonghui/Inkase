import { onBeforeUnmount } from 'vue'
import { useAppearanceStore } from '../stores/appearance'

/**
 * 编辑器字号缩放 Composable
 *
 * 在指定元素上注册 Ctrl + 滚轮 监听：
 * - Ctrl 按下时阻止默认缩放行为，改为步进调整编辑区字号（±1）
 * - 与 PDF/图片查看器的 Ctrl+滚轮缩放交互保持一致
 */

function handleWheel(event: WheelEvent, onZoom: (delta: number) => void): void {
  if (!event.ctrlKey) return
  event.preventDefault()
  onZoom(event.deltaY < 0 ? 1 : -1)
}

/**
 * 在元素上挂载 Ctrl+滚轮 字号缩放，返回清理函数。
 * 若传入 Vue 组件生命周期上下文（在 setup 中调用），自动在卸载时清理。
 */
export function useEditorFontZoom() {
  const cleanups: Array<() => void> = []

  function attach(target: HTMLElement): void {
    const appearanceStore = useAppearanceStore()
    const listener = (event: WheelEvent): void => handleWheel(event, (delta) => {
      appearanceStore.zoomEditorFontSize(delta)
    })
    target.addEventListener('wheel', listener, { passive: false })
    cleanups.push(() => target.removeEventListener('wheel', listener))
  }

  function dispose(): void {
    while (cleanups.length) {
      cleanups.pop()?.()
    }
  }

  onBeforeUnmount(dispose)

  return { attach, dispose }
}
