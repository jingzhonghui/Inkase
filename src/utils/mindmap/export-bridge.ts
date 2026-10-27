/**
 * 思维导图图片导出的「桥」
 *
 * 图片必须从**渲染中的 DOM** 抄，而 DOM 只在 `MindMapEditor` 里；
 * 菜单栏与 store 却要发起导出。两边不能直接 import（循环依赖 + 组件实例不可达），
 * 于是这里放一个「当前挂载的导图编辑器」单点登记。
 *
 * 为什么只用一个槽位而不是 Map：
 * 同一时刻只有激活标签会被真正渲染（`EditorPanel` 只渲染 activeTab），
 * 所以「当前能导出的导图」天然只有一个；多槽位反而要处理失效清理。
 */

export type MindMapImageFormat = 'png' | 'svg'

/** 生成好的一张图（还没落盘） */
export interface MindMapImageFile {
  format: MindMapImageFormat
  /** 图片的 CSS 尺寸（PNG 的像素尺寸是它的 scale 倍） */
  width: number
  height: number
  bytes: Uint8Array
}

export type MindMapImageBuilder = (format: MindMapImageFormat) => Promise<MindMapImageFile>

let builder: MindMapImageBuilder | null = null

/**
 * 登记当前导图编辑器的出图能力，返回注销函数。
 * 注销函数会校验「注销的是不是自己」：切标签时新实例可能已经先登记上了，
 * 无条件置空会把新实例的能力一起清掉。
 */
export function registerMindMapImageBuilder(next: MindMapImageBuilder): () => void {
  builder = next
  return () => {
    if (builder === next) builder = null
  }
}

export function getMindMapImageBuilder(): MindMapImageBuilder | null {
  return builder
}

/** 仅供测试复位 */
export function resetMindMapImageBuilder(): void {
  builder = null
}
