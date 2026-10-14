// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { EditorState, NodeSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { parseMarkdown } from '../markdown'
import { HorizontalRuleView } from '../horizontal-rule-view'

let mountedView: EditorView | null = null
afterEach(() => {
  mountedView?.destroy()
  mountedView = null
  document.body.innerHTML = ''
})

function mount(content: string): { view: EditorView; hr: () => HorizontalRuleView | null } {
  const doc = parseMarkdown(content)
  const place = document.createElement('div')
  document.body.appendChild(place)
  let created: HorizontalRuleView | null = null
  const view = new EditorView(place, {
    state: EditorState.create({ doc }),
    nodeViews: {
      horizontal_rule: (node, view2, getPos) => {
        created = new HorizontalRuleView(node, view2, getPos as () => number)
        return created
      }
    }
  })
  mountedView = view
  return { view, hr: () => created }
}

describe('HorizontalRuleView', () => {
  it('renders a .ir-hr-node element', () => {
    const { view } = mount('---\n\n正文')
    expect(view.state.doc.firstChild?.type.name).toBe('horizontal_rule')
    expect(view.dom.querySelector('.ir-hr-node')).not.toBeNull()
  })

  it('adds the selected class on selectNode and removes it on deselectNode', () => {
    const { hr } = mount('---\n\n正文')
    const instance = hr()!
    instance.selectNode()
    expect(instance.dom.classList.contains('ProseMirror-selectednode')).toBe(true)
    instance.deselectNode()
    expect(instance.dom.classList.contains('ProseMirror-selectednode')).toBe(false)
  })

  it('selects the node (NodeSelection) on mousedown and stops the event', () => {
    const { view, hr } = mount('---\n\n正文')
    const instance = hr()!
    const stopped = instance.stopEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(stopped).toBe(true)
    expect(view.state.selection).toBeInstanceOf(NodeSelection)
    expect((view.state.selection as NodeSelection).from).toBe(0)
  })
})
