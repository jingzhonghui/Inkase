import { describe, expect, it } from 'vitest'
import { fitMiddleEllipsis } from '../middle-ellipsis'

/** 等宽假测量：每个字符 10px，便于精确断言 */
function charWidth(value: string): number {
  return Array.from(value).length * 10
}

describe('fitMiddleEllipsis', () => {
  it('returns the original text when it fits', () => {
    expect(fitMiddleEllipsis('季度报告.pdf', 200, charWidth)).toBe('季度报告.pdf')
  })

  it('keeps the head, the tail and the ellipsis in the middle', () => {
    const text = 'abcdefghijklmnop.mdx'
    const result = fitMiddleEllipsis(text, 100, charWidth)

    expect(result).toContain('…')
    expect(result.startsWith('a')).toBe(true)
    expect(result.endsWith('.mdx')).toBe(true)
    expect(charWidth(result)).toBeLessThanOrEqual(100)
    expect(result.length).toBeLessThan(text.length)
  })

  it('does not exceed the available width', () => {
    const text = '这是一个很长很长很长很长很长的文件名.mdx'
    for (const width of [40, 60, 90, 120, 160]) {
      const result = fitMiddleEllipsis(text, width, charWidth)
      expect(charWidth(result)).toBeLessThanOrEqual(width)
    }
  })

  it('keeps the tail longer than the head so the extension stays visible', () => {
    const text = '2026年Q1季度业务复盘与规划说明.mdx'
    const result = fitMiddleEllipsis(text, 130, charWidth)

    expect(result.startsWith('2026')).toBe(true)
    expect(result.endsWith('.mdx')).toBe(true)
    const [head, tail] = result.split('…')
    expect(Array.from(tail).length).toBeGreaterThanOrEqual(Array.from(head).length)
  })

  it('returns just the ellipsis when even one character cannot fit', () => {
    expect(fitMiddleEllipsis('abcdef.mdx', 5, charWidth)).toBe('…')
  })

  it('returns an empty string for non-positive widths and keeps empty text', () => {
    expect(fitMiddleEllipsis('abc', 0, charWidth)).toBe('')
    expect(fitMiddleEllipsis('abc', -10, charWidth)).toBe('')
    expect(fitMiddleEllipsis('', 100, charWidth)).toBe('')
  })

  it('counts surrogate pairs as single characters', () => {
    const text = '📄文档📄文档📄文档📄文档.mdx'
    const result = fitMiddleEllipsis(text, 100, charWidth)

    expect(result).toContain('…')
    expect(result.endsWith('.mdx')).toBe(true)
    expect(charWidth(result)).toBeLessThanOrEqual(100)
  })
})
