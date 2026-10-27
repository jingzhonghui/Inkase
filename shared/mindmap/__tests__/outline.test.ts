import { describe, expect, it } from 'vitest'
import { extractMindMapOutline, hasReadableOutline } from '../../../shared/mindmap/outline'

/**
 * 大纲转换是 AI 读取导图的唯一入口：
 * 它决定模型看到的是「可读层级」还是「一坨 JSON 括号」。
 */

function doc(root: unknown): string {
  return JSON.stringify({ schema: 'inkase.mindmap', version: 1, root })
}

describe('extractMindMapOutline', () => {
  it('按层级缩进输出主题文本', () => {
    const outline = extractMindMapOutline(
      doc({
        id: 'r',
        text: '项目规划',
        children: [
          { id: 'c1', text: '目标', children: [{ id: 'g1', text: '上线时间', children: [] }] },
          { id: 'c2', text: '风险', children: [] }
        ]
      })
    )

    expect(outline).toBe(['项目规划', '  目标', '    上线时间', '  风险'].join('\n'))
  })

  it('备注跟在主题后面，而不是丢掉', () => {
    const outline = extractMindMapOutline(
      doc({ id: 'r', text: '根', note: '下周一确认预算', children: [] })
    )

    expect(outline).toBe('根（备注：下周一确认预算）')
  })

  it('空主题占位而不是输出空行', () => {
    expect(extractMindMapOutline(doc({ id: 'r', text: '', children: [] }))).toBe('（未命名主题）')
  })

  it('非法 JSON / 非导图结构返回空串，交给调用方决定策略', () => {
    expect(extractMindMapOutline('{ broken')).toBe('')
    expect(extractMindMapOutline('')).toBe('')
    expect(extractMindMapOutline('[]')).toBe('')
    expect(extractMindMapOutline(JSON.stringify({ schema: 'inkase.mindmap' }))).toBe('')
  })

  it('children 里混进非对象时跳过而不是崩溃', () => {
    const outline = extractMindMapOutline(
      doc({ id: 'r', text: '根', children: ['脏数据', null, { id: 'c', text: '子', children: [] }] })
    )

    expect(outline).toBe(['根', '  子'].join('\n'))
  })

  it('支持自定义缩进与备注包裹', () => {
    const outline = extractMindMapOutline(
      doc({ id: 'r', text: '根', note: 'N', children: [{ id: 'c', text: '子', children: [] }] }),
      { indent: '\t', notePrefix: ' [', noteSuffix: ']' }
    )

    expect(outline).toBe(['根 [N]', '\t子'].join('\n'))
  })

  it('超深嵌套会被截断而不是栈溢出', () => {
    let node: Record<string, unknown> = { id: 'leaf', text: '叶子', children: [] }
    for (let i = 0; i < 200; i += 1) node = { id: `n${i}`, text: `层${i}`, children: [node] }

    const outline = extractMindMapOutline(doc(node))
    expect(outline.split('\n').length).toBeLessThanOrEqual(129)
  })

  it('hasReadableOutline 只认非空内容', () => {
    expect(hasReadableOutline('根')).toBe(true)
    expect(hasReadableOutline('   ')).toBe(false)
    expect(hasReadableOutline('')).toBe(false)
  })
})
