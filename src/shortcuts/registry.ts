/**
 * 命令注册表：**所有**快捷键的唯一真相。
 *
 * 在这之前同一件事有三份记录——`handleKeydown` 里的 if 分支（行为）、
 * 菜单项里的 `shortcut: 'Ctrl+S'`（显示）、`shortcuts` 数组（速查表）。
 * 改一个键要改三处，漏一处就自相矛盾。现在它们都从这里读。
 *
 * ## `owner` 是什么意思
 *
 * 不是所有按键都该由应用的派发器处理：
 * - `app`：应用级命令，落在 `AppHeader` 的派发器上（新建、打开、保存、设置…）；
 * - `editor`：编辑器内部命令，真正的执行者是 ProseMirror / CodeMirror 的
 *   keymap（加粗、查找、插入链接…）。注册表里记着它的键位，是为了让菜单、
 *   速查表、将来的录制界面都能显示同一份数据，派发器**不会**去抢这些键；
 * - `native`：交给系统/浏览器的默认行为（剪切复制粘贴这类，我们只展示）。
 *
 * ## Phase 1 的边界
 *
 * 这一轮只做「把现状搬进注册表」：键位与行为都不变，没有存储、没有录制界面。
 * `binding` 现在直接返回默认值；Phase 2 会在这一层挂上用户覆盖值
 * （`bindingOf` 是唯一的读取入口，届时只改它一个函数）。
 */
import {
  bindingSignature,
  detectPlatform,
  formatBinding,
  parseBinding,
  type ShortcutPlatform
} from './binding'
import { getOverrides, type ShortcutOverrides } from './overrides'

/** 命令 id：`分组.动作`，稳定且可持久化，改名会让旧配置失效 */
export type CommandId =
  | 'file.new'
  | 'file.new-mindmap'
  | 'file.new-diagram'
  | 'file.open'
  | 'file.quick-open'
  | 'file.save'
  | 'file.save-as'
  | 'file.close-tab'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.cut'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.find'
  | 'edit.replace'
  | 'insert.image'
  | 'insert.link'
  | 'view.graph'
  | 'app.settings'
  | 'tab.prev'
  | 'tab.next'
  | 'editor.bold'
  | 'editor.italic'
  | 'editor.toggle-mode'
  | 'editor.format'

export type CommandGroup = 'file' | 'edit' | 'view' | 'navigation' | 'editor'

/** 谁负责执行这个命令，见文件头注释 */
export type CommandOwner = 'app' | 'editor' | 'native'

export interface ShortcutCommand {
  id: CommandId
  /** 给人看的名字：速查表用，将来的录制界面也用这一份 */
  label: string
  group: CommandGroup
  owner: CommandOwner
  /** 默认绑定；`null` 表示没有默认键 */
  binding: string | null
  /**
   * `capture`：必须在编辑器之前处理。目前只有标签切换——
   * `Ctrl+←/→` 与编辑器内「按词移动光标」冲突，冒泡阶段已经来不及。
   */
  priority?: 'bubble' | 'capture'
  /**
   * 焦点在输入框时是否仍然生效。
   *
   * 默认 true（「在哪儿按都算」）。置 false 的只有会**把用户眼前的输入框整个
   * 换掉**的那四条：新建文件 / 新建导图 / 新建图表 / 打开文件——它们会在你
   * 正打文件名时换成新标签或系统对话框。快速打开、设置、图谱这类只是「再开
   * 一个面板」，按到也没损失，保持生效。
   *
   * 注意这条只对渲染层的 keydown 派发有效：走主进程转发（`MAIN_INTERCEPTED_
   * COMMANDS`）的命令没有焦点信息。好在名单里那三条（保存/另存为/关标签）
   * 本来就该在输入框里生效，两边不冲突。
   */
  allowInInput?: boolean
  /** 有对话框开着时不响应（免得用户想关对话框却关掉了文档） */
  needsDialogClosed?: boolean
}

export const COMMAND_GROUP_LABELS: Record<CommandGroup, string> = {
  file: '文件',
  edit: '编辑',
  view: '视图',
  navigation: '导航',
  editor: '编辑器'
}

