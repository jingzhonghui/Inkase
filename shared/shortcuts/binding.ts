/**
 * 快捷键绑定：在「人类写的字符串」和 `KeyboardEvent` 之间互相翻译。
 *
 * 放在 `shared/` 是因为**主进程也要用**：焦点在 draw.io 的跨域 iframe 里时，
 * 页面收不到 keydown，只能靠 `webContents.on('before-input-event')` 拦截，
 * 而主进程判断「这次按键是不是保存」必须和渲染层用同一套解析与匹配——
 * 两边各写一份，用户改键之后就必然对不上。
 *
 * 这一层全是纯函数，没有 Vue / DOM / Node 依赖。
 *
 * ## 为什么用 `Mod`
 *
 * 绑定一律写成 `Mod+S` 而不是 `Ctrl+S`：`Mod` 在 Windows/Linux 上是 Ctrl，
 * 在 macOS 上是 ⌘。存储与匹配只认 `Mod`，显示时才展开成当前平台的写法，
 * 这样同一个键位在三种平台上各得其所，配置也还能跨平台迁移。
 *
 * 需要绑死某一个物理键时才写 `Ctrl` / `Meta`，但默认都该用 `Mod`。
 *
 * ## 键名规范化
 *
 * `event.key` 在不同按键上给的形态并不统一：字母给 `n`，带 Shift 时给 `N`，
 * 逗号给 `,`，方向键给 `ArrowLeft`。这里统一成一套内部名字
 * （`n` / `n` / `Comma` / `Left`），解析与匹配都只跟这套名字打交道。
 */

/** 支持快捷键的平台。`process.platform` 的三选一，浏览器里由 UA 推断 */
export type ShortcutPlatform = 'win32' | 'darwin' | 'linux'

/** 一份解析好的绑定 */
export interface ParsedBinding {
  /** 平台主修饰键（Win/Linux = Ctrl，macOS = ⌘） */
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  /** 规范化后的键名，见 `normalizeKey` */
  key: string
}

/** 遮住 `KeyboardEvent` 里我们关心的四个修饰键 + key，方便测试与主进程直接构造假事件 */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const MODIFIER_ALIASES: Record<string, 'mod' | 'ctrl' | 'alt' | 'shift' | 'meta'> = {
  mod: 'mod',
  cmdorctrl: 'mod',
  primary: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta'
}

/**
 * 键名别名表：小写别名 → 内部键名。
 *
 * 三个来源共用这张表：写配置的人（`Mod+Comma`）、`event.key`（`,`）、
 * ProseMirror 的键名（`Mod-BracketLeft`，Phase 4 才接，先留好）。
 */
const KEY_ALIASES: Record<string, string> = {
  arrowleft: 'Left',
  left: 'Left',
  arrowright: 'Right',
  right: 'Right',
  arrowup: 'Up',
  up: 'Up',
  arrowdown: 'Down',
  down: 'Down',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: 'Space',
  ' ': 'Space',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  ',': 'Comma',
  comma: 'Comma',
  '/': 'Slash',
  slash: 'Slash',
  '[': 'BracketLeft',
  bracketleft: 'BracketLeft',
  ']': 'BracketRight',
  bracketright: 'BracketRight',
  '-': 'Minus',
  minus: 'Minus',
  '=': 'Equal',
  equal: 'Equal',
  '`': 'Backquote',
  backquote: 'Backquote',
  ';': 'Semicolon',
  semicolon: 'Semicolon',
  "'": 'Quote',
  quote: 'Quote',
  '\\': 'Backslash',
  backslash: 'Backslash',
  '.': 'Period',
  period: 'Period',
  '+': 'Plus',
  plus: 'Plus'
}

/** 键名 → 显示文本（只放「照抄键名会看不懂」的那些） */
const KEY_LABELS: Record<string, string> = {
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  Comma: ',',
  Slash: '/',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
  Escape: 'Esc',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
  Period: '.',
  Plus: '+'
}

/**
 * 把任意来源的键名压成内部名字；认不出来返回 null（`Control`、`Shift` 这类
 * 纯修饰键会走这条，用于避免把「单独按 Ctrl」误判成某个绑定）。
 */
