import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

export type ThemeType = 'light' | 'dark' | 'system'

interface ThemeState {
  theme: ThemeType
  followSystem: boolean
}

const THEME_STORAGE_KEY = 'inkase-theme'

/**
 * 主题状态管理 Store
 */
export const useThemeStore = defineStore('theme', () => {
  // State
  const theme = ref<ThemeType>('system')
  const followSystem = ref(true)
  const systemPreference = ref<'light' | 'dark'>(getSystemTheme())

  // Getters
  const currentTheme = computed(() => {
    if (followSystem.value || theme.value === 'system') {
      return systemPreference.value
    }
    return theme.value
  })

  const isDark = computed(() => currentTheme.value === 'dark')
  const isLight = computed(() => currentTheme.value === 'light')

  // Actions
  /**
   * 获取系统主题偏好
   */
  function getSystemTheme(): 'light' | 'dark' {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
    return 'light'
  }

  /**
   * 设置主题
   */
  function applyThemeToDocument(): void {
    document.documentElement.dataset.theme = currentTheme.value
  }

  /**
   * 把当前主题同步成系统级暗色偏好（主进程的 `nativeTheme.themeSource`）。
   *
   * 为什么需要：图表编辑器是跨域 iframe 里的 draw.io，它的配色只看
   * `prefers-color-scheme`，渲染层改 `data-theme` 影响不到它。同步之后画布会
   * 自己翻色（实测 ~35ms），就不必在切主题时重建整个 iframe（那要 765–1250ms）。
   *
   * 反过来要注意：一旦覆盖成 light/dark，`matchMedia` 读到的就是**我们的覆盖值**
   * 而不是真实系统偏好。所以只有跟随系统时才把读到的东西记进 `systemPreference`。
   */
  async function syncNativeTheme(): Promise<void> {
    const source: ThemeType =
      followSystem.value || theme.value === 'system' ? 'system' : theme.value
    try {
      await window.electronAPI?.setThemeSource?.(source)
    } catch {
      // 配色偏好同步失败不影响主题本身，静默降级即可
    }
    if (source === 'system') updateSystemPreference()
  }

  function setTheme(newTheme: ThemeType): void {
    theme.value = newTheme
    followSystem.value = newTheme === 'system'
    applyThemeToDocument()
    saveTheme()
    void syncNativeTheme()
  }

  /**
   * 切换浅色/深色主题
   */
  function toggleTheme(): void {
    if (currentTheme.value === 'dark') {
      setTheme('light')
    } else {
      setTheme('dark')
    }
  }

  /**
   * 从 localStorage 加载主题设置
   */
  function loadTheme(): void {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY)
      if (saved) {
        const parsed: ThemeState = JSON.parse(saved)
        theme.value = parsed.theme
        followSystem.value = parsed.followSystem
      }
    } catch {
      // 忽略解析错误
    }
  }

  /**
   * 保存主题设置到 localStorage
   */
  function saveTheme(): void {
    try {
      const state: ThemeState = {
        theme: theme.value,
        followSystem: followSystem.value
      }
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 忽略存储错误
    }
  }

  /**
   * 更新系统主题偏好
   */
  function updateSystemPreference(): void {
    systemPreference.value = getSystemTheme()
    applyThemeToDocument()
  }

  /**
   * 初始化主题
   */
  function initTheme(): void {
    loadTheme()
    // 此刻 `themeSource` 还是系统的默认值，读到的就是真实系统偏好
    updateSystemPreference()
    // 推给主进程，图表 iframe 一打开就是对的配色
    void syncNativeTheme()
    // 监听系统主题变化
    if (window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      mediaQuery.addEventListener('change', () => {
        // 应用内选了 light/dark 时，这个媒体特性已被我们覆盖，
        // 此时读到的是自己的覆盖值，记下来会污染「切回跟随系统」的结果。
        if (!followSystem.value && theme.value !== 'system') return
        updateSystemPreference()
      })
    }
  }

  return {
    theme,
    followSystem,
    systemPreference,
    currentTheme,
    isDark,
    isLight,
    setTheme,
    toggleTheme,
    initTheme
  }
})
