/**
 * 应用主题 → 系统级暗色偏好。
 *
 * 为什么需要这一条 IPC：图表编辑器是跨域 iframe 里的 draw.io，它的配色由
 * `prefers-color-scheme` 决定。渲染层改 `document.documentElement.dataset.theme`
 * 只影响 Inkase 自己，画布收不到。而 Electron 里这个媒体特性的值由主进程的
 * `nativeTheme.themeSource` 控制 —— 改它，所有渲染进程（含 iframe）都会收到
 * media change，draw.io 自己就翻色了。
 *
 * 收益是有实测对比的：切主题时重建 iframe 要 765–1250ms（整份 webapp 重载），
 * 走这条路让画布自己翻色只要 ~35ms。
 *
 * 边界：
 * - `themeSource` 是**应用级**的，设成 light/dark 之后 `matchMedia` 读到的就是
 *   被覆盖的值，不再是真实系统偏好。所以渲染层那边只在「跟随系统」时才信任它
 *   （见 `src/stores/theme.ts` 的 `syncNativeTheme`）。
 * - 主窗口是 `frame: false` 的自定义标题栏，不依赖原生边框配色，所以这里不涉及
 *   标题栏闪色问题；系统对话框与滚动条跟随它变化，反而是期望行为。
 */

import { ipcMain, nativeTheme } from 'electron'
import { IPC_CHANNELS } from './channels'

/** 渲染层能传的值：与主题 store 的三种模式一一对应 */
export type ThemeSource = 'light' | 'dark' | 'system'

const VALID: readonly ThemeSource[] = ['light', 'dark', 'system']

export function isThemeSource(value: unknown): value is ThemeSource {
  return typeof value === 'string' && (VALID as readonly string[]).includes(value)
}

/**
 * 设置系统级暗色偏好。
 *
 * 非法值一律忽略而不是抛错：这只是显示偏好，不值得让渲染层崩掉。
 * 返回最终生效的值，方便调用方（与测试）确认。
 */
export function applyThemeSource(value: unknown): ThemeSource {
  if (!isThemeSource(value)) return nativeTheme.themeSource as ThemeSource
  nativeTheme.themeSource = value
  return nativeTheme.themeSource as ThemeSource
}

export function registerThemeHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.THEME.SET_SOURCE,
    (_event, source: unknown): { success: boolean; data?: ThemeSource; error?: string } => {
      try {
        return { success: true, data: applyThemeSource(source) }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : '设置主题失败'
        }
      }
    }
  )
}
