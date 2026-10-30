/**
 * 渲染层主题 ↔ Inkase 主题
 *
 * mind-elixir 的换肤是 CSS 变量注入（`theme.cssVar`），
 * 且它**不会**跟随 `prefers-color-scheme`，所以明暗切换要显式 `changeTheme`。
 *
 * 这里的策略：从 Inkase 的 CSS 变量读取实际颜色，注入渲染层，
 * 保证导图与编辑器/预览的底色、文字色一致；读取失败时回退渲染库默认值。
 */

import type { Theme, ThemeCssVar } from 'mind-elixir'

type UnknownRecord = Record<string, unknown>

/**
 * 读取根节点上的 CSS 变量。
 * SSR / 测试环境（无 document 或 getComputedStyle）时返回空串，由调用方回退。
 */
function readCssVar(name: string): string {
  if (typeof document === 'undefined') return ''
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name)
    return value.trim()
  } catch {
    return ''
  }
}

/** 读取 CSS 变量并可选地做半透明处理；为空则返回回退值 */
function withFallback(name: string, fallback: string): string {
  return readCssVar(name) || fallback
}

/** 把 `#rrggbb` / `rgb(...)` 转成带透明度的 `rgba(...)`；无法解析时返回 fallback */
function toAlpha(color: string, alpha: number, fallback: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (hex) {
    const int = Number.parseInt(hex[1], 16)
    const r = (int >> 16) & 0xff
    const g = (int >> 8) & 0xff
    const b = int & 0xff
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color.trim())
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`
  return fallback
}

/**
 * 把颜色转成带透明度的形式（给分支底纹用）。
 * 解析不了时返回 fallback，调用方可以据此决定是否加底纹。
 */
export function withAlpha(color: string, alpha: number, fallback = 'transparent'): string {
  return toAlpha(color, alpha, fallback)
}

/** 主分支配色：沿用 Inkase 主色系，保证多分支可区分且不刺眼 */
const LIGHT_PALETTE = [
  '#4a7dff',
  '#12b886',
  '#f59f00',
  '#e8590c',
  '#9c36b5',
  '#0c8599',
  '#d6336c',
  '#5c7cfa',
  '#37b24d',
  '#845ef7'
]

const DARK_PALETTE = [
  '#5b8cff',
  '#2fbf8f',
  '#f6b73c',
  '#ff8a4c',
  '#b57bff',
  '#38b6c4',
  '#ff6ba3',
  '#7c9dff',
  '#51cf66',
  '#9775fa'
]

export type MindMapThemeMode = 'light' | 'dark'

/** 单色模式下的分支色（不抢眼，和边框色同族） */
const MONO_LIGHT = '#94a3b8'
const MONO_DARK = '#64748b'

/** 主题构建选项 */
export interface MindMapThemeOptions {
  /** 彩虹分支：按调色板给每个主分支分配颜色（XMind 的「彩虹分支」） */
  rainbow?: boolean
}

/** 当前模式下可用的分支调色板（右键菜单里的「分支颜色」直接用这一组） */
export function getMindMapPalette(mode: MindMapThemeMode): string[] {
  return [...(mode === 'dark' ? DARK_PALETTE : LIGHT_PALETTE)]
}

/**
 * 单色模式下的分支色。
 * 彩虹关闭时所有分支（含连线）都用它，所以属性栏与画布必须读同一个来源，
 * 否则属性栏显示的是「自动」，画布上却是调色板里的某个颜色。
 */
export function getMindMapMonoColor(mode: MindMapThemeMode): string {
  return mode === 'dark' ? MONO_DARK : MONO_LIGHT
}

/**
 * 构建渲染层主题。
 * @param mode 明暗模式，取自 Inkase 的 theme store 解析结果
 * @param options 彩虹分支开关；关闭时所有分支同色，观感接近传统单色导图
 */
export function createMindMapTheme(
  mode: MindMapThemeMode,
  options: MindMapThemeOptions = {}
): Theme {
  const isDark = mode === 'dark'
  const rainbow = options.rainbow !== false

  const canvasBg = withFallback('--color-bg-primary', isDark ? '#1e1e1e' : '#ffffff')
  const nodeBg = isDark
    ? withFallback('--color-bg-secondary', '#2a2a2a')
    : withFallback('--color-bg-secondary', '#f5f7fa')
  const textColor = withFallback('--color-text', isDark ? '#e6e6e6' : '#333333')
  const primary = withFallback('--color-primary', isDark ? '#5b8cff' : '#4a7dff')
  const borderColor = withFallback('--color-border', isDark ? '#3a3a3a' : '#e0e0e0')
  const panelBg = withFallback('--color-bg-secondary', isDark ? '#2a2a2a' : '#ffffff')
  const selected = withFallback('--color-primary', '#4dc4ff')

  const cssVar: Partial<ThemeCssVar> = {
    /**
     * 间距四件套（渲染库读这些变量排布整张图）：
     * - `node-gap-x` 是 `me-parent` 的左右 padding，即「节点 ↔ 它的子节点列」的横向缝，
     *   同一层兄弟节点的横向间隔也由它撑开；
     * - `node-gap-y` 是同级节点之间的纵向间隔（`me-parent` 的 margin-top）；
     * - `main-gap-x/y` 是每个一级分支 wrapper 的外边距，即分支与分支之间的留白。
     * 主题盒子偏小时这些缝要相对更宽，否则整张图会糊成一片。
     */
    '--node-gap-x': '34px',
    '--node-gap-y': '16px',
    '--main-gap-x': '72px',
    '--main-gap-y': '52px',
    '--root-radius': '10px',
    '--main-radius': '8px',
    '--root-color': '#ffffff',
    '--root-bgcolor': primary,
    '--root-border-color': 'transparent',
    '--main-border': `1px solid ${borderColor}`,
    '--main-color': textColor,
    '--main-bgcolor': nodeBg,
    '--main-bgcolor-transparent': toAlpha(
      nodeBg,
      0.85,
      isDark ? 'rgba(42, 42, 42, 0.85)' : 'rgba(245, 247, 250, 0.85)'
    ),
    '--topic-padding': '3px',
    '--color': textColor,
    '--bgcolor': canvasBg,
    '--selected': selected,
    '--accent-color': primary,
    '--panel-color': textColor,
    '--panel-bgcolor': panelBg,
    '--panel-border-color': borderColor,
    '--map-padding': '40px 60px'
  }

  return {
    name: `${isDark ? 'Inkase Dark' : 'Inkase Light'}${rainbow ? '' : ' Mono'}`,
    type: isDark ? 'dark' : 'light',
    /**
     * 渲染库的主分支着色规则是 `palette[第几个主分支 % palette.length]`：
     * 所以「彩虹」= 多色调色板，「单色」= 只有一个元素的调色板。
     * 节点级的 `branchColor` 会覆盖这里的分配。
     */
    palette: rainbow ? getMindMapPalette(mode) : [isDark ? MONO_DARK : MONO_LIGHT],
    cssVar
  }
}

/** 判断主题是否为暗色（渲染层 Theme.type 可能缺失，交给调用方决定回退） */
export function isDarkTheme(theme: Theme | undefined): boolean {
  if (!theme) return false
  if (theme.type) return theme.type === 'dark'
  const record = theme as UnknownRecord
  const name = typeof record.name === 'string' ? record.name.toLowerCase() : ''
  return name.includes('dark')
}
