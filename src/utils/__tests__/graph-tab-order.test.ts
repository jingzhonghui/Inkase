import { describe, expect, it } from 'vitest'
import type { TabInfo } from '../../stores/file/types'
import {
  AI_TAB_KEY,
  GRAPH_TAB_KEY,
  buildBarItems,
  type BarItem,
  type GraphBarItem
} from '../tab-order'

/**
 * `buildBarItems` 的第四参 `extra` 扩展（设计 §5.7）。
 * 对应 TC-TABORDER-001 ~ 003。
 *
 * 图谱是**视图不是文档**，所以它不进 `fileStore.tabs`，只作为合成标签追加在
 * 标签栏末尾；AI 项仍按 `aiTabIndex` 插入。键盘导航与拖拽排序共用这份顺序。
 */

function tab(id: string, path = `/${id}.mdx`): TabInfo {
  return { id, fileInfo: { path, name: `${id}.mdx` } } as unknown as TabInfo
}

const graphItem: GraphBarItem = { key: GRAPH_TAB_KEY, kind: 'graph' }

function kinds(items: readonly BarItem[]): string[] {
  return items.map((item) => item.kind)
}

describe('buildBarItems / 向后兼容（TC-TABORDER-003）', () => {
  it('只传 3 个参数时行为与扩展前一致', () => {
    const tabs = [tab('t1'), tab('t2')]

    expect(buildBarItems(tabs, false, null)).toEqual([
      { key: 't1', kind: 'file', tab: tabs[0] },
      { key: 't2', kind: 'file', tab: tabs[1] }
    ])
  })

  it('不传 extra 时不产生任何合成标签', () => {
    const items = buildBarItems([tab('t1')], true, 0)

    expect(kinds(items)).toEqual(['ai', 'file'])
    expect(items.some((item) => item.key === GRAPH_TAB_KEY)).toBe(false)
  })

  it('extra 为空数组时与不传等价', () => {
    const tabs = [tab('t1')]

    expect(buildBarItems(tabs, true, 1, [])).toEqual(buildBarItems(tabs, true, 1))
  })
})

describe('buildBarItems / AI 项位置（TC-TABORDER-002）', () => {
  it('AI 项按 aiTabIndex 插入，且不受 extra 影响', () => {
    const tabs = [tab('t1'), tab('t2'), tab('t3')]

    const withoutExtra = buildBarItems(tabs, true, 1)
    const withExtra = buildBarItems(tabs, true, 1, [graphItem])

    expect(kinds(withoutExtra)).toEqual(['file', 'ai', 'file', 'file'])
    // 前面部分逐项相同 —— 图谱项只是追加在末尾
    expect(withExtra.slice(0, withoutExtra.length)).toEqual(withoutExtra)
    expect(kinds(withExtra)).toEqual(['file', 'ai', 'file', 'file', 'graph'])
  })

  it('aiTabIndex 为 null 时 AI 项排在文件之后、图谱之前', () => {
    const items = buildBarItems([tab('t1')], true, null, [graphItem])

    expect(kinds(items)).toEqual(['file', 'ai', 'graph'])
  })

  it('aiTabIndex 越界时被夹在合法范围内', () => {
    const items = buildBarItems([tab('t1'), tab('t2')], true, 99, [graphItem])

    expect(kinds(items)).toEqual(['file', 'file', 'ai', 'graph'])
  })

  it('AI 面板关闭时只有文件与图谱项', () => {
    const items = buildBarItems([tab('t1')], false, 0, [graphItem])

    expect(kinds(items)).toEqual(['file', 'graph'])
  })
})

describe('buildBarItems / 图谱项恒在末尾（TC-TABORDER-001）', () => {
  it('图谱项总是最后一项', () => {
    const items = buildBarItems([tab('t1'), tab('t2')], false, 0, [graphItem])

    expect(items.at(-1)).toEqual(graphItem)
    expect(items.at(-1)?.key).toBe(GRAPH_TAB_KEY)
  })

  it('AI 项在末尾时图谱项仍排在它之后', () => {
    const items = buildBarItems([tab('t1')], true, null, [graphItem])

    expect(items.at(-2)?.key).toBe(AI_TAB_KEY)
    expect(items.at(-1)?.key).toBe(GRAPH_TAB_KEY)
  })

  it('没有文件标签时图谱项是唯一项', () => {
    const items = buildBarItems([], false, null, [graphItem])

    expect(items).toEqual([graphItem])
  })

  it('图谱项不进入 file 序列，也不改变文件顺序', () => {
    const tabs = [tab('t3'), tab('t1'), tab('t2')]

    const withGraph = buildBarItems(tabs, false, null, [graphItem])
    const fileKeys = withGraph.filter((item) => item.kind === 'file').map((item) => item.key)

    expect(fileKeys).toEqual(['t3', 't1', 't2'])
    expect(withGraph.filter((item) => item.kind === 'graph')).toHaveLength(1)
  })

  it('多次调用结果稳定（不修改入参数组）', () => {
    const tabs = [tab('t1')]
    const extras: BarItem[] = [graphItem]

    const first = buildBarItems(tabs, false, null, extras)
    const second = buildBarItems(tabs, false, null, extras)

    expect(first).toEqual(second)
    expect(extras).toEqual([graphItem])
    expect(tabs).toHaveLength(1)
  })
})
