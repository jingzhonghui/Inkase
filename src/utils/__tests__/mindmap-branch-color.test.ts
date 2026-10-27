// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  assignBranchColors,
  branchIndexOf,
  headTopicOf,
  paintBranchTopics,
  readSelectionInfo,
  resolveBranchColor,
  topBranchOf,
  type MindMapBranchColorOptions
} from '../mindmap/branch-color'
import type { MindMapTopicElement } from '../mindmap/context-menu'
import { getMindMapMonoColor, getMindMapPalette } from '../mindmap/theme'

/**
 * 彩虹分支的着色规则
 *
 * 这里手工搭一套渲染库的 DOM 结构（不启动 mind-elixir）：
 * 规则本身是「读 DOM 决定第几个分支」，所以只要 DOM 形状对，就能脱离渲染库验证。
 *
 * 结构（与渲染库一致）：
 * me-nodes
 * ├── me-main.lhs > me-wrapper > me-parent > me-tpc
 * │                             > me-children > me-wrapper …
 * ├── me-root > me-tpc
 * ├── me-main.rhs > me-wrapper …
 * └── svg.lines > path（每个一级分支一条连线，颜色写在 stroke 上）
 *
 * 关键回归点：
 * 1. **分支里每个主题都要着色**，不能只染一级主题——渲染库只给连线和一级主题
 *    上色，如果这里也只染一级，就是用户看到的「彩虹分支没生效」。
 * 2. **自动分配不能和已占用的颜色撞车**，否则「下一个分支」会和上一个同色。
 * 3. **底色必须不透明**，底纹叠在上面；否则连线会从主题内部透出来，
 *    看起来像画在文字上。
 */

const LIGHT = getMindMapPalette('light')
const MONO = getMindMapMonoColor('light')

const RAINBOW: MindMapBranchColorOptions = { palette: LIGHT, mono: MONO, rainbow: true }
const MONO_ONLY: MindMapBranchColorOptions = { palette: LIGHT, mono: MONO, rainbow: false }

/** `#rrggbb` → jsdom 规范化后的 `rgb(r, g, b)` */
function hexToRgb(hex: string): string {
  const int = Number.parseInt(hex.replace('#', ''), 16)
  return `rgb(${(int >> 16) & 0xff}, ${(int >> 8) & 0xff}, ${int & 0xff})`
}

function topic(
  text: string,
  extra: { branchColor?: string; note?: string; expanded?: boolean } = {}
): MindMapTopicElement {
  const element = document.createElement('me-tpc') as MindMapTopicElement
  element.nodeObj = { id: `n_${text}`, topic: text, children: [], ...extra }
  return element
}

/** 一个 wrapper = 一个主题 + 它的子树 */
function wrapper(
  head: MindMapTopicElement,
  children: HTMLElement[] = [],
  childCount = children.length
): HTMLElement {
  head.nodeObj = { ...head.nodeObj, children: new Array(childCount).fill({ id: 'x' }) }
  const element = document.createElement('me-wrapper')
  const parent = document.createElement('me-parent')
  parent.appendChild(head)
  element.appendChild(parent)
  if (children.length > 0) {
    const group = document.createElement('me-children')
    children.forEach((child) => group.appendChild(child))
    element.appendChild(group)
  }
  return element
}

function main(...branches: HTMLElement[]): HTMLElement {
  const element = document.createElement('me-main')
  branches.forEach((branch) => element.appendChild(branch))
  return element
}

interface Diagram {
  map: HTMLElement
  /** 分支 A 的一级 / 二级 / 三级主题 */
  a1: MindMapTopicElement
  a2: MindMapTopicElement
  a3: MindMapTopicElement
  /** 分支 B 的一级主题 */
  b1: MindMapTopicElement
  root: MindMapTopicElement
}

/**
 * 搭一张两支导图：A 深入三层、B 只有一层，左侧一个 me-main、右侧一个。
 * 左右两个 me-main 各自贡献分支，序号按文档顺序 —— 与渲染库一致。
 */
