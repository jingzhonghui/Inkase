import { describe, expect, it } from 'vitest'
import {
  DARK_CURSOR_PALETTE,
  LIGHT_CURSOR_PALETTE,
  cursorSvg,
  paletteFor,
  themedCursor
} from '../cursor'

const CURSOR_PATTERN = /^url\("data:image\/svg\+xml;base64,([^"]+)"\) (\d+) (\d+), (crosshair|move)$/

function partsOf(value: string): {
  svg: string
  hotspotX: string
  hotspotY: string
  fallback: string
} {
  const match = CURSOR_PATTERN.exec(value)
  if (!match) throw new Error(`不是预期的 cursor 取值：${value}`)
  return { svg: atob(match[1]), hotspotX: match[2], hotspotY: match[3], fallback: match[4] }
}

function decodeCursor(value: string): string {
  return partsOf(value).svg
}

describe('主题化光标', () => {
  it('浅色主题用深色主体，深色主题用浅色主体', () => {
    const light = decodeCursor(themedCursor(false))
    const dark = decodeCursor(themedCursor(true))

    expect(light).toContain(LIGHT_CURSOR_PALETTE.main)
    expect(dark).toContain(DARK_CURSOR_PALETTE.main)
    expect(light).not.toBe(dark)
  })

  it('主体之外还有一圈反色描边，压在异色节点或深色图片上也不会消失', () => {
    for (const [dark, palette] of [
      [false, LIGHT_CURSOR_PALETTE],
      [true, DARK_CURSOR_PALETTE]
    ] as const) {
      for (const shape of ['crosshair', 'move'] as const) {
        const svg = decodeCursor(themedCursor(dark, shape))
        expect(svg).toContain(palette.main)
        expect(svg).toContain(palette.halo)
      }
    }
  })

  it('生成的是 24×24 的 SVG，热点在正中', () => {
    const { svg, hotspotX, hotspotY } = partsOf(themedCursor(false))

    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('width="24"')
    expect(svg).toContain('height="24"')
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(hotspotX).toBe('12')
    expect(hotspotY).toBe('12')
  })

  it('两种形状各自兜底到同名系统光标，且都不是 grab/grabbing', () => {
    expect(partsOf(themedCursor(false, 'crosshair')).fallback).toBe('crosshair')
    expect(partsOf(themedCursor(false, 'move')).fallback).toBe('move')

    for (const shape of ['crosshair', 'move'] as const) {
      for (const active of [false, true]) {
        const value = themedCursor(false, shape, active)
        expect(value).not.toContain('grab')
      }
    }
  })

  it('准星与四向箭头是两种不同的图形', () => {
    const crosshair = decodeCursor(themedCursor(false, 'crosshair'))
    const move = decodeCursor(themedCursor(false, 'move'))

    expect(crosshair).toContain('<circle cx="12" cy="12" r="5.4"/>')
    expect(move).not.toContain('<circle cx="12" cy="12" r="5.4"/>')
    expect(move).toContain('M12 4V20M4 12H20')
    expect(crosshair).not.toBe(move)
  })

  it('按下态与静止态可区分：准星放大中心点，四向箭头加中心方块', () => {
    const idleCross = decodeCursor(themedCursor(false, 'crosshair', false))
    const activeCross = decodeCursor(themedCursor(false, 'crosshair', true))
    expect(idleCross).toContain('r="1.5"')
    expect(activeCross).toContain('r="2.7"')

    const idleMove = decodeCursor(themedCursor(false, 'move', false))
    const activeMove = decodeCursor(themedCursor(false, 'move', true))
    expect(idleMove).not.toContain('r="2.2"')
    expect(activeMove).toContain('r="2.2"')
    expect(idleMove).not.toBe(activeMove)
  })

  it('data URI 里不残留裸的 # 与引号（转义问题会让整个 cursor 失效）', () => {
    for (const dark of [false, true]) {
      for (const shape of ['crosshair', 'move'] as const) {
        for (const active of [false, true]) {
          const value = themedCursor(dark, shape, active)
          const payload = value.slice('url("'.length, value.indexOf('") '))
          expect(payload).not.toContain('#')
          expect(payload).not.toContain('"')
          expect(payload).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/)
        }
      }
    }
  })

  it('纯函数：同样的入参永远得到同样的字符串', () => {
    expect(themedCursor(true, 'move', true)).toBe(themedCursor(true, 'move', true))
    expect(themedCursor(false)).toBe(themedCursor(false))
  })

  it('paletteFor 与 styles/index.css 的前景色一致', () => {
    expect(paletteFor(false)).toBe(LIGHT_CURSOR_PALETTE)
    expect(paletteFor(true)).toBe(DARK_CURSOR_PALETTE)
    expect(LIGHT_CURSOR_PALETTE.main).toBe('#1f2937')
    expect(DARK_CURSOR_PALETTE.main).toBe('#e5e7eb')
  })

  it('svg 结构闭合，能原样解码回来', () => {
    for (const shape of ['crosshair', 'move'] as const) {
      const svg = cursorSvg(LIGHT_CURSOR_PALETTE, shape, false)
      expect(svg.endsWith('</svg>')).toBe(true)
      expect((svg.match(/<svg/g) ?? []).length).toBe(1)
      expect((svg.match(/<\/svg>/g) ?? []).length).toBe(1)
      expect(decodeCursor(themedCursor(false, shape))).toBe(svg)
    }
  })
})
