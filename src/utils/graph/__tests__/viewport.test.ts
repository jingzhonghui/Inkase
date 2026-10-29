import { describe, expect, it } from 'vitest'
import {
  IDENTITY_TRANSFORM,
  MAX_ZOOM,
  MIN_ZOOM,
  boundsOf,
  centerOn,
  clampZoom,
  fitToBounds,
  hitTest,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt
} from '../viewport'

/**
 * 视口变换的纯计算测试（设计 §4.2 / §5.8）。
 * 对应 TC-CANVAS-001（以光标为中心缩放）、TC-CANVAS-002（边界钳制）、
 * TC-CANVAS-003（平移）、TC-CANVAS-006（适应内容），以及命中测试。
 *
 * 这些是画布交互的正确性内核：换算错了，缩放会「跑偏」、点节点点不中。
 */

describe('clampZoom（TC-CANVAS-002）', () => {
  it('夹在 [0.1, 4]', () => {
    expect(MIN_ZOOM).toBe(0.1)
    expect(MAX_ZOOM).toBe(4)
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(clampZoom(0.05)).toBe(MIN_ZOOM)
    expect(clampZoom(100)).toBe(MAX_ZOOM)
    expect(clampZoom(2.5)).toBe(2.5)
  })

  it('非有限数退回 1，不产生 NaN 视口', () => {
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(1)
  })
})

describe('坐标换算', () => {
  it('worldToScreen 与 screenToWorld 互逆', () => {
    const transform = { x: 120, y: -40, k: 2.5 }
    const point = { x: 33, y: 77 }

    const screen = worldToScreen(transform, point)
    const back = screenToWorld(transform, screen)

    expect(back.x).toBeCloseTo(point.x, 10)
    expect(back.y).toBeCloseTo(point.y, 10)
  })

  it('单位变换下屏幕坐标等于世界坐标', () => {
    expect(worldToScreen(IDENTITY_TRANSFORM, { x: 5, y: 6 })).toEqual({ x: 5, y: 6 })
  })
})

describe('zoomAt（TC-CANVAS-001 以光标为中心）', () => {
  it('锚点下的世界坐标在缩放前后保持不变', () => {
    const anchor = { x: 300, y: 200 }
    const before = { x: 40, y: -10, k: 1.4 }

    const worldBefore = screenToWorld(before, anchor)
    const after = zoomAt(before, 1.2, anchor)
    const worldAfter = screenToWorld(after, anchor)

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 10)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 10)
    // 缩放确实生效了
    expect(after.k).toBeGreaterThan(before.k)
  })

  it('缩小同样保持锚点不动', () => {
    const anchor = { x: 10, y: 20 }
    const before = { x: 0, y: 0, k: 2 }

    const worldBefore = screenToWorld(before, anchor)
    const after = zoomAt(before, 0.5, anchor)

    expect(screenToWorld(after, anchor).x).toBeCloseTo(worldBefore.x, 10)
    expect(after.k).toBeCloseTo(1, 10)
  })

  it('已在上限时返回原对象且 k 不再增大', () => {
    const transform = { x: 0, y: 0, k: MAX_ZOOM }

    const after = zoomAt(transform, 2, { x: 0, y: 0 })

    expect(after).toBe(transform)
    expect(after.k).toBe(MAX_ZOOM)
  })

  it('已在下限时返回原对象且 k 不再减小', () => {
    const transform = { x: 5, y: 5, k: MIN_ZOOM }

    const after = zoomAt(transform, 0.5, { x: 0, y: 0 })

    expect(after).toBe(transform)
    expect(after.k).toBe(MIN_ZOOM)
  })

  it('连续放大 50 次后 k 仍不超过上限', () => {
    let transform = { x: 0, y: 0, k: 1 }
    for (let i = 0; i < 50; i++) transform = zoomAt(transform, 1.2, { x: 100, y: 100 })

    expect(transform.k).toBeLessThanOrEqual(MAX_ZOOM)
    expect(Number.isFinite(transform.x)).toBe(true)
  })

  it('连续缩小 50 次后 k 仍不低于下限', () => {
    let transform = { x: 0, y: 0, k: 1 }
    for (let i = 0; i < 50; i++) transform = zoomAt(transform, 0.85, { x: 100, y: 100 })

    expect(transform.k).toBeGreaterThanOrEqual(MIN_ZOOM)
    expect(Number.isFinite(transform.y)).toBe(true)
  })
})

