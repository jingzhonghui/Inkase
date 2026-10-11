// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { parseMarkdown, serializeMarkdown } from '../markdown'
import { insertLink } from '../keymap'

describe('insertLink command', () => {
  it('inserts a literal [label](url) when selection is empty', () => {
    const doc = parseMarkdown('- 第一项\n- 第二项')
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) })
    let tr = null
    const result = insertLink('https://example.com', '')(state, (t) => { tr = t })
    expect(result).toBe(true)
    expect(tr).not.toBeNull()
    const nextState = state.apply(tr)
    const md = serializeMarkdown(nextState.doc)
    expect(md).toContain('[https://example.com](https://example.com)')
  })

  it('wraps selected text in a literal link', () => {
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