function diagram(options: { branchColorA?: string } = {}): Diagram {
  const a1 = topic('A1', options.branchColorA ? { branchColor: options.branchColorA } : {})
  const a2 = topic('A2')
  const a3 = topic('A3')
  const b1 = topic('B1')
  const root = topic('中心主题')

  const branchA = wrapper(a1, [wrapper(a2, [wrapper(a3)])], 1)
  const branchB = wrapper(b1)

  const nodes = document.createElement('me-nodes')
  nodes.appendChild(main(branchA))
  const rootHost = document.createElement('me-root')
  rootHost.appendChild(root)
  nodes.appendChild(rootHost)
  nodes.appendChild(main(branchB))
  nodes.appendChild(linesLayer(2))

  const map = document.createElement('div')
  map.className = 'map-container'
  map.appendChild(nodes)

  return { map, a1, a2, a3, b1, root }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 渲染库的连线图层：`.lines` 里每个一级分支一条 `<path>`，
 * 顺序与 `me-main > me-wrapper` 一致，颜色写在 `stroke` 上。
 */
function linesLayer(count: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  svg.setAttribute('class', 'lines')
  for (let index = 0; index < count; index += 1) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('stroke', '#000000')
    svg.appendChild(path)
  }
  return svg
}

/** 取连线图层的每一条 path 的颜色 */
function strokeOf(map: Element, index: number): string | null {
  const paths = map.querySelectorAll('.lines > path')
  return paths[index]?.getAttribute('stroke') ?? null
}

/** 三支同级的导图（用来验证调色板顺延与绕回） */
function threeBranches(): { branches: HTMLElement[]; map: HTMLElement } {
  const branches = ['X', 'Y', 'Z'].map((text) => wrapper(topic(text)))
  const nodes = document.createElement('me-nodes')
  nodes.appendChild(main(...branches))
  nodes.appendChild(linesLayer(branches.length))

  const map = document.createElement('div')
  map.className = 'map-container'
  map.appendChild(nodes)
  return { branches, map }
}

describe('分支颜色的解析（与渲染库连线取同一份颜色）', () => {
  it('一级分支按序号取调色板，且标记为自动分配', () => {
    const { a1, b1 } = diagram()

    expect(resolveBranchColor(a1, RAINBOW)).toEqual({ color: LIGHT[0], explicit: false })
    expect(resolveBranchColor(b1, RAINBOW)).toEqual({ color: LIGHT[1], explicit: false })
  })

  it('二级、三级主题继承所属分支的颜色（这就是「彩虹分支没生效」的根因）', () => {
    const { a2, a3 } = diagram()
    const expected = LIGHT[0]

    expect(resolveBranchColor(a2, RAINBOW).color).toBe(expected)
    expect(resolveBranchColor(a3, RAINBOW).color).toBe(expected)
    // 沿后代走不改写「是否显式指定」
    expect(resolveBranchColor(a3, RAINBOW).explicit).toBe(false)
  })

  it('显式指定过颜色的主题及其子孙都用这个颜色', () => {
    const custom = '#123456'
    const { a1, a2, a3 } = diagram({ branchColorA: custom })

    expect(resolveBranchColor(a1, RAINBOW)).toEqual({ color: custom, explicit: true })
    expect(resolveBranchColor(a2, RAINBOW).color).toBe(custom)
    expect(resolveBranchColor(a3, RAINBOW).color).toBe(custom)
  })

  it('单色模式下所有分支同色', () => {
    const { a1, a2, b1 } = diagram()

    expect(resolveBranchColor(a1, MONO_ONLY)).toEqual({ color: MONO, explicit: false })
    expect(resolveBranchColor(a2, MONO_ONLY).color).toBe(MONO)
    expect(resolveBranchColor(b1, MONO_ONLY).color).toBe(MONO)
  })

  it('根主题不属于任何分支', () => {
    const { root } = diagram()

    expect(topBranchOf(root)).toBeNull()
    expect(branchIndexOf(null)).toBe(-1)
    expect(resolveBranchColor(root, RAINBOW).explicit).toBe(false)
  })

  it('自动分配会跳过后面的分支已经显式占用的颜色（相邻分支不会撞色）', () => {
    // 分支 A 被手动设成调色板第 2 色；分支 B 走自动，序号正好也是第 2 色。
    // 只按序号取色就会撞成同一个绿，用户看到的正是「下个分支和上一个同色」。
    const { a1, b1 } = diagram({ branchColorA: LIGHT[1] })

    expect(resolveBranchColor(a1, RAINBOW).color).toBe(LIGHT[1])
    expect(resolveBranchColor(b1, RAINBOW).color).not.toBe(LIGHT[1])
  })

  it('调色板绕回一圈时也只保证不和紧邻的分支同色', () => {
    const { branches } = threeBranches()
    const tiny: MindMapBranchColorOptions = {
      palette: [LIGHT[0], LIGHT[1]],
      mono: MONO,
      rainbow: true
    }

    const colors = assignBranchColors(branches, tiny)
    expect(colors).toEqual([LIGHT[0], LIGHT[1], LIGHT[0]])
    expect(colors[2]).not.toBe(colors[1])
  })

  it('正常调色板下每支一色，按顺序铺开', () => {
    const { branches } = threeBranches()

    expect(assignBranchColors(branches, RAINBOW)).toEqual([LIGHT[0], LIGHT[1], LIGHT[2]])
  })
})

