/**
 * 图表「保存前冲刷」注册表。
 *
 * 问题：draw.io 的改动是经 `autosave` 消息异步回传的（本仓库还加了去抖），
 * 而 Ctrl+S 走的是 store 里的 `saveFile()`——它读的是 `tab.content`。
 * 用户刚拖完一个框就按保存，很可能把去抖窗口里的最后一次改动写丢。
 *
 * 解法：编辑器挂载时往这里登记一个「立刻把最新 XML 推给 store」的函数，
 * store 在写盘前按 tabId 找它冲一次。用注册表而不是让 store 直接引用组件，
 * 是为了保持「store 不认识 UI」这条边界。
 */

type DiagramFlusher = () => Promise<void> | void

const flushers = new Map<string, DiagramFlusher>()

/** 登记某个标签的冲刷函数，返回注销函数（组件卸载时调用）。 */
export function registerDiagramFlusher(tabId: string, flusher: DiagramFlusher): () => void {
  flushers.set(tabId, flusher)
  return () => {
    if (flushers.get(tabId) === flusher) flushers.delete(tabId)
  }
}

/** 保存前调用：把图表编辑器里最新状态同步进 store。没有登记时是空操作。 */
export async function flushDiagramEdits(tabId?: string | null): Promise<void> {
  if (!tabId) return
  const flusher = flushers.get(tabId)
  if (!flusher) return
  try {
    await flusher()
  } catch {
    // 冲刷失败（例如编辑器已销毁）不应阻断保存：宁可写上一份已知内容
  }
}

/** 仅用于测试：清空登记表。 */
export function resetDiagramFlushers(): void {
  flushers.clear()
}
