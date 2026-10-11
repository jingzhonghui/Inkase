import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { tableEditing } from 'prosemirror-tables'
import { markdownSchema } from '../schema'
import { buildKeymap, handleTab, handleShiftTab, tabFocusModePlugin, tabFocusModeKey } from '../keymap'

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
