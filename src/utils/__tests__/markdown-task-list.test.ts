import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../markdown'

/** 只保留勾选框相关结构，方便断言（预览 HTML 里其它标记会干扰）。 */
function taskItems(html: string): Array<{ checked: boolean; text: string }> {
  const items: Array<{ checked: boolean; text: string }> = []
  // li 上除 class / data-checked 外还可能有 data-source-line 等属性
  const pattern = /<li class="task-list-item" data-checked="(true|false)"[^>]*>([\s\S]*?)<\/li>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const body = match[2]
      .replace(/<input[^>]*>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim()
    items.push({ checked: match[1] === 'true', text: body })
  }
  return items
}

describe('renderMarkdown task list', () => {
  it('renders real checkboxes and strips the source markers', () => {
    const html = renderMarkdown('- [x] 已完成\n- [ ] 未完成\n')
    expect(html).toContain('class="contains-task-list"')
    expect(html).toContain('<input type="checkbox" class="task-checkbox" checked disabled>')
    expect(html).toContain('<input type="checkbox" class="task-checkbox" disabled>')
    // 旧实现的症状：`[x]` 原样留在文本里
    expect(html).not.toContain('[x]')
    expect(html).not.toContain('[ ]')
    expect(taskItems(html)).toEqual([
      { checked: true, text: '已完成' },
      { checked: false, text: '未完成' }
    ])
  })

  it('keeps inline formatting after the marker', () => {
    const html = renderMarkdown('- [x] **加粗** 与 `code`')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).not.toContain('[x]')
    expect(taskItems(html)[0]).toEqual({ checked: true, text: '加粗 与 code' })
  })

  it('treats only matching items as tasks (GFM per-item semantics)', () => {
    const html = renderMarkdown('- [x] 任务\n- 普通项')
    expect(html).toContain('class="task-list-item"')
    expect(html).toContain('>普通项</li>')
    // 普通项不能被误标
    expect(html.match(/task-list-item/g)).toHaveLength(1)
  })

  it('does not treat bracketed text in the middle as a task marker', () => {
    const html = renderMarkdown('- 前缀 [x] 后缀')
    expect(html).not.toContain('task-checkbox')
    expect(html).toContain('[x] 后缀')
  })

  it('does not touch code blocks that look like task lists', () => {
    const html = renderMarkdown('```md\n- [x] 不是任务\n```')
    expect(html).not.toContain('task-checkbox')
    expect(html).toContain('- [x] 不是任务')
  })

  it('supports ordered task lists', () => {
    const html = renderMarkdown('1. [x] 第一步\n2. [ ] 第二步')
    expect(html).toContain('class="contains-task-list"')
    expect(html).toContain('<ol')
    expect(taskItems(html)).toEqual([
      { checked: true, text: '第一步' },
      { checked: false, text: '第二步' }
    ])
  })

  it('supports empty task items', () => {
    const html = renderMarkdown('- [x]\n- [ ]')
    expect(html).toContain('checked disabled')
    expect(taskItems(html)).toEqual([
      { checked: true, text: '' },
      { checked: false, text: '' }
    ])
  })

  it('supports nested task lists without leaking the outer marker', () => {
    const html = renderMarkdown('- [ ] 父项\n  - [x] 子项')
    expect(html).not.toContain('[ ]')
    expect(html).not.toContain('[x]')
    // 父项未选中、子项选中，且各有一个勾选框
    expect(html.match(/task-checkbox/g)).toHaveLength(2)
    expect(html).toMatch(/data-checked="false"[^>]*><input type="checkbox" class="task-checkbox" disabled><span class="task-text">父项<\/span>/)
    expect(html).toMatch(/data-checked="true"[^>]*><input type="checkbox" class="task-checkbox" checked disabled><span class="task-text">子项<\/span>/)
  })

  it('accepts uppercase X and requires whitespace after the marker', () => {
    expect(taskItems(renderMarkdown('- [X] 大写'))).toEqual([{ checked: true, text: '大写' }])
    // GFM 要求 `[x]` 后必须有空白，否则按普通文本处理
    const noSpace = renderMarkdown('- [x]done')
    expect(noSpace).not.toContain('task-checkbox')
    expect(noSpace).toContain('[x]done')
  })
})

describe('renderMarkdown source line anchors', () => {
  it('tags block elements with their markdown line number', () => {
    const html = renderMarkdown('# 标题\n\n正文段落\n\n- 列表项\n\n```js\ncode\n```\n')
    expect(html).toContain('<h1 data-source-line="1">标题</h1>')
    expect(html).toContain('<p data-source-line="3">正文段落</p>')
    expect(html).toMatch(/<ul data-source-line="5"/)
    expect(html).toContain('<pre class="shiki" data-source-line="7">')
  })

  it('keeps source line anchors stable after task list rewriting', () => {
    const html = renderMarkdown('- [ ] 任务\n')
    expect(html).toMatch(/<ul class="contains-task-list" data-source-line="1">/)
  })
})
