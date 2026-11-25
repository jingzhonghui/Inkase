import { describe, expect, it } from 'vitest'
import {
  nextPageSize,
  MINDMAP_PAGE_MIN,
  MINDMAP_PAGE_PADDING
} from '../mindmap/viewport'

/**
 * 画布尺寸的纯函数层。
 * （滚动交给画布的原生滚动；缩放步进与百分比格式化已收进 `stores/zoom.ts`。）
 */

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
