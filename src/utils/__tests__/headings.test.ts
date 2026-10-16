import { describe, expect, it } from 'vitest'
import { extractHeadings } from '../markdown'

describe('extractHeadings', () => {
  it('returns an empty list for content without headings', () => {
    expect(extractHeadings('普通段落\n\n又一段')).toEqual([])
    expect(extractHeadings('')).toEqual([])
  })

  it('extracts h1..h6 in order with 1-based line numbers', () => {
    const content = '# 一级\n\n## 二级\n\n正文\n\n### 三级'
    expect(extractHeadings(content)).toEqual([
      { level: 1, text: '一级', line: 1 },
      { level: 2, text: '二级', line: 3 },
      { level: 3, text: '三级', line: 7 }
    ])
  })

  it('supports levels 5 and 6', () => {
    const content = '##### 五级\n\n###### 六级'
    expect(extractHeadings(content).map((h) => h.level)).toEqual([5, 6])
  })

  it('strips a trailing closing hash sequence', () => {
    expect(extractHeadings('## 标题 ##')).toEqual([{ level: 2, text: '标题', line: 1 }])
  })

  it('skips headings inside fenced code blocks', () => {
    const content = [
      '# 真标题',
      '```',
      '# 代码里的井号',
      '```',
      '## 另一个真标题',
      '~~~',
      '# 波浪围栏内',
      '~~~'
    ].join('\n')
    expect(extractHeadings(content)).toEqual([
      { level: 1, text: '真标题', line: 1 },
      { level: 2, text: '另一个真标题', line: 5 }
    ])
  })

  it('ignores blockquote-prefixed headings (top-level only)', () => {
    expect(extractHeadings('> # 引用标题')).toEqual([])
  })

  it('requires a space after the hash sequence', () => {
    expect(extractHeadings('##无空格')).toEqual([])
  })
})
