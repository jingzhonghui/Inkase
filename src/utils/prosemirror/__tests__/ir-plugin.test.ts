import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { DecorationSet } from 'prosemirror-view'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { createIRPlugin } from '../ir-plugin'
import { parseMarkdown } from '../markdown'

function decorationsFor(doc: ProseMirrorNode, from: number, to: number = from): DecorationSet {
  const plugin = createIRPlugin()
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
    plugins: [plugin]
  })
  const props = plugin.spec.props as { decorations: (state: EditorState) => DecorationSet }
  return props.decorations(state)
}

function classesOf(set: DecorationSet): string[] {
  return set.find().map((deco) => (deco.type.attrs.class as string) ?? '')
}

function findMarkRange(doc: ProseMirrorNode, markName: string): { from: number; to: number } {
  let from = -1
  let to = -1
  doc.descendants((node, pos) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === markName)) {
      if (from < 0) from = pos
      to = pos + node.nodeSize
    }
  })
  return { from, to }
}

function firstBlockPos(doc: ProseMirrorNode, typeName: string): number {
  let pos = -1
  doc.forEach((node, offset) => {
    if (pos < 0 && node.type.name === typeName) pos = offset + 1
  })
  return pos
}

describe('IR marker decorations', () => {
  it('marks only the heading under the cursor', () => {
    const doc = parseMarkdown('# 一级标题\n\n正文段落')
    const decos = decorationsFor(doc, 2)

    expect(classesOf(decos)).toEqual(['ir-active-block'])
    expect(decos.find()[0].from).toBe(0)
  })

  it('does not mark other headings in the document', () => {
    const doc = parseMarkdown('# 甲\n\n## 乙\n\n正文')
    const decos = decorationsFor(doc, 2)

    const blocks = decos.find().filter((deco) => deco.type.attrs.class === 'ir-active-block')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].to).toBe(doc.child(0).nodeSize)
  })

  it('marks nothing when the cursor is in a plain paragraph', () => {
    const doc = parseMarkdown('# 标题\n\n普通段落')
    const decos = decorationsFor(doc, firstBlockPos(doc, 'paragraph'))

    expect(decos.find()).toHaveLength(0)
  })

  it('marks the blockquote under the cursor only', () => {
    const doc = parseMarkdown('> 引用一\n\n> 引用二')
    const decos = decorationsFor(doc, 2)

    const blocks = decos.find().filter((deco) => deco.type.attrs.class === 'ir-active-block')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].from).toBe(0)
  })

  it('marks only the inline mark under the cursor', () => {
    const doc = parseMarkdown('普通 **粗体** 文本')
    const range = findMarkRange(doc, 'bold')
    const decos = decorationsFor(doc, range.from + 1)

    const marks = decos.find().filter((deco) => deco.type.attrs.class === 'ir-active-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0].from).toBe(range.from)
    expect(marks[0].to).toBe(range.to)
  })

  it('does not mark inline marks elsewhere in the document', () => {
    const doc = parseMarkdown('普通段落\n\n**粗体**')
    const decos = decorationsFor(doc, firstBlockPos(doc, 'paragraph'))

    expect(classesOf(decos)).not.toContain('ir-active-mark')
  })
})