export const COMMANDS: readonly ShortcutCommand[] = [
  {
    id: 'file.new',
    label: '新建文件',
    group: 'file',
    owner: 'app',
    binding: 'Mod+N',
    // 会新建标签，把用户眼前的输入框整个换掉——在搜索框里打字误按很恼人
    allowInInput: false
  },
  {
    id: 'file.new-mindmap',
    label: '新建思维导图',
    group: 'file',
    owner: 'app',
    binding: 'Mod+Shift+N',
    allowInInput: false
  },
  {
    id: 'file.new-diagram',
    label: '新建图表',
    group: 'file',
    owner: 'app',
    binding: 'Mod+Shift+D',
    allowInInput: false
  },
  {
    id: 'file.open',
    label: '打开文件',
    group: 'file',
    owner: 'app',
    binding: 'Mod+O',
    // 会弹系统对话框，同样属于「把人从当前输入甩走」
    allowInInput: false
  },
  {
    id: 'file.quick-open',
    label: '快速打开文件',
    group: 'file',
    owner: 'app',
    binding: 'Mod+P'
  },
  { id: 'file.save', label: '保存文件', group: 'file', owner: 'app', binding: 'Mod+S' },
  { id: 'file.save-as', label: '另存为', group: 'file', owner: 'app', binding: 'Mod+Shift+S' },
  {
    id: 'file.close-tab',
    label: '关闭标签页',
    group: 'file',
    owner: 'app',
    binding: 'Mod+W',
    needsDialogClosed: true
  },

  // 编辑器与系统默认实现这些动作，这里只登记键位用于显示
  { id: 'edit.undo', label: '撤销', group: 'edit', owner: 'editor', binding: 'Mod+Z' },
  { id: 'edit.redo', label: '重做', group: 'edit', owner: 'editor', binding: 'Mod+Y' },
  { id: 'edit.cut', label: '剪切', group: 'edit', owner: 'native', binding: 'Mod+X' },
  { id: 'edit.copy', label: '复制', group: 'edit', owner: 'native', binding: 'Mod+C' },
  { id: 'edit.paste', label: '粘贴', group: 'edit', owner: 'native', binding: 'Mod+V' },
  { id: 'edit.find', label: '查找', group: 'edit', owner: 'editor', binding: 'Mod+F' },
  { id: 'edit.replace', label: '替换', group: 'edit', owner: 'editor', binding: 'Mod+H' },

  {
    id: 'insert.image',
    label: '插入图片',
    group: 'edit',
    owner: 'editor',
    binding: 'Mod+Shift+K'
  },
  { id: 'insert.link', label: '插入链接', group: 'edit', owner: 'editor', binding: 'Mod+K' },

  { id: 'view.graph', label: '打开知识图谱', group: 'view', owner: 'app', binding: 'Mod+Shift+G' },
  { id: 'app.settings', label: '打开设置', group: 'view', owner: 'app', binding: 'Mod+Comma' },

  {
    id: 'tab.prev',
    label: '上一个标签',
    group: 'navigation',
    owner: 'app',
    binding: 'Mod+Left',
    priority: 'capture'
  },
  {
    id: 'tab.next',
    label: '下一个标签',
    group: 'navigation',
    owner: 'app',
    binding: 'Mod+Right',
    priority: 'capture'
  },

  { id: 'editor.bold', label: '粗体', group: 'editor', owner: 'editor', binding: 'Mod+B' },
  { id: 'editor.italic', label: '斜体', group: 'editor', owner: 'editor', binding: 'Mod+I' },
  {
    id: 'editor.toggle-mode',
    label: '切换编辑模式',
    group: 'editor',
    owner: 'editor',
    binding: 'Mod+Slash'
  },
  {
    id: 'editor.format',
    label: '格式化文档（代码/纯文本）',
    group: 'editor',
    owner: 'editor',
    binding: 'Shift+Alt+F'
  }
]

const COMMANDS_BY_ID = new Map<string, ShortcutCommand>(
  COMMANDS.map((command) => [command.id, command])
)

export function commandById(id: CommandId): ShortcutCommand {
  const command = COMMANDS_BY_ID.get(id)
  if (!command) throw new Error(`未注册的命令：${id}`)
  return command
}

/**
 * 命令当前生效的绑定：**用户覆盖值 ?? 默认值**。
 *
 * 这是全仓库读取键位的唯一入口。覆盖值有三态：
 * - `undefined`：没改过 → 用默认值；
 * - `null`：显式解绑 → 没有绑定；
 * - 字符串：用户改的键 → 解析不了就当没改过（坏配置只影响这一条）。
 *
 * 依赖 `getOverride` 读的是模块级 reactive，所以模板里调用本函数时
 * 天然带上了响应性：改完快捷键菜单文案会立刻跟着变。
 */