describe('分支着色（paintBranchTopics）', () => {
  /** 取元素的内联样式，jsdom 会把颜色规范化成 rgb()/rgba() */
  function styleOf(element: Element): CSSStyleDeclaration {
    return (element as HTMLElement).style
  }

  /**
   * 取出颜色的 RGB 通道。
   * 一级主题用实色、深层主题用同一颜色的半透明描边，两者字符串不同但色相相同，
   * 所以要比较通道值而不是比较字符串。
   */
  function rgbOf(element: Element): number[] {
    const numbers = styleOf(element)
      .borderColor.match(/[\d.]+/g)
      ?.map(Number)
    return (numbers ?? []).slice(0, 3)
  }

  it('分支里的每一层主题都拿到该分支的颜色，不同分支颜色不同', () => {
    const { map, a1, a2, a3, b1 } = diagram()

    paintBranchTopics(map, RAINBOW)

    for (const element of [a1, a2, a3]) {
      expect(styleOf(element).borderColor).toBeTruthy()
      expect(styleOf(element).backgroundColor).toBeTruthy()
    }
    // 同一分支：色相一致（一级实色、深层同色半透明），深层之间完全一致
    expect(rgbOf(a1)).toEqual(rgbOf(a2))
    expect(rgbOf(a2)).toEqual(rgbOf(a3))
    expect(styleOf(a2).borderColor).toBe(styleOf(a3).borderColor)
    // 不同分支色相不同
    expect(rgbOf(a1)).not.toEqual(rgbOf(b1))
  })

  it('中层主题的描边是同色的半透明版本（更轻，不抢一级主题的视觉）', () => {
    const { map, a1, a2 } = diagram()

    paintBranchTopics(map, RAINBOW)

    expect(styleOf(a1).borderColor).not.toContain('rgba')
    expect(styleOf(a2).borderColor).toContain('rgba')
  })

  it('一级主题比深层主题更醒目（边框更粗）', () => {
    const { map, a1, a2 } = diagram()

    paintBranchTopics(map, RAINBOW)

    expect(styleOf(a1).borderWidth).toBe('2px')
    expect(styleOf(a2).borderWidth).toBe('1px')
  })

  it('不染文字颜色，避免浅色分支色把文字压得看不清', () => {
    const { map, a1, a2 } = diagram()

    paintBranchTopics(map, RAINBOW)

    expect(styleOf(a1).color).toBe('')
    expect(styleOf(a2).color).toBe('')
  })

  it('底色保持不透明，底纹叠在底色之上（否则连线会从主题内部透出来）', () => {
    const { map, a1, a2 } = diagram()

    paintBranchTopics(map, RAINBOW)

    for (const element of [a1, a2]) {
      // 不透明底：连线/别的图层不可能透到文字上
      expect(styleOf(element).backgroundColor).toContain('var(--main-bgcolor')
      // 底纹走 background-image，画在底色之上、文字之下
      expect(styleOf(element).backgroundImage).toContain('linear-gradient')
    }
    // 一级主题的底纹更实
    expect(styleOf(a1).backgroundImage).not.toBe(styleOf(a2).backgroundImage)
  })

  it('连线颜色跟随主题边框色（否则会出现「主题蓝、连线绿」）', () => {
    const { map } = diagram({ branchColorA: LIGHT[1] })

    paintBranchTopics(map, RAINBOW)

    // A 被显式设成第 2 色，B 顺延到第 3 色；连线必须和边框一致
    expect(strokeOf(map, 0)).toBe(LIGHT[1])
    expect(strokeOf(map, 1)).toBe(LIGHT[2])
    const borders = Array.from(
      map.querySelectorAll('me-main > me-wrapper > me-parent > me-tpc')
    ).map((topic) => (topic as HTMLElement).style.borderColor)
    expect(borders[0]).not.toBe(borders[1])
  })

  it('自动分配与属性栏读到的颜色完全一致（同一套算法）', () => {
    const { map, a1, b1 } = diagram({ branchColorA: LIGHT[1] })

    paintBranchTopics(map, RAINBOW)

    expect(styleOf(a1).borderColor).toBe(hexToRgb(LIGHT[1]))
    expect(styleOf(b1).borderColor).toBe(hexToRgb(resolveBranchColor(b1, RAINBOW).color))
  })

  it('关掉彩虹后全部换成单色并去掉底纹（不能残留上一次的彩色）', () => {
    const { map, a1, a2, b1 } = diagram()

    paintBranchTopics(map, RAINBOW)
    expect(styleOf(a1).backgroundColor).toBeTruthy()

    // 模拟「切换彩虹开关但 DOM 没重建」：渲染库的 changeTheme(theme, false) 就是这样
    paintBranchTopics(map, MONO_ONLY)

    for (const element of [a1, a2, b1]) {
      expect(styleOf(element).backgroundColor).toBe('')
      expect(styleOf(element).borderWidth).toBe('1px')
    }
    // 单色模式下各分支的边框色必须收敛为同一个
    expect(styleOf(a1).borderColor).toBe(styleOf(b1).borderColor)
  })

  it('没有画布时不报错（解析失败期间会走到这里）', () => {
    expect(() => paintBranchTopics(null, RAINBOW)).not.toThrow()
  })
})

