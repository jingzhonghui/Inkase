import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  useAppearanceStore,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_EDITOR_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE
} from '../appearance'

function stubEnvironment(getItemValue: string | null = null) {
  const setProperty = vi.fn()
  vi.stubGlobal('document', {
    documentElement: { style: { setProperty } }
  })
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => getItemValue),
    setItem: vi.fn()
  })
  return { setProperty }
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
  })

  it('loads persisted values', () => {
    stubEnvironment(JSON.stringify({ uiFontSize: 15, editorFontSize: 20 }))
    const store = useAppearanceStore()

    store.initAppearance()

    expect(store.uiFontSize).toBe(15)
    expect(store.editorFontSize).toBe(20)
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
  })

  it('falls back to defaults for invalid input', () => {
    const store = useAppearanceStore()

    store.setUiFontSize(Number.NaN)
    expect(store.uiFontSize).toBe(DEFAULT_UI_FONT_SIZE)
    store.setEditorFontSize(Number.NaN)
    expect(store.editorFontSize).toBe(DEFAULT_EDITOR_FONT_SIZE)
  })

  it('persists changes to localStorage', () => {
    const store = useAppearanceStore()

    store.setUiFontSize(15)
    store.setEditorFontSize(18)

    const raw = (localStorage.setItem as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]
    expect(JSON.parse(raw as string)).toEqual({ uiFontSize: 15, editorFontSize: 18 })
  })

  it('applies css variables when values change', () => {
    const store = useAppearanceStore()

    store.setUiFontSize(16)
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith('--ui-font-size', '16px')

    store.setEditorFontSize(22)
    expect(document.documentElement.style.setProperty).toHaveBeenCalledWith('--editor-font-size', '22px')
  })
})
