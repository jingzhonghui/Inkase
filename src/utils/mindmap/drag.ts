/**
 * 画布拖拽的纯逻辑
 *
 * 为什么自己写拖拽：渲染库内建的节点拖拽在 Electron 里没能生效，
 * 而它的实现埋在一大坨压缩代码里、还依赖 `document.elementFromPoint` 和内部
 * 状态机，出问题时无法定位也无法兜底。这里把「落在哪儿、插到哪」抽成纯函数，
 * 组件只负责指针事件和调用渲染库的 moveNode* 接口。
 */

/** 拖动时的插入方式：放到目标之前 / 成为目标子节点 / 放到目标之后 */
export type DropInsertType = 'before' | 'in' | 'after'

/** 触发拖拽的最小位移（像素）：太小会把单击误判成拖动 */
export const DRAG_THRESHOLD = 4

/** 落到目标上/下 1/4 区域时算「前后插入」，中间一半算「成为子节点」 */
export const DROP_EDGE_RATIO = 0.25

/**
 * 根据指针在目标主题内的纵向位置决定插入方式。
 * 与 XMind 一致：靠近上边缘往上插，靠近下边缘往下插，中间区域变成子节点。
 */
export function resolveInsertType(
  rect: { top: number; height: number },
  clientY: number
): DropInsertType {
  if (!(rect.height > 0)) return 'in'
  const ratio = (clientY - rect.top) / rect.height
  if (ratio < DROP_EDGE_RATIO) return 'before'
  if (ratio >= 1 - DROP_EDGE_RATIO) return 'after'
  return 'in'
}

/** 渲染库节点结构里我们需要的字段 */
export interface DraggableNodeLike {
  id?: string
  children?: unknown[]
}

/**
 * 判断 `id` 是否落在 `node` 这棵子树里（含自身）。
 * 用于挡住「把主题拖进自己的子孙节点」这种会让数据成环的非法操作。
 */
export function containsNodeId(node: DraggableNodeLike | null | undefined, id: string): boolean {
  if (!node || !id) return false
  if (node.id === id) return true
  if (!Array.isArray(node.children)) return false
  return node.children.some((child) => containsNodeId(child as DraggableNodeLike, id))
}

/** 拖拽浮层的展示文案：过长时截断，避免浮层被撑爆 */
export function ghostLabel(text: string, maxLength = 40): string {
  const trimmed = text.trim()
  if (trimmed === '') return '主题'
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed
}
