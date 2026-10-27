// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MindElixir from 'mind-elixir'
import type { MindElixirInstance } from 'mind-elixir'
import { MINDMAP_FILE_SCHEMA, type MindMapDocument } from '../../types/mindmap'
import { fromElixirData, toElixirData } from '../mindmap/adapter'
import { parseMindMap } from '../mindmap/schema'

/**
 * 与真实 mind-elixir 的集成校验（不使用桩）。
 *
 * jsdom 没有真实布局度量，因此这里只断言「不抛错 + 数据往返正确」，
 * 不做像素级/交互级断言。它能挡住的风险是：
 * 渲染库升级后构造函数、init、getData 的签名或数据结构变化。
 */

const instances: MindElixirInstance[] = []
const hosts: HTMLElement[] = []

function createDocument(): MindMapDocument {
  return {
    schema: MINDMAP_FILE_SCHEMA,
    version: 1,
    direction: 'side',
    root: {
      id: 'n_root',
      text: '中心主题',
      children: [
        { id: 'n_a', text: '分支 A', children: [{ id: 'n_a1', text: '叶子', children: [] }] },
        { id: 'n_b', text: '分支 B', collapsed: true, children: [] }
      ]
    }
  }
}

function mountReal(document_: MindMapDocument): MindElixirInstance {
  const el = window.document.createElement('div')
  // 给个非零尺寸，减少布局 API 缺失带来的干扰
  el.style.width = '800px'
  el.style.height = '600px'
  window.document.body.appendChild(el)
  hosts.push(el)

  const mind = new MindElixir({
    el,
    direction: MindElixir.SIDE,
    editable: true,
    toolBar: true,
    keypress: true,
    allowUndo: true
  })
  mind.init(toElixirData(document_))
  instances.push(mind)
  return mind
}

describe('mind-elixir 集成（真实渲染库）', () => {
  beforeEach(() => {
    // jsdom 未实现 matchMedia，渲染库在构造时会读取系统主题偏好
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    )
  })

  afterEach(() => {
    for (const mind of instances) {
      try {
        mind.destroy()
      } catch {
        // jsdom 下销毁可能因缺少布局 API 抛错，不影响断言
      }
    }
    instances.length = 0
    for (const el of hosts) el.remove()
    hosts.length = 0
    vi.unstubAllGlobals()
  })

  it('能用自有模型初始化并原样回读', () => {
    const mind = mountReal(createDocument())
    const data = mind.getData()

    expect(data.nodeData.id).toBe('n_root')
    expect(data.nodeData.topic).toBe('中心主题')
    expect(data.nodeData.children).toHaveLength(2)
    expect(data.nodeData.children?.[0].topic).toBe('分支 A')
    expect(data.nodeData.children?.[0].children?.[0].topic).toBe('叶子')
  })

  it('折叠状态在往返后保持（collapsed ↔ expanded 取反）', () => {
    const mind = mountReal(createDocument())
    const roundTripped = fromElixirData(mind.getData())

    expect(roundTripped.root.children[1].collapsed).toBe(true)
    expect(roundTripped.root.children[0].collapsed).toBeUndefined()
  })

  it('refresh 可替换整棵树（外部变更走这条路径）', () => {
    const mind = mountReal(createDocument())
    const replaced: MindMapDocument = {
      schema: MINDMAP_FILE_SCHEMA,
      version: 1,
      root: { id: 'n_new', text: '换了一棵树', children: [] }
    }

    mind.refresh(toElixirData(replaced))
    const data = mind.getData()

    expect(data.nodeData.id).toBe('n_new')
    expect(data.nodeData.topic).toBe('换了一棵树')
    expect(data.nodeData.children ?? []).toHaveLength(0)
  })

  it('getData 结果可序列化为合法 .inkmind 文本并再次解析', () => {
    const mind = mountReal(createDocument())
    const roundTripped = fromElixirData(mind.getData())
    const text = JSON.stringify(roundTripped, null, 2)

    const parsed = parseMindMap(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.root.children[0].children[0].text).toBe('叶子')
  })

  it('导出数据不含 parent 反向引用（否则写盘会成环）', () => {
    const mind = mountReal(createDocument())
    const data = mind.getData()

    expect(JSON.stringify(data)).not.toContain('"parent"')
    expect(data.nodeData.parent).toBeUndefined()
  })
})
