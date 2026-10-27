import { describe, expect, it } from 'vitest'
import type { MindMapDocument, MindMapNode } from '../../types/mindmap'
import { MINDMAP_FILE_SCHEMA, MINDMAP_VERSION } from '../../types/mindmap'
import {
  MINDMAP_PRIORITIES,
  normalizeIcons,
  normalizeImage,
  normalizeLink,
  normalizeTags,
  tagFromXmindMarker
} from '../mindmap/rich-content'
import { parseMindMap, serializeMindMap } from '../mindmap/schema'
import { fromElixirData, toElixirData } from '../mindmap/adapter'

/**
 * 富内容（图片/图标/标签/链接/关系线/概要）的校验与往返。
 *
 * 这一层的价值全在「坏数据不炸」和「往返不变形」：
 * 文件是纯文本，用户随时会手改，测试要覆盖那些改坏的情形。
 */

function node(partial: Partial<MindMapNode> & { id: string }): MindMapNode {
  return { text: '', children: [], ...partial }
}

function doc(partial: Partial<MindMapDocument> = {}): MindMapDocument {
  return {
    schema: MINDMAP_FILE_SCHEMA,
    version: MINDMAP_VERSION,
    root: node({ id: 'r', text: '根' }),
    ...partial
  }
}

describe('rich-content 校验', () => {
  it('图标只保留白名单内的名字，且去重', () => {
    expect(normalizeIcons(['star', 'star', 'nope', 42, 'check'])).toEqual(['star', 'check'])
    expect(normalizeIcons('star')).toEqual([])
    expect(normalizeIcons(undefined)).toEqual([])
  })

  it('标签支持裸字符串与带颜色对象，空白丢弃、超长截断、重复去掉', () => {
    expect(normalizeTags(['P1', ' P1 ', '', { text: '重点', color: '#EF4444' }])).toEqual([
      { text: 'P1' },
      { text: '重点', color: '#ef4444' }
    ])
    const long = normalizeTags(['x'.repeat(100)])
    expect(long[0].text).toHaveLength(32)
    // 非法颜色不写进标签
    expect(normalizeTags([{ text: 'a', color: 'red' }])).toEqual([{ text: 'a' }])
  })

  it('链接只放行 http/https', () => {
    expect(normalizeLink('https://example.com/a')).toBe('https://example.com/a')
    expect(normalizeLink('  http://a.cn ')).toBe('http://a.cn')
    expect(normalizeLink('javascript:alert(1)')).toBeUndefined()
    expect(normalizeLink('file:///C:/x')).toBeUndefined()
    expect(normalizeLink('')).toBeUndefined()
  })

  it('图片接受包内路径与 data URL，拒绝绝对路径与越级路径', () => {
    expect(normalizeImage({ src: 'assets/images/a.png', width: 240 })).toEqual({
      src: 'assets/images/a.png',
      width: 240
    })
    expect(normalizeImage({ src: 'data:image/png;base64,AAAA' })).toEqual({
      src: 'data:image/png;base64,AAAA'
    })
    expect(normalizeImage({ src: 'C:/x/a.png' })).toBeUndefined()
    expect(normalizeImage({ src: '/abs/a.png' })).toBeUndefined()
    expect(normalizeImage({ src: '../escape.png' })).toBeUndefined()
    expect(normalizeImage({ src: 'https://evil/a.png' })).toBeUndefined()
    // 只认 assets/images 一层：files 目录、越级写法都不算图片
    expect(normalizeImage({ src: 'assets/files/a.png' })).toBeUndefined()
    expect(normalizeImage({ src: 'assets/images/../a.png' })).toBeUndefined()
    // 旧版同目录 .assets 写法已不再接受（格式已改为容器）
    expect(normalizeImage({ src: '图.assets/a.png' })).toBeUndefined()
    // 尺寸越界只丢尺寸，不丢图片
    expect(normalizeImage({ src: 'assets/images/a.png', width: 99999 })).toEqual({
      src: 'assets/images/a.png'
    })
  })

  it('XMind 标记映射成标签：优先级取预设色，其它取短名', () => {
    expect(tagFromXmindMarker('priority-1')).toEqual(MINDMAP_PRIORITIES[0])
    expect(tagFromXmindMarker('priority-5')).toEqual({ text: 'P5' })
    expect(tagFromXmindMarker('flag-red')).toEqual({ text: 'red' })
    expect(tagFromXmindMarker('')).toBeUndefined()
  })
})

