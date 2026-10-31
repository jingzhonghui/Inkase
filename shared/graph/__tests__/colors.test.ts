import { describe, expect, it } from 'vitest'
import {
  ROOT_FOLDER_HUE,
  folderColor,
  folderHue,
  graphPalette,
  unresolvedColor
} from '../colors'

/**
 * 颜色是图谱里唯一的「分组」编码，必须稳定：
 * 值得为它单独写测试，因为一旦飘了，用户刚建立的「蓝的那一簇」记忆就废了。
 */

describe('folderHue', () => {
  it('同一文件夹每次都是同一个色相', () => {
    expect(folderHue('notes')).toBe(folderHue('notes'))
    expect(folderHue('projects/2026')).toBe(folderHue('projects/2026'))
  })

  it('根目录用专用色相', () => {
    expect(folderHue('')).toBe(ROOT_FOLDER_HUE)
  })

  it('子目录避让根目录色带，不会与「根目录」撞色', () => {
    const folders = ['notes', 'projects', 'archive', 'daily', 'drafts', 'research', 'a', 'b']
    for (const folder of folders) {
      const hue = folderHue(folder)
      expect(Math.abs(hue - ROOT_FOLDER_HUE)).toBeGreaterThan(20)
    }
  })

  it('不同文件夹拿到不同的色相', () => {
    const hues = new Set(
      ['notes', 'projects', 'archive', 'daily', 'drafts', 'research'].map(folderHue)
    )
    expect(hues.size).toBe(6)
  })

  it('色相落在合法区间', () => {
    for (const folder of ['', 'a', 'notes/sub', '中文目录']) {
      const hue = folderHue(folder)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })
})

describe('folderColor', () => {
  it('深浅两套主题给出不同颜色', () => {
    const light = folderColor('notes', 'light')
    const dark = folderColor('notes', 'dark')

    expect(light.fill).not.toBe(dark.fill)
  })

  it('色相与 folderHue 一致', () => {
    expect(folderColor('notes', 'light').hue).toBe(folderHue('notes'))
  })

  it('节点是实心填充：不带 alpha 通道', () => {
    for (const theme of ['light', 'dark'] as const) {
      const { fill } = folderColor('notes', theme)
      expect(fill).not.toContain('hsla')
      expect(fill).not.toContain('/')
    }
  })

  it('浅色底压暗、深色底提亮，两套都能在白/深底上立得住', () => {
    const lightness = (fill: string): number =>
      Number(/,\s*(\d+)%\)$/.exec(fill)?.[1])

    const light = lightness(folderColor('notes', 'light').fill)
    const dark = lightness(folderColor('notes', 'dark').fill)

    expect(light).toBeLessThan(50)
    expect(dark).toBeGreaterThan(50)
  })

  it('饱和度收在中段：三十个目录排开也不至于像调色盘', () => {
    for (const theme of ['light', 'dark'] as const) {
      const saturation = Number(
        /hsl\(\d+,\s*(\d+)%/.exec(folderColor('notes', theme).fill)?.[1]
      )
      expect(saturation).toBeGreaterThanOrEqual(50)
      expect(saturation).toBeLessThanOrEqual(80)
    }
  })
})

describe('graphPalette', () => {
  it('两套主题给出两套画布色（画布跟随面板，不是一块独立的白纸）', () => {
    expect(graphPalette('light').canvas).not.toBe(graphPalette('dark').canvas)
  })

  it('常规标签与焦点标签是两种墨色：主次只靠颜色，不靠字号', () => {
    for (const theme of ['light', 'dark'] as const) {
      const palette = graphPalette(theme)
      expect(palette.label).not.toBe(palette.labelFocus)
    }
  })

  it('选中光环用强调色，两套主题各一档', () => {
    expect(graphPalette('light').accent).not.toBe(graphPalette('dark').accent)
  })

  it('边与标签是两档中性灰：边比字更淡，字比边更实', () => {
    for (const theme of ['light', 'dark'] as const) {
      const palette = graphPalette(theme)
      expect(palette.edge).not.toBe(palette.edgeFocus)
      expect(palette.edge).not.toBe(palette.label)
    }
  })

  it('断链色与所有文件夹色相都不同族', () => {
    const broken = unresolvedColor('light')

    expect(broken).toContain('hsl')
    expect(unresolvedColor('dark')).not.toBe(broken)
    // 断链固定红系（hue≈2），与根目录的蓝（215）不会混淆
    expect(Number(/hsl\((\d+)/.exec(broken)?.[1])).toBeLessThan(10)
  })
})
