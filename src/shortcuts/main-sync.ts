import { bindingOf, isCommandId, MAIN_INTERCEPTED_COMMANDS, type CommandId } from './registry'

/**
 * 把「主进程需要拦截的命令 → 当前绑定」推送给主进程。
 *
 * 为什么需要这一步：图表画布的 draw.io 在跨域 iframe 里，那里的 keydown 冒泡
 * 不到页面，只能在主进程的 `before-input-event` 里拦。而键位是用户可以改的，
 * 主进程自己不可能知道——所以渲染层推什么，主进程就拦什么，两边不会各说各话。
 *
 * 只推 `MAIN_INTERCEPTED_COMMANDS` 里的那几条（保存 / 另存为 / 关标签）。
 * 解绑的条目直接剔除：没绑定的命令不该被拦截。
 *
 * 调用时机：`AppHeader` 的 setup 里挂一个 `watchEffect`，它读 `bindingOf`，
 * 因此用户一保存快捷键就会自动重推——不需要额外的事件。
 */
export function pushShortcutsToMain(): void {
  const api = window.electronAPI
  if (!api?.syncShortcuts) return

  const bindings: Array<{ id: string; binding: string }> = []
  for (const id of MAIN_INTERCEPTED_COMMANDS) {
    const binding = bindingOf(id)
    if (binding) bindings.push({ id, binding })
  }
  api.syncShortcuts(bindings)
}

/**
 * 主进程转发回来的按键 → 命令。
 *
 * 主进程只可能转发 `MAIN_INTERCEPTED_COMMANDS` 里的 id（那份名单是它唯一
 * 认得的东西），但仍然要校验一次：IPC 是跨进程边界，不该假设对端守规矩。
 */
export function isForwardedCommand(id: string): id is CommandId {
  return isCommandId(id) && MAIN_INTERCEPTED_COMMANDS.includes(id)
}
