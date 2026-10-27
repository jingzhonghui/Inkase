import { describe, expect, it } from 'vitest'
import {
  DRAG_THRESHOLD,
  containsNodeId,
  ghostLabel,
  resolveInsertType
} from '../mindmap/drag'

/**
 * 拖拽落点判定是「拖动主题改变位置」的核心逻辑。
 *
 * 交互约定（与 XMind 一致）：
 * - 落在目标上/下 1/4 → 插到目标前/后；
 * - 落在中间一半 → 成为目标的子主题；
 * - 拖进自己的子孙节点必须被拒绝，否则会把数据改成环。
 */

describe('resolveInsertType', () => {
  const rect = { top: 100, height: 40 }

  it('上边缘 1/4 内是插到前面', () => {
    expect(resolveInsertType(rect, 100)).toBe('before')
    expect(resolveInsertType(rect, 105)).toBe('before')
    expect(resolveInsertType(rect, 109)).toBe('before')
  })

  it('中间一半是成为子主题', () => {
    expect(resolveInsertType(rect, 110)).toBe('in')
    expect(resolveInsertType(rect, 120)).toBe('in')
    expect(resolveInsertType(rect, 129)).toBe('in')
  })

  it('下边缘 1/4 内是插到后面', () => {
    expect(resolveInsertType(rect, 130)).toBe('after')
    expect(resolveInsertType(rect, 140)).toBe('after')
  })

  it('指针落在范围外时退回最接近的插入方式', () => {
    expect(resolveInsertType(rect, 0)).toBe('before')
    expect(resolveInsertType(rect, 999)).toBe('after')
  })

  it('目标没有高度（未布局）时按子主题处理，避免误判成插入前后', () => {
    expect(resolveInsertType({ top: 0, height: 0 }, 10)).toBe('in')
    expect(resolveInsertType({ top: 0, height: -5 }, 10)).toBe('in')
  })
})

describe('containsNodeId', () => {
  const tree = {
    id: 'root',
    children: [
      { id: 'a', children: [{ id: 'a1', children: [] }] },
      { id: 'b', children: [] }
    ]
  }

  it('命中自身', () => {
    expect(containsNodeId(tree, 'root')).toBe(true)
  })

  it('命中深层子孙', () => {
    expect(containsNodeId(tree, 'a1')).toBe(true)
  })

  it('未命中兄弟分支之外的节点', () => {
    expect(containsNodeId(tree, 'nope')).toBe(false)
  })

  it('空节点或空 id 一律返回 false', () => {
    expect(containsNodeId(null, 'root')).toBe(false)
    expect(containsNodeId(undefined, 'root')).toBe(false)
    expect(containsNodeId(tree, '')).toBe(false)
  })

  it('叶子节点没有 children 时不抛错', () => {
    expect(containsNodeId({ id: 'leaf' }, 'other')).toBe(false)
  })
})

describe('ghostLabel', () => {
  it('去掉首尾空白', () => {
    expect(ghostLabel('  产品规划  ')).toBe('产品规划')
  })

  it('空主题有兜底文案', () => {
    expect(ghostLabel('   ')).toBe('主题')
  })

  it('过长时截断并加省略号', () => {
    const label = ghostLabel('一'.repeat(60), 10)
    expect(label).toHaveLength(11)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('DRAG_THRESHOLD', () => {
  it('阈值足够大，单击不会被误判成拖动', () => {
    expect(DRAG_THRESHOLD).toBeGreaterThanOrEqual(3)
    expect(DRAG_THRESHOLD).toBeLessThanOrEqual(8)
  })
})
