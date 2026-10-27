import { describe, expect, it } from 'vitest'
import { describeXmindWarnings, hasXmindWarnings, mindMapToXmind, xmindToMindMap } from '../xmind'
import { MINDMAP_VERSION } from '../document'

/**
 * XMind 互转的映射与容错。
 *
 * 这里守住三件事：能出去（导出的 JSON 结构对）、能进来（导入后层级/文字/备注不丢）、
 * 坏了不崩（畸形输入失败要可解释，且不能把整张图带塌）。
 */

function inkmind(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

const basic = inkmind({
  schema: 'inkase.mindmap',
  version: MINDMAP_VERSION,
  direction: 'right',
  root: {
    id: 'r',
    text: '产品规划',
    children: [
      {
        id: 'a',
        text: 'Alpha 计划',
        note: '九月启动',
        collapsed: true,
        color: '#4c8dff',
        children: [{ id: 'b', text: 'Alpha 排期', children: [] }]
      },
      { id: 'd', text: 'Beta 复盘', children: [] }
    ]
  }
})

function parseContent(result: { files: Record<string, string> }): any[] {
  return JSON.parse(result.files['content.json'])
}

describe('mindMapToXmind', () => {
  it('产出 XMind 压缩包需要的三个文件', () => {
    const result = mindMapToXmind(basic)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.files).sort()).toEqual([
      'content.json',
      'manifest.json',
      'metadata.json'
    ])
    // manifest 必须登记 content.json，否则 XMind 可能不认
    expect(JSON.parse(result.files['manifest.json'])['file-entries']).toHaveProperty('content.json')
    expect(JSON.parse(result.files['metadata.json']).activeSheetId).toBe('sheet_r')
  })

  it('画布：单元素数组，带 id/class/title 与结构类', () => {
    const result = mindMapToXmind(basic)
    if (!result.ok) throw new Error(result.error)
    const content = parseContent(result)
    expect(content).toHaveLength(1)
    expect(content[0]).toMatchObject({ id: 'sheet_r', class: 'sheet', title: '产品规划' })
    expect(content[0].rootTopic).toMatchObject({
      id: 'r',
      class: 'topic',
      title: '产品规划',
      // right → 单向逻辑图
      structureClass: 'org.xmind.ui.logic.right'
    })
  })

  it('主题：备注、折叠、颜色、子层级都映射到位', () => {
    const result = mindMapToXmind(basic)
    if (!result.ok) throw new Error(result.error)
    const [alpha, beta] = parseContent(result)[0].rootTopic.children.attached

    expect(alpha).toMatchObject({
      id: 'a',
      class: 'topic',
      title: 'Alpha 计划',
      notes: { plain: { content: '九月启动' } },
      branch: 'folded',
      style: { 'svg:fill': '#4c8dff' }
    })
    expect(alpha.children.attached).toHaveLength(1)
    expect(alpha.children.attached[0]).toMatchObject({ id: 'b', title: 'Alpha 排期' })
    // 没有子主题就不写 children（避免 XMind 里出现空的可展开节点）
    expect(beta.children).toBeUndefined()
    expect(beta.branch).toBeUndefined()
  })

  it('四种朝向映射到对应的 structureClass，未知朝向退回左右发散', () => {
    const cases: Array<[string | undefined, string]> = [
      ['side', 'org.xmind.ui.map.unbalanced'],
      ['right', 'org.xmind.ui.logic.right'],
      ['left', 'org.xmind.ui.logic.left'],
      ['down', 'org.xmind.ui.org-chart.down'],
      [undefined, 'org.xmind.ui.map.unbalanced'],
      ['斜着', 'org.xmind.ui.map.unbalanced']
    ]
    for (const [direction, expected] of cases) {
      const text = inkmind({
        schema: 'inkase.mindmap',
        version: 1,
        ...(direction ? { direction } : {}),
        root: { id: 'r', text: '根', children: [] }
      })
      const result = mindMapToXmind(text)
      if (!result.ok) throw new Error(result.error)
      expect(parseContent(result)[0].rootTopic.structureClass).toBe(expected)
    }
  })

  it('根主题不会被标成折叠（折叠根主题在 XMind 里没有意义）', () => {
    const text = inkmind({
      schema: 'inkase.mindmap',
      version: 1,
      root: { id: 'r', text: '根', collapsed: true, children: [] }
    })
    const result = mindMapToXmind(text)
    if (!result.ok) throw new Error(result.error)
    expect(parseContent(result)[0].rootTopic.branch).toBeUndefined()
  })

  it('非法颜色不写进 style', () => {
    const text = inkmind({
      schema: 'inkase.mindmap',
      version: 1,
      root: {
        id: 'r',
        text: '根',
        children: [{ id: 'c', text: '子', color: 'red', children: [] }]
      }
    })
    const result = mindMapToXmind(text)
    if (!result.ok) throw new Error(result.error)
    expect(parseContent(result)[0].rootTopic.children.attached[0].style).toBeUndefined()
  })

  it('内容不是 JSON 或没有根主题时给出可读的错误', () => {
    expect(mindMapToXmind('{ 坏掉的')).toEqual({
      ok: false,
      error: '思维导图内容不是合法的 JSON，无法导出'
    })
    // 数组不是文档对象
    expect(mindMapToXmind('[]')).toEqual({
      ok: false,
      error: '思维导图内容结构不正确，无法导出'
    })
    expect(mindMapToXmind('{"schema":"inkase.mindmap"}')).toEqual({
      ok: false,
      error: '思维导图中没有可导出的根主题'
    })
  })
})

