import { ref } from 'vue'
import { defineStore } from 'pinia'

const APPEARANCE_STORAGE_KEY = 'inkase-appearance'

export const DEFAULT_UI_FONT_SIZE = 13
export const MIN_UI_FONT_SIZE = 12
export const MAX_UI_FONT_SIZE = 18

export const DEFAULT_EDITOR_FONT_SIZE = 16
export const MIN_EDITOR_FONT_SIZE = 12
export const MAX_EDITOR_FONT_SIZE = 24

interface AppearanceState {
  uiFontSize: number
  editorFontSize: number
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 外观设置 Store：编辑区字号 + 主界面字号
 * 通过 CSS 变量（--editor-font-size / --ui-font-size）应用到文档根节点。
 */
export const useAppearanceStore = defineStore('appearance', () => {
  const uiFontSize = ref<number>(DEFAULT_UI_FONT_SIZE)
  const editorFontSize = ref<number>(DEFAULT_EDITOR_FONT_SIZE)

  /** 将当前字号写入文档根节点的 CSS 变量 */
  function applyToDocument(): void {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.style.setProperty('--ui-font-size', `${uiFontSize.value}px`)
    root.style.setProperty('--editor-font-size', `${editorFontSize.value}px`)
  }

  function saveAppearance(): void {
    try {
      const state: AppearanceState = {
        uiFontSize: uiFontSize.value,
        editorFontSize: editorFontSize.value
      }
      localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 忽略存储错误
    }
  }

  function loadAppearance(): void {
    try {
      const saved = localStorage.getItem(APPEARANCE_STORAGE_KEY)
      if (!saved) return
      const parsed = JSON.parse(saved) as Partial<AppearanceState>
      if (parsed.uiFontSize !== undefined) {
        uiFontSize.value = clamp(parsed.uiFontSize, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE, DEFAULT_UI_FONT_SIZE)
      }
      if (parsed.editorFontSize !== undefined) {
        editorFontSize.value = clamp(
          parsed.editorFontSize,
          MIN_EDITOR_FONT_SIZE,
          MAX_EDITOR_FONT_SIZE,
          DEFAULT_EDITOR_FONT_SIZE
        )
      }
    } catch {
      // 忽略解析错误
    }
  }

  function setUiFontSize(value: number): void {
    uiFontSize.value = clamp(value, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE, DEFAULT_UI_FONT_SIZE)
    applyToDocument()
    saveAppearance()
  }

  function setEditorFontSize(value: number): void {
    editorFontSize.value = clamp(value, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, DEFAULT_EDITOR_FONT_SIZE)
    applyToDocument()
    saveAppearance()
  }

  function initAppearance(): void {
    loadAppearance()
    applyToDocument()
  }

  return {
    uiFontSize,
    editorFontSize,
    setUiFontSize,
    setEditorFontSize,
    initAppearance
  }
})
