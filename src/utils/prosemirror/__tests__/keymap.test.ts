import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { tableEditing } from 'prosemirror-tables'
import { markdownSchema } from '../schema'
import {
  buildKeymap,
  handleTab,
  handleShiftTab,
  tabFocusModePlugin,
  tabFocusModeKey,
  exitBlockOnArrowUp
} from '../keymap'

const paragraph = markdownSchema.nodes.paragraph
const codeBlock = markdownSchema.nodes.code_block
const table = markdownSchema.nodes.table
const tableRow = markdownSchema.nodes.table_row
const tableCell = markdownSchema.nodes.table_cell

function makeState(
  nodes: ReturnType<typeof markdownSchema.node>[],
  selectionPos: number,
  plugins = [tabFocusModePlugin]
): EditorState {
  const doc = markdownSchema.node('doc', null, nodes)
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, selectionPos),
    plugins
  })
}

function run(command: ReturnType<typeof handleTab>, state: EditorState): Transaction | null {
  let tr: Transaction | null = null
  command(state, (t) => { tr = t })
  return tr
}

describe('IR keymap Tab handling', () => {
  it('inserts two spaces inside a code block at the cursor', () => {
    const state = makeState([codeBlock.create({ language: '' }, markdownSchema.text('abc'))], 2)

    const tr = run(handleTab(markdownSchema), state)

    expect(tr).not.toBeNull()
    const next = state.apply(tr!)
    expect(next.doc.textContent).toBe('a  bc')
    expect(next.selection.from).toBe(4)
  })

  it('indents every covered line for a multi-line code block selection', () => {
    const state = makeState(
      [codeBlock.create({ language: '' }, markdownSchema.text('a\nb'))],
      1,
      [tabFocusModePlugin]
    )
    const ranged = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 4)))

    const tr = run(handleTab(markdownSchema), ranged)

    expect(tr).not.toBeNull()
    expect(ranged.apply(tr!).doc.textContent).toBe('  a\n  b')
  })

  it('removes up to two leading spaces on Shift-Tab in a code block', () => {
    const state = makeState([codeBlock.create({ language: '' }, markdownSchema.text('  abc'))], 3)

    const tr = run(handleShiftTab(markdownSchema), state)

    expect(tr).not.toBeNull()
    expect(state.apply(tr!).doc.textContent).toBe('abc')
  })

  it('consumes Tab in a paragraph without changing the document', () => {
    const state = makeState([paragraph.create(null, markdownSchema.text('abc'))], 2)

    const tr = run(handleTab(markdownSchema), state)

    expect(tr).toBeNull()
    expect(handleTab(markdownSchema)(state, undefined)).toBe(true)
  })

  it('consumes Shift-Tab in a paragraph without changing the document', () => {
    const state = makeState([paragraph.create(null, markdownSchema.text('abc'))], 2)

    expect(handleShiftTab(markdownSchema)(state, undefined)).toBe(true)
  })

  it('moves to the next cell when Tab is pressed inside a table', () => {
    const cell = (): ReturnType<typeof tableCell.create> =>
      tableCell.create(null, paragraph.create(null, markdownSchema.text('x')))
    const tableNode = table.create(null, [tableRow.create(null, [cell(), cell()])])
    const doc = markdownSchema.node('doc', null, [tableNode])
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 4),
      plugins: [tabFocusModePlugin, tableEditing()]
    })

    const tr = run(handleTab(markdownSchema), state)

    expect(tr).not.toBeNull()
    const next = state.apply(tr!)
    expect(next.selection.from).not.toBe(4)
    expect(next.selection.from).toBeGreaterThan(6)
  })

  it('lets Tab escape the editor when tab focus mode is on', () => {
    const state = makeState([codeBlock.create({ language: '' }, markdownSchema.text('abc'))], 2)
    const focusModeState = state.apply(state.tr.setMeta(tabFocusModeKey, true))

    expect(handleTab(markdownSchema)(focusModeState, undefined)).toBe(false)
    expect(handleShiftTab(markdownSchema)(focusModeState, undefined)).toBe(false)
  })

  it('binds Ctrl-m to toggle tab focus mode', () => {
    const keymap = buildKeymap(markdownSchema)
    const toggle = keymap['Ctrl-m']
    expect(toggle).toBeDefined()

    const state = makeState([paragraph.create(null, markdownSchema.text('abc'))], 2)
    let tr: Transaction | null = null
    expect(toggle(state, (t) => { tr = t })).toBe(true)

    const next = state.apply(tr!)
    expect(tabFocusModeKey.getState(next)).toBe(true)
  })
})

