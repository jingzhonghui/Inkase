import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { markdownSchema as schema } from '../schema'
import { buildKeymap } from '../keymap'
import { taskListRule } from '../inputrules'
import { parseMarkdown } from '../markdown'

const keymap = buildKeymap(schema)

/** 构造「在无序列表项里刚输入完 `[ ] `」的状态。 */
function stateBeforeTaskRule(): EditorState {
  const paragraph = schema.nodes.paragraph.create(null, schema.text('[ ] '))
  const item = schema.nodes.list_item.create(null, paragraph)
  const list = schema.nodes.bullet_list.create(null, item)
  const doc = schema.nodes.doc.create(null, list)
  // bullet_list(0) > list_item(1) > paragraph(2) > text 3..7
  return EditorState.create({ doc, selection: TextSelection.create(doc, 7) })
}

function applyTaskRule(state: EditorState): EditorState {
  const rule = taskListRule(schema.nodes.bullet_list, schema.nodes.task_list, schema.nodes.task_item)
  const tr = rule.handler(state, ['[ ] ', ' '] as unknown as RegExpMatchArray, 3, 7)
  if (!tr) throw new Error('taskListRule 未产出事务')
  return state.apply(tr)
}

/** 在 pos 处按回车，返回新文档；命令抛错时让测试失败。 */
function pressEnter(state: EditorState, pos?: number): EditorState {
  const withSel = pos == null
    ? state
    : state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)))
  let next = withSel
  keymap['Enter'](withSel, (tr) => { next = withSel.apply(tr) })
  return next
}

function textEnd(doc: Parameters<typeof TextSelection.create>[0]): number {
  let pos = 1
  doc.descendants((node, p) => {
    if (node.type.name === 'task_item' || node.type.name === 'list_item') {
      const first = node.firstChild
      if (first?.isTextblock) pos = p + 2 + first.content.size
    }
    return true
  })
  return pos
}

describe('任务列表输入规则与回车分割', () => {
  it('输入 [ ] 后生成的是合法的 task_list（不是装着 task_item 的 bullet_list）', () => {
    const next = applyTaskRule(stateBeforeTaskRule())
    expect(next.doc.childCount).toBe(1)
    expect(next.doc.firstChild?.type.name).toBe('task_list')
    expect(next.doc.firstChild?.firstChild?.type.name).toBe('task_item')
    expect(next.doc.firstChild?.firstChild?.attrs.checked).toBe(false)
  })

  it('输入 [x] 后任务项为已勾选', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('[x] '))
    const item = schema.nodes.list_item.create(null, paragraph)
    const list = schema.nodes.bullet_list.create(null, item)
    const doc = schema.nodes.doc.create(null, list)
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 7) })
    const rule = taskListRule(schema.nodes.bullet_list, schema.nodes.task_list, schema.nodes.task_item)
    const next = state.apply(rule.handler(state, ['[x] ', 'x'] as unknown as RegExpMatchArray, 3, 7)!)
    expect(next.doc.firstChild?.firstChild?.attrs.checked).toBe(true)
  })

  it('非空任务项回车，在同一 task_list 内新增一个 task_item（不抛异常）', () => {
    const base = applyTaskRule(stateBeforeTaskRule())
    const withText = base.apply(base.tr.insertText('abc')) // 现在光标在 "abc" 之后
    const next = pressEnter(withText)

    const list = next.doc.firstChild
    expect(list?.type.name).toBe('task_list')
    expect(list?.childCount).toBe(2)
    expect(list?.child(0).type.name).toBe('task_item')
    expect(list?.child(1).type.name).toBe('task_item')
    expect(list?.child(0).textContent).toBe('abc')
    expect(list?.child(1).textContent).toBe('')
    // 新项默认未勾选
    expect(list?.child(1).attrs.checked).toBe(false)
  })

  it('解析 `- [ ]` 空任务项时仍识别为任务列表（与预览一致）', () => {
    const doc = parseMarkdown('- [ ]\n- [x] 完成')
    expect(doc.firstChild?.type.name).toBe('task_list')
    expect(doc.firstChild?.childCount).toBe(2)
    expect(doc.firstChild?.child(0).type.name).toBe('task_item')
    expect(doc.firstChild?.child(0).attrs.checked).toBe(false)
    expect(doc.firstChild?.child(0).textContent).toBe('')
    expect(doc.firstChild?.child(1).attrs.checked).toBe(true)
    expect(doc.firstChild?.child(1).textContent).toBe('完成')
  })

  it('空任务项回车：多项目列表里退出列表（项变回普通段落）', () => {
    const doc = parseMarkdown('- [x] 第一项\n- [ ]')
    expect(doc.firstChild?.type.name).toBe('task_list')
    const secondItemStart = (() => {
      let pos = 0
      doc.descendants((node, p) => {
        if (node.type.name === 'task_item') pos = p
        return true
      })
      return pos
    })()
    // 光标放在空项段落内
    const next = pressEnter(
      EditorState.create({ doc, selection: TextSelection.create(doc, secondItemStart + 2) })
    )
    const types = [] as string[]
    next.doc.forEach((n) => types.push(n.type.name))
    // 空项被提升为普通段落，剩余的第一项仍留在 task_list 里
    expect(types).toContain('paragraph')
    expect(types).toContain('task_list')
    expect(next.doc.lastChild?.type.name).toBe('paragraph')
    expect(next.doc.firstChild?.childCount).toBe(1)
  })

  it('光标在任务项文本中间回车时也能正确分割', () => {
    const doc = parseMarkdown('- [ ] abcd')
    const pos = textEnd(doc) - 1 // "abc|d"
    const next = pressEnter(EditorState.create({ doc, selection: TextSelection.create(doc, pos) }))
    const list = next.doc.firstChild
    expect(list?.type.name).toBe('task_list')
    expect(list?.childCount).toBe(2)
    expect(list?.child(0).textContent).toBe('abc')
    expect(list?.child(1).textContent).toBe('d')
  })
})
