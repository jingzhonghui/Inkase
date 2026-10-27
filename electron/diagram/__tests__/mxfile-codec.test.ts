import { describe, expect, it } from 'vitest'
import {
  decodeDiagramPayload,
  decodeWholeFile,
  decompressMxfile,
  encodeDiagramPayload
} from '../mxfile-codec'
import { isCompressedDiagramPayload, parseDiagramPages } from '../../../shared/diagram/document'

const MODEL = '<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel>'

describe('encodeDiagramPayload / decodeDiagramPayload', () => {
  it('往返保持 XML 原样（含中文与特殊字符）', () => {
    const xml = '<diagram name="流程 & 校验">开始：接收请求</diagram>'
    const encoded = encodeDiagramPayload(xml)
    expect(isCompressedDiagramPayload(encoded)).toBe(true)
    expect(decodeDiagramPayload(encoded)).toBe(xml)
  })

  it('生成的载荷是合法 base64', () => {
    expect(encodeDiagramPayload(MODEL)).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('忽略载荷里的空白（从文件里复制出来的换行不影响解码）', () => {
    const encoded = encodeDiagramPayload(MODEL)
    const wrapped = `${encoded.slice(0, 10)}\n  ${encoded.slice(10)}`
    expect(decodeDiagramPayload(wrapped)).toBe(MODEL)
  })

  it('空载荷解出空串', () => {
    expect(decodeDiagramPayload('   ')).toBe('')
  })

  it('损坏的载荷抛出可读错误', () => {
    expect(() => decodeDiagramPayload('not-a-real-deflate-stream')).toThrow(/解压失败/)
  })
})

describe('decompressMxfile', () => {
  it('只展开压缩页，明文页原样保留', () => {
    const compressed = encodeDiagramPayload(MODEL)
    const xml = `<mxfile pages="2"><diagram id="a" name="流程">${MODEL}</diagram><diagram id="b" name="架构">${compressed}</diagram></mxfile>`
    const expanded = decompressMxfile(xml)
    expect(expanded).toContain('<diagram id="a" name="流程"><mxGraphModel>')
    expect(expanded).toContain(`<diagram id="b" name="架构">${MODEL}</diagram>`)
    // 展开后不该再被判成压缩
    expect(parseDiagramPages(expanded).map((page) => page.compressed)).toEqual([false, false])
  })

  it('单页损坏不影响其它页（返回原文而不是抛错）', () => {
    const xml = '<mxfile><diagram id="a">broken-base64!!</diagram><diagram id="b">' + encodeDiagramPayload(MODEL) + '</diagram></mxfile>'
    const expanded = decompressMxfile(xml)
    expect(expanded).toContain('broken-base64!!')
    expect(expanded).toContain(MODEL)
  })

  it('没有 diagram 节点时原样返回', () => {
    expect(decompressMxfile('# 不是图表')).toBe('# 不是图表')
  })
})

describe('decodeWholeFile', () => {
  it('裸压缩载荷解成明文，明文原样返回', () => {
    expect(decodeWholeFile(encodeDiagramPayload(MODEL))).toBe(MODEL)
    expect(decodeWholeFile(MODEL)).toBe(MODEL)
  })
})
