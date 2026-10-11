import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { DecorationSet } from 'prosemirror-view'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { createIRPlugin, findLinkAt } from '../ir-plugin'
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
  return set
    .find()
    .filter((deco) => !deco.widget)
    .map((deco) => (deco.type.attrs.class as string) ?? '')
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

    const marks = decos
      .find()
      .filter((deco) => !deco.widget && deco.type.attrs.class === 'ir-active-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0].from).toBe(range.from)
    expect(marks[0].to).toBe(range.to)
  })

  it('does not mark inline marks elsewhere in the document', () => {
    const doc = parseMarkdown('普通段落\n\n**粗体**')
    const decos = decorationsFor(doc, firstBlockPos(doc, 'paragraph'))

    expect(classesOf(decos)).not.toContain('ir-active-mark')
  })

  // 链接在 IR 中以字面文本存储，由插件按选区展开/折叠
  const LINK_MD = '前文 [链接](https://example.com) 后文'
  function linkBounds(text: string): {
    openFrom: number
    textFrom: number
    textTo: number
    suffixFrom: number
    suffixTo: number
  } {
    const base = 1 // 段落内容起始位置
    const i0 = text.indexOf('[')
    const i1 = text.indexOf(']', i0)
    const i2 = text.indexOf(')', i1)
    return {
      openFrom: base + i0,
      textFrom: base + i0 + 1,
      textTo: base + i1,
      suffixFrom: base + i1,
      suffixTo: base + i2 + 1
    }
  }
  function classedDecos(set: DecorationSet): Array<{ from: number; to: number; cls: string }> {
    return set
      .find()
      .filter((deco) => !deco.widget && deco.type.attrs?.class)
      .map((deco) => ({ from: deco.from, to: deco.to, cls: deco.type.attrs.class as string }))
  }

  it('folds the link (hides [ and ](url)) when the cursor is outside', () => {
    const doc = parseMarkdown(LINK_MD)
    const b = linkBounds(doc.firstChild!.textContent)
    const decos = decorationsFor(doc, 1) // 光标在“前文”内，链接之外

    const deco = classedDecos(decos)
    const hidden = deco.filter((d) => d.cls === 'md-link-hidden').map((d) => [d.from, d.to])
    const text = deco.filter((d) => d.cls === 'md-link-text').map((d) => [d.from, d.to])
    expect(hidden).toEqual([[b.openFrom, b.textFrom], [b.suffixFrom, b.suffixTo]])
    expect(text).toEqual([[b.textFrom, b.textTo]])
  })

  it('expands the link (shows [ ](url)) when the cursor is inside', () => {
    const doc = parseMarkdown(LINK_MD)
    const b = linkBounds(doc.firstChild!.textContent)
    const decos = decorationsFor(doc, b.textFrom + 1)

    const deco = classedDecos(decos)
    expect(deco.filter((d) => d.cls === 'md-link-hidden')).toHaveLength(0)
    const marks = deco.filter((d) => d.cls === 'md-link-mark').map((d) => [d.from, d.to])
    expect(marks).toEqual([[b.openFrom, b.textFrom], [b.suffixFrom, b.suffixTo]])
  })

  it('keeps the link expanded when the cursor is at its very end (before ")")', () => {
    const doc = parseMarkdown(LINK_MD)
    const b = linkBounds(doc.firstChild!.textContent)
    const decos = decorationsFor(doc, b.suffixTo - 1)

    expect(classedDecos(decos).some((d) => d.cls === 'md-link-mark')).toBe(true)
  })

  it('folds the link when the cursor is just after it', () => {
    const doc = parseMarkdown(LINK_MD)
    const b = linkBounds(doc.firstChild!.textContent)
    const decos = decorationsFor(doc, b.suffixTo)

    const deco = classedDecos(decos)
    expect(deco.some((d) => d.cls === 'md-link-hidden')).toBe(true)
    expect(deco.some((d) => d.cls === 'md-link-mark')).toBe(false)
  })

  it('styles bare URLs as links without folding', () => {
    const doc = parseMarkdown('see https://example.com now')
    const decos = decorationsFor(doc, 1)

    const deco = classedDecos(decos)
    expect(deco.some((d) => d.cls === 'md-link-text')).toBe(true)
    expect(deco.some((d) => d.cls === 'md-link-hidden')).toBe(false)
  })

  it('folds adjacent links without cross-matching bare URLs', () => {
    const doc = parseMarkdown('[a](https://a.com)[b](https://b.com) tail https://bare.com end')
    const text = doc.firstChild!.textContent
    const decos = decorationsFor(doc, 1) // 光标在最前，全部折叠

    const deco = classedDecos(decos)
    const hidden = deco
      .filter((d) => d.cls === 'md-link-hidden')
      .map((d) => text.slice(d.from - 1, d.to - 1))
    const texts = deco
      .filter((d) => d.cls === 'md-link-text')
      .map((d) => text.slice(d.from - 1, d.to - 1))
    expect(hidden).toEqual(['[', '](https://a.com)', '[', '](https://b.com)'])
    expect(texts).toEqual(['a', 'b', 'https://bare.com'])
  })

  it('findLinkAt locates the link at a position and returns null outside', () => {    const doc = parseMarkdown(LINK_MD)
    const b = linkBounds(doc.firstChild!.textContent)
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, b.textFrom) })

    const found = findLinkAt(state, b.textFrom + 1)
    expect(found?.href).toBe('https://example.com')
    expect(found?.text).toBe('链接')
    expect(found?.from).toBe(b.openFrom)
    expect(found?.to).toBe(b.suffixTo)
    expect(found?.labelFrom).toBe(b.textFrom)
    expect(found?.labelTo).toBe(b.textTo)
    expect(findLinkAt(state, 1)).toBeNull()
  })

  it('still marks an inclusive mark (bold) at its end boundary', () => {
    const doc = parseMarkdown('前文 **粗体** 后文')
    const range = findMarkRange(doc, 'bold')
    const decos = decorationsFor(doc, range.to)

    expect(classesOf(decos)).toContain('ir-active-mark')
  })
})
