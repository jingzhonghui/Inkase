import { describe, expect, it } from 'vitest'
import {
  ROOT_FOLDER_HUE,
  folderColor,
  folderHue,
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
    expect(light.label).not.toBe(dark.label)
  })

  it('色相与 folderHue 一致', () => {
    expect(folderColor('notes', 'light').hue).toBe(folderHue('notes'))
  })

  it('断链配色与所有文件夹色相都不同族', () => {
    const broken = unresolvedColor('light')

    expect(broken.hue).toBe(0)
    expect(broken.stroke).toContain('hsl')
    expect(unresolvedColor('dark').stroke).not.toBe(broken.stroke)
  })
})