describe('IR keymap code block Backspace', () => {
  const keymap = buildKeymap(markdownSchema)

  it('removes only the empty first line when pressed at its start', () => {
    const state = makeState([codeBlock.create({ language: '' }, markdownSchema.text('\nfoo'))], 1)

    const tr = run(keymap['Backspace'], state)

    expect(tr).not.toBeNull()
    const next = state.apply(tr!)
    expect(next.doc.textContent).toBe('foo')
    expect(next.doc.firstChild?.type.name).toBe('code_block')
    expect(next.selection.from).toBe(1)
  })

  it('deletes the whole code block only when it is empty', () => {
    const state = makeState(
      [paragraph.create(null, markdownSchema.text('a')), codeBlock.create({ language: '' })],
      4
    )

    const tr = run(keymap['Backspace'], state)

    expect(tr).not.toBeNull()
    const next = state.apply(tr!)
    expect(next.doc.childCount).toBe(1)
    expect(next.doc.firstChild?.type.name).toBe('paragraph')
  })

  it('keeps the code block when the first line has content', () => {
    const state = makeState([codeBlock.create({ language: '' }, markdownSchema.text('bar\nfoo'))], 1)

    const tr = run(keymap['Backspace'], state)
    const next = tr ? state.apply(tr) : state

    expect(next.doc.textContent).toBe('bar\nfoo')
    expect(next.doc.firstChild?.type.name).toBe('code_block')
  })
})

describe('IR keymap ArrowUp exit block', () => {
  const arrowUp = exitBlockOnArrowUp(markdownSchema)

  const cell = (text = 'x'): ReturnType<typeof tableCell.create> =>
    tableCell.create(null, markdownSchema.text(text))

  function tableState(
    tableNode: ReturnType<typeof table.create>,
    cellIndex: number,
    lineOffset = 0,
    preceding: ReturnType<typeof markdownSchema.node>[] = []
  ): EditorState {
    const doc = markdownSchema.node('doc', null, [...preceding, tableNode])
    let seen = -1
    let pos = -1
    doc.descendants((node, p) => {
      if (node.type.name === 'table_cell') {
        seen++
        if (seen === cellIndex) {
          pos = p + 1 + lineOffset
          return false
        }
      }
      return true
    })
    return EditorState.create({
      doc,
      selection: TextSelection.create(doc, pos),
      plugins: [tabFocusModePlugin]
    })
  }

  it('inserts an empty paragraph above a leading code block on the first line', () => {
    const state = makeState([codeBlock.create({ language: '' }, markdownSchema.text('abc'))], 1)

    const tr = run(arrowUp, state)

    expect(tr).not.toBeNull()
    const next = state.apply(tr!)
    expect(next.doc.childCount).toBe(2)
    expect(next.doc.child(0).type.name).toBe('paragraph')
    expect(next.doc.child(0).content.size).toBe(0)
    expect(next.doc.child(1).type.name).toBe('code_block')
    expect(next.selection.from).toBe(1)
  })

  it('moves the cursor to the end of a preceding paragraph', () => {
    const state = makeState(
      [
        paragraph.create(null, markdownSchema.text('a')),
        codeBlock.create({ language: '' }, markdownSchema.text('abc'))
      ],
      4
    )

    const tr = run(arrowUp, state)

    expect(tr).not.toBeNull()
    const next = state.apply(tr!)
    expect(next.doc.childCount).toBe(2)
    expect(next.selection.from).toBe(2)
  })

  it('inserts an empty paragraph above the code block when the block above is not a paragraph', () => {
    const state = makeState(
      [
        codeBlock.create({ language: '' }, markdownSchema.text('a')),
        codeBlock.create({ language: '' }, markdownSchema.text('b'))
      ],
      4
    )

    const tr = run(arrowUp, state)

    expect(tr).not.toBeNull()
    const next = state.apply(tr!)
    expect(next.doc.childCount).toBe(3)
    expect(next.doc.child(1).type.name).toBe('paragraph')
    expect(next.doc.child(1).content.size).toBe(0)
  })

  it('does not handle ArrowUp on a non-first line of a code block', () => {
    const state = makeState([codeBlock.create({ language: '' }, markdownSchema.text('a\nb'))], 3)

    expect(arrowUp(state, undefined)).toBe(false)
  })

  it('moves the cursor to the preceding paragraph from the first row of a table', () => {
    const tableNode = table.create(null, [tableRow.create(null, [cell('a'), cell('b')])])
    const state = tableState(tableNode, 0, 0, [paragraph.create(null, markdownSchema.text('p'))])

    const tr = run(arrowUp, state)

    expect(tr).not.toBeNull()
    const next = state.apply(tr!)
    expect(next.selection.from).toBe(2)
  })

  it('inserts an empty paragraph above a leading table', () => {
    const tableNode = table.create(null, [tableRow.create(null, [cell('a'), cell('b')])])
    const state = tableState(tableNode, 0)

    const tr = run(arrowUp, state)

    expect(tr).not.toBeNull()
    const next = state.apply(tr!)
    expect(next.doc.child(0).type.name).toBe('paragraph')
    expect(next.doc.child(0).content.size).toBe(0)
    expect(next.doc.child(1).type.name).toBe('table')
  })

  it('does not handle ArrowUp outside the first row of a table', () => {
    const tableNode = table.create(null, [
      tableRow.create(null, [cell('a'), cell('b')]),
      tableRow.create(null, [cell('c'), cell('d')])
    ])
    const state = tableState(tableNode, 2)

    expect(arrowUp(state, undefined)).toBe(false)
  })

  it('does not handle ArrowUp on a non-first line inside a table cell', () => {
    const tableNode = table.create(null, [tableRow.create(null, [cell('a\nb'), cell('c')])])
    const state = tableState(tableNode, 0, 2)

    expect(arrowUp(state, undefined)).toBe(false)
  })
})
