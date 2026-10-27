/**
 * 思维导图磁盘格式的共享定义
 *
 * 主进程（新建 `.inkmind` 文件时要写入一个可解析的空白导图）与渲染进程
 * （解析 / 序列化 / 识别文件类型）都依赖这几个常量，集中在这里避免两边
 * 各写一份 schema 字符串而悄悄漂移。
 *
 * 这里只放「主进程也需要」的最小集合；完整的节点模型、id 生成、
 * 容错解析与序列化仍在 `src/types/mindmap.ts` 与 `src/utils/mindmap/schema.ts`。
 */

/** 磁盘格式标识（写入 `schema` 字段，用于识别文件类型与拒绝异物） */
export const MINDMAP_FILE_SCHEMA = 'inkase.mindmap'

/** 当前 schema 版本 */
export const MINDMAP_VERSION = 2

/** 思维导图文件扩展名（含点） */
export const MINDMAP_EXTENSION = '.inkmind'

/**
 * 优先级标签的预设。
 *
 * 放在 shared 而不是渲染层：XMind 导入时要把 `priority-1` 映射成同样的标签与配色，
 * 两边各写一份就会出现「导入的 P1 是红的、手点的 P1 是橙的」。
 */
export const MINDMAP_PRIORITIES = [
  { text: 'P1', color: '#ef4444' },
  { text: 'P2', color: '#f97316' },
  { text: 'P3', color: '#eab308' }
] as const

/** 空白导图的根节点 id（固定值即可：每个文件只在自己的文档内唯一） */
const EMPTY_ROOT_ID = 'n_root'

/**
 * 生成空白导图的落盘文本。
 *
 * 输出格式必须与渲染进程的 `serializeMindMap` 保持一致（2 空格缩进 + 末尾换行）：
 * 主进程创建的文件随后会被渲染层解析、编辑、再序列化，若格式不同，
 * 用户会看到「刚建的文件被无端重排」。
 */
export function createEmptyMindMapText(rootText = '中心主题'): string {
  const document = {
    schema: MINDMAP_FILE_SCHEMA,
    version: MINDMAP_VERSION,
    root: {
      id: EMPTY_ROOT_ID,
      text: rootText,
      children: [] as unknown[]
    }
  }
  return `${JSON.stringify(document, null, 2)}\n`
}
