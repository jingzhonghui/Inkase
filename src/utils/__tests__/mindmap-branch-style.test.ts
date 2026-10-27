import { describe, expect, it } from 'vitest'
import { MINDMAP_FILE_SCHEMA, type MindMapDocument } from '../../types/mindmap'
import { fromElixirData, toElixirData } from '../mindmap/adapter'
import { parseMindMap, serializeMindMap } from '../mindmap/schema'
import { createMindMapTheme, getMindMapPalette } from '../mindmap/theme'

/**
 * 彩虹分支 + 分支颜色 + 根主题折叠语义
 *
 * 这些是「对标 XMind 编辑体验」新增的能力，最容易出错的地方是**落盘往返**：
 * 颜色存在节点上、彩虹开关存在文档上，任何一个在 getData → 序列化 的链路上
 * 被丢掉，用户下次打开就白改了。
 */

function documentWithColor(): MindMapDocument {
  return {
    schema: MINDMAP_FILE_SCHEMA,
    version: 1,
    direction: 'side',
    rainbowBranches: false,
    root: {
      id: 'n_root',
      text: '中心主题',
      children: [
        { id: 'n_a', text: '分支 A', color: '#e8590c', children: [] },
        { id: 'n_b', text: '分支 B', children: [{ id: 'n_b1', text: '叶子', children: [] }] }
      ]
    }
  }
}

describe('分支颜色与彩虹开关的落盘', () => {
  it('节点颜色与彩虹开关能往返', () => {
    const text = serializeMindMap(documentWithColor())
    const parsed = parseMindMap(text)

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.rainbowBranches).toBe(false)
    expect(parsed.document.root.children[0].color).toBe('#e8590c')
    expect(parsed.document.root.children[1].color).toBeUndefined()
  })

  it('彩虹开关默认开启时不写进文件（保持文件干净、手写文件也能开）', () => {
    const document = documentWithColor()
    delete document.rainbowBranches
    const text = serializeMindMap(document)

    expect(text).not.toContain('rainbowBranches')
    const parsed = parseMindMap(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.rainbowBranches).toBeUndefined()
  })

  it('非法颜色被丢弃而不是写进 CSS', () => {
    const parsed = parseMindMap(
      JSON.stringify({
        schema: MINDMAP_FILE_SCHEMA,
        version: 1,
        root: {
          id: 'n_root',
          text: '根',
          children: [{ id: 'n_a', text: 'A', color: 'red;background:url(x)', children: [] }]
        }
      })
    )

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.root.children[0].color).toBeUndefined()
    expect(parsed.repaired.some((item) => item.includes('分支颜色'))).toBe(true)
  })

  it('颜色统一转成小写，避免同一颜色写出两种形式', () => {
    const parsed = parseMindMap(
      JSON.stringify({
        schema: MINDMAP_FILE_SCHEMA,
        version: 1,
        root: {
          id: 'n_root',
          text: '根',
          children: [{ id: 'n_a', text: 'A', color: '#E8590C', children: [] }]
        }
      })
    )

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.root.children[0].color).toBe('#e8590c')
  })
})

describe('渲染层适配', () => {
  it('颜色映射到 branchColor 并能回读', () => {
    const elixir = toElixirData(documentWithColor())
    expect(elixir.nodeData.children?.[0].branchColor).toBe('#e8590c')

    const back = fromElixirData(elixir, { rainbowBranches: false })
    expect(back.root.children[0].color).toBe('#e8590c')
    expect(back.rainbowBranches).toBe(false)
  })

  it('根主题上的 expanded=false 不会写成 collapsed（折叠全部时会误设）', () => {
    const elixir = toElixirData(documentWithColor())
    elixir.nodeData.expanded = false
    elixir.nodeData.children![1].expanded = false

    const back = fromElixirData(elixir)
    expect(back.root.collapsed).toBeUndefined()
    expect(back.root.children[1].collapsed).toBe(true)
  })

  it('折叠全部之后根主题依然保持展开（否则文件里留下无意义的 collapsed）', () => {
    const document = documentWithColor()
    document.root.collapsed = true
    const elixir = toElixirData(document)
    expect(elixir.nodeData.expanded).toBeUndefined()
  })
})

describe('主题与彩虹分支', () => {
  it('彩虹开启时使用多色调色板', () => {
    const theme = createMindMapTheme('light', { rainbow: true })
    expect(theme.palette.length).toBeGreaterThan(1)
    expect(new Set(theme.palette).size).toBe(theme.palette.length)
  })

  it('彩虹关闭时所有分支同色', () => {
    const theme = createMindMapTheme('light', { rainbow: false })
    expect(theme.palette).toHaveLength(1)
    // 单色不应和彩虹模式撞色板
    expect(theme.palette).not.toEqual(getMindMapPalette('light'))
  })

  it('明暗两套调色板都可用，且顺序稳定（右键菜单色板依赖它）', () => {
    expect(getMindMapPalette('dark')).toEqual(getMindMapPalette('dark'))
    expect(getMindMapPalette('light')).toEqual(getMindMapPalette('light'))
    expect(getMindMapPalette('light')).not.toEqual(getMindMapPalette('dark'))
  })

  it('主题带明暗标记，供渲染库判断首次配色', () => {
    expect(createMindMapTheme('dark').type).toBe('dark')
    expect(createMindMapTheme('light').type).toBe('light')
  })
})
