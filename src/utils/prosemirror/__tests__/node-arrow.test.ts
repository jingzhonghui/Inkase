import { describe, expect, it } from 'vitest'
import { EditorState, NodeSelection, TextSelection, type Transaction } from 'prosemirror-state'
import { markdownSchema } from '../schema'
import { arrowFromNodeSelection } from '../keymap'

const { paragraph, horizontal_rule } = markdownSchema.nodes

function docWithRule(): { doc: ReturnType<typeof markdownSchema.node>; rulePos: number } {
  const doc = markdownSchema.node('doc', null, [
    paragraph.create(null, markdownSchema.text('X')),
    horizontal_rule.create(),
    paragraph.create(null, markdownSchema.text('Y'))
  ])
  return { doc, rulePos: paragraph.create(null, markdownSchema.text('X')).nodeSize }
}

function run(dir: 1 | -1, state: EditorState): { handled: boolean; next: EditorState | null } {
  let tr: Transaction | null = null
  const handled = arrowFromNodeSelection(dir)(state, (t) => { tr = t }, {} as never)
  return { handled, next: tr ? state.apply(tr) : null }
}

function stateWithRuleSelected(): EditorState {
  const { doc, rulePos } = docWithRule()
  return EditorState.create({ doc, selection: NodeSelection.create(doc, rulePos) })
}

describe('IR arrow keys from a node selection (horizontal rule)', () => {
  it('moves the caret to the previous block on ArrowLeft', () => {
    const state = stateWithRuleSelected()

    const { handled, next } = run(-1, state)

    expect(handled).toBe(true)
    expect(next?.selection).not.toBeInstanceOf(NodeSelection)
    expect(next?.selection.$from.parent.textContent).toBe('X')
  })

  it('moves the caret to the next block on ArrowRight', () => {
    const state = stateWithRuleSelected()

    const { handled, next } = run(1, state)

    expect(handled).toBe(true)
    expect(next?.selection).not.toBeInstanceOf(NodeSelection)
    expect(next?.selection.$from.parent.textContent).toBe('Y')
  })

  it('does not intercept when a text selection is active', () => {
    const { doc } = docWithRule()
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) })

    expect(run(-1, state).handled).toBe(false)
    expect(run(1, state).handled).toBe(false)
  })
})
