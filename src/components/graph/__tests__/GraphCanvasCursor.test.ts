// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 画布光标的接线（设计 §5.8）。
 *
 * `cursor.test.ts` 只管「按主题生成什么取值」这个纯函数；这里补的是另一半——
 * `GraphCanvas` 是否真的把那个取值写到了 `<canvas>` 上。原生光标无法用 CSS 改色，
 * 这套 data URI 一旦没绑上去，光谱就退回 css 里的兜底 crosshair，颜色不再跟随主题，
 * 而纯函数测试完全发现不了。所以这层接线值得单独钉住。
 */

const themeState = vi.hoisted(() => ({ isDark: false }))

vi.mock('../../../stores/theme', () => ({
  useThemeStore: () => ({
    get isDark() {
      return themeState.isDark
    }
  })
}))

import GraphCanvas from '../GraphCanvas.vue'

function fakeContext(): Record<string, unknown> {
  const noop = (): void => {}
  return {
    canvas: null,
    save: noop,
    restore: noop,
    clearRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    fillText: noop,
    setTransform: noop,
    scale: noop,
    translate: noop,
    measureText: () => ({ width: 0 }),
    setLineDash: noop,
    createLinearGradient: () => ({ addColorStop: noop })
  }
}

/** 挂载后读 `<canvas>` 上的两个自定义属性（css 里由 var() 消费） */
function surfaceStyles(): { idle: string; active: string } {
  const wrapper = mount(GraphCanvas, { attachTo: document.body })
  const style = (wrapper.find('canvas').element as HTMLCanvasElement).style
  const snapshot = {
    idle: style.getPropertyValue('--graph-cursor'),
    active: style.getPropertyValue('--graph-cursor-active')
  }
  wrapper.unmount()
  return snapshot
}

function decode(value: string): string {
  return atob(/base64,([^"]+)"/.exec(value)![1])
}

describe('GraphCanvas 光标接线', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
        unobserve(): void {}
      }
    )
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeContext() as unknown as RenderingContext
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({})
    } as DOMRect)
  })

  it('浅色主题写入深色主体，深色主题写入浅色主体', () => {
    themeState.isDark = false
    const light = surfaceStyles()
    expect(light.idle).toContain('data:image/svg+xml;base64,')
    expect(light.idle.endsWith('crosshair')).toBe(true)
    expect(decode(light.idle)).toContain('#1f2937')

    themeState.isDark = true
    const dark = surfaceStyles()
    expect(decode(dark.idle)).toContain('#e5e7eb')
    expect(dark.idle).not.toBe(light.idle)
  })

  it('静止态与按下态是两个不同取值', () => {
    themeState.isDark = false
    const style = surfaceStyles()
    expect(style.active).toContain('data:image/svg+xml;base64,')
    expect(style.active).not.toBe(style.idle)
    expect(decode(style.active)).toContain('r="2.7"')
    expect(decode(style.idle)).toContain('r="1.5"')
  })
})
