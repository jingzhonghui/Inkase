import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { markdownSchema } from '../schema'
import { tableArrowKey } from '../keymap'

const { paragraph, table, table_row, table_header, table_cell } = markdownSchema.nodes

const header = (t: string): ProseMirrorNode => table_header.create(null, markdownSchema.text(t))
const cell = (t: string): ProseMirrorNode => table_cell.create(null, markdownSchema.text(t))
const row = (...cells: ProseMirrorNode[]): ProseMirrorNode => table_row.create(null, cells)
const makeTable = (...rows: ProseMirrorNode[]): ProseMirrorNode => table.create(null, rows)
const para = (t = ''): ProseMirrorNode => paragraph.create(null, t ? markdownSchema.text(t) : undefined)

function posOfText(doc: ProseMirrorNode, text: string, atEnd = true): number {
  let p = -1
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text) p = atEnd ? pos + node.nodeSize : pos
    return true
  })
  return p
}

function run(
  axis: 'horiz' | 'vert',
  dir: 1 | -1,
  state: EditorState
): { handled: boolean; next: EditorState | null } {
  let tr: Transaction | null = null
  const handled = tableArrowKey(axis, dir)(state, (t) => { tr = t }, {} as never)
  return { handled, next: tr ? state.apply(tr) : null }
}

function tableDoc(): ProseMirrorNode {
  return markdownSchema.node('doc', null, [
    makeTable(row(header('A'), header('B')), row(cell('C'), cell('D'))),
    para()
  ])
}

describe('IR table arrow navigation', () => {
  it('moves to the next cell on ArrowRight at the end of a cell', () => {
    const doc = tableDoc()
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, posOfText(doc, 'A'))
    })

    const { handled, next } = run('horiz', 1, state)

    expect(handled).toBe(true)
    expect(next?.selection.$from.parent.textContent).toBe('B')
  })

  it('moves to the cell below on ArrowDown', () => {
    const doc = tableDoc()
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, posOfText(doc, 'A'))
    })

    const { handled, next } = run('vert', 1, state)

    expect(handled).toBe(true)
    expect(next?.selection.$from.parent.textContent).toBe('C')
  })

  it('exits to the paragraph after the table on ArrowRight at the last cell', () => {
    const doc = tableDoc()
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, posOfText(doc, 'D'))
    })

    const { handled, next } = run('horiz', 1, state)

    expect(handled).toBe(true)
    expect(next?.selection.$from.parent.type.name).toBe('paragraph')
  })

  it('exits to the paragraph before the table on ArrowUp in the top row', () => {
    const doc = markdownSchema.node('doc', null, [
      para('X'),
      makeTable(row(header('A'), header('B')), row(cell('C'), cell('D'))),
      para()
    ])
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, posOfText(doc, 'A'))
    })

    const { handled, next } = run('vert', -1, state)

    expect(handled).toBe(true)
    expect(next?.selection.$from.parent.textContent).toBe('X')
  })

  it('does not intercept arrows in the middle of cell text', () => {
    const doc = markdownSchema.node('doc', null, [makeTable(row(header('AB'), header('C'))), para()])
    const start = posOfText(doc, 'AB', false)
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, start + 1) })

    expect(run('horiz', 1, state).handled).toBe(false)
  })

  it('does not intercept arrows outside a table', () => {
    const doc = markdownSchema.node('doc', null, [para('hello')])
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) })

    expect(run('horiz', 1, state).handled).toBe(false)
    expect(run('vert', -1, state).handled).toBe(false)
  })
})
