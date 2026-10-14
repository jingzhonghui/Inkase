import { describe, expect, it } from 'vitest'
import { EditorState, NodeSelection, TextSelection, type Transaction } from 'prosemirror-state'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { markdownSchema } from '../schema'
import { tableArrowKey, codeBlockArrowKey, arrowFromNodeSelection } from '../keymap'

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

describe('block-exit arrow: table boundary into a non-text block', () => {
  it('inserts a paragraph when moving Down from the last row into an hr', () => {
    const root = doc(twoByTwo(), hr())
    const state = at(root, posOfText(root, 'D'))

    const { handled, next } = run(tableArrowKey('vert', 1), state)

    expect(handled).toBe(true)
    expect(next?.doc.childCount).toBe(3)
    expect(next?.doc.child(1).type.name).toBe('paragraph')
    expect(next?.doc.child(2).type.name).toBe('horizontal_rule')
    expect(next?.selection.$from.parent.type.name).toBe('paragraph')
  })

  it('inserts a paragraph when moving Right from the last cell into an hr', () => {
    const root = doc(twoByTwo(), hr())
    const state = at(root, posOfText(root, 'D'))

    const { handled, next } = run(tableArrowKey('horiz', 1), state)

    expect(handled).toBe(true)
    expect(next?.doc.child(1).type.name).toBe('paragraph')
  })

  it('inserts a paragraph when moving Down into a math block', () => {
    const root = doc(twoByTwo(), math())
    const state = at(root, posOfText(root, 'D'))

    const { handled, next } = run(tableArrowKey('vert', 1), state)

    expect(handled).toBe(true)
    expect(next?.doc.child(1).type.name).toBe('paragraph')
    expect(next?.doc.child(2).type.name).toBe('math_block')
  })

  it('inserts a paragraph above when moving Up from the first row into an hr', () => {
    const root = doc(hr(), twoByTwo())
    const state = at(root, posOfText(root, 'A'))

    const { handled, next } = run(tableArrowKey('vert', -1), state)

    expect(handled).toBe(true)
    expect(next?.doc.child(0).type.name).toBe('horizontal_rule')
    expect(next?.doc.child(1).type.name).toBe('paragraph')
    expect(next?.doc.child(2).type.name).toBe('table')
  })

  it('enters an adjacent paragraph without inserting a new one', () => {
    const root = doc(twoByTwo(), para('Z'))
    const state = at(root, posOfText(root, 'D'))

    const { handled, next } = run(tableArrowKey('vert', 1), state)

    expect(handled).toBe(true)
    expect(next?.doc.childCount).toBe(2)
    expect(next?.selection.$from.parent.textContent).toBe('Z')
  })
})

describe('block-exit arrow: code block boundary', () => {
  it('inserts a paragraph when exiting the code block downward into an hr', () => {
    const root = doc(code('a'), hr())
    const state = at(root, posOfText(root, 'a'))

    const { handled, next } = run(codeBlockArrowKey('vert', 1), state)

    expect(handled).toBe(true)
    expect(next?.doc.childCount).toBe(3)
    expect(next?.doc.child(1).type.name).toBe('paragraph')
    expect(next?.selection.$from.parent.type.name).toBe('paragraph')
  })

  it('enters an adjacent paragraph when exiting the code block downward', () => {
    const root = doc(code('a'), para('Z'))
    const state = at(root, posOfText(root, 'a'))

    const { handled, next } = run(codeBlockArrowKey('vert', 1), state)

    expect(handled).toBe(true)
    expect(next?.doc.childCount).toBe(2)
    expect(next?.selection.$from.parent.textContent).toBe('Z')
  })

  it('does not intercept movement within a multi-line code block', () => {
    const root = doc(code('a\nb\nc'))
    // 光标停在第二行行首（b 之前）
    const state = at(root, 3)

    expect(run(codeBlockArrowKey('vert', -1), state).handled).toBe(false)
    expect(run(codeBlockArrowKey('vert', 1), state).handled).toBe(false)
  })
})

describe('block-exit arrow: node selection into a non-text block', () => {
  it('inserts a paragraph between two horizontal rules', () => {
    const root = doc(hr(), hr())
    const state = EditorState.create({ doc: root, selection: NodeSelection.create(root, 0) })

    const { handled, next } = run(arrowFromNodeSelection(1), state)

    expect(handled).toBe(true)
    expect(next?.doc.childCount).toBe(3)
    expect(next?.doc.child(1).type.name).toBe('paragraph')
  })

  it('inserts a paragraph above when moving Up from the first block', () => {
    const root = doc(hr(), para('Y'))
    const state = EditorState.create({ doc: root, selection: NodeSelection.create(root, 0) })

    const { handled, next } = run(arrowFromNodeSelection(-1), state)

    expect(handled).toBe(true)
    expect(next?.doc.child(0).type.name).toBe('paragraph')
    expect(next?.selection.$from.parent.type.name).toBe('paragraph')
  })

  it('enters an adjacent paragraph from a selected math block', () => {
    const root = doc(math(), para('Y'))
    const state = EditorState.create({ doc: root, selection: NodeSelection.create(root, 0) })

    const { handled, next } = run(arrowFromNodeSelection(1), state)

    expect(handled).toBe(true)
    expect(next?.selection.$from.parent.textContent).toBe('Y')
  })
})
