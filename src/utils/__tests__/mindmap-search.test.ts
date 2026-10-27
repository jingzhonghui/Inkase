import { describe, expect, it } from 'vitest'
import { collectMatches, findAncestorIds, nextMatchIndex } from '../mindmap/search'
import type { MindMapNode } from '../../types/mindmap'

/**
 * 导图内查找的匹配规则、命中顺序与跳转索引。
 *
 * 这三件事都直接影响「按 Enter 跳的时候会不会跳错」，
 * 所以全部用假数据精确断言，不依赖画布。
 */

function node(id: string, text: string, children: MindMapNode[] = []): MindMapNode {
  return { id, text, children }
}

/** 根 → A(B, C) 、D：用来验证「父先于子、兄弟按声明顺序」 */
const tree = node('root', '产品规划', [
  node('a', 'Alpha 计划', [node('b', 'Alpha 排期'), node('c', 'Beta 排期')]),
  node('d', 'Alpha 复盘')
])

describe('collectMatches', () => {
  it('空查询与纯空白查询都不产生命中', () => {
    expect(collectMatches(tree, '')).toEqual([])
    expect(collectMatches(tree, '   ')).toEqual([])
    expect(collectMatches(tree, '\n\t ')).toEqual([])
  })

  it('默认不区分大小写', () => {
    expect(collectMatches(tree, 'alpha').map((m) => m.id)).toEqual(['a', 'b', 'd'])
    expect(collectMatches(tree, 'ALPHA').map((m) => m.id)).toEqual(['a', 'b', 'd'])
  })

  it('区分大小写时按原样匹配', () => {
    expect(collectMatches(tree, 'alpha', true)).toEqual([])
    expect(collectMatches(tree, 'Alpha', true).map((m) => m.id)).toEqual(['a', 'b', 'd'])
    expect(collectMatches(tree, 'alpha 排期', true)).toEqual([])
  })

  it('命中顺序是深度优先（阅读顺序），父节点先于子节点', () => {
    // a 排在 b、c 之前，d 在 a 的整棵子树之后
    expect(collectMatches(tree, '排期').map((m) => m.text)).toEqual(['Alpha 排期', 'Beta 排期'])
    expect(collectMatches(tree, '计划').map((m) => m.id)).toEqual(['a'])
    expect(collectMatches(tree, '复盘').map((m) => m.id)).toEqual(['d'])
  })

  it('根节点本身也能命中', () => {
    const matches = collectMatches(tree, '产品')
    expect(matches.map((m) => m.id)).toEqual(['root'])
    expect(matches[0].ancestorIds).toEqual([])
  })

  it('同一段文字出现在多个节点时逐个命中', () => {
    const duplicated = node('r', '重复', [
      node('x', '重复'),
      node('y', '重复', [node('z', '重复')])
    ])
    expect(collectMatches(duplicated, '重复').map((m) => m.id)).toEqual(['r', 'x', 'y', 'z'])
  })

  it('命中项带上从根到父级的祖先链', () => {
    const matches = collectMatches(tree, 'Beta')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      id: 'c',
      text: 'Beta 排期',
      // 根与 a 是 c 的祖先，自身不在链里
      ancestorIds: ['root', 'a']
    })
  })

  it('没有命中时返回空数组而不是抛错', () => {
    expect(collectMatches(tree, '不存在的词')).toEqual([])
    expect(collectMatches(node('solo', '单节点'), '单节点')).toHaveLength(1)
    expect(collectMatches(node('solo', '单节点'), '单节')).toHaveLength(1)
  })

  it('深层嵌套不丢结果也不栈溢出', () => {
    let deep = node('leaf', '终极目标')
    for (let i = 20; i >= 1; i -= 1) {
      deep = node(`n${i}`, `层级 ${i}`, [deep])
    }
    const matches = collectMatches(deep, '终极')
    expect(matches).toHaveLength(1)
    // n1..n20 共 20 层祖先，leaf 自身不在链里
    expect(matches[0].ancestorIds).toHaveLength(20)
    expect(matches[0].ancestorIds[0]).toBe('n1')
  })

  it('中文与英文混排按子串匹配', () => {
    const mixed = node('r', 'Inkase 思维导图', [node('c', 'mind-elixir 渲染层')])
    expect(collectMatches(mixed, '思维').map((m) => m.id)).toEqual(['r'])
    expect(collectMatches(mixed, 'elixir').map((m) => m.id)).toEqual(['c'])
  })

  it('正则元字符按普通字符处理', () => {
    const literal = node('r', '函数 f(x) 与 * 星号', [])
    expect(collectMatches(literal, 'f(x)')).toHaveLength(1)
    expect(collectMatches(literal, '*')).toHaveLength(1)
    // 若被当成正则，`.` 会匹配任意字符从而误命中
    expect(collectMatches(literal, 'f.x')).toEqual([])
  })
})

describe('findAncestorIds', () => {
  it('根节点没有祖先', () => {
    expect(findAncestorIds(tree, 'root')).toEqual([])
  })

  it('返回从根到父级的链，不含自身', () => {
    expect(findAncestorIds(tree, 'a')).toEqual(['root'])
    expect(findAncestorIds(tree, 'c')).toEqual(['root', 'a'])
  })

  it('节点不存在时返回空数组', () => {
    expect(findAncestorIds(tree, 'missing')).toEqual([])
  })
})

describe('nextMatchIndex', () => {
  it('正向推进并在末尾回卷', () => {
    expect(nextMatchIndex(0, 3, 1)).toBe(1)
    expect(nextMatchIndex(2, 3, 1)).toBe(0)
  })

  it('反向推进并在开头回卷', () => {
    expect(nextMatchIndex(1, 3, -1)).toBe(0)
    expect(nextMatchIndex(0, 3, -1)).toBe(2)
  })

  it('当前索引无效时从头或从尾进入', () => {
    expect(nextMatchIndex(-1, 3, 1)).toBe(0)
    expect(nextMatchIndex(-1, 3, -1)).toBe(2)
    expect(nextMatchIndex(99, 3, 1)).toBe(0)
  })

  it('没有命中时返回 -1（调用方据此不跳转）', () => {
    expect(nextMatchIndex(0, 0, 1)).toBe(-1)
    expect(nextMatchIndex(-1, 0, -1)).toBe(-1)
  })
})