describe('schema v2 解析与序列化', () => {
  const richJson = {
    schema: MINDMAP_FILE_SCHEMA,
    version: 2,
    root: {
      id: 'r',
      text: '根',
      image: { src: 'assets/images/hero.png', width: 320, height: 180 },
      icons: ['star'],
      tags: [{ text: 'P1', color: '#ef4444' }],
      href: 'https://example.com',
      children: [
        { id: 'a', text: 'A', children: [] },
        { id: 'b', text: 'B', children: [] }
      ]
    },
    arrows: [
      { id: 'ar1', from: 'a', to: 'b', label: '依赖', color: '#f97316', bidirectional: true }
    ],
    summaries: [{ id: 'sm1', parent: 'r', start: 0, end: 1, label: '阶段一', color: '#22c55e' }]
  }

  it('解析出全部富内容', () => {
    const result = parseMindMap(JSON.stringify(richJson))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { document } = result
    expect(document.version).toBe(MINDMAP_VERSION)
    expect(document.root.image).toEqual({ src: 'assets/images/hero.png', width: 320, height: 180 })
    expect(document.root.icons).toEqual(['star'])
    expect(document.root.tags).toEqual([{ text: 'P1', color: '#ef4444' }])
    expect(document.root.href).toBe('https://example.com')
    expect(document.arrows).toEqual([
      { id: 'ar1', from: 'a', to: 'b', label: '依赖', bidirectional: true, color: '#f97316' }
    ])
    expect(document.summaries).toEqual([
      { id: 'sm1', parent: 'r', start: 0, end: 1, label: '阶段一', color: '#22c55e' }
    ])
  })

  it('序列化 → 解析可以原样往返', () => {
    const parsed = parseMindMap(JSON.stringify(richJson))
    if (!parsed.ok) throw new Error(parsed.error)
    const text = serializeMindMap(parsed.document)
    const again = parseMindMap(text)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.document).toEqual(parsed.document)
    expect(again.repaired).toEqual([])
  })

  it('悬空的关系线被丢弃，并记录修复', () => {
    const result = parseMindMap(
      JSON.stringify({
        root: { id: 'r', text: '根', children: [] },
        arrows: [
          { id: 'ar1', from: 'r', to: 'ghost' },
          { id: 'ar2', from: 'r', to: 'r' }
        ]
      })
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.document.arrows).toBeUndefined()
    expect(result.repaired.some((line) => line.includes('关系线'))).toBe(true)
  })

  it('概要区间越界时夹到合法范围，完全失效时丢弃', () => {
    const result = parseMindMap(
      JSON.stringify({
        root: {
          id: 'r',
          text: '根',
          children: [
            { id: 'a', text: 'A', children: [] },
            { id: 'b', text: 'B', children: [] }
          ]
        },
        summaries: [
          { id: 'sm1', parent: 'r', start: 1, end: 99 },
          { id: 'sm2', parent: 'ghost', start: 0, end: 1 },
          { id: 'sm3', parent: 'a', start: 0, end: 0 }
        ]
      })
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.document.summaries).toEqual([{ id: 'sm1', parent: 'r', start: 1, end: 1 }])
  })

  it('非法富内容被忽略，但文字与层级照常读出', () => {
    const result = parseMindMap(
      JSON.stringify({
        root: {
          id: 'r',
          text: '根',
          href: 'javascript:alert(1)',
          image: { src: 'C:/secret.png' },
          icons: ['not-an-icon'],
          tags: 'oops',
          children: [{ id: 'a', text: 'A', children: [] }]
        }
      })
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.document.root.text).toBe('根')
    expect(result.document.root.children[0].text).toBe('A')
    expect(result.document.root.href).toBeUndefined()
    expect(result.document.root.image).toBeUndefined()
    expect(result.document.root.icons).toBeUndefined()
    expect(result.document.root.tags).toBeUndefined()
    expect(result.repaired.length).toBeGreaterThan(0)
  })

  it('没有富内容时序列化结果保持干净（不多写空字段）', () => {
    const text = serializeMindMap(doc())
    expect(text).not.toContain('arrows')
    expect(text).not.toContain('summaries')
    expect(text).not.toContain('image')
  })

  it('v1 文件照常打开', () => {
    const result = parseMindMap(
      JSON.stringify({
        schema: MINDMAP_FILE_SCHEMA,
        version: 1,
        root: { id: 'r', text: '老文件', children: [] }
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.root.text).toBe('老文件')
    expect(result.repaired).toEqual([])
  })
})

describe('adapter 富内容映射', () => {
  const document = doc({
    root: node({
      id: 'r',
      text: '根',
      image: { src: 'assets/images/hero.png', width: 300, height: 200 },
      icons: ['star', 'flag'],
      tags: [{ text: 'P1', color: '#ef4444' }, { text: '待确认' }],
      href: 'https://example.com/spec',
      children: [node({ id: 'a', text: 'A' }), node({ id: 'b', text: 'B' })]
    }),
    arrows: [{ id: 'ar1', from: 'a', to: 'b', label: '依赖', color: '#f97316' }],
    summaries: [{ id: 'sm1', parent: 'r', start: 0, end: 1, label: '阶段一', color: '#22c55e' }]
  })

  it('文档 → 渲染层：图片走 resolver，其余字段直接映射', () => {
    const data = toElixirData(document, {
      resolveImageSrc: (src) => `inkase-asset://${src}`
    })
    // 画布上是字形：渲染库把 icons 当纯文本输出，给名字会显示「star」这个词
    expect(data.nodeData.icons).toEqual(['⭐', '🚩'])
    expect(data.nodeData.hyperLink).toBe('https://example.com/spec')
    expect(data.nodeData.image).toEqual({
      url: 'inkase-asset://assets/images/hero.png',
      width: 300,
      height: 200
    })
    // 原始相对路径带在 metadata 里，回读时不会变成绝对路径
    expect((data.nodeData.metadata as Record<string, unknown>).inkaseImageSrc).toBe(
      'assets/images/hero.png'
    )
    // 带颜色的标签变成徽章对象，不带颜色的保持字符串
    expect(data.nodeData.tags).toEqual([
      {
        text: 'P1',
        style: { backgroundColor: '#ef4444', color: '#ffffff', borderColor: '#ef4444' }
      },
      '待确认'
    ])
    expect(data.arrows).toEqual([
      { id: 'ar1', label: '依赖', from: 'a', to: 'b', style: { stroke: '#f97316' } }
    ])
    expect(data.summaries).toEqual([
      {
        id: 'sm1',
        label: '阶段一',
        parent: 'r',
        start: 0,
        end: 1,
        style: { stroke: '#22c55e' }
      }
    ])
  })

  it('渲染层 → 文档：富内容原样回读', () => {
    const data = toElixirData(document, { resolveImageSrc: (src) => `asset://${src}` })
    const back = fromElixirData(data, { rainbowBranches: true })
    expect(back.root.icons).toEqual(['star', 'flag'])
    expect(back.root.href).toBe('https://example.com/spec')
    // 关键：图片 src 回到相对路径，而不是渲染用的 asset:// URL
    expect(back.root.image).toEqual({ src: 'assets/images/hero.png', width: 300, height: 200 })
    expect(back.root.tags).toEqual([{ text: 'P1', color: '#ef4444' }, { text: '待确认' }])
    expect(back.arrows).toEqual([
      { id: 'ar1', from: 'a', to: 'b', label: '依赖', color: '#f97316' }
    ])
    expect(back.summaries).toEqual([
      { id: 'sm1', parent: 'r', start: 0, end: 1, label: '阶段一', color: '#22c55e' }
    ])
  })

  it('渲染层里指向已删除节点的连线/概要不会进文档', () => {
    const data = toElixirData(document)
    data.arrows = [{ id: 'ar2', label: '', from: 'a', to: 'ghost' }]
    data.summaries = [{ id: 'sm2', label: '', parent: 'ghost', start: 0, end: 0 }]
    const back = fromElixirData(data)
    expect(back.arrows).toBeUndefined()
    expect(back.summaries).toBeUndefined()
  })
})
