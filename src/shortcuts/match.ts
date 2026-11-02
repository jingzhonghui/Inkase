/**
 * 快捷键匹配：把一次按键翻译成一个命令。
 *
 * 这里是「谁先吃这个键」的唯一裁决处，顺序写死、不做插件式扩展——
 * 快捷键系统最容易烂的地方就是优先级变得不可推理。
 *
 * 判定顺序：
 * 1. 只考虑注册表里 `owner: 'app'` 的命令（编辑器自己的键派发器不抢）；
 * 2. 只在同一优先级层里匹配（`capture` 层由标签切换专享）；
 * 3. 修饰键必须完全一致（由 `matchesBinding` 保证，多按少按都不算）；
 * 4. `needsDialogClosed` 的命令在对话框打开时不响应；
 * 5. `allowInInput` 为 false 的命令在输入框聚焦时不响应。
 *
 * 输入法组合（`isComposing`）与 Esc 仍由调用方先行处理：那两条不属于
 * 「命令」，而是「按键该不该被当成命令」的前置判断。
 */
import { matchesBinding, type KeyEventLike, type ShortcutPlatform } from './binding'
import { bindingOf, COMMANDS, type ShortcutCommand } from './registry'

export interface MatchContext {
  /** 要匹配哪一层：冒泡阶段的应用命令，还是捕获阶段的导航命令 */
  priority: 'bubble' | 'capture'
  hasDialogOpen: boolean
  isTextInput: boolean
}

export function matchCommand(
  event: KeyEventLike,
  platform: ShortcutPlatform,
  context: MatchContext
): ShortcutCommand | null {
  for (const command of COMMANDS) {
    if (command.owner !== 'app') continue
    if ((command.priority ?? 'bubble') !== context.priority) continue
    // 必须读 `bindingOf` 而不是 `command.binding`：前者把用户改的键算进去，
    // 后者永远是默认值——只读默认值的话，设置面板里改完键，界面文案变了、
    // 主进程也跟着变了，唯独真正派发的这一处还按旧键，等于改键没生效。
    const binding = bindingOf(command.id)
    if (!binding) continue
    if (!matchesBinding(binding, event, platform)) continue
    if (context.hasDialogOpen && command.needsDialogClosed) continue
    if (context.isTextInput && command.allowInInput === false) continue
    return command
  }
  return null
}
