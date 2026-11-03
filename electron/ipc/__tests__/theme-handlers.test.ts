import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nativeTheme: { themeSource: 'system' as string },
  handle: vi.fn()
}))

vi.mock('electron', () => ({
  nativeTheme: mocks.nativeTheme,
  ipcMain: { handle: mocks.handle }
}))

const { applyThemeSource, isThemeSource, registerThemeHandlers } = await import('../theme-handlers')

describe('isThemeSource', () => {
  it('只认三种合法值', () => {
    expect(isThemeSource('light')).toBe(true)
    expect(isThemeSource('dark')).toBe(true)
    expect(isThemeSource('system')).toBe(true)
    expect(isThemeSource('auto')).toBe(false)
    expect(isThemeSource('')).toBe(false)
    expect(isThemeSource(null)).toBe(false)
    expect(isThemeSource(1)).toBe(false)
  })
})

describe('applyThemeSource', () => {
  beforeEach(() => {
    mocks.nativeTheme.themeSource = 'system'
  })

  it('把应用主题写进 nativeTheme.themeSource', () => {
    // 图表画布靠它翻色：改这个值等于替所有渲染进程改了 prefers-color-scheme
    expect(applyThemeSource('dark')).toBe('dark')
    expect(mocks.nativeTheme.themeSource).toBe('dark')
    expect(applyThemeSource('light')).toBe('light')
    expect(mocks.nativeTheme.themeSource).toBe('light')
  })

  it('非法值被忽略，保持原样而不是抛错', () => {
    mocks.nativeTheme.themeSource = 'dark'
    expect(applyThemeSource('auto')).toBe('dark')
    expect(mocks.nativeTheme.themeSource).toBe('dark')
    expect(applyThemeSource(undefined)).toBe('dark')
  })
})

describe('registerThemeHandlers', () => {
  it('注册 theme:setSource 通道', () => {
    registerThemeHandlers()
    expect(mocks.handle).toHaveBeenCalledWith('theme:setSource', expect.any(Function))
  })
})
