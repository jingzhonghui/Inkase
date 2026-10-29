import { describe, expect, it } from 'vitest'
import { extractLinks, extractLinksDetailed } from '../link-extract'

/**
 * 抽取规则直接决定图谱里有什么：
 * 漏抽 = 图上少一条边，多抽 = 代码示例里的假路径变成断链。
 * 所以这里逐条对齐设计文档 §5.3 的剥离清单。
 */

function lines(...parts: string[]): string {
  return parts.join('\n')
}

describe('extractLinks：必须剥离的区域', () => {
  it('围栏代码块里的链接不算', () => {
    const md = lines(
      '# 标题',
      '',
      '```ts',
      'const a = "[代码里的](hidden.md)"',
      '```',
      '',
      '[真链接](real.md)'
    )

    expect(extractLinks(md)).toEqual([{ href: 'real.md', line: 7 }])
  })

  it('波浪线围栏同样剥离', () => {
    const md = lines('~~~', '[隐藏](hidden.md)', '~~~', '[真](real.md)')

    expect(extractLinks(md)).toEqual([{ href: 'real.md', line: 4 }])
  })

  it('未闭合的围栏一直吞到文末', () => {
    const md = lines('```', '[隐藏](hidden.md)', '', '[也是隐藏](alsod.md)')

    expect(extractLinks(md)).toEqual([])
  })

  it('行内代码里的链接不算', () => {
    const md = lines('写作时用 `[示例](example.md)` 表示链接', '', '[真](real.md)')

    expect(extractLinks(md)).toEqual([{ href: 'real.md', line: 3 }])
  })

  it('多反引号包裹的行内代码也算行内代码', () => {
    const md = lines('用 ``[带`反引号](hidden.md)`` 表示', '', '[真](real.md)')

    expect(extractLinks(md)).toEqual([{ href: 'real.md', line: 3 }])
  })

  it('HTML 注释里的链接不算', () => {
    const md = lines('<!-- [注释掉的](hidden.md) -->', '', '[真](real.md)')

    expect(extractLinks(md)).toEqual([{ href: 'real.md', line: 3 }])
  })

  it('图片语法不算链接', () => {
    const md = lines('![架构图](assets/images/arch.png)', '', '[真](real.md)')

    expect(extractLinks(md)).toEqual([{ href: 'real.md', line: 3 }])
  })

  it('图片作为链接文字时，外层链接仍然要抽出来', () => {
    const md = '[![封面](cover.png)](doc.md)'

    expect(extractLinks(md)).toEqual([{ href: 'doc.md', line: 1 }])
  })
})

describe('extractLinks：三种写法', () => {
  it('中文链接文字与路径', () => {
    expect(extractLinks('[目标笔记](笔记/目标.mdx)')).toEqual([
      { href: '笔记/目标.mdx', line: 1 }
    ])
  })

  it('尖括号包裹的带空格路径', () => {
    expect(extractLinks('[带空格](<my notes/a.md>)')).toEqual([
      { href: 'my notes/a.md', line: 1 }
    ])
  })

  it('可选的 title 不计入 href', () => {
    expect(extractLinks('[t](a.md "标题")')).toEqual([{ href: 'a.md', line: 1 }])
    expect(extractLinks("[t](a.md '标题')")).toEqual([{ href: 'a.md', line: 1 }])
  })

  it('尖括号自动链接', () => {
    expect(extractLinks('<b.md>')).toEqual([{ href: 'b.md', line: 1 }])
  })

  it('引用定义', () => {
    expect(extractLinks('[ref]: ../x.md')).toEqual([{ href: '../x.md', line: 1 }])
  })

  it('链接文字里带嵌套方括号也能配对', () => {
    expect(extractLinks('[外层 [内层] 文字](target.md)')).toEqual([
      { href: 'target.md', line: 1 }
    ])
  })

  it('路径里的转义空格还原成空格', () => {
    expect(extractLinks('[t](my\\ notes/a.md)')).toEqual([{ href: 'my notes/a.md', line: 1 }])
  })
})

describe('extractLinks：排除项', () => {
  it('外链与纯锚点在抽取阶段就丢掉', () => {
    const md = lines(
      '[外链](https://example.com)',
      '[锚点](#section)',
      '<https://example.com/auto>',
      '[邮件](mailto:a@b.com)',
      '[真](real.md)'
    )

    expect(extractLinks(md)).toEqual([{ href: 'real.md', line: 5 }])
  })

  it('Windows 盘符路径不会被当成协议丢掉', () => {
    expect(extractLinks('[t](C:/notes/a.md)')).toEqual([{ href: 'C:/notes/a.md', line: 1 }])
  })
})

describe('extractLinks：行号与限额', () => {
  it('行号与原文一致', () => {
    const md = lines('# 标题', '', '第一段', '[一](a.md) 和 [二](b.md)', '', '结尾 [三](c.md)')

    expect(extractLinks(md)).toEqual([
      { href: 'a.md', line: 4 },
      { href: 'b.md', line: 4 },
      { href: 'c.md', line: 6 }
    ])
  })

  it('同一目标出现多次不会被合并（边权重需要条数）', () => {
    const md = lines('[一](a.md)', '[二](a.md)')

    expect(extractLinks(md)).toEqual([
      { href: 'a.md', line: 1 },
      { href: 'a.md', line: 2 }
    ])
  })

  it('超过单文件上限时截断并标记', () => {
    const md = Array.from({ length: 2005 }, (_, i) => `[n${i}](f${i}.md)`).join('\n')
    const result = extractLinksDetailed(md)

    expect(result.links).toHaveLength(2000)
    expect(result.truncated).toBe(true)
  })

  it('未超上限时 truncated 为 false', () => {
    const result = extractLinksDetailed('[a](a.md)')

    expect(result.links).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })

  it('空正文返回空结果', () => {
    expect(extractLinksDetailed('')).toEqual({ links: [], truncated: false })
  })
})
