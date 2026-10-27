// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  areAllChildrenCollapsed,
  buildMindMapMenu,
  isRootTopic,
  resolveTopicFromEvent,
  type MindMapTopicElement
} from '../mindmap/context-menu'

/**
 * 右键菜单构造规则
 *
 * 交互对齐 XMind：菜单项按「被右键的主题」的能力生成，根主题没有同级主题、
 * 没有父主题，也不能上移/下移/删除；叶子节点没有可折叠内容。
 */

function makeTopic(options: {
  childCount?: number
  expanded?: boolean
  parentTag?: string
  note?: string
}): MindMapTopicElement {
  const el = document.createElement('me-tpc')
  const parentTag = options.parentTag ?? 'ME-PARENT'
  const parent = document.createElement(parentTag)
  parent.appendChild(el)

  Object.defineProperty(el, 'nodeObj', {
    value: {
      id: 'n1',
      topic: '主题',
      expanded: options.expanded,
      note: options.note,
      children: Array.from({ length: options.childCount ?? 0 }, (_, i) => ({ id: `c${i}` }))
    },
    configurable: true
  })
  return el as MindMapTopicElement
}

describe('buildMindMapMenu', () => {
  it('根主题没有同级/父主题，且不能上移下移或删除', () => {
    const actions = buildMindMapMenu(makeTopic({ childCount: 2 }), true).map((item) => item.action)

    expect(actions).toEqual([
      'edit',
      'edit-note',
      'add-tag',
      'add-link',
      'pick-icons',
      'add-image',
      'add-attachment',
      'add-child',
      'add-arrow',
      'add-summary',
      'toggle-collapse',
      'export-png',
      'export-svg',
      'remove'
    ])
    const removeItem = buildMindMapMenu(makeTopic({ childCount: 2 }), true).find(
      (item) => item.action === 'remove'
    )
    expect(removeItem?.disabled).toBe(true)
  })

  it('普通主题提供完整的结构操作', () => {
    const actions = buildMindMapMenu(makeTopic({ childCount: 1 }), false).map((item) => item.action)

    expect(actions).toEqual([
      'edit',
      'edit-note',
      'add-tag',
      'add-link',
      'pick-icons',
      'add-image',
      'add-attachment',
      'add-child',
      'add-sibling',
      'add-parent',
      'move-up',
      'move-down',
      'add-arrow',
      'add-summary',
      'toggle-collapse',
      'export-png',
      'export-svg',
      'remove'
    ])
  })

  it('叶子节点不能折叠，折叠项置灰但仍展示', () => {
    const items = buildMindMapMenu(makeTopic({ childCount: 0 }), false)
    const collapse = items.find((item) => item.action === 'toggle-collapse')

    expect(collapse).toBeDefined()
    expect(collapse?.disabled).toBe(true)
    expect(collapse?.label).toBe('折叠子主题')
  })

  it('已折叠的主题提供「展开子主题」而不是「折叠」', () => {
    const items = buildMindMapMenu(makeTopic({ childCount: 2, expanded: false }), false)
    const collapse = items.find((item) => item.action === 'toggle-collapse')

    expect(collapse?.label).toBe('展开子主题')
    expect(collapse?.disabled).toBe(false)
  })

  /*
   * 根主题在渲染库的 DOM 里是 `me-root > me-tpc`，没有 `me-parent`/`me-epd`，
   * 库的 `expandNode` 会写 `parentNode.children[1].expanded` 直接崩溃。
   * 所以根主题的折叠语义是「整张导图」，文案也必须按整张导图来写。
   */
  it('根主题的折叠项按「整张导图」措辞', () => {
    const root = buildMindMapMenu(makeTopic({ childCount: 2, parentTag: 'ME-ROOT' }), true).find(
      (item) => item.action === 'toggle-collapse'
    )
    expect(root?.label).toBe('折叠全部')
    expect(root?.disabled).toBe(false)
  })

  it('根主题的子主题全部折叠时改为「展开全部」', () => {
    const el = document.createElement('me-tpc')
    document.createElement('me-root').appendChild(el)
    Object.defineProperty(el, 'nodeObj', {
      value: {
        id: 'n_root',
        topic: '中心主题',
        // 根主题自己的 expanded 不参与判断，只看子主题
        children: [
          { id: 'c0', expanded: false },
          { id: 'c1', expanded: false }
        ]
      },
      configurable: true
    })

    const collapse = buildMindMapMenu(el as MindMapTopicElement, true).find(
      (item) => item.action === 'toggle-collapse'
    )
    expect(collapse?.label).toBe('展开全部')
    expect(areAllChildrenCollapsed(el as MindMapTopicElement)).toBe(true)
  })

  it('areAllChildrenCollapsed 只认「有子主题且全部折叠」', () => {
    expect(areAllChildrenCollapsed(null)).toBe(false)
    // 无子主题
    expect(areAllChildrenCollapsed(makeTopic({ childCount: 0 }))).toBe(false)
    // 有子主题但都展开（expanded 缺省视为展开）
    expect(areAllChildrenCollapsed(makeTopic({ childCount: 2 }))).toBe(false)
  })

  it('备注项按节点是否已有备注切换文案', () => {
    expect(
      buildMindMapMenu(makeTopic({ childCount: 0 }), false).find(
        (item) => item.action === 'edit-note'
      )?.label
    ).toBe('添加备注')
    expect(
      buildMindMapMenu(makeTopic({ note: '记录一下' }), false).find(
        (item) => item.action === 'edit-note'
      )?.label
    ).toBe('编辑备注')
    // 根主题也能写备注
    expect(
      buildMindMapMenu(makeTopic({ note: '中心说明', parentTag: 'ME-ROOT' }), true).find(
        (item) => item.action === 'edit-note'
      )?.disabled
    ).toBeFalsy()
  })

  it('没有命中主题时只保留无副作用的项，且不崩溃', () => {
    const items = buildMindMapMenu(null, true)

    expect(items.map((item) => item.action)).toEqual([
      'edit',
      'edit-note',
      'add-tag',
      'add-link',
      'pick-icons',
      'add-image',
      'add-attachment',
      'add-child',
      'add-arrow',
      'add-summary',
      'toggle-collapse',
      'export-png',
      'export-svg',
      'remove'
    ])
    expect(items.find((item) => item.action === 'toggle-collapse')?.disabled).toBe(true)
  })

  it('每个可执行项都带中文文案，快捷键提示只在有快捷键的项上出现', () => {
    const items = buildMindMapMenu(makeTopic({ childCount: 1 }), false)

    for (const item of items) {
      expect(item.label.length).toBeGreaterThan(0)
      // 文案必须是中文（不能留着渲染库的英文默认值）；格式名如 PNG / SVG 属于正常例外
      expect(/[\u4e00-\u9fa5]/.test(item.label)).toBe(true)
    }
    expect(items.find((item) => item.action === 'add-child')?.hint).toBe('Tab')
    expect(items.find((item) => item.action === 'move-up')?.hint).toBeUndefined()
  })

  /*
   * 导出是画布级操作，与具体主题无关，但右键菜单是「把这张图拿走」最自然的落点。
   * 两个格式项对所有主题（含根主题）都要出现，且不能被置灰。
   */
  it('每个主题（含根主题）的菜单都提供 PNG / SVG 导出', () => {
    for (const [topic, isRoot] of [
      [makeTopic({ childCount: 2, parentTag: 'ME-ROOT' }), true],
      [makeTopic({ childCount: 2 }), false],
      [makeTopic({ childCount: 0 }), false]
    ] as const) {
      const items = buildMindMapMenu(topic, isRoot)
      const png = items.find((item) => item.action === 'export-png')
      const svg = items.find((item) => item.action === 'export-svg')

      expect(png?.label).toBe('导出为 PNG 图片')
      expect(svg?.label).toBe('导出为 SVG 矢量图')
      expect(png?.disabled).toBeFalsy()
      expect(svg?.disabled).toBeFalsy()
    }
  })

  it('导出项排在删除之前，破坏性操作始终在菜单最底部', () => {
    const actions = buildMindMapMenu(makeTopic({ childCount: 1 }), false).map((item) => item.action)

    expect(actions.slice(-3)).toEqual(['export-png', 'export-svg', 'remove'])
  })
})

describe('resolveTopicFromEvent', () => {
  it('从主题内部的文本节点向上解析到主题元素', () => {
    const topic = makeTopic({ childCount: 0 })
    const span = document.createElement('span')
    span.textContent = '主题'
    topic.appendChild(span)

    expect(resolveTopicFromEvent(span)).toBe(topic)
  })

  it('事件目标是画布而非主题时返回 null', () => {
    const canvas = document.createElement('div')

    expect(resolveTopicFromEvent(canvas)).toBeNull()
    expect(resolveTopicFromEvent(null)).toBeNull()
  })
})

describe('isRootTopic', () => {
  it('父元素是 me-root 时判定为根主题', () => {
    expect(isRootTopic(makeTopic({ parentTag: 'ME-ROOT' }))).toBe(true)
  })

  it('父元素是 me-parent 时不是根主题', () => {
    expect(isRootTopic(makeTopic({ parentTag: 'ME-PARENT' }))).toBe(false)
    expect(isRootTopic(null)).toBe(false)
  })
})
