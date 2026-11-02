import { reactive } from 'vue'

/**
 * 用户对快捷键的覆盖值。
 *
 * 单独一个模块而不是 Pinia store 的原因：注册表（`registry.ts`）需要读它，
 * 而 store 依赖 Pinia 实例——注册表的 `bindingOf` 在单测里也会被调用，
 * 不该背着「必须先 setActivePinia」的负担。这里只用一个模块级 reactive，
 * 组件里读它天然是响应式的，非组件环境（单测、Node 脚本）也照常工作。
 *
 * ## 只存覆盖值
 *
 * 存的是 `{ 命令 id: 绑定字符串 | null }`，**不存整张表**：
 * 默认键将来改版（比如把「另存为」换成别的组合）用户能自动拿到新默认值，
 * 只有他真的改过的那些才被钉住。`null` 表示「显式解绑」，与「没改过」不同。
 */

const STORAGE_KEY = 'inkase-shortcuts'
const STORAGE_VERSION = 1

/** `'Mod+Shift+K'` = 改键；`null` = 显式解绑 */
export type ShortcutOverride = string | null
export type ShortcutOverrides = Record<string, ShortcutOverride>

const state = reactive<{ overrides: ShortcutOverrides }>({
  overrides: loadRawOverrides()
})

/**
 * 从 localStorage 读出原始覆盖值。
 *
 * 这里**只做结构上的兜底**（不是对象、值不是 string/null 就丢掉），
 * 不做语义校验：绑定是否可解析、命令 id 是否存在都由注册表在读取时判定。
 * 这样坏数据只会让**那一条**回落到默认，而不会让整个配置失效。
 */
function loadRawOverrides(): ShortcutOverrides {
  try {
    const storage = typeof localStorage === 'undefined' ? null : localStorage
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return {}

    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}

    const container = parsed as { version?: unknown; overrides?: unknown }
    // 版本不同就先不认：将来若改结构，在这里加迁移分支
    if (container.version !== STORAGE_VERSION) return {}
    if (!container.overrides || typeof container.overrides !== 'object') return {}

    const result: ShortcutOverrides = {}
    for (const [id, value] of Object.entries(container.overrides as Record<string, unknown>)) {
      if (value === null || typeof value === 'string') result[id] = value
    }
    return result
  } catch {
    // 配置坏了不该让应用起不来：整体回退到「全部默认」
    return {}
  }
}

/** 当前生效的覆盖值（只读视图，注册表与界面都从这里读） */
export function getOverrides(): Readonly<ShortcutOverrides> {
  return state.overrides
}

/** 某条命令的覆盖值；`undefined` = 没改过 */
export function getOverride(id: string): ShortcutOverride | undefined {
  const value = state.overrides[id]
  return value === undefined ? undefined : value
}

/**
 * 整体替换覆盖值并落盘。
 *
 * 走「整表替换」而不是逐条增删：设置面板本来就是一个 draft 一次性提交，
 * 中间态不需要被持久化，也就不需要处理「写了一半」的问题。
 */
export function applyOverrides(next: ShortcutOverrides): void {
  const cleaned: ShortcutOverrides = {}
  for (const [id, value] of Object.entries(next)) {
    if (value === null || typeof value === 'string') cleaned[id] = value
  }
  state.overrides = cleaned
  persist()
}

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, overrides: state.overrides })
    )
  } catch {
    // 磁盘满 / 隐私模式：快捷键改动这一会话内仍然生效，只是下次打开会回到默认
  }
}
