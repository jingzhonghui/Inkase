// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { markdownSchema } from '../schema'
import { parseMarkdown } from '../markdown'
import { createPlugins } from '../plugins'

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

function mount(md: string): EditorView {
  const doc = parseMarkdown(md)
  const place = document.createElement('div')
  document.body.appendChild(place)
  view = new EditorView(place, {
    state: EditorState.create({ doc, plugins: createPlugins(markdownSchema) })
  })
  return view
}

function pressKey(v: EditorView, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  v.dom.dispatchEvent(event)
  return event.defaultPrevented
}

describe('IR arrow integration (real editor + full plugin chain)', () => {
  it('ArrowDown from the end of a paragraph above a table enters the first cell', () => {
    const v = mount('普通文本\n\n| A | B |\n| --- | --- |\n| C | D |')
    let end = -1
    v.state.doc.descendants((n, p) => {
      if (n.isText && n.text === '普通文本') end = p + n.nodeSize
    })
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, end)))

    const prevented = pressKey(v, 'ArrowDown')

    expect(prevented).toBe(true)
    expect(v.state.selection.$from.parent.type.name).toBe('table_header')
    expect(v.state.selection.$from.parent.textContent).toBe('A')
  })

  it('ArrowUp from the start of a paragraph below a table enters the last cell', () => {
    const v = mount('| A | B |\n| --- | --- |\n| C | D |\n\n下方文本')
    let start = -1
    v.state.doc.descendants((n, p) => {
      if (n.isText && n.text === '下方文本') start = p
    })
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, start)))

    const prevented = pressKey(v, 'ArrowUp')

    expect(prevented).toBe(true)
    expect(v.state.selection.$from.parent.textContent).toBe('D')
  })

  it('ArrowDown from the end of a list item above a table enters the first cell', () => {
    const v = mount('- 目标：依赖\n\n| A | B |\n| --- | --- |\n| C | D |')
    expect(v.state.doc.firstChild?.type.name).toBe('bullet_list')
    expect(v.state.doc.child(1).type.name).toBe('table')

    let end = -1
    v.state.doc.descendants((n, p) => {
      if (n.isText && n.text === '目标：依赖') end = p + n.nodeSize
    })
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, end)))

    const prevented = pressKey(v, 'ArrowDown')

    expect(prevented).toBe(true)
    expect(v.state.selection.$from.parent.type.name).toBe('table_header')
    expect(v.state.selection.$from.parent.textContent).toBe('A')
  })

  it('ArrowUp from the start of a list item below a table enters the last cell', () => {
    const v = mount('| A | B |\n| --- | --- |\n| C | D |\n\n- 下面是列表')
    expect(v.state.doc.lastChild?.type.name).toBe('bullet_list')

    let start = -1
    v.state.doc.descendants((n, p) => {
      if (n.isText && n.text === '下面是列表') start = p
    })
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, start)))

    const prevented = pressKey(v, 'ArrowUp')

    expect(prevented).toBe(true)
    expect(v.state.selection.$from.parent.textContent).toBe('D')
  })
})
