import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { NodeSelection } from 'prosemirror-state'
import type { EditorView, NodeView } from 'prosemirror-view'

/**
 * 水平分割线的 NodeView：让分割线成为可点击选中的节点，
 * 避免只有 gap cursor、无法选中以及出现"横光标 + 正常光标"的问题。
 */
export class HorizontalRuleView implements NodeView {
  dom: HTMLElement
  private view: EditorView
  private getPos: () => number

  constructor(_node: ProseMirrorNode, view: EditorView, getPos: () => number) {
    this.view = view
    this.getPos = getPos
    this.dom = document.createElement('div')
    this.dom.className = 'ir-hr-node'
    this.dom.setAttribute('data-type', 'horizontal_rule')
    this.dom.contentEditable = 'false'
    const line = document.createElement('div')
    line.className = 'ir-hr-line'
    this.dom.appendChild(line)
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode')
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode')
  }

  stopEvent(event: Event): boolean {
    if (event.type === 'mousedown') {
      this.view.dispatch(
        this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, this.getPos()))
      )
      this.view.focus()
    }
    return true
  }

  ignoreMutation(): boolean {
    return true
  }
}
