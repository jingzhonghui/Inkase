/**
 * 主题化画布光标。
 *
 * 为什么需要这个：`grab` / `grabbing` / 手形这些**原生光标不受 CSS 颜色影响**。
 * Windows 上它们是一张白色填充的位图，压在浅色主题的白底画布或白底图片上时，
 * 指针几乎糊进背景里，用户会觉得「鼠标没了」。想让它跟着主题走，只能自绘一张
 * SVG 光标喂给 `cursor: url(...)`。
 *
 * 可见性策略：主体用主题前景色（浅色主题深、深色主题浅），再垫一圈**反色**描边。
 * 只靠单一颜色是不够的——光标压在异色节点或深色图片上同样会消失，双色才能保证
 * 无论落在什么底色上都还有轮廓。
 */

/** 24×24 是稳妥尺寸：Chromium 在 Windows 上对光标图有尺寸上限，超过会被缩放或忽略 */
const CURSOR_SIZE = 24
/** 热点取正中，点哪就是哪 */
const CURSOR_HOTSPOT = CURSOR_SIZE / 2

export interface CursorPalette {
  /** 光标主体颜色 */
  main: string
  /** 主体外围的对比描边颜色 */
  halo: string
}

/**
 * 两种形状：
 * - `crosshair`：圆环 + 四向刻度 + 中心点，用于图谱这类「要点准某个圆点」的画布；
 * - `move`：四向箭头，用于拖动（平移）语义的画布，图片查看器与导图画布用它。
 *
 * 都不画手形：手形路径在 24px 下很容易糊成一团，重画的轮廓往往还不如原生那张。
 */
export type CursorShape = 'crosshair' | 'move'

/** 与 `styles/index.css` 的 `--color-text` / `--color-bg-primary` 对齐 */
export const LIGHT_CURSOR_PALETTE: CursorPalette = { main: '#1f2937', halo: '#ffffff' }
export const DARK_CURSOR_PALETTE: CursorPalette = { main: '#e5e7eb', halo: '#1f2937' }

/**
 * 平台不认 SVG 光标时的兜底关键字。
 *
 * 特意不用 `grab` / `grabbing`：那正是我们要替换掉的那张白手位图，兜底退回它
 * 等于把原始问题原样带回来。`crosshair` 与 `move` 都是黑白双色的系统光标，
 * 任何底色上都看得见。
 */
const CURSOR_FALLBACK: Record<CursorShape, string> = {
  crosshair: 'crosshair',
  move: 'move'
}

export function paletteFor(dark: boolean): CursorPalette {
  return dark ? DARK_CURSOR_PALETTE : LIGHT_CURSOR_PALETTE
}

function crosshairPaths(active: boolean): { stroke: string; dot: string } {
  return {
    stroke: 'M12 2v4.4M12 17.6V22M2 12h4.4M17.6 12H22',
    dot: `<circle cx="12" cy="12" r="${active ? 2.7 : 1.5}" fill="@@MAIN@@"/>`
  }
}

function movePaths(active: boolean): { stroke: string; dot: string } {
  return {
    // 四向轴 + 四个箭头端点，箭尖与轴端重合
    stroke: 'M12 4V20M4 12H20M9 7l3-3 3 3M9 17l3 3 3-3M7 9l-3 3 3 3M17 9l3 3-3 3',
    dot: active ? '<circle cx="12" cy="12" r="2.2" fill="@@MAIN@@"/>' : ''
  }
}

export function cursorSvg(palette: CursorPalette, shape: CursorShape, active: boolean): string {
  const { main, halo } = palette
  const { stroke, dot } = shape === 'move' ? movePaths(active) : crosshairPaths(active)
  const ring = shape === 'move' ? '' : '<circle cx="12" cy="12" r="5.4"/>'
  const body = `${ring}<path d="${stroke}"/>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_SIZE}" height="${CURSOR_SIZE}" viewBox="0 0 24 24">`,
    `<g fill="none" stroke="${halo}" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.95">${body}</g>`,
    `<g fill="none" stroke="${main}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</g>`,
    dot.replace('@@MAIN@@', main),
    `</svg>`
  ].join('')
}

/**
 * 生成可直接写进 `cursor` 的完整取值。
 *
 * 用 base64 而不是百分号编码：SVG 里全是 ASCII，base64 能躲开 `#`、引号、逗号
 * 在 data URI 里的转义坑。
 */
export function themedCursor(
  dark: boolean,
  shape: CursorShape = 'crosshair',
  active = false
): string {
  const svg = cursorSvg(paletteFor(dark), shape, active)
  const base64 = btoa(svg)
  return `url("data:image/svg+xml;base64,${base64}") ${CURSOR_HOTSPOT} ${CURSOR_HOTSPOT}, ${CURSOR_FALLBACK[shape]}`
}
