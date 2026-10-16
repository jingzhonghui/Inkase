import { describe, expect, it } from 'vitest'
import { activeOutlineIndex, clampScale, fitWidthScale, flattenOutline, pageAtScroll, scaledPageSize, scrollOffsetsForPage, ZOOM_STEP } from '../pdf-viewer'

describe('scaledPageSize', () => {
  it('scales base page size by the given scale', () => {
    expect(scaledPageSize({ width: 612, height: 792 }, 1)).toEqual({ width: 612, height: 792 })
    expect(scaledPageSize({ width: 612, height: 792 }, 2)).toEqual({ width: 1224, height: 1584 })
  })

  it('returns a minimal size for zero scale', () => {
    const size = scaledPageSize({ width: 612, height: 792 }, 0)
    expect(size.width).toBeGreaterThan(0)
    expect(size.height).toBeGreaterThan(0)
  })
})

describe('clampScale', () => {
  it('keeps scale within bounds', () => {
    expect(clampScale(0.1)).toBe(0.25)
    expect(clampScale(10)).toBe(5)
    expect(clampScale(1.5)).toBe(1.5)
  })

  it('rounds to two decimals to avoid float drift', () => {
    expect(clampScale(0.25 + 0.05 + 0.05)).toBe(0.35)
  })
})

describe('zoom stepping', () => {
  it('steps in by ZOOM_STEP and clamps', () => {
    let scale = 1
    scale = clampScale(scale + ZOOM_STEP)
    expect(scale).toBe(1.25)
    scale = clampScale(scale + ZOOM_STEP * 100)
    expect(scale).toBe(5)
  })

  it('steps out by ZOOM_STEP and clamps', () => {
    let scale = 1
    scale = clampScale(scale - ZOOM_STEP)
    expect(scale).toBe(0.75)
    scale = clampScale(scale - ZOOM_STEP * 100)
    expect(scale).toBe(0.25)
  })
})

describe('fitWidthScale', () => {
  it('returns available width divided by page width', () => {
    expect(fitWidthScale(800, 400, 48)).toBeCloseTo((800 - 48) / 400)
  })

  it('never returns less than a minimal positive scale', () => {
    expect(fitWidthScale(10, 1000, 48)).toBeGreaterThan(0)
  })
})

describe('pageAtScroll', () => {
  const offsets = [
    { top: 0, height: 100 },
    { top: 110, height: 100 },
    { top: 220, height: 100 }
  ]

  it('returns 1 at the top', () => {
    expect(pageAtScroll(offsets, 0, 50)).toBe(1)
  })

  it('returns the page covering the scroll position', () => {
    expect(pageAtScroll(offsets, 120, 50)).toBe(2)
    expect(pageAtScroll(offsets, 230, 50)).toBe(3)
  })

  it('returns the last page when scrolled past the end', () => {
    expect(pageAtScroll(offsets, 10_000, 50)).toBe(3)
  })

  it('returns 1 for an empty document', () => {
    expect(pageAtScroll([], 0, 50)).toBe(1)
  })

  it('returns the previous page when focus lands in the gap between pages', () => {
    // 页间有 16px 间隙：第二页范围是 110..210，gap 是 210..226，第三页从 226 起
    expect(pageAtScroll(offsets, 226 - 25 - 15, 50)).toBe(2)
  })

  it('keeps tracking while scrolling deep into the document', () => {
    // 视口高 50，中线 = scrollTop + 25；第二页 110..210，gap 210..220，第三页从 220 起
    expect(pageAtScroll(offsets, 60, 50)).toBe(1) // 中线 85，仍在第一页（0..100）
    expect(pageAtScroll(offsets, 115, 50)).toBe(2) // 中线 140，第二页
    expect(pageAtScroll(offsets, 190, 50)).toBe(2) // 中线 215，落在 gap，取上一页
    expect(pageAtScroll(offsets, 220, 50)).toBe(3) // 中线 245，第三页
  })
})

