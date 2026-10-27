import { describe, expect, it } from 'vitest'
import {
  MINDMAP_FILE_SCHEMA,
  MINDMAP_VERSION,
  createEmptyMindMap,
  createMindMapNode
} from '../../types/mindmap'
import {
  countMindMapNodes,
  countMindMapText,
  findMindMapNode,
  flattenMindMap,
  parseMindMap,
  serializeMindMap
} from '../mindmap/schema'

describe('mindmap schema', () => {
  it('创建空白导图并往返序列化', () => {
    const document = createEmptyMindMap('中心')
    const text = serializeMindMap(document)
    const parsed = parseMindMap(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.schema).toBe(MINDMAP_FILE_SCHEMA)
    expect(parsed.document.version).toBe(MINDMAP_VERSION)
    expect(parsed.document.root.text).toBe('中心')
    expect(parsed.document.root.children).toEqual([])
    expect(parsed.repaired).toEqual([])
  })

  it('序列化使用 2 空格缩进并以换行结尾（便于 git diff）', () => {
    const text = serializeMindMap(createEmptyMindMap('A'))
    expect(text).toContain('\n  "root"')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('解析空文件时生成空白导图并记录修复', () => {
    const parsed = parseMindMap('   ')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.root.text).toBe('中心主题')
    expect(parsed.repaired.length).toBe(1)
  })

  it('非法 JSON 返回可读错误而不是抛出', () => {
    const parsed = parseMindMap('{ not json ')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('不是合法的 JSON')
  })

  it('缺少 root 时报错', () => {
    const parsed = parseMindMap('{"schema":"inkase.mindmap","version":1}')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('root')
  })

  it('拒绝其它 schema 的 JSON 文件', () => {
    const parsed = parseMindMap('{"schema":"other.format","root":{"text":"x"}}')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('不是 Inkase 思维导图文件')
  })

  it('容忍缺少 schema/version 的最小文件', () => {
    const parsed = parseMindMap('{"root":{"text":"最小"}}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.root.text).toBe('最小')
    expect(parsed.document.version).toBe(MINDMAP_VERSION)
  })

  it('补齐缺失的节点 id 并记录修复', () => {
    const parsed = parseMindMap(
      '{"root":{"text":"根","children":[{"text":"子1"},{"text":"子2"}]}}'
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const [first, second] = parsed.document.root.children
    expect(first.id).toBeTruthy()
    expect(second.id).toBeTruthy()
    expect(first.id).not.toBe(second.id)
  })

  it('重建重复的节点 id', () => {
    const parsed = parseMindMap(
      JSON.stringify({
        schema: MINDMAP_FILE_SCHEMA,
        version: 1,
        root: {
          id: 'dup',
          text: '根',
          children: [{ id: 'dup', text: '子', children: [] }]
        }
      })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.root.id).not.toBe(parsed.document.root.children[0].id)
    expect(parsed.repaired.some((item) => item.includes('重复节点 id'))).toBe(true)
  })

  it('丢弃非数组 children 并记录修复', () => {
    const parsed = parseMindMap(
      '{"root":{"text":"根","children":"oops"}}'
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.root.children).toEqual([])
    expect(parsed.repaired.some((item) => item.includes('children 不是数组'))).toBe(true)
  })

  it('保留 collapsed / note / direction 字段', () => {
    const text = JSON.stringify({
      schema: MINDMAP_FILE_SCHEMA,
      version: 1,
      direction: 'right',
      root: {
        id: 'r1',
        text: '根',
        collapsed: true,
        note: '备注',
        children: [{ id: 'c1', text: '子', direction: 'left', children: [] }]
      }
    })
    const parsed = parseMindMap(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.direction).toBe('right')
    expect(parsed.document.root.collapsed).toBe(true)
    expect(parsed.document.root.note).toBe('备注')
    expect(parsed.document.root.children[0].direction).toBe('left')
  })

  it('高版本文件按当前版本读取并提示', () => {
    const parsed = parseMindMap(
      '{"schema":"inkase.mindmap","version":99,"root":{"text":"根"}}'
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.version).toBe(MINDMAP_VERSION)
    expect(parsed.repaired.some((item) => item.includes('高于当前支持版本'))).toBe(true)
  })

  it('统计节点数与文本长度', () => {
    const root = createMindMapNode('根', [
      createMindMapNode('子一'),
      createMindMapNode('子二', [createMindMapNode('孙')])
    ])
    expect(countMindMapNodes(root)).toBe(4)
    expect(countMindMapText(root)).toBe(1 + 2 + 2 + 1)
  })

  it('展平与按 id 查找', () => {
    const child = createMindMapNode('子')
    const root = createMindMapNode('根', [child])
    expect(flattenMindMap(root).map((node) => node.text)).toEqual(['根', '子'])
    expect(findMindMapNode(root, child.id)?.text).toBe('子')
    expect(findMindMapNode(root, 'missing')).toBeNull()
  })
})
