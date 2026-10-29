import type { GraphNodeFormat } from '../../../shared/graph/types'

/**
 * 格式 → 形状。
 *
 * 颜色已经被「顶层目录」占用了，入链数占用了半径，断链占用了虚线空心，
 * 于是四种文档格式在画布上原本**没有任何视觉表达**——一篇导图和一篇笔记
 * 长得一模一样，只有点开才知道是什么。
 *
 * 形状是唯一还能开的通道，而且在小尺寸下就可辨（圆 / 菱形 / 方 / 三角）。
 * 它刻意不做成「每种格式一个形状」：`.mdx` 与 `.md` 都是正文文档，
 * 差别只在容器，用户不需要为此建立第四种视觉符号，因此合并成圆点。
 */
export type NodeShape = 'circle' | 'diamond' | 'square' | 'triangle'

export function nodeShape(format: GraphNodeFormat): NodeShape {
  switch (format) {
    case 'mindmap':
      return 'diamond'
    case 'diagram':
      return 'square'
    case 'attachment':
      // 被链接到的非文档文件：形状上必须与「文档」明确分开，
      // 否则 `deploy.sh` 看起来和一篇笔记一样，点开才发现打不开
      return 'triangle'
    default:
      return 'circle'
  }
}

/**
 * 侧栏「类型」分组的定义。
 *
 * 与 `nodeShape` 必须共用同一份映射：侧栏里画出来的样本形状就是画布上的形状，
 * 否则图例和画面对不上，用户学到的是错的读法。
 * 后缀一并写在这里，是因为「哪些后缀算同一类」本身就是这条视觉编码的定义。
 */
export interface ShapeGroup {
  id: string
  shape: NodeShape
  title: string
  /** 归入这一组的格式（过滤时一起开关） */
  formats: readonly GraphNodeFormat[]
  /** 该组的文件后缀，供侧栏直接展示 */
  extensions: string
}

export const SHAPE_GROUPS: readonly ShapeGroup[] = [
  { id: 'docs', shape: 'circle', title: '文档', formats: ['mdx', 'markdown'], extensions: '.mdx .md' },
  { id: 'mindmap', shape: 'diamond', title: '导图', formats: ['mindmap'], extensions: '.inkmind' },
  { id: 'diagram', shape: 'square', title: '图表', formats: ['diagram'], extensions: '.drawio' },
  {
    id: 'attachment',
    shape: 'triangle',
    title: '其他',
    formats: ['attachment'],
    // 这一组不是靠后缀认的：任何后缀都可能出现在这里，只看「有没有被链接到」
    extensions: '任意后缀'
  }
]