describe('scrollOffsetsForPage', () => {
  it('returns the page top offset relative to the scroll container', () => {
    const offsets = [
      { top: 0, height: 100 },
      { top: 110, height: 100 },
      { top: 220, height: 100 }
    ]
    expect(scrollOffsetsForPage(offsets, 2)).toBe(110)
  })

  it('clamps to the first page for invalid input', () => {
    expect(scrollOffsetsForPage([], 0)).toBe(0)
    expect(scrollOffsetsForPage([{ top: 0, height: 10 }], -1)).toBe(0)
    expect(scrollOffsetsForPage([{ top: 0, height: 10 }], 99)).toBe(0)
  })
})

describe('activeOutlineIndex', () => {
  const items = [
    { page: 1 },
    { page: null },
    { page: 3 },
    { page: 5 }
  ]

  it('returns -1 when there are no items', () => {
    expect(activeOutlineIndex([], 1)).toBe(-1)
  })

  it('returns the last item whose page is not after the current page', () => {
    expect(activeOutlineIndex(items, 1)).toBe(0)
    expect(activeOutlineIndex(items, 2)).toBe(0)
    expect(activeOutlineIndex(items, 3)).toBe(2)
    expect(activeOutlineIndex(items, 4)).toBe(2)
    expect(activeOutlineIndex(items, 5)).toBe(3)
    expect(activeOutlineIndex(items, 99)).toBe(3)
  })

  it('ignores items without a resolvable page', () => {
    expect(activeOutlineIndex([{ page: null }, { page: null }], 5)).toBe(-1)
  })
})

describe('flattenOutline', () => {
  const item = (title: string, extra: Record<string, unknown> = {}) => ({ title, ...extra })

  it('flattens a flat list with depth 0', async () => {
    const out = await flattenOutline([item('一'), item('二')])
    expect(out).toEqual([
      { title: '一', depth: 0, page: null },
      { title: '二', depth: 0, page: null }
    ])
  })

  it('pre-order flattens nested children with incremented depth', async () => {
    const out = await flattenOutline([
      item('父', { items: [item('子1'), item('子2', { items: [item('孙')] })] }),
      item('兄弟')
    ])
    expect(out).toEqual([
      { title: '父', depth: 0, page: null },
      { title: '子1', depth: 1, page: null },
      { title: '子2', depth: 1, page: null },
      { title: '孙', depth: 2, page: null },
      { title: '兄弟', depth: 0, page: null }
    ])
  })

  it('tolerates null or empty children', async () => {
    expect(await flattenOutline([item('a', { items: null }), item('b', { items: [] })])).toEqual([
      { title: 'a', depth: 0, page: null },
      { title: 'b', depth: 0, page: null }
    ])
  })

  it('skips items without a title', async () => {
    expect(await flattenOutline([item('有'), { items: [item('无标题子的')] }])).toEqual([
      { title: '有', depth: 0, page: null }
    ])
  })

  it('truncates over-long titles', async () => {
    const long = '章'.repeat(100)
    const [first] = await flattenOutline([item(long)])
    expect(first.title.length).toBeLessThanOrEqual(80)
    expect(first.title.endsWith('…')).toBe(true)
  })

  it('returns an empty array for empty or missing items', async () => {
    expect(await flattenOutline([])).toEqual([])
  })

  it('attaches a page number resolved via the injected resolver', async () => {
    const out = await flattenOutline([item('甲'), item('乙')], (n) => (n.title === '甲' ? 3 : 5))
    expect(out).toEqual([
      { title: '甲', depth: 0, page: 3 },
      { title: '乙', depth: 0, page: 5 }
    ])
  })

  it('supports async resolvers and null for unresolvable destinations', async () => {
    const out = await flattenOutline(
      [item('可跳', { dest: 'x' }), item('不可跳', { dest: 'y' })],
      async (n) => (n.dest === 'x' ? 7 : null)
    )
    expect(out).toEqual([
      { title: '可跳', depth: 0, page: 7 },
      { title: '不可跳', depth: 0, page: null }
    ])
  })
})
