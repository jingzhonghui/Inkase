import { describe, expect, it } from 'vitest'
import { collectOutlineHeadings } from '../outline'
import { parseMarkdown } from '../markdown'

describe('collectOutlineHeadings', () => {
  it('returns an empty list for a document without headings', () => {
    expect(collectOutlineHeadings(parseMarkdown('普通段落\n\n又一段'))).toEqual([])
  })

  it('returns headings in document order with level and marker-stripped text', () => {
    const doc = parseMarkdown('# 一级\n\n## 二级\n\n正文\n\n### 三级')
    expect(collectOutlineHeadings(doc)).toEqual([
      { level: 1, text: '一级', pos: expect.any(Number) },
      { level: 2, text: '二级', pos: expect.any(Number) },
      { level: 3, text: '三级', pos: expect.any(Number) }
    ])
  })

  it('supports levels 5 and 6', () => {
    const doc = parseMarkdown('##### 五级\n\n###### 六级')
    expect(collectOutlineHeadings(doc).map((h) => h.level)).toEqual([5, 6])
  })

  it('points pos at the heading node itself', () => {
    const doc = parseMarkdown('# 标题\n\n正文')
    for (const item of collectOutlineHeadings(doc)) {
      const node = doc.nodeAt(item.pos)
      expect(node?.type.name).toBe('heading')
      expect(node?.attrs.level).toBe(item.level)
    }
  })

  it('strips inline marks from the displayed text', () => {
    const doc = parseMarkdown('## 带 **粗体** 的标题')
    expect(collectOutlineHeadings(doc)[0].text).toBe('带 粗体 的标题')
  })

  it('ignores headings nested inside blockquotes (top-level only)', () => {
    const doc = parseMarkdown('# 顶层\n\n> ## 引用内标题\n\n## 另一个顶层')
    expect(collectOutlineHeadings(doc).map((h) => h.text)).toEqual(['顶层', '另一个顶层'])
  })
})