export function normalizeKey(raw: string): string | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  const alias = KEY_ALIASES[lower]
  if (alias) return alias
  if (/^[a-z]$/.test(lower)) return lower
  if (/^[0-9]$/.test(lower)) return lower
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase()
  return null
}

/** 解析 `Mod+Shift+K` 这样的绑定串；格式不对返回 null（调用方按「无绑定」处理） */
export function parseBinding(input: string): ParsedBinding | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null

  const parts = trimmed.split('+').map((part) => part.trim())
  // 'Ctrl++' 会切出空段：末尾的 '+' 是键本身，中间的才是多余的
  const keyRaw = parts[parts.length - 1]
  if (!keyRaw) return null

  const key = normalizeKey(keyRaw)
  if (!key) return null

  const parsed: ParsedBinding = {
    mod: false,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key
  }

  for (const part of parts.slice(0, -1)) {
    if (!part) return null
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (!modifier) return null
    parsed[modifier] = true
  }

  return parsed
}

/**
 * `Mod` 展开成当前平台的真实修饰键。
 * 显式写了 `Ctrl` / `Meta` 的保持原样，不会被平台覆盖。
 */
function resolveModifiers(
  parsed: ParsedBinding,
  platform: ShortcutPlatform
): { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean } {
  return {
    ctrl: parsed.ctrl || (parsed.mod && platform !== 'darwin'),
    alt: parsed.alt,
    shift: parsed.shift,
    meta: parsed.meta || (parsed.mod && platform === 'darwin')
  }
}

function keyLabel(key: string): string {
  const label = KEY_LABELS[key]
  if (label) return label
  return /^[a-z]$/.test(key) ? key.toUpperCase() : key
}

/**
 * 绑定的显示文本。
 *
 * Windows/Linux 按 `Ctrl → Shift → Alt` 排列——这是仓库里既有文案的顺序
 * （`Ctrl+Shift+S`、`Shift+Alt+F`），顺序换了会让菜单文案整体变脸。
 * macOS 用符号并按 `⌃⌥⇧⌘` 排。
 */
export function formatBinding(
  binding: string,
  platform: ShortcutPlatform = detectPlatform()
): string {
  const parsed = parseBinding(binding)
  if (!parsed) return binding

  const mods = resolveModifiers(parsed, platform)
  const key = keyLabel(parsed.key)

  if (platform === 'darwin') {
    return `${mods.ctrl ? '⌃' : ''}${mods.alt ? '⌥' : ''}${mods.shift ? '⇧' : ''}${
      mods.meta ? '⌘' : ''
    }${key}`
  }

  const parts: string[] = []
  if (mods.ctrl) parts.push('Ctrl')
  if (mods.shift) parts.push('Shift')
  if (mods.alt) parts.push('Alt')
  if (mods.meta) parts.push('Win')
  parts.push(key)
  return parts.join('+')
}

/** 事件是否命中该绑定：修饰键必须**完全一致**，多按少按都不算 */
export function matchesBinding(
  binding: string,
  event: KeyEventLike,
  platform: ShortcutPlatform = detectPlatform()
): boolean {
  const parsed = parseBinding(binding)
  if (!parsed) return false

  const expected = resolveModifiers(parsed, platform)
  if (expected.ctrl !== event.ctrlKey) return false
  if (expected.meta !== event.metaKey) return false
  if (expected.alt !== event.altKey) return false
  if (expected.shift !== event.shiftKey) return false

  return normalizeKey(event.key) === parsed.key
}

/**
 * 把一次按键**录**成绑定字符串（录制界面用）。
 *
 * 与 `matchesBinding` 互为逆运算，两点约定：
 * 1. 平台主修饰键一律写成 `Mod`，另一个平台的那个键写成 `Ctrl` / `Meta`，
 *    这样录出来的配置换台机器还能理解；
 * 2. 只按修饰键（单独按 Ctrl、单独按 Shift）返回 null——录制界面据此
 *    继续等待下一个按键，而不是把「Ctrl」当成一个绑定收下。
 */
