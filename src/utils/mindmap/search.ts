/**
 * 思维导图内查找
 *
 * 职责边界：只做「在模型上找出命中」，不碰 DOM、不 import 渲染库。
 * 跳转（展开祖先、滚动居中、选中）由组件负责，这里只给出需要的信息。
 *
 * 为什么单独成模块：命中顺序、大小写规则、祖先链这三件事最容易出错，
 * 抽成纯函数后可以用假数据精确验证，不必挂载画布。
 */

import type { MindMapNode } from '../../types/mindmap'

/** 一条命中 */
export interface MindMapMatch {
  /** 命中节点的 id（与渲染层一一对应，用于 findEle） */
  id: string
  /** 节点文字（面板后续要显示路径时可直接用） */
  text: string
  /** 从根到该节点父级的 id 链（不含自身），按层序由浅到深 */
  ancestorIds: string[]
}

/** 归一化查询词：去首尾空白；区分大小写时保持原样 */
function normalizeQuery(query: string, caseSensitive: boolean): string {
  const trimmed = typeof query === 'string' ? query.trim() : ''
  return caseSensitive ? trimmed : trimmed.toLowerCase()
}

/**
 * 找出从根到 `id` 的祖先 id 链（**不含自身**）。
 *
 * 返回 `[]` 有两种含义，调用方按同一策略处理即可：
 * - 目标就是根节点（没有祖先）；
 * - 目标不在树上。
 */
export function findAncestorIds(root: MindMapNode, id: string): string[] {
  if (root.id === id) return []

  const walk = (node: MindMapNode, trail: string[]): string[] | null => {
    for (const child of node.children) {
      if (child.id === id) return trail
      const found = walk(child, [...trail, child.id])
      if (found) return found
    }
    return null
  }

  // 根节点自身要进 trail：它的子节点命中时祖先链应当是 [root.id]
  return walk(root, [root.id]) ?? []
}

/**
 * 收集命中节点。
 *
 * 遍历顺序是深度优先（父节点先于子节点、兄弟按声明顺序），
 * 即画布上的「阅读顺序」，用户按 Enter 逐个跳时符合直觉。
 *
 * 空查询、纯空白查询、非字符串一律返回空数组——调用方据此清空高亮。
 */
export function collectMatches(
  root: MindMapNode,
  query: string,
  caseSensitive = false
): MindMapMatch[] {
  const needle = normalizeQuery(query, caseSensitive)
  if (needle === '') return []

  const matches: MindMapMatch[] = []

  const walk = (node: MindMapNode, trail: string[]): void => {
    const haystack = caseSensitive ? node.text : node.text.toLowerCase()
    if (haystack.includes(needle)) {
      matches.push({ id: node.id, text: node.text, ancestorIds: trail })
    }
    const nextTrail = [...trail, node.id]
    for (const child of node.children) walk(child, nextTrail)
  }

  walk(root, [])
  return matches
}

/**
 * 在命中列表上循环步进。
 *
 * - `total <= 0`（没有命中）返回 `-1`，调用方据此不跳转；
 * - `current` 非法（-1、越界）时：正向取第一项，反向取最后一项；
 * - 其余情况按取模回卷，保证 `Enter` 连按永远在命中之间循环。
 */
export function nextMatchIndex(current: number, total: number, step: 1 | -1): number {
  if (!Number.isFinite(total) || total <= 0) return -1
  if (!Number.isFinite(current) || current < 0 || current >= total) {
    return step === 1 ? 0 : total - 1
  }
  return (current + step + total) % total
}
