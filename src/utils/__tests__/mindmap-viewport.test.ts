import { describe, expect, it } from 'vitest'
import {
  formatZoomPercent,
  nextPageSize,
  nextZoomScale,
  MINDMAP_PAGE_MIN,
  MINDMAP_PAGE_PADDING,
  MINDMAP_ZOOM_MAX,
  MINDMAP_ZOOM_MIN
} from '../mindmap/viewport'

/**
 * 缩放取值是控制条/滚轮缩放的唯一逻辑所在。
 * （滚动本身交给画布的原生滚动，不再有坐标换算逻辑。）
 */

describe('nextZoomScale', () => {
  it('按倍率放大/缩小，而不是加减固定值', () => {
    expect(nextZoomScale(1, 'in')).toBeCloseTo(1.2, 6)
    expect(nextZoomScale(1.2, 'out')).toBeCloseTo(1, 6)
  })

  it('不会越过上下限', () => {
    expect(nextZoomScale(MINDMAP_ZOOM_MAX, 'in')).toBe(MINDMAP_ZOOM_MAX)
    expect(nextZoomScale(MINDMAP_ZOOM_MIN, 'out')).toBe(MINDMAP_ZOOM_MIN)
    expect(nextZoomScale(999, 'in')).toBeLessThanOrEqual(MINDMAP_ZOOM_MAX)
    expect(nextZoomScale(0.001, 'out')).toBeGreaterThanOrEqual(MINDMAP_ZOOM_MIN)
  })

  it('结果收敛到 1%，不累积浮点噪声', () => {
    let scale = 1
    for (let i = 0; i < 5; i += 1) scale = nextZoomScale(scale, 'in')
    expect(Number.isInteger(Math.round(scale * 100))).toBe(true)
    expect(String(scale).length).toBeLessThan(8)
  })

  it('非法输入按 100% 处理', () => {
    expect(nextZoomScale(Number.NaN, 'in')).toBeCloseTo(1.2, 6)
    expect(nextZoomScale(0, 'out')).toBeCloseTo(1 / 1.2, 2)
  })

  it('支持自定义步进与上下限（滚轮缩放用同一套规则）', () => {
    expect(nextZoomScale(1, 'in', { step: 2 })).toBe(2)
    expect(nextZoomScale(1, 'in', { step: 2, max: 1.5 })).toBe(1.5)
  })
})

describe('formatZoomPercent', () => {
  it('格式化为整数百分比', () => {
    expect(formatZoomPercent(1)).toBe('100%')
    expect(formatZoomPercent(0.85)).toBe('85%')
    expect(formatZoomPercent(1.234)).toBe('123%')
  })

  it('非法输入回退为 100%', () => {
    expect(formatZoomPercent(Number.NaN)).toBe('100%')
    expect(formatZoomPercent(0)).toBe('100%')
  })
})

describe('nextPageSize', () => {
  it('小图保持最小纸面尺寸', () => {
    expect(nextPageSize(400, 300, 1, MINDMAP_PAGE_MIN)).toBe(MINDMAP_PAGE_MIN)
  })

  it('内容超出纸面时按内容扩张并留出空白', () => {
    // 宽 3000 的导图放在 2000 的纸上会被裁掉
    expect(nextPageSize(3000, 800, 1, MINDMAP_PAGE_MIN)).toBe(3000 + MINDMAP_PAGE_PADDING)
    expect(nextPageSize(800, 3000, 1, MINDMAP_PAGE_MIN)).toBe(3000 + MINDMAP_PAGE_PADDING)
  })

  it('按屏幕尺寸测量时用缩放比还原成布局尺寸', () => {
    // 50% 缩放下量到 3000px，实际布局只有 6000px
    expect(nextPageSize(3000, 600, 0.5, MINDMAP_PAGE_MIN)).toBe(6000 + MINDMAP_PAGE_PADDING)
  })

  it('只增不减，避免滚动位置跳动', () => {
    const current = 4000
    expect(nextPageSize(500, 500, 1, current)).toBe(current)
  })

  it('测量不到或非法尺寸时保持原样', () => {
    expect(nextPageSize(0, 0, 1, 2600)).toBe(2600)
    expect(nextPageSize(Number.NaN, 100, 1, 2600)).toBe(2600)
    expect(nextPageSize(100, 100, 0, 2600)).toBeGreaterThanOrEqual(2600)
  })
})