export function bindingFromEvent(
  event: KeyEventLike,
  platform: ShortcutPlatform = detectPlatform()
): string | null {
  const key = normalizeKey(event.key)
  if (!key) return null

  const parts: string[] = []
  const primaryPressed = platform === 'darwin' ? event.metaKey : event.ctrlKey
  const foreignPressed = platform === 'darwin' ? event.ctrlKey : event.metaKey

  if (primaryPressed) parts.push('Mod')
  if (foreignPressed) parts.push(platform === 'darwin' ? 'Ctrl' : 'Meta')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  // 没有任何修饰键的组合不收：单键绑定会把打字吞掉
  if (parts.length === 0) return null

  // 字母统一大写存放，和注册表里的默认值写法保持一致
  const keyText = /^[a-z]$/.test(key) ? key.toUpperCase() : key
  return [...parts, keyText].join('+')
}

/**
 * 绑定的「同键判定」签名：把 `Mod` 按平台展开后再序列化。
 *
 * 冲突检测必须用它而不是直接比字符串：`Mod+K` 与 `Ctrl+K` 在 Windows 上是
 * 同一个键、在 macOS 上不是（一个是 ⌘K，一个是 ⌃K）。签名把平台差异算进去，
 * 于是同一个函数在两边都能给出正确结论。
 */
export function bindingSignature(
  binding: string,
  platform: ShortcutPlatform = detectPlatform()
): string | null {
  const parsed = parseBinding(binding)
  if (!parsed) return null
  const mods = resolveModifiers(parsed, platform)
  return [
    mods.ctrl ? 'C' : '',
    mods.alt ? 'A' : '',
    mods.shift ? 'S' : '',
    mods.meta ? 'M' : '',
    parsed.key
  ].join('|')
}

/**
 * 系统保留键：录到这些组合时直接拒绝，不当作可配置绑定。
 *
 * 只列「按下去系统会先动手」的那几个——放进来一旦录成功，用户会以为
 * 应用抢到了，实际是系统赢了，之后怎么按都没反应。
 */
export function isReservedBinding(
  binding: string,
  platform: ShortcutPlatform = detectPlatform()
): boolean {
  const parsed = parseBinding(binding)
  if (!parsed) return false
  const mods = resolveModifiers(parsed, platform)
  const key = parsed.key

  // 退出/关闭窗口：Alt+F4（Win）、⌘Q（macOS）
  if (mods.alt && !mods.ctrl && !mods.shift && !mods.meta && key === 'F4' && platform !== 'darwin')
    return true
  if (mods.meta && !mods.alt && !mods.ctrl && key === 'q') return true
  if (mods.meta && !mods.alt && !mods.ctrl && (key === 'h' || key === 'm')) return true

  // 开发者工具与全屏
  if (key === 'F12') return true
  if (key === 'F11') return true

  return false
}

/** 把 `process.platform` 这类字符串收窄成三种取值 */
export function normalizePlatform(value: string): ShortcutPlatform {
  if (value === 'darwin') return 'darwin'
  if (value === 'linux') return 'linux'
  return 'win32'
}

/**
 * 当前平台（渲染层用）。
 *
 * 用 UA 推断而**不是**主进程的 `getPlatform` IPC，原因是这个函数必须是同步的：
 * 注册表格式化、菜单渲染、按键匹配全在同步路径上调用它，改成 await 会把整条
 * 链路染成异步。Electron 的默认 UA 里带着平台（`Macintosh` / `Win32` /
 * `Linux`），足够可靠。
 *
 * `app:getPlatform` 那条通道是补齐过的（早前只有 preload 声明、主进程没注册
 * handler，调用必 reject），保留它给「需要精确平台又不在同步路径上」的场景。
 * 主进程自己用 `process.platform` + `normalizePlatform`，不经过这里。
 */
export function detectPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'win32'
  const ua = navigator.userAgent || ''
  if (/mac|iphone|ipad/i.test(ua)) return 'darwin'
  if (/linux|android/i.test(ua)) return 'linux'
  return 'win32'
}
