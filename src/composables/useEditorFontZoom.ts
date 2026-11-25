import { onBeforeUnmount } from 'vue'
import { useFileStore } from '../stores/file'
import { TEXT_ZOOM_PROFILE, useZoomStore } from '../stores/zoom'

/**
 * 编辑区缩放 Composable
 *
 * 在指定元素上注册 Ctrl + 滚轮 监听，步进**当前标签页**的正文缩放倍率。
 *
 * 与旧版的关键差别：以前这里调的是 `appearanceStore.zoomEditorFontSize`，
 * 改的是全局字号（写 localStorage、所有文档一起变）。现在缩放是「按标签页」的，
 * 只影响当前标签；100% 仍然等于设置中心里的字号（见 `EditorPanel.vue` 的
 * `--editor-zoom`），两者不再互相覆盖。
 */

function handleWheel(event: WheelEvent, onZoom: (delta: number) => void): void {
  if (!event.ctrlKey) return
  event.preventDefault()
  onZoom(event.deltaY < 0 ? 1 : -1)
}

/**
 * 在元素上挂载 Ctrl+滚轮 缩放，返回清理函数。
 * 若传入 Vue 组件生命周期上下文（在 setup 中调用），自动在卸载时清理。
 */
export function useEditorFontZoom() {
  const cleanups: Array<() => void> = []

  function attach(target: HTMLElement): void {
    const listener = (event: WheelEvent): void => handleWheel(event, (delta) => {
      const fileStore = useFileStore()
      const zoomStore = useZoomStore()
      zoomStore.step(fileStore.activeTabId, TEXT_ZOOM_PROFILE, delta > 0 ? 1 : -1)
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
