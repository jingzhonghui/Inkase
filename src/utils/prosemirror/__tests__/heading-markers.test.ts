import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { Fragment, Slice } from 'prosemirror-model'
import {
  parseHeadingLevel,
  getHeadingMarkerLength,
  injectHeadingMarkers,
  injectHeadingMarkersIntoFragment,
  applyHeadingLevel,
  headingMarkerPlugin
} from '../heading-markers'
import { markdownSchema, parseMarkdown, serializeMarkdown } from '../markdown'

describe('parseHeadingLevel', () => {
  it('parses levels 1..6', () => {
    expect(parseHeadingLevel('# 标题')).toBe(1)
    expect(parseHeadingLevel('###### 标题')).toBe(6)
  })
  it('returns null without a valid marker', () => {
    expect(parseHeadingLevel('正文')).toBeNull()
    expect(parseHeadingLevel('####### 标题')).toBeNull()
    expect(parseHeadingLevel('##无空格')).toBeNull()
  })
})

describe('getHeadingMarkerLength', () => {
  it('returns marker length including the trailing space', () => {
    const heading = markdownSchema.node('heading', { level: 2 }, markdownSchema.text('## 标题'))
    expect(getHeadingMarkerLength(heading)).toBe(3)
  })
  it('returns 0 when there is no marker', () => {
    const heading = markdownSchema.node('heading', { level: 2 }, markdownSchema.text('无标记'))
    expect(getHeadingMarkerLength(heading)).toBe(0)
  })
})

describe('injectHeadingMarkers', () => {
  it('prepends the marker to headings on parse', () => {
    const doc = parseMarkdown('## 标题')
    const heading = injectHeadingMarkers(doc, markdownSchema).firstChild!
    expect(heading.textContent).toBe('## 标题')
  })
  it('injects markers for headings nested in blockquotes', () => {
    const doc = parseMarkdown('> # 引用标题')
    const injected = injectHeadingMarkers(doc, markdownSchema)
    expect(injected.textContent).toContain('# 引用标题')
  })
  it('is idempotent when the marker is already present', () => {
    const doc = parseMarkdown('## 标题')
    const once = injectHeadingMarkers(doc, markdownSchema)
    const twice = injectHeadingMarkers(once, markdownSchema)
    expect(serializeMarkdown(twice)).toBe(serializeMarkdown(once))
  })
})

describe('heading markdown round-trip', () => {
  it('serializes headings back to source form', () => {
    for (const src of ['# 一级', '## 二级', '###### 六级', '## 带 **粗体** 的标题']) {
      expect(serializeMarkdown(parseMarkdown(src))).toBe(src)
    }
  })
  it('keeps the marker text inside the heading node', () => {
    const doc = parseMarkdown('## 标题')
    expect(doc.firstChild!.textContent).toBe('## 标题')
  })
})

function applyTo(src: string, pos: number, level: number | null): string {
  const doc = parseMarkdown(src)
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) })
  let tr: ReturnType<typeof state.tr> | null = null
  applyHeadingLevel(level)(state, (t) => {
    tr = t
  })
  return serializeMarkdown(tr ? state.apply(tr).doc : state.doc)
}

describe('applyHeadingLevel', () => {
  it('sets a paragraph to the given heading level, inserting the marker', () => {
    expect(applyTo('标题', 1, 2)).toBe('## 标题')
  })
  it('changes an existing heading level by rewriting the marker', () => {
    expect(applyTo('# 标题', 2, 3)).toBe('### 标题')
  })
  it('degrades a heading to a paragraph, removing the marker', () => {
    expect(applyTo('## 标题', 2, null)).toBe('标题')
  })
  it('does not touch code blocks', () => {
    const before = '```\ncode\n```'
    expect(applyTo(before, 2, 2)).toBe(serializeMarkdown(parseMarkdown(before)))
  })
  it('applies the level to every block in a multi-block selection', () => {
    const doc = parseMarkdown('第一段\n\n第二段')
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, doc.content.size - 1)
    })
    let tr: ReturnType<typeof state.tr> | null = null
    applyHeadingLevel(2)(state, (t) => { tr = t })
    expect(tr).not.toBeNull()
    expect(serializeMarkdown(state.apply(tr!).doc)).toBe('## 第一段\n\n## 第二段')
  })
})

function typeDelete(doc: ReturnType<typeof parseMarkdown>, from: number, to: number) {
  // 用真实事务模拟删除，触发 appendTransaction 同步
  const state = EditorState.create({ doc, plugins: [headingMarkerPlugin()] })
  let result = state
  result = result.apply(result.tr.delete(from, to))
  return result
}

describe('headingMarkerPlugin', () => {
  it('downgrades a heading whose marker was fully deleted', () => {
    const doc = parseMarkdown('## 标题')
    // 删除 `## `（位置 1..4）→ 应为段落
    const result = typeDelete(doc, 1, 4)
    expect(result.doc.firstChild!.type.name).toBe('paragraph')
    expect(serializeMarkdown(result.doc)).toBe('标题')
  })

  it('updates level when one # is removed', () => {
    const doc = parseMarkdown('## 标题')
    // 删除一个 #（位置 1..2）→ 应为 H1
    const result = typeDelete(doc, 1, 2)
    expect(result.doc.firstChild!.attrs.level).toBe(1)
    expect(serializeMarkdown(result.doc)).toBe('# 标题')
  })

  it('syncs the level from the marker text and terminates', () => {
    const heading = markdownSchema.node('heading', { level: 2 }, markdownSchema.text('# 标题'))
    const para = markdownSchema.node('paragraph', null, markdownSchema.text('正文'))
    const doc = markdownSchema.node('doc', null, [heading, para])
    const state = EditorState.create({ doc, plugins: [headingMarkerPlugin()] })
    const paraPos = heading.nodeSize + 1
    // 一次文档变更触发 appendTransaction：级别应由 '#'×1 同步为 1
    const next = state.apply(state.tr.insertText('x', paraPos))
    expect(next.doc.firstChild!.attrs.level).toBe(1)
    // 再次变更：级别保持 1，且 apply 正常返回（证明收敛、无无限追加事务）
    const again = next.apply(next.tr.insertText('y', paraPos + 1))
    expect(again.doc.firstChild!.attrs.level).toBe(1)
  })
})

describe('粘贴/拖入标题标记注入', () => {
  it('injects markers into headings inside a pasted fragment', () => {
    const heading = markdownSchema.node('heading', { level: 2 }, markdownSchema.text('标题'))
    const fragment = Fragment.fromArray([heading])
    const out = injectHeadingMarkersIntoFragment(fragment, markdownSchema)
    expect(out.firstChild!.textContent).toBe('## 标题')
  })

  it('normalizes pasted slices so markerless headings get markers', () => {
    const heading = markdownSchema.node('heading', { level: 1 }, markdownSchema.text('标题'))
    const slice = new Slice(Fragment.fromArray([heading]), 0, 0)
    const plugin = headingMarkerPlugin()
    const view = { state: EditorState.create({ doc: parseMarkdown('') }) }
    const out = plugin.spec.props!.transformPasted!(slice, view as never)
    expect(out.content.firstChild!.textContent).toBe('# 标题')
  })
})