describe('属性栏数据（readSelectionInfo）', () => {
  it('一级主题：层级、子主题数、备注都可读出', () => {
    const { a1 } = diagram()
    a1.nodeObj = { ...a1.nodeObj, note: '下周一确认预算' }

    const info = readSelectionInfo(a1, resolveBranchColor(a1, RAINBOW))
    expect(info?.depth).toBe(1)
    expect(info?.text).toBe('A1')
    expect(info?.note).toBe('下周一确认预算')
    expect(info?.childCount).toBe(1)
    expect(info?.isRoot).toBe(false)
    expect(info?.collapsed).toBe(false)
  })

  it('深层主题的层级按 wrapper 层数算', () => {
    const { a2, a3 } = diagram()

    expect(readSelectionInfo(a2, resolveBranchColor(a2, RAINBOW))?.depth).toBe(2)
    expect(readSelectionInfo(a3, resolveBranchColor(a3, RAINBOW))?.depth).toBe(3)
  })

  it('根主题层级为 0 且带 isRoot 标记（属性栏据此隐藏分支颜色）', () => {
    const { root } = diagram()
    root.nodeObj = { ...root.nodeObj, children: [{ id: 'c1' }, { id: 'c2' }] }

    const info = readSelectionInfo(root, resolveBranchColor(root, RAINBOW))
    expect(info?.depth).toBe(0)
    expect(info?.isRoot).toBe(true)
    expect(info?.childCount).toBe(2)
  })

  it('折叠状态映射到 collapsed', () => {
    const { a1 } = diagram()
    a1.nodeObj = { ...a1.nodeObj, expanded: false }

    expect(readSelectionInfo(a1, resolveBranchColor(a1, RAINBOW))?.collapsed).toBe(true)
  })

  it('显式着色的主题会带上 explicitColor，供属性栏高亮色块', () => {
    const custom = '#abcdef'
    const { a1 } = diagram({ branchColorA: custom })

    const info = readSelectionInfo(a1, resolveBranchColor(a1, RAINBOW))
    expect(info?.color).toBe(custom)
    expect(info?.explicitColor).toBe(true)
  })

  it('缺少 nodeObj 时返回 null（避免把渲染库的异常对象塞进面板）', () => {
    const element = document.createElement('me-tpc') as MindMapTopicElement

    expect(readSelectionInfo(element, { color: MONO, explicit: false })).toBeNull()
  })
})

describe('DOM 结构定位', () => {
  it('headTopicOf 取 wrapper 自己的主题，而不是子树的主题', () => {
    const { a1, a2 } = diagram()

    expect(headTopicOf(a1.closest('me-wrapper'))?.nodeObj?.id).toBe(a1.nodeObj?.id)
    expect(headTopicOf(a2.closest('me-wrapper'))?.nodeObj?.id).toBe(a2.nodeObj?.id)
  })

  it('topBranchOf 找到最外层的一级分支', () => {
    const { a3 } = diagram()
    const top = topBranchOf(a3)

    // 一级分支的父元素必须是 me-main，不能停在中间层 wrapper
    expect(top?.parentElement?.tagName).toBe('ME-MAIN')
  })
})
