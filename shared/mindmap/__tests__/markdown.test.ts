import { describe, expect, it } from 'vitest'
import { markdownToMindMapJson } from '../../../shared/mindmap/markdown'
import { MINDMAP_VERSION } from '../document'

/**
 * Markdown → 导图的转换规则：
 * 标题按层级嵌套、列表按缩进嵌套、纯段落退化为子主题。
 * 断言里只看结构（text/children），不锁定 id，因为 id 只要求文档内唯一。
 */

interface ParsedNode {
  id: string
  text: string
  children: ParsedNode[]
}

function parse(json: string): ParsedNode {
  return JSON.parse(json).root as ParsedNode
}

/** 结构快照：`text(子1, 子2)`，便于一眼比对层级 */
function shape(node: ParsedNode): string {
  if (node.children.length === 0) return node.text
  return `${node.text}(${node.children.map(shape).join(', ')})`
}

describe('markdownToMindMapJson', () => {
  it('标题按层级嵌套，# 是中心主题下的一级子主题', () => {
    const json = markdownToMindMapJson('# 项目\n## 目标\n### 上线时间\n## 风险\n', {
      title: '规划'
    })

    expect(shape(parse(json))).toBe('规划(项目(目标(上线时间), 风险))')
  })

  it('列表按缩进嵌套，并挂在最近的标题下', () => {
    const json = markdownToMindMapJson(
      ['## 目标', '- 上线', '  - 灰度', '    - 10%', '- 预算'].join('\n'),
      { title: '规划' }
    )

    expect(shape(parse(json))).toBe('规划(目标(上线(灰度(10%)), 预算))')
  })

  it('有序列表与 Tab 缩进同样生效', () => {
    const json = markdownToMindMapJson(['1. 第一步', '\t- 子步骤', '2. 第二步'].join('\n'), {
      title: '流程'
    })

    expect(shape(parse(json))).toBe('流程(第一步(子步骤), 第二步)')
  })

  it('没有标题时，中心主题退回到首个可用标题或默认值', () => {
    expect(shape(parse(markdownToMindMapJson('- 甲\n- 乙')))).toBe('中心主题(甲, 乙)')
    expect(parse(markdownToMindMapJson('')).text).toBe('中心主题')
  })

  it('纯段落每行变成一个子主题，不丢内容', () => {
    const json = markdownToMindMapJson('第一段\n\n第二段\n', { title: '笔记' })

    expect(shape(parse(json))).toBe('笔记(第一段, 第二段)')
  })

  it('清理行内标记与链接，只保留可读文字', () => {
    const json = markdownToMindMapJson('- **粗体** 与 [链接](https://example.com)\n', {
      title: '清理'
    })

    expect(shape(parse(json))).toBe('清理(粗体 与 链接)')
  })

  it('跳过代码围栏、引用块与分割线', () => {
    const json = markdownToMindMapJson(
      ['```js', 'const a = 1', '```', '> 引用', '---', '- 保留'].join('\n'),
      { title: '过滤' }
    )

    expect(shape(parse(json))).toBe('过滤(保留)')
  })

  it('输出可被导图解析层直接消费的落盘格式', () => {
    const json = markdownToMindMapJson('# 主题', { title: '标题' })
    const doc = JSON.parse(json)

    expect(doc.schema).toBe('inkase.mindmap')
    expect(doc.version).toBe(MINDMAP_VERSION)
    expect(json.endsWith('\n')).toBe(true)
    expect(json).toContain('\n  "root"')
  })

  it('节点 id 在文档内唯一，且数量受上限约束', () => {
    const json = markdownToMindMapJson(
      Array.from({ length: 50 }, (_, i) => `- 条目${i}`).join('\n'),
      { title: '多', maxNodes: 10 }
    )
    const collected: string[] = []
    const walk = (node: ParsedNode): void => {
      collected.push(node.id)
      node.children.forEach(walk)
    }
    walk(parse(json))

    expect(collected.length).toBeLessThanOrEqual(10)
    expect(new Set(collected).size).toBe(collected.length)
  })
})
