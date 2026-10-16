/**
 * IR 模式大纲提取。
 *
 * 从 ProseMirror 文档模型直接提取标题，而不是从序列化后的 Markdown 文本按行解析：
 * 文档模型带有节点的真实位置，点击大纲即可精确跳转。标题行首的 `#` 标记是真实
 * 文本（见 heading-markers.ts），提取时需按标记长度剥离。
 */
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { getHeadingMarkerLength } from './heading-markers'

/** 大纲条目：标题级别、显示文本、以及标题节点在文档中的起始位置。 */
export interface OutlineHeading {
  /** 1..6 */
  level: number
  /** 去掉行首 `#` 标记后的纯文本 */
  text: string
  /** 标题节点自身的文档位置，可用于 view.nodeDOM(pos) 定位 DOM */
  pos: number
}

/**
 * 按文档顺序收集所有**顶层**标题。
 * 与文本提取（extractHeadings，仅行首 ATX）口径一致：引用块/列表内嵌套的标题不计入，
 * 从而保证大纲列表索引与跳转目标一一对应。
 */
export function collectOutlineHeadings(doc: ProseMirrorNode): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  doc.forEach((node, pos) => {
    if (node.type.name !== 'heading') return
    const markerLength = getHeadingMarkerLength(node)
    const text = node.textContent.slice(markerLength).trim()
    headings.push({
      level: (node.attrs.level as number) ?? 1,
      text,
      pos
    })
  })
  return headings
}
