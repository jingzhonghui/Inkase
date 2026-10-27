import { describe, expect, it } from 'vitest'
import type { MindElixirData } from 'mind-elixir'
import { MINDMAP_FILE_SCHEMA, createMindMapNode, type MindMapDocument } from '../../types/mindmap'
import { fromElixirData, iconsFromElixir, toElixirData, writeIconsToElixir } from '../mindmap/adapter'

function makeDocument(): MindMapDocument {
  return {
    schema: MINDMAP_FILE_SCHEMA,
    version: 1,
    direction: 'side',
    root: {
      id: 'n_root',
      text: '中心',
      collapsed: true,
      note: '根备注',
      children: [
        { id: 'n_a', text: '分支 A', children: [{ id: 'n_a1', text: '叶子', children: [] }] },
        { id: 'n_b', text: '分支 B', direction: 'left', children: [] }
      ]
    }
  }
}

describe('mindmap adapter', () => {
  it('映射到渲染层时保留 id、文本、备注（根主题不折叠）', () => {
    const data = toElixirData(makeDocument())
    expect(data.nodeData.id).toBe('n_root')
    expect(data.nodeData.topic).toBe('中心')
    // 根主题没有「折叠」语义：即使文档里写了 collapsed 也不落成 expanded=false，
    // 否则「折叠全部」这类批量操作会在文件里留下误导性的字段
    expect(data.nodeData.expanded).toBeUndefined()
    expect(data.nodeData.note).toBe('根备注')
    expect(data.nodeData.children?.map((child) => child.id)).toEqual(['n_a', 'n_b'])
    expect(data.direction).toBe(2)
  })

  it('非根节点的折叠状态正常映射', () => {
    const document = makeDocument()
    document.root.children[0].collapsed = true
    const data = toElixirData(document)
    expect(data.nodeData.children?.[0].expanded).toBe(false)
  })

  it('父节点展开时不写 expanded 字段', () => {
    const document = makeDocument()
    document.root.children[0].collapsed = false
    const data = toElixirData(document)
    expect(data.nodeData.children?.[0].expanded).toBeUndefined()
  })

  it('渲染层节点方向映射为自有字段', () => {
    const data = toElixirData(makeDocument())
    const second = data.nodeData.children?.[1]
    expect(second?.direction).toBe(0)
  })

  it('往返一致（除未定义的缺省字段与根主题折叠）', () => {
    const document = makeDocument()
    const roundTripped = fromElixirData(toElixirData(document))
    expect(roundTripped.schema).toBe(MINDMAP_FILE_SCHEMA)
    expect(roundTripped.direction).toBe('side')
    // 根主题的 collapsed 是无效语义，往返时被丢弃是有意为之
    const expectedRoot = { ...document.root }
    delete expectedRoot.collapsed
    expect(roundTripped.root).toEqual(expectedRoot)
  })

  it('不把 parent 反向引用带回自有模型', () => {
    const data = toElixirData(makeDocument())
    const roundTripped = fromElixirData(data)
    expect(roundTripped.root.parent).toBeUndefined()
    expect(roundTripped.root.children[0].parent).toBeUndefined()
  })

  it('渲染层缺失 id 时补一个', () => {
    const data = {
      nodeData: { id: '', topic: '孤儿', children: [] }
    } as unknown as MindElixirData
    const document = fromElixirData(data)
    expect(document.root.id).toBeTruthy()
    expect(document.root.id.length).toBeGreaterThan(0)
  })

  it('渲染层缺失 children 时视为叶子节点', () => {
    const data = { nodeData: { id: 'x', topic: '叶子' } } as MindElixirData
    const document = fromElixirData(data)
    expect(document.root.children).toEqual([])
  })

  it('深层嵌套结构往返保持层级', () => {
    const document: MindMapDocument = {
      schema: MINDMAP_FILE_SCHEMA,
      version: 1,
      root: createMindMapNode('L0', [createMindMapNode('L1', [createMindMapNode('L2')])])
    }
    const roundTripped = fromElixirData(toElixirData(document))
    expect(roundTripped.root.children[0].children[0].text).toBe('L2')
  })
})

/**
 * 图标的「名字 ↔ 字形」是这一层最容易写错的地方：
 * 画布要字形（渲染库把 icons 当纯文本塞进 span），文件要名字。
 */
describe('mindmap 图标转换', () => {
  it('写到渲染层时放的是字形，不是名字', () => {
    const document: MindMapDocument = {
      schema: MINDMAP_FILE_SCHEMA,
      version: 1,
      root: { id: 'r', text: '根', icons: ['star', 'check'], children: [] }
    }
    const data = toElixirData(document)
    expect(data.nodeData.icons).toEqual(['⭐', '✅'])
  })

  it('从渲染层读回时还原成名字', () => {
    const data = {
      nodeData: { id: 'r', topic: '根', icons: ['⭐', '✅'] }
    } as unknown as MindElixirData
    expect(fromElixirData(data).root.icons).toEqual(['star', 'check'])
  })

  it('手写文件里直接写名字也认', () => {
    const data = {
      nodeData: { id: 'r', topic: '根', icons: ['flag'] }
    } as unknown as MindElixirData
    expect(fromElixirData(data).root.icons).toEqual(['flag'])
  })

  it('切换图标时按名字增删，不会把名字混进字形数组', () => {
    const node: { icons?: string[] } = { icons: ['⭐'] }
    // 曾经的 bug：直接把 'check' push 进去，画布上多出一个单词
    const names = [...iconsFromElixir(node), 'check' as const]
    writeIconsToElixir(node, names)
    expect(node.icons).toEqual(['⭐', '✅'])
    expect(iconsFromElixir(node)).toEqual(['star', 'check'])
  })

  it('取消最后一个图标时把键删掉，不留空数组', () => {
    const node: { icons?: string[] } = { icons: ['⭐'] }
    writeIconsToElixir(node, [])
    expect(node.icons).toBeUndefined()
  })

  it('未知字形不会被误当成图标名', () => {
    const node: { icons?: string[] } = { icons: ['🤖'] }
    expect(iconsFromElixir(node)).toEqual([])
  })
})