describe('panBy（TC-CANVAS-003）', () => {
  it('按位移平移视口，缩放不变', () => {
    const transform = { x: 10, y: 10, k: 1.5 }

    expect(panBy(transform, 50, -30)).toEqual({ x: 60, y: -20, k: 1.5 })
  })

  it('不修改入参', () => {
    const transform = { x: 0, y: 0, k: 1 }
    panBy(transform, 5, 5)

    expect(transform).toEqual({ x: 0, y: 0, k: 1 })
  })
})

describe('boundsOf', () => {
  it('计算包围盒', () => {
    expect(boundsOf([{ x: 0, y: 0 }, { x: 10, y: -5 }, { x: -3, y: 2 }])).toEqual({
      minX: -3,
      minY: -5,
      maxX: 10,
      maxY: 2
    })
  })

  it('空集合与非法坐标返回 null', () => {
    expect(boundsOf([])).toBeNull()
    expect(boundsOf([{ x: Number.NaN, y: 1 }])).toBeNull()
  })
})

describe('fitToBounds（TC-CANVAS-006 适应内容）', () => {
  it('内容居中且完整落在视口内', () => {
    const bounds = { minX: -100, minY: -50, maxX: 100, maxY: 50 }
    const width = 800
    const height = 600
    const transform = fitToBounds(bounds, width, height, 40)

    // 四角都在视口内
    for (const point of [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY }
    ]) {
      const screen = worldToScreen(transform, point)
      expect(screen.x).toBeGreaterThanOrEqual(0)
      expect(screen.x).toBeLessThanOrEqual(width)
      expect(screen.y).toBeGreaterThanOrEqual(0)
      expect(screen.y).toBeLessThanOrEqual(height)
    }

    // 内容中心落在视口中心
    const center = worldToScreen(transform, { x: 0, y: 0 })
    expect(center.x).toBeCloseTo(width / 2, 6)
    expect(center.y).toBeCloseTo(height / 2, 6)
  })

  it('单节点不会被放大到荒谬倍数', () => {
    const transform = fitToBounds({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 800, 600)

    expect(transform.k).toBeLessThanOrEqual(2)
    expect(transform.k).toBeGreaterThanOrEqual(MIN_ZOOM)
  })

  it('空内容退化为居中且 k=1', () => {
    expect(fitToBounds(null, 400, 300)).toEqual({ x: 200, y: 150, k: 1 })
  })

  it('极大内容时缩小但仍不低于下限', () => {
    const transform = fitToBounds({ minX: -100000, minY: -100000, maxX: 100000, maxY: 100000 }, 800, 600)

    expect(transform.k).toBeGreaterThanOrEqual(MIN_ZOOM)
  })
})

describe('centerOn', () => {
  it('把给定世界坐标移到视口中心，缩放不变', () => {
    const transform = centerOn({ x: 0, y: 0, k: 2 }, { x: 50, y: 50 }, 800, 600)

    expect(transform.k).toBe(2)
    expect(worldToScreen(transform, { x: 50, y: 50 })).toEqual({ x: 400, y: 300 })
  })
})

describe('hitTest', () => {
  const candidates = [
    { id: 'a', x: 0, y: 0, radius: 5 },
    { id: 'b', x: 20, y: 0, radius: 5 },
    { id: 'c', x: 0, y: 0, radius: 1 }
  ]

  it('点在节点内命中', () => {
    expect(hitTest(candidates, { x: 1, y: 1 })).toBe('a')
    expect(hitTest(candidates, { x: 20, y: 0 })).toBe('b')
  })

  it('多个候选命中时取距离最近者', () => {
    // a 与 c 同心，c 半径更小但距离相同 —— 取先遇到的最近距离（a）
    expect(hitTest([{ id: 'c', x: 0, y: 0, radius: 1 }, { id: 'a', x: 0.5, y: 0, radius: 5 }], { x: 0, y: 0 })).toBe('c')
  })

  it('空白处返回 null', () => {
    expect(hitTest(candidates, { x: 200, y: 200 })).toBeNull()
  })

  it('容差允许点在半径外一点点仍命中', () => {
    expect(hitTest([{ id: 'a', x: 0, y: 0, radius: 5 }], { x: 0, y: 7 }, 3)).toBe('a')
    expect(hitTest([{ id: 'a', x: 0, y: 0, radius: 5 }], { x: 0, y: 9 }, 3)).toBeNull()
  })

  it('空候选集返回 null', () => {
    expect(hitTest([], { x: 0, y: 0 })).toBeNull()
  })
})