export function bindingOf(id: CommandId): string | null {
  return effectiveBinding(id, getOverrides())
}

/**
 * 草稿态的生效绑定。
 *
 * 设置面板改的是 draft，还没落盘，所以不能走 `bindingOf`（那读的是当前值）。
 * 语义与 `bindingOf` 完全一致，只是数据源换成传进来的覆盖表。
 */
export function effectiveBinding(id: CommandId, overrides: ShortcutOverrides): string | null {
  const command = commandById(id)
  if (!Object.prototype.hasOwnProperty.call(overrides, id)) return command.binding
  const override = overrides[id]
  if (override === null) return null
  return parseBinding(override) ? override : command.binding
}

/** 该命令是否被用户改过（含显式解绑），界面据此显示「恢复」入口 */
export function isOverridden(id: CommandId, overrides: ShortcutOverrides): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, id)
}

/**
 * 冲突检测：同一个键被两条命令占着。
 *
 * 只在**同一优先级层**里比：`capture` 层的标签切换与 `bubble` 层的命令
 * 即使撞键也不会互相抢（前者更早拿到事件），不需要打扰用户。
 * 返回的 Map 两边都有记录，界面无论从哪一行都能说出「和谁撞了」。
 */
export function findConflicts(
  overrides: ShortcutOverrides,
  platform: ShortcutPlatform
): Map<CommandId, CommandId[]> {
  const buckets = new Map<string, CommandId[]>()

  for (const command of COMMANDS) {
    const binding = effectiveBinding(command.id, overrides)
    if (!binding) continue
    const signature = bindingSignature(binding, platform)
    if (!signature) continue
    const key = `${command.priority ?? 'bubble'}::${signature}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(command.id)
    else buckets.set(key, [command.id])
  }

  const conflicts = new Map<CommandId, CommandId[]>()
  for (const ids of buckets.values()) {
    if (ids.length < 2) continue
    for (const id of ids) conflicts.set(id, ids.filter((other) => other !== id))
  }
  return conflicts
}

/**
 * 需要主进程代为拦截的命令。
 *
 * 只放「焦点在图表画布的跨域 iframe 里会失灵」的那几条：那些地方页面收不到
 * keydown，只能靠主进程的 `before-input-event` 兜底转发。范围刻意收窄——
 * 名单越长，主进程越容易把本该交给输入框/编辑器的按键吞掉。
 */
export const MAIN_INTERCEPTED_COMMANDS: readonly CommandId[] = [
  'file.save',
  'file.save-as',
  'file.close-tab'
]

/** 运行期校验：IPC 与本地存储里拿到的字符串是不是已知命令 */
export function isCommandId(value: string): value is CommandId {
  return COMMANDS_BY_ID.has(value)
}

/** 按分组整理出设置面板要渲染的列表（组内保持注册表顺序） */
export function commandGroups(): Array<{
  group: CommandGroup
  label: string
  commands: ShortcutCommand[]
}> {
  const order: CommandGroup[] = ['file', 'edit', 'view', 'navigation', 'editor']
  return order
    .map((group) => ({
      group,
      label: COMMAND_GROUP_LABELS[group],
      commands: COMMANDS.filter((command) => command.group === group)
    }))
    .filter((section) => section.commands.length > 0)
}

/** 去掉「与默认值相同」和「值非法」的条目，只留下真正需要保存的改动 */
export function normalizeOverrides(overrides: ShortcutOverrides): ShortcutOverrides {
  const result: ShortcutOverrides = {}
  for (const [id, value] of Object.entries(overrides)) {
    const command = COMMANDS_BY_ID.get(id)
    if (!command) continue
    if (value === null) {
      if (command.binding) result[id] = null
      continue
    }
    if (typeof value !== 'string' || !parseBinding(value)) continue
    if (value === command.binding) continue
    result[id] = value
  }
  return result
}

/** 命令的显示文本；没有绑定时返回空串（菜单据此不渲染快捷键列） */
export function formatShortcut(
  id: CommandId,
  platform: ShortcutPlatform = detectPlatform()
): string {
  const binding = bindingOf(id)
  return binding ? formatBinding(binding, platform) : ''
}

