import { describe, expect, it } from 'vitest'
import { EditorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { markdownSchema } from '../schema'
import { buildInputRules } from '../inputrules'

/**
 * 用假 view 驱动真实的 inputRules 插件：
 * 插件的 handleTextInput 只依赖 view.state / view.composing / view.dispatch，
 * 因此无需真实 DOM（默认 node 环境）即可验证规则是否命中并观察结果文档。
 */
function typeSpace(text: string, caretOffset: number) {
  const doc = markdownSchema.node('doc', null, [
    markdownSchema.node('paragraph', null, [markdownSchema.text(text)])
  ])
  const plugin = buildInputRules(markdownSchema)
  let state = EditorState.create({ doc, plugins: [plugin] })

  const fakeView = {
    state,
    composing: false,
    dispatch: (tr: Transaction) => {
      state = state.apply(tr)
      fakeView.state = state
    }
  } as unknown as EditorView

  // 段内容起始于位置 1，故光标位置 = 1 + 段内偏移
  const pos = 1 + caretOffset
  const handled = plugin.props.handleTextInput!(fakeView, pos, pos, ' ') as boolean
  return { handled, state }
}

describe('headingRule 输入规则', () => {
  it('段落输入 "##" + 空格：转为 H2 并保留 "## " 标记文本', () => {
    const { handled, state } = typeSpace('##', 2)
    const block = state.doc.firstChild!
    expect(handled).toBe(true)
    expect(block.type.name).toBe('heading')
    expect(block.attrs.level).toBe(2)
    expect(block.textContent).toBe('## ')
  })

  it('段落输入 "#" + 空格：转为 H1 并保留 "# " 标记文本', () => {
    const { handled, state } = typeSpace('#', 1)
    const block = state.doc.firstChild!
    expect(handled).toBe(true)
    expect(block.type.name).toBe('heading')
    expect(block.attrs.level).toBe(1)
    expect(block.textContent).toBe('# ')
  })

  it('光标位于 "##" 之后但段内仍有正文时不触发（仍为段落）', () => {
    const { handled, state } = typeSpace('## x', 2)
    const block = state.doc.firstChild!
    expect(handled).toBe(false)
    expect(block.type.name).toBe('paragraph')
    expect(block.textContent).toBe('## x')
  })
})
