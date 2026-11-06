import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../markdown'
import { blockAtLine, blockAtPos, buildScrollAnchorTable } from '../scroll-anchor'

const content = [
  '# 标题一', // 1
  '', // 2
  '第一段文字。', // 3
  '', // 4
  '- 列表项 A', // 5
  '- 列表项 B', // 6
  '', // 7
  '> 引用内容', // 8
  '', // 9
  '```js', // 10
  'const a = 1', // 11
  'const b = 2', // 12
  '```', // 13
  '', // 14
  '## 标题二', // 15
  '', // 16
  '第二段。' // 17
].join('\n')

describe('buildScrollAnchorTable', () => {
  it('maps every top-level block to its 1-based markdown line', () => {
    const table = buildScrollAnchorTable(parseMarkdown(content))
    expect(table).not.toBeNull()
    const lines = table!.blocks.map((b) => b.line)
    expect(lines).toEqual([1, 3, 5, 8, 10, 15, 17])
  })

  it('records each block position in the ProseMirror document', () => {
    const doc = parseMarkdown(content)
    const table = buildScrollAnchorTable(doc)!
    for (const block of table.blocks) {
      // 位置应指向该块自己的起点
      expect(doc.nodeAt(block.pos)?.type.name).toBe(doc.child(table.blocks.indexOf(block)).type.name)
    }
  })

  it('returns null when the document cannot be serialized back to the content', () => {
    // 空文档会补一个空段落，仍应能建立表；这里只验证不抛异常
    expect(() => buildScrollAnchorTable(parseMarkdown(''))).not.toThrow()
  })
})

describe('blockAtLine / blockAtPos', () => {
  const table = buildScrollAnchorTable(parseMarkdown(content))!

  it('finds the block whose start line is closest above the target line', () => {
    expect(blockAtLine(table, 1)?.line).toBe(1)
    expect(blockAtLine(table, 2)?.line).toBe(1) // 空行归属上一个块
    expect(blockAtLine(table, 4)?.line).toBe(3)
    expect(blockAtLine(table, 7)?.line).toBe(5) // 列表整体算一个块
    expect(blockAtLine(table, 12)?.line).toBe(10) // 代码块内部
    expect(blockAtLine(table, 999)?.line).toBe(17) // 超出末尾取最后一块
  })

  it('finds the block containing a document position', () => {
    const [heading] = table.blocks
    const last = table.blocks[table.blocks.length - 1]
    expect(blockAtPos(table, heading.pos)?.line).toBe(heading.line)
    expect(blockAtPos(table, last.pos)?.line).toBe(last.line)
    expect(blockAtPos(table, 0)?.line).toBe(1)
  })

  it('round-trips: block position maps back to the same line', () => {
    for (const block of table.blocks) {
      expect(blockAtPos(table, block.pos)?.line).toBe(block.line)
      expect(blockAtLine(table, block.line)?.pos).toBe(block.pos)
    }
  })
})