describe('xmindToMindMap', () => {
  const sheet = [
    {
      id: 'sheet-1',
      class: 'sheet',
      title: '画布 1',
      relationships: [{ id: 'rel1' }],
      summaries: [{ id: 's1' }, { id: 's2' }],
      rootTopic: {
        id: 'root-1',
        class: 'topic',
        title: '中心主题',
        structureClass: 'org.xmind.ui.org-chart.down',
        children: {
          attached: [
            {
              id: 'n1',
              class: 'topic',
              title: '分支一',
              notes: { plain: { content: '备注内容' } },
              branch: 'folded',
              style: { 'svg:fill': '#FF8800' },
              markers: [{ markerId: 'priority-1' }, { markerId: 'flag-red' }],
              labels: ['标签'],
              href: 'https://example.com',
              children: { attached: [{ id: 'n2', title: '叶子' }] }
            }
          ]
        }
      }
    }
  ]

  it('解析出层级、文字、备注、折叠、颜色与朝向', () => {
    const result = xmindToMindMap(sheet)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const document = JSON.parse(result.text)
    expect(document.schema).toBe('inkase.mindmap')
    expect(document.version).toBe(MINDMAP_VERSION)
    // org-chart.down → down
    expect(document.direction).toBe('down')

    const [first] = document.root.children
    expect(document.root).toMatchObject({ id: 'root-1', text: '中心主题' })
    expect(first).toMatchObject({
      id: 'n1',
      text: '分支一',
      note: '备注内容',
      collapsed: true,
      // 颜色归一为小写
      color: '#ff8800'
    })
    expect(first.children[0]).toMatchObject({ id: 'n2', text: '叶子' })
    // 落盘文本以换行结尾，与 serializeMindMap 一致
    expect(result.text.endsWith('\n')).toBe(true)
  })

  it('把丢弃的内容按类别计数', () => {
    const result = xmindToMindMap(sheet)
    if (!result.ok) throw new Error(result.error)
    expect(result.warnings).toMatchObject({
      relationships: 1,
      summaries: 2,
      extraSheets: 0
    })
    expect(hasXmindWarnings(result.warnings)).toBe(true)
    const lines = describeXmindWarnings(result.warnings)
    // 标记与标签已能表达，不再出现在提示里
    expect(lines).toContain('关系线 1 处')
    expect(lines.some((line) => line.includes('标记'))).toBe(false)
    // 这张画布没有图片，提示里就不该出现「图片」
    expect(lines.some((line) => line.includes('图片'))).toBe(false)
  })

  it('多画布只取第一张，其余计入提示', () => {
    const result = xmindToMindMap([sheet[0], { ...sheet[0], id: 'sheet-2' }])
    if (!result.ok) throw new Error(result.error)
    expect(result.warnings.extraSheets).toBe(1)
    expect(describeXmindWarnings(result.warnings)).toContain('其余画布 1 张（只导入第一张）')
  })

  /* 标记/标签/超链接在新版里能表达，映射到节点的 tags 与 href */

  it('标记与标签收进 tags，优先级套用预设色', () => {
    const result = xmindToMindMap([
      {
        rootTopic: {
          id: 'r',
          title: '根',
          markers: [{ markerId: 'priority-1' }, { markerId: 'flag-red' }],
          labels: ['标签'],
          children: { attached: [] }
        }
      }
    ])
    if (!result.ok) throw new Error(result.error)
    const document = JSON.parse(result.text)
    expect(document.root.tags).toEqual([
      { text: 'P1', color: '#ef4444' },
      { text: 'red' },
      { text: '标签' }
    ])
  })

  it('超链接保留，非法协议丢弃', () => {
    const result = xmindToMindMap([
      {
        rootTopic: {
          id: 'r',
          title: '根',
          href: 'https://example.com/a',
          children: {
            attached: [{ id: 'c', title: '子', href: 'javascript:alert(1)' }]
          }
        }
      }
    ])
    if (!result.ok) throw new Error(result.error)
    const document = JSON.parse(result.text)
    expect(document.root.href).toBe('https://example.com/a')
    expect(document.root.children[0].href).toBeUndefined()
  })

  it('导出时把 tags 写成 labels、href 写成 href', () => {
    const text = inkmind({
      schema: 'inkase.mindmap',
      version: MINDMAP_VERSION,
      root: {
        id: 'r',
        text: '根',
        href: 'https://example.com',
        tags: [{ text: 'P1', color: '#ef4444' }, { text: '待确认' }],
        children: []
      }
    })
    const result = mindMapToXmind(text)
    if (!result.ok) throw new Error(result.error)
    const topic = parseContent(result)[0].rootTopic
    expect(topic.labels).toEqual(['P1', '待确认'])
    expect(topic.href).toBe('https://example.com')
  })

  it('标签与链接能往返，优先级颜色由名字重新推导', () => {
    const text = inkmind({
      schema: 'inkase.mindmap',
      version: MINDMAP_VERSION,
      root: {
        id: 'r',
        text: '根',
        href: 'https://example.com',
        tags: [{ text: 'P2' }, { text: '待确认' }],
        children: []
      }
    })
    const toXmind = mindMapToXmind(text)
    if (!toXmind.ok) throw new Error(toXmind.error)
    const back = xmindToMindMap(JSON.parse(toXmind.files['content.json']))
    if (!back.ok) throw new Error(back.error)
    const restored = JSON.parse(back.text)
    expect(restored.root.href).toBe('https://example.com')
    expect(restored.root.tags).toEqual([{ text: 'P2', color: '#f97316' }, { text: '待确认' }])
  })

  it('未知的 structureClass 退回默认朝向且不丢内容', () => {
    const result = xmindToMindMap([
      { rootTopic: { id: 'r', title: '根', structureClass: 'org.xmind.ui.fishbone.leftHeaded' } }
    ])
    if (!result.ok) throw new Error(result.error)
    const document = JSON.parse(result.text)
    expect(document.direction).toBeUndefined()
    expect(document.root.text).toBe('根')
  })

  it('根主题标题缺失时用默认文案', () => {
    const result = xmindToMindMap([{ rootTopic: { id: 'r' } }])
    if (!result.ok) throw new Error(result.error)
    expect(JSON.parse(result.text).root.text).toBe('中心主题')
  })

  it('重复 id 会被改写成文档内唯一的值', () => {
    const result = xmindToMindMap([
      {
        rootTopic: {
          id: 'r',
          title: '根',
          children: {
            attached: [
              { id: 'dup', title: 'A' },
              { id: 'dup', title: 'B' }
            ]
          }
        }
      }
    ])
    if (!result.ok) throw new Error(result.error)
    const ids = JSON.parse(result.text).root.children.map((node: { id: string }) => node.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('游离主题与图片都只计数，不进层级', () => {
    const result = xmindToMindMap([
      {
        rootTopic: {
          id: 'r',
          title: '根',
          image: { src: 'x.png' },
          children: {
            attached: [],
            detached: [{ id: 'free', title: '游离' }]
          }
        }
      }
    ])
    if (!result.ok) throw new Error(result.error)
    expect(result.warnings.detachedTopics).toBe(1)
    expect(result.warnings.images).toBe(1)
    expect(JSON.parse(result.text).root.children).toEqual([])
  })

  it('畸形输入给出可读错误而不是抛出', () => {
    expect(xmindToMindMap(null)).toEqual({ ok: false, error: 'XMind 内容不是有效的 JSON 结构' })
    expect(xmindToMindMap([])).toEqual({ ok: false, error: 'XMind 文件里没有任何画布' })
    expect(xmindToMindMap([{ title: '没有根主题' }])).toEqual({
      ok: false,
      error: 'XMind 文件里没有可识别的根主题'
    })
    expect(xmindToMindMap(['不是对象'])).toEqual({
      ok: false,
      error: 'XMind 第一张画布结构不正确'
    })
  })

  it('children 结构不合法时退化成没有子主题，而不是报错', () => {
    const result = xmindToMindMap([{ rootTopic: { id: 'r', title: '根', children: 'oops' } }])
    if (!result.ok) throw new Error(result.error)
    expect(JSON.parse(result.text).root.children).toEqual([])
  })

  it('超出节点上限时截断并计数，不抛错', () => {
    const attached = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, title: `子 ${i}` }))
    const build = (depth: number): Record<string, unknown> => {
      if (depth === 0) return { id: 'leaf', title: '最深' }
      return { id: `d${depth}`, title: `层 ${depth}`, children: { attached: [build(depth - 1)] } }
    }
    const result = xmindToMindMap([
      { rootTopic: { id: 'r', title: '根', children: { attached: [build(200), ...attached] } } }
    ])
    if (!result.ok) throw new Error(result.error)
    // 200 层那一支只活下来第一层（再往下被深度上限截断），60 个兄弟节点全部保留
    expect(result.warnings.truncatedTopics).toBeGreaterThan(0)
    expect(JSON.parse(result.text).root.children.length).toBe(61)
  })
})

describe('往返', () => {
  it('inkmind → xmind → inkmind 后文字、层级、备注、折叠、颜色、朝向都不变', () => {
    const toXmind = mindMapToXmind(basic)
    if (!toXmind.ok) throw new Error(toXmind.error)

    const content = JSON.parse(toXmind.files['content.json'])
    const back = xmindToMindMap(content)
    if (!back.ok) throw new Error(back.error)

    const original = JSON.parse(basic)
    const restored = JSON.parse(back.text)
    expect(restored).toEqual(original)
  })
})
