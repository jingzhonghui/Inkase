import { describe, expect, it } from 'vitest'
import { EditorState, NodeSelection, TextSelection, type Transaction } from 'prosemirror-state'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { markdownSchema } from '../schema'
import { textBlockArrowKey } from '../keymap'

const { paragraph, code_block, math_block, table, table_row, table_header, table_cell, horizontal_rule } =
  markdownSchema.nodes

const header = (t: string): ProseMirrorNode => table_header.create(null, markdownSchema.text(t))
const cell = (t: string): ProseMirrorNode => table_cell.create(null, markdownSchema.text(t))
const row = (...cells: ProseMirrorNode[]): ProseMirrorNode => table_row.create(null, cells)
const makeTable = (...rows: ProseMirrorNode[]): ProseMirrorNode => table.create(null, rows)
const para = (t = ''): ProseMirrorNode => paragraph.create(null, t ? markdownSchema.text(t) : undefined)
const code = (t: string): ProseMirrorNode => code_block.create({ language: '' }, markdownSchema.text(t))
const math = (): ProseMirrorNode => math_block.create({ source: 'x' })
const hr = (): ProseMirrorNode => horizontal_rule.create()

const twoByTwo = (): ProseMirrorNode => makeTable(row(header('A'), header('B')), row(cell('C'), cell('D')))

function doc(...nodes: ProseMirrorNode[]): ProseMirrorNode {
  return markdownSchema.node('doc', null, nodes)
}

function posOfText(root: ProseMirrorNode, text: string, atEnd = true): number {
  let p = -1
  root.descendants((node, pos) => {
    if (node.isText && node.text === text) p = atEnd ? pos + node.nodeSize : pos
    return true
  })
  return p
}

type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void, view?: unknown) => boolean

function run(cmd: Cmd, state: EditorState): { handled: boolean; next: EditorState | null } {
  let tr: Transaction | null = null
  const handled = cmd(state, (t) => { tr = t }, {} as never)
  return { handled, next: tr ? state.apply(tr) : null }
}

function at(root: ProseMirrorNode, pos: number): EditorState {
  return EditorState.create({ doc: root, selection: TextSelection.create(root, pos) })
}

describe('text-block arrow into an adjacent table', () => {
  it('ArrowUp from an empty paragraph below a table enters the last cell and removes the spacer', () => {
    const root = doc(twoByTwo(), para(), hr())
    const table = root.child(0)
    const state = at(root, table.nodeSize + 1)

    const { handled, next } = run(textBlockArrowKey('vert', -1), state)

    expect(handled).toBe(true)
    expect(next?.doc.childCount).toBe(2)
    expect(next?.doc.child(0).type.name).toBe('table')
    expect(next?.doc.child(1).type.name).toBe('horizontal_rule')
    expect(next?.selection.$from.parent.textContent).toBe('D')
  })

  it('ArrowDown from an empty paragraph above a table enters the first cell and removes the spacer', () => {
    const root = doc(hr(), para(), twoByTwo())
    const state = at(root, 2)

    const { handled, next } = run(textBlockArrowKey('vert', 1), state)

    expect(handled).toBe(true)
    expect(next?.doc.childCount).toBe(2)
    expect(next?.doc.child(1).type.name).toBe('table')
    expect(next?.selection.$from.parent.textContent).toBe('A')
  })

  it('does not delete a non-empty paragraph, but still enters the table cell', () => {
    const root = doc(twoByTwo(), para('Z'))
    const state = at(root, posOfText(root, 'Z'))

    const { handled, next } = run(textBlockArrowKey('vert', -1), state)

    expect(handled).toBe(true)
    expect(next?.doc.childCount).toBe(2)
    expect(next?.selection.$from.parent.textContent).toBe('D')
  })

  it('keeps the spacer when the table is the last block (would be re-added)', () => {
    const root = doc(twoByTwo(), para())
    const table = root.child(0)
    const state = at(root, table.nodeSize + 1)

    const { handled, next } = run(textBlockArrowKey('vert', -1), state)

    expect(handled).toBe(true)
    expect(next?.doc.childCount).toBe(2)
    expect(next?.selection.$from.parent.textContent).toBe('D')
  })

  it('moves Left into the last cell from the start of a paragraph after a table', () => {
    const root = doc(twoByTwo(), para('Z'))
    const state = at(root, posOfText(root, 'Z', false))

    const { handled, next } = run(textBlockArrowKey('horiz', -1), state)

    expect(handled).toBe(true)
    expect(next?.selection.$from.parent.textContent).toBe('D')
  })
})

describe('text-block arrow into an adjacent atom block', () => {
  it('ArrowDown from an empty paragraph selects the horizontal rule below', () => {
    const root = doc(para(), hr())
    const state = at(root, 1)

    const { handled, next } = run(textBlockArrowKey('vert', 1), state)

    expect(handled).toBe(true)
    expect(next?.doc.childCount).toBe(1)
    expect(next?.selection).toBeInstanceOf(NodeSelection)
    expect((next?.selection as NodeSelection).node.type.name).toBe('horizontal_rule')
  })

  it('ArrowUp from a paragraph below a math block selects the math block', () => {
    const root = doc(math(), para('Z'))
    const state = at(root, posOfText(root, 'Z'))

    const { handled, next } = run(textBlockArrowKey('vert', -1), state)

    expect(handled).toBe(true)
    expect(next?.selection).toBeInstanceOf(NodeSelection)
    expect((next?.selection as NodeSelection).node.type.name).toBe('math_block')
  })
})

describe('text-block arrow into an adjacent code block', () => {
  it('ArrowUp from a paragraph below a code block puts the caret at the end of the code', () => {
    const root = doc(code('ab'), para('Z'))
    const state = at(root, posOfText(root, 'Z'))

    const { handled, next } = run(textBlockArrowKey('vert', -1), state)

    expect(handled).toBe(true)
    expect(next?.selection.$from.parent.type.name).toBe('code_block')
    expect(next?.selection.$from.parentOffset).toBe(2)
  })
})

describe('text-block arrow does not over-intercept', () => {
  it('ignores movement between ordinary paragraphs', () => {
    const root = doc(para('X'), para('Z'), para('W'))
    const state = at(root, posOfText(root, 'Z'))

    expect(run(textBlockArrowKey('vert', -1), state).handled).toBe(false)
    expect(run(textBlockArrowKey('vert', 1), state).handled).toBe(false)
  })

  it('ignores horizontal movement that is not at the paragraph end', () => {
    const root = doc(para('abc'), twoByTwo())
    const state = at(root, 2)

    expect(run(textBlockArrowKey('horiz', 1), state).handled).toBe(false)
  })

  it('ignores vertical movement that is not on the first/last line of a multi-line paragraph', () => {
    const multi = paragraph.create(null, [
      markdownSchema.text('a'),
      markdownSchema.nodes.hard_break.create(),
      markdownSchema.text('b')
    ])
    const root = doc(multi, twoByTwo())
    const state = at(root, 2)

    expect(run(textBlockArrowKey('vert', 1), state).handled).toBe(false)
  })
})
