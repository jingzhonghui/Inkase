import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  useAppearanceStore,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EDITOR_FONT_FAMILY,
  DEFAULT_EDITOR_MONO_FONT_FAMILY,
  DEFAULT_EDITOR_LINE_HEIGHT,
  MIN_UI_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_LINE_HEIGHT,
  MAX_EDITOR_LINE_HEIGHT
} from '../appearance'

function stubEnvironment(getItemValue: string | null = null) {
  const setProperty = vi.fn()
  const removeProperty = vi.fn()
  vi.stubGlobal('document', {
    documentElement: { style: { setProperty, removeProperty } }
  })
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => getItemValue),
    setItem: vi.fn()
  })
  return { setProperty, removeProperty }
}

describe('appearance store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubEnvironment()
  })

  it('exposes defaults', () => {
    const store = useAppearanceStore()
    expect(store.uiFontSize).toBe(DEFAULT_UI_FONT_SIZE)
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE)
    expect(store.editorFontFamily).toBe(DEFAULT_EDITOR_FONT_FAMILY)
    expect(store.editorMonoFontFamily).toBe(DEFAULT_EDITOR_MONO_FONT_FAMILY)
    expect(store.editorLineHeight).toBe(DEFAULT_EDITOR_LINE_HEIGHT)
  })

  it('applies css variables to the document root on init', () => {
    stubEnvironment()
    const store = useAppearanceStore()

    store.initAppearance()

    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
      '--ui-font-size',
      `${DEFAULT_UI_FONT_SIZE}px`
    )
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
      '--editor-font-size',
      `${DEFAULT_EDITOR_FONT_SIZE}px`
    )
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
      '--editor-line-height',
      `${DEFAULT_EDITOR_LINE_HEIGHT}`
    )
  })

  it('removes font family variables when unset', () => {
    const { removeProperty } = stubEnvironment()
    const store = useAppearanceStore()

    store.initAppearance()

    expect(removeProperty).toHaveBeenCalledWith('--editor-font-family')
    expect(removeProperty).toHaveBeenCalledWith('--editor-mono-font-family')
  })

  it('loads persisted values', () => {
    stubEnvironment(JSON.stringify({ uiFontSize: 15, editorFontSize: 20 }))
    const store = useAppearanceStore()

    store.initAppearance()

    expect(store.uiFontSize).toBe(15)
    expect(store.editorFontSize).toBe(20)
  })

  it('loads persisted font family and line height', () => {
    stubEnvironment(JSON.stringify({
      editorFontFamily: "'Microsoft YaHei'",
      editorMonoFontFamily: "'JetBrains Mono'",
      editorLineHeight: 2
    }))
    const store = useAppearanceStore()

    store.initAppearance()

    expect(store.editorFontFamily).toBe("'Microsoft YaHei'")
    expect(store.editorMonoFontFamily).toBe("'JetBrains Mono'")
    expect(store.editorLineHeight).toBe(2)
  })

  it('applies font family css variables when set', () => {
    stubEnvironment()
    const store = useAppearanceStore()

    store.setEditorFontFamily("'Microsoft YaHei'")
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
      '--editor-font-family',
      "'Microsoft YaHei'"
    )

    store.setEditorMonoFontFamily("'JetBrains Mono'")
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
      '--editor-mono-font-family',
      "'JetBrains Mono'"
    )

    store.setEditorLineHeight(1.5)
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith('--editor-line-height', '1.5')
  })

  it('removes font family variables when reset to default', () => {
    const { removeProperty } = stubEnvironment()
    const store = useAppearanceStore()

    store.setEditorFontFamily("'Microsoft YaHei'")
    store.setEditorFontFamily('')
    expect(removeProperty).toHaveBeenCalledWith('--editor-font-family')

    store.setEditorMonoFontFamily("'JetBrains Mono'")
    store.setEditorMonoFontFamily('')
    expect(removeProperty).toHaveBeenCalledWith('--editor-mono-font-family')
  })

  it('clamps out-of-range values', () => {
    const store = useAppearanceStore()

    store.setUiFontSize(999)
    expect(store.uiFontSize).toBe(MAX_UI_FONT_SIZE)
    store.setUiFontSize(1)
    expect(store.uiFontSize).toBe(MIN_UI_FONT_SIZE)

    store.setEditorFontSize(999)
    expect(store.editorFontSize).toBe(MAX_EDITOR_FONT_SIZE)
    store.setEditorFontSize(1)
    expect(store.editorFontSize).toBe(MIN_EDITOR_FONT_SIZE)

    store.setEditorLineHeight(99)
    expect(store.editorLineHeight).toBe(MAX_EDITOR_LINE_HEIGHT)
    store.setEditorLineHeight(0.5)
    expect(store.editorLineHeight).toBe(MIN_EDITOR_LINE_HEIGHT)
  })

  it('keeps one decimal place for line height', () => {
    const store = useAppearanceStore()

    store.setEditorLineHeight(1.55)
    expect(store.editorLineHeight).toBe(1.6)
    store.setEditorLineHeight(1.949)
    expect(store.editorLineHeight).toBe(1.9)
  })

  it('falls back to defaults for invalid input', () => {
    const store = useAppearanceStore()

    store.setUiFontSize(Number.NaN)
    expect(store.uiFontSize).toBe(DEFAULT_UI_FONT_SIZE)
    store.setEditorFontSize(Number.NaN)
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE)
    store.setEditorLineHeight(Number.NaN)
    expect(store.editorLineHeight).toBe(DEFAULT_EDITOR_LINE_HEIGHT)
  })

  it('falls back to defaults for invalid font family input', () => {
    const store = useAppearanceStore()

    store.setEditorFontFamily(123 as unknown as string)
    expect(store.editorFontFamily).toBe(DEFAULT_EDITOR_FONT_FAMILY)
    store.setEditorFontFamily('x'.repeat(300))
    expect(store.editorFontFamily).toBe(DEFAULT_EDITOR_FONT_FAMILY)
    store.setEditorMonoFontFamily(undefined as unknown as string)
    expect(store.editorMonoFontFamily).toBe(DEFAULT_EDITOR_MONO_FONT_FAMILY)
  })

  it('trims whitespace on font family input', () => {
    const store = useAppearanceStore()

    store.setEditorFontFamily("  'SimSun'  ")
    expect(store.editorFontFamily).toBe("'SimSun'")
  })

  it('zooms editor font size by ±1 within bounds', () => {
    const store = useAppearanceStore()

    store.zoomEditorFontSize(1)
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE + 1)
    store.zoomEditorFontSize(-1)
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE)

    // 超大 delta 也只按一次滚动步进 ±1
    store.zoomEditorFontSize(-999)
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE - 1)

    // 连续缩放触底/触顶后被夹紧
    for (let i = 0; i < 30; i++) store.zoomEditorFontSize(-1)
    expect(store.editorFontSize).toBe(MIN_EDITOR_FONT_SIZE)
    store.zoomEditorFontSize(999)
    expect(store.editorFontSize).toBe(MIN_EDITOR_FONT_SIZE + 1)
    for (let i = 0; i < 30; i++) store.zoomEditorFontSize(1)
    expect(store.editorFontSize).toBe(MAX_EDITOR_FONT_SIZE)
  })

  it('ignores invalid zoom deltas', () => {
    const store = useAppearanceStore()

    store.zoomEditorFontSize(Number.NaN)
    store.zoomEditorFontSize(0)
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE)
  })

  it('persists changes to localStorage', () => {
    const store = useAppearanceStore()

    store.setUiFontSize(15)
    store.setEditorFontSize(18)
    store.setEditorFontFamily("'SimSun'")
    store.setEditorMonoFontFamily("'Consolas'")
    store.setEditorLineHeight(1.6)

    const raw = (localStorage.setItem as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]
    expect(JSON.parse(raw as string)).toEqual({
      uiFontSize: 15,
      editorFontSize: 18,
      editorFontFamily: "'SimSun'",
      editorMonoFontFamily: "'Consolas'",
      editorLineHeight: 1.6
    })
  })

  it('applies css variables when values change', () => {
    const store = useAppearanceStore()

    store.setUiFontSize(16)
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith('--ui-font-size', '16px')

    store.setEditorFontSize(22)
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith('--editor-font-size', '22px')
  })

  it('keeps old persisted data compatible (missing new fields use defaults)', () => {
    stubEnvironment(JSON.stringify({ uiFontSize: 14, editorFontSize: 19 }))
    const store = useAppearanceStore()

    store.initAppearance()

    expect(store.uiFontSize).toBe(14)
    expect(store.editorFontSize).toBe(19)
    expect(store.editorFontFamily).toBe(DEFAULT_EDITOR_FONT_FAMILY)
    expect(store.editorMonoFontFamily).toBe(DEFAULT_EDITOR_MONO_FONT_FAMILY)
    expect(store.editorLineHeight).toBe(DEFAULT_EDITOR_LINE_HEIGHT)
  })
})
