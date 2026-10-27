import { describe, expect, it } from 'vitest'
import {
  DIAGRAM_EXTENSION,
  countDiagramCells,
  createEmptyDiagramXml,
  escapeXmlAttribute,
  isCompressedDiagramPayload,
  isDiagramPath,
  isDiagramPayload,
  normalizeDiagramXml,
  parseDiagramPages
} from '../document'

describe('isDiagramPath', () => {
  it('识别 .drawio，忽略大小写', () => {
    expect(isDiagramPath('C:\\ws\\架构图.drawio')).toBe(true)
    expect(isDiagramPath('/tmp/flow.DRAWIO')).toBe(true)
  })

  it('不把其它扩展名当成图表', () => {
    expect(isDiagramPath('note.md')).toBe(false)
    expect(isDiagramPath('map.inkmind')).toBe(false)
    expect(isDiagramPath('drawio.md')).toBe(false)
    expect(isDiagramPath(undefined)).toBe(false)
    expect(isDiagramPath(null)).toBe(false)
  })

  it('扩展名常量与判定保持一致', () => {
    expect(DIAGRAM_EXTENSION).toBe('.drawio')
  })
})

describe('parseDiagramPages', () => {
  it('解析单页 mxfile 的页名与 id', () => {
    const pages = parseDiagramPages(createEmptyDiagramXml('流程'))
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ id: 'page-1', name: '流程', compressed: false })
  })

  it('解析多页，并标出哪一页是压缩载荷', () => {
    const xml = `<mxfile pages="2">
      <diagram id="a" name="流程"><mxGraphModel><root /></mxGraphModel></diagram>
      <diagram id="b" name="架构">7ZRNb5wwEIb/Csc9sCzZ</diagram>
    </mxfile>`
    const pages = parseDiagramPages(xml)
    expect(pages.map((page) => page.name)).toEqual(['流程', '架构'])
    expect(pages.map((page) => page.compressed)).toEqual([false, true])
  })

  it('属性顺序不影响解析，缺 id/name 时回退到序号', () => {
    const pages = parseDiagramPages('<mxfile><diagram name="P"><a /></diagram><diagram id="x"><b /></diagram></mxfile>')
    expect(pages[0]).toMatchObject({ id: 'page-1', name: 'P' })
    expect(pages[1]).toMatchObject({ id: 'x', name: '第 2 页' })
  })

  it('非图标数据返回空数组', () => {
    expect(parseDiagramPages('')).toEqual([])
    expect(parseDiagramPages('# 标题')).toEqual([])
  })
})

describe('isDiagramPayload', () => {
  it('接受 mxfile、裸 mxGraphModel 与裸压缩载荷', () => {
    expect(isDiagramPayload(createEmptyDiagramXml())).toBe(true)
    expect(isDiagramPayload('<mxGraphModel><root /></mxGraphModel>')).toBe(true)
    expect(isDiagramPayload('7ZRNb5wR7MLb0aB3vNq9XyZ2kLpQ')).toBe(true)
  })

  it('拒绝空内容、普通 Markdown 与过短的乱码', () => {
    expect(isDiagramPayload('')).toBe(false)
    expect(isDiagramPayload('# 标题\n正文')).toBe(false)
    expect(isDiagramPayload('abc')).toBe(false)
  })
})

describe('countDiagramCells', () => {
  it('空白图表算 0 个图元（两个根 cell 不计入）', () => {
    expect(countDiagramCells(createEmptyDiagramXml())).toBe(0)
  })

  it('统计 mxCell 与 UserObject', () => {
    const xml = `<mxfile><diagram id="p" name="x"><mxGraphModel><root>
      <mxCell id="0" /><mxCell id="1" parent="0" />
      <mxCell id="2" value="A" vertex="1" parent="1" />
      <UserObject id="3" label="B"><mxCell id="3" vertex="1" parent="1" /></UserObject>
    </root></mxGraphModel></diagram></mxfile>`
    expect(countDiagramCells(xml)).toBe(2)
  })
})

describe('normalizeDiagramXml', () => {
  it('去掉 BOM、统一换行并保证结尾一个换行', () => {
    expect(normalizeDiagramXml('\uFEFF<mxfile>\r\n  <diagram />\r\n</mxfile>\r\n\r\n')).toBe(
      '<mxfile>\n  <diagram />\n</mxfile>\n'
    )
  })

  it('空内容保持为空串', () => {
    expect(normalizeDiagramXml('   \n  ')).toBe('')
  })
})

describe('createEmptyDiagramXml', () => {
  it('生成的文档能被自己解析，页名做 XML 转义', () => {
    const xml = createEmptyDiagramXml('A & B "quoted"')
    const pages = parseDiagramPages(xml)
    expect(pages).toHaveLength(1)
    expect(pages[0].name).toBe('A &amp; B &quot;quoted&quot;')
    expect(isDiagramPayload(xml)).toBe(true)
  })
})

describe('escapeXmlAttribute', () => {
  it('转义四个必要字符', () => {
    expect(escapeXmlAttribute(`<a href="x">&`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;')
  })
})

describe('isCompressedDiagramPayload', () => {
  it('以 < 开头视为明文，否则视为压缩', () => {
    expect(isCompressedDiagramPayload('<mxGraphModel />')).toBe(false)
    expect(isCompressedDiagramPayload('   ')).toBe(false)
    expect(isCompressedDiagramPayload('7ZRNb5w=')).toBe(true)
  })
})
