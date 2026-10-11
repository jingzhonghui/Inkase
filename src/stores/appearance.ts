import { ref } from 'vue'
import { defineStore } from 'pinia'

const APPEARANCE_STORAGE_KEY = 'inkase-appearance'

export const DEFAULT_UI_FONT_SIZE = 13
export const MIN_UI_FONT_SIZE = 12
export const MAX_UI_FONT_SIZE = 18

export const DEFAULT_EDITOR_FONT_SIZE = 16
export const MIN_EDITOR_FONT_SIZE = 12
export const MAX_EDITOR_FONT_SIZE = 24

export const DEFAULT_EDITOR_LINE_HEIGHT = 1.8
export const MIN_EDITOR_LINE_HEIGHT = 1.4
export const MAX_EDITOR_LINE_HEIGHT = 2.2

/** 空字符串表示跟随系统默认字体（不注入变量） */
export const DEFAULT_EDITOR_FONT_FAMILY = ''
export const DEFAULT_EDITOR_MONO_FONT_FAMILY = ''

/** 编辑器正文字体预设（sans），value 为合法的 CSS font-family 值 */
export const EDITOR_FONT_FAMILY_PRESETS: Array<{ label: string; value: string }> = [
  { label: '跟随系统', value: '' },
  { label: '微软雅黑', value: "'Microsoft YaHei'" },
  { label: '苹方', value: "'PingFang SC'" },
  { label: '思源黑体', value: "'Source Han Sans SC', 'Noto Sans SC'" },
  { label: '宋体', value: "'SimSun'" },
  { label: '黑体', value: "'SimHei'" },
  { label: '楷体', value: "'KaiTi'" },
  { label: '等线', value: "'DengXian'" },
  { label: 'Segoe UI', value: "'Segoe UI'" },
  { label: '自定义…', value: '__custom__' }
]

/** 编辑器代码/源码字体预设（mono） */
export const EDITOR_MONO_FONT_FAMILY_PRESETS: Array<{ label: string; value: string }> = [
  { label: '跟随系统', value: '' },
  { label: 'Cascadia Code', value: "'Cascadia Code'" },
  { label: 'Consolas', value: "'Consolas'" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono'" },
  { label: 'Source Code Pro', value: "'Source Code Pro'" },
  { label: 'Courier New', value: "'Courier New'" },
  { label: '自定义…', value: '__custom__' }
]

/** 预设中「自定义…」选项的哨兵值 */
export const CUSTOM_FONT_SENTINEL = '__custom__'

interface AppearanceState {
  uiFontSize: number
  editorFontSize: number
  editorFontFamily: string
  editorMonoFontFamily: string
  editorLineHeight: number
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 行高等小数用钳制：保留一位小数，不用 Math.round 吞掉小数部分 */
function clampFloat(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  const rounded = Math.round(Math.min(max, Math.max(min, value)) * 10) / 10
  return rounded
}

/** 字体族字符串校验：非字符串或超长视为非法，回退默认 */
function sanitizeFontFamily(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length > 200) return fallback
  return trimmed
}

/**
 * 外观设置 Store：编辑区字号/字体族/行高 + 主界面字号
 * 通过 CSS 变量（--editor-font-size / --ui-font-size 等）应用到文档根节点。
 */
export const useAppearanceStore = defineStore('appearance', () => {
  const uiFontSize = ref<number>(DEFAULT_UI_FONT_SIZE)
  const editorFontSize = ref<number>(DEFAULT_EDITOR_FONT_SIZE)
  const editorFontFamily = ref<string>(DEFAULT_EDITOR_FONT_FAMILY)
  const editorMonoFontFamily = ref<string>(DEFAULT_EDITOR_MONO_FONT_FAMILY)
  const editorLineHeight = ref<number>(DEFAULT_EDITOR_LINE_HEIGHT)

  /** 将当前设置写入文档根节点的 CSS 变量（空字体值移除变量以恢复默认） */
  function applyToDocument(): void {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.style.setProperty('--ui-font-size', `${uiFontSize.value}px`)
    root.style.setProperty('--editor-font-size', `${editorFontSize.value}px`)
    if (editorFontFamily.value) {
      root.style.setProperty('--editor-font-family', editorFontFamily.value)
    } else {
      root.style.removeProperty('--editor-font-family')
    }
    if (editorMonoFontFamily.value) {
      root.style.setProperty('--editor-mono-font-family', editorMonoFontFamily.value)
    } else {
      root.style.removeProperty('--editor-mono-font-family')
    }
    root.style.setProperty('--editor-line-height', `${editorLineHeight.value}`)
  }

  function saveAppearance(): void {
    try {
      const state: AppearanceState = {
        uiFontSize: uiFontSize.value,
        editorFontSize: editorFontSize.value,
        editorFontFamily: editorFontFamily.value,
        editorMonoFontFamily: editorMonoFontFamily.value,
        editorLineHeight: editorLineHeight.value
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
      if (parsed.editorFontFamily !== undefined) {
        editorFontFamily.value = sanitizeFontFamily(parsed.editorFontFamily, DEFAULT_EDITOR_FONT_FAMILY)
      }
      if (parsed.editorMonoFontFamily !== undefined) {
        editorMonoFontFamily.value = sanitizeFontFamily(
          parsed.editorMonoFontFamily,
          DEFAULT_EDITOR_MONO_FONT_FAMILY
        )
      }
      if (parsed.editorLineHeight !== undefined) {
        editorLineHeight.value = clampFloat(
          parsed.editorLineHeight,
          MIN_EDITOR_LINE_HEIGHT,
          MAX_EDITOR_LINE_HEIGHT,
          DEFAULT_EDITOR_LINE_HEIGHT
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

  /** Ctrl+滚轮缩放：在当前字号基础上步进 ±1，夹紧到允许范围 */
  function zoomEditorFontSize(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return
    const step = delta > 0 ? 1 : -1
    setEditorFontSize(editorFontSize.value + step)
  }

  function setEditorFontFamily(value: string): void {
    editorFontFamily.value = sanitizeFontFamily(value, DEFAULT_EDITOR_FONT_FAMILY)
    applyToDocument()
    saveAppearance()
  }

  function setEditorMonoFontFamily(value: string): void {
    editorMonoFontFamily.value = sanitizeFontFamily(value, DEFAULT_EDITOR_MONO_FONT_FAMILY)
    applyToDocument()
    saveAppearance()
  }

  function setEditorLineHeight(value: number): void {
    editorLineHeight.value = clampFloat(value, MIN_EDITOR_LINE_HEIGHT, MAX_EDITOR_LINE_HEIGHT, DEFAULT_EDITOR_LINE_HEIGHT)
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
    editorFontFamily,
    editorMonoFontFamily,
    editorLineHeight,
    setUiFontSize,
    setEditorFontSize,
    zoomEditorFontSize,
    setEditorFontFamily,
    setEditorMonoFontFamily,
    setEditorLineHeight,
    initAppearance
  }
})
