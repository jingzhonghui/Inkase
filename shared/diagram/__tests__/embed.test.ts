import { describe, expect, it } from 'vitest'
import {
  buildDiagramEmbedUrl,
  decodeDiagramDataUrl,
  pickEventXml,
  DIAGRAM_SCHEME,
  DIAGRAM_HOST
} from '../embed'

describe('buildDiagramEmbedUrl', () => {
  it('默认走自定义协议并带上 embed 必需参数', () => {
    const url = new URL(buildDiagramEmbedUrl())
    expect(url.protocol).toBe(`${DIAGRAM_SCHEME}:`)
    expect(url.host).toBe(DIAGRAM_HOST)
    expect(url.pathname).toBe('/index.html')
    expect(url.searchParams.get('embed')).toBe('1')
    expect(url.searchParams.get('proto')).toBe('json')
    expect(url.searchParams.get('noExitBtn')).toBe('1')
    expect(url.searchParams.get('saveAndExit')).toBe('0')
    // 脏标记交给 Inkase 管，不让 draw.io 自己弹提示
    expect(url.searchParams.get('modified')).toBe('0')
  })

  it('深色主题与语言透传', () => {
    const url = new URL(buildDiagramEmbedUrl({ dark: true, lang: 'en' }))
    expect(url.searchParams.get('dark')).toBe('1')
    expect(url.searchParams.get('lang')).toBe('en')
    expect(new URL(buildDiagramEmbedUrl({ dark: false })).searchParams.get('dark')).toBe('0')
  })

  it('可以关掉形状库（只读预览场景）', () => {
    const url = new URL(buildDiagramEmbedUrl({ libraries: false }))
    expect(url.searchParams.get('libraries')).toBeNull()
  })

  it('支持自定义基址（测试或改用本地 http 时）', () => {
    const url = buildDiagramEmbedUrl({ baseUrl: 'http://127.0.0.1:9999/' })
    expect(url.startsWith('http://127.0.0.1:9999/index.html')).toBe(true)
  })

  it('基址缺少结尾斜杠时也能拼对', () => {
    expect(buildDiagramEmbedUrl({ baseUrl: 'inkase-drawio://app' })).toContain(
      'inkase-drawio://app/index.html'
    )
  })
})

describe('pickEventXml', () => {
  it('优先取 xml 字段', () => {
    expect(pickEventXml({ xml: '<mxfile />', data: '<ignored />' })).toBe('<mxfile />')
  })

  it('xml 缺失时回退到以 < 开头的 data（旧版报文）', () => {
    expect(pickEventXml({ data: '<mxfile />' })).toBe('<mxfile />')
    expect(pickEventXml({ data: 'data:image/svg+xml;base64,AAA' })).toBe('')
  })

  it('空载荷返回空串', () => {
    expect(pickEventXml(null)).toBe('')
    expect(pickEventXml({})).toBe('')
  })
})

describe('decodeDiagramDataUrl', () => {
  it('解出 base64 字节与文本', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>开始</text></svg>'
    const dataUrl = `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(svg)))}`
    const decoded = decodeDiagramDataUrl(dataUrl)
    expect(decoded).not.toBeNull()
    expect(decoded?.text).toBe(svg)
    expect(decoded?.bytes.length).toBeGreaterThan(0)
  })

  it('不是 data URL 时按原文编码', () => {
    const decoded = decodeDiagramDataUrl('<svg />')
    expect(decoded?.text).toBe('<svg />')
  })

  it('空输入返回 null', () => {
    expect(decodeDiagramDataUrl('')).toBeNull()
  })
})
