// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { parseMarkdown, serializeMarkdown } from '../markdown'
import { insertLink } from '../keymap'

describe('insertLink command', () => {
  it('inserts a link with mark when selection is empty', () => {
    const doc = parseMarkdown('- 第一项\n- 第二项')
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) })
    let tr = null
    const result = insertLink('https://example.com', '')(state, (t) => { tr = t })
    expect(result).toBe(true)
    expect(tr).not.toBeNull()
    const nextState = state.apply(tr)
    const texts: Array<{ text: string; marks: string[] }> = []
    nextState.doc.nodesBetween(0, nextState.doc.content.size, (node) => {
      if (node.isText) texts.push({ text: node.text || '', marks: node.marks.map((m) => m.type.name) })
      return true
    })
    console.log('TEXTS:', JSON.stringify(texts))
    const hasLinkMark = texts.some((t) => t.marks.includes('link'))
    expect(hasLinkMark).toBe(true)
    const md = serializeMarkdown(nextState.doc)
    console.log('MD:', JSON.stringify(md))
    expect(md).toContain('https://example.com')
    expect(md).toContain('[')
  })

  it('wraps selected text in a link', () => {
    const doc = parseMarkdown('- 第一项\n- 第二项')
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 3, 6) })
    let tr = null
    const result = insertLink('https://example.com', '')(state, (t) => { tr = t })
    expect(result).toBe(true)
    const nextState = state.apply(tr)
    const md = serializeMarkdown(nextState.doc)
    // tightLists: true，紧凑列表序列化时不插入空行
    expect(md).toBe('- [第一项](https://example.com)\n- 第二项')
  })
})
