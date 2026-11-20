/**
 * 写系统剪贴板。
 *
 * 失败一律静默。复制是右键菜单里的高频小动作，剪贴板不可用（窗口未聚焦、
 * 无安全上下文等）时弹一个错误框只会打断用户；内容没进剪贴板，用户自然会再点一次。
 *
 * 必须 `.catch()`：`writeText` 返回 Promise，失败走 reject 而不是 throw，
 * 只套 `try/catch` 会漏成 unhandled rejection。
 */
export function writeClipboardText(text: string): void {
  try {
    void navigator.clipboard.writeText(text).catch(() => {
      // 忽略
    })
  } catch {
    // 忽略：连 clipboard 对象都没有
  }
}
