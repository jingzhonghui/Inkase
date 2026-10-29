import { describe, expect, it } from 'vitest'
import {
  buildRelatedBullet,
  escapeLinkText,
  planRelatedLinkInsertion,
  RELATED_SECTION_TITLE
} from '../link-insert'

/**
 * `shared/graph/link-insert.ts` 的纯函数测试。
 *
 * 对应 docs/2026-10-28-knowledge-graph-test-cases.md 的 TC-INSERT-001 ~ 007。
 * 设计依据：docs/2026-10-28-knowledge-graph-design.md §5.10。
 *
 * 注意：幂等（TC-INSERT-003）与 encodeURI 往返（TC-INSERT-007）不在本模块，
 * 分别由 `electron/graph/__tests__/link-write.test.ts` 覆盖——幂等依赖路径解析，
 * encodeURI 在 `link-resolve.encodeLinkTarget` 里。
 */

const BULLET = '- [目标](b.md)'

/** 把结果按行切开，便于用「行号」这一设计承诺做断言 */
function linesOf(content: string): string[] {
  return content.split('\n')
}

describe('planRelatedLinkInsertion / 新建小节', () => {
  it('TC-INSERT-001 没有小节时在文末新建并前置空行', () => {
    const plan = planRelatedLinkInsertion('# 标题\n正文', BULLET)

    // 设计 §5.10：小节不存在则先创建（前置一个空行）
    expect(plan.content).toBe('# 标题\n正文\n\n## 相关笔记\n\n- [目标](b.md)\n')
    // 原正文逐字保留
    expect(plan.content.startsWith('# 标题\n正文\n\n')).toBe(true)
    expect(plan.content).toContain(`## ${RELATED_SECTION_TITLE}`)
  })

  it('空正文时只产出小节标题与条目，不留多余空行', () => {
    const plan = planRelatedLinkInsertion('', BULLET)

    expect(plan.content).toBe('## 相关笔记\n\n- [目标](b.md)\n')
    expect(plan.content).not.toMatch(/\n{3,}/)
  })

  it('正文已有尾随空行时不堆积超过两个空行', () => {
    const plan = planRelatedLinkInsertion('# 标题\n\n\n\n', BULLET)

    expect(plan.content).toBe('# 标题\n\n## 相关笔记\n\n- [目标](b.md)\n')
    expect(plan.content).not.toMatch(/\n{3,}/)
  })
})

describe('planRelatedLinkInsertion / 已有小节', () => {
  it('TC-INSERT-002 追加到小节末尾且在下一个标题之前', () => {
    const source = '# T\n\n## 相关笔记\n- [a](a.md)\n\n## 其他\n正文'
    const plan = planRelatedLinkInsertion(source, BULLET)

    const lines = linesOf(plan.content)
    expect(lines[3]).toBe('- [a](a.md)')
    expect(lines[4]).toBe('- [目标](b.md)')
    expect(lines[6]).toBe('## 其他')
    expect(lines[7]).toBe('正文')
    // 其它小节的内容一字未动
    expect(plan.content).toContain('## 其他\n正文')
  })

  it('小节内多条已有条目时插到最后一条之后', () => {
    const source = '## 相关笔记\n- [a](a.md)\n- [b2](b2.md)\n'
    const plan = planRelatedLinkInsertion(source, BULLET)

    const lines = linesOf(plan.content)
    expect(lines[1]).toBe('- [a](a.md)')
    expect(lines[2]).toBe('- [b2](b2.md)')
    expect(lines[3]).toBe('- [目标](b.md)')
  })

  it('多个「相关笔记」小节时插入最后一个', () => {
    const source = '## 相关笔记\n- [first](first.md)\n\n# 中间\n\n## 相关笔记\n- [last](last.md)\n'
    const plan = planRelatedLinkInsertion(source, BULLET)

    const lines = linesOf(plan.content)
    // 第一个小节保持原样
    expect(lines[1]).toBe('- [first](first.md)')
    // 新条目落在最后一个小节内
    const lastHeading = lines.lastIndexOf('## 相关笔记')
    expect(lines[lastHeading + 2]).toBe('- [目标](b.md)')
  })

  it('TC-INSERT-004 小节紧邻下一个标题时补一个空行，不粘行', () => {
    const plan = planRelatedLinkInsertion('## 相关笔记\n## 下一个', BULLET)

    expect(plan.content).toBe('## 相关笔记\n- [目标](b.md)\n\n## 下一个')
    // 标题与列表项之间没有出现「标题紧跟列表项」的粘连
    expect(plan.content).not.toContain('## 下一个- [')
  })

  it('小节内只有空行时条目紧跟标题下', () => {
    const plan = planRelatedLinkInsertion('## 相关笔记\n\n\n## 其他', BULLET)

    const lines = linesOf(plan.content)
    expect(lines[0]).toBe('## 相关笔记')
    expect(lines[1]).toBe('- [目标](b.md)')
    expect(lines).toContain('## 其他')
  })

  it('三级标题不结束小节，条目落在整个小节末尾而非切断子节', () => {
    const source = '## 相关笔记\n- [a](a.md)\n### 子标题\n正文\n'
    const plan = planRelatedLinkInsertion(source, BULLET)

    const lines = linesOf(plan.content)
    // 设计 §5.10：插入点在「下一个同级或更高级标题之前」，即 ### 子节整体之后
    expect(lines[2]).toBe('### 子标题')
    expect(lines[3]).toBe('正文')
    expect(lines[4]).toBe('- [目标](b.md)')
    expect(plan.line).toBe(5)
  })
})

describe('planRelatedLinkInsertion / 行号与行尾', () => {
  it('TC-INSERT-006 返回的行号（1 起）指向新增条目', () => {
    const plan = planRelatedLinkInsertion('# 标题\n正文', BULLET)
    const target = linesOf(plan.content)[plan.line - 1]

    expect(target).toBe(BULLET)
  })

  it('TC-INSERT-006 已有小节分支返回的行号同样准确', () => {
    const source = '# T\n\n## 相关笔记\n- [a](a.md)\n'
    const plan = planRelatedLinkInsertion(source, BULLET)

    expect(linesOf(plan.content)[plan.line - 1]).toBe(BULLET)
  })

  it('TC-INSERT-005 CRLF 正文归一为 LF，不混行尾', () => {
    const source = '# T\r\n\r\n## 相关笔记\r\n- [a](a.md)\r\n'
    const plan = planRelatedLinkInsertion(source, BULLET)

    expect(plan.content).not.toContain('\r')
    expect(linesOf(plan.content)[plan.line - 1]).toBe(BULLET)
    // 原有行内容不丢字
    expect(plan.content).toContain('## 相关笔记')
    expect(plan.content).toContain('- [a](a.md)')
  })

  it('中文正文与中文标题不被破坏', () => {
    const plan = planRelatedLinkInsertion('## 会议记录\n讨论了图谱设计。', '- [设计](设计文档.md)')

    expect(plan.content).toContain('## 会议记录\n讨论了图谱设计。')
    expect(plan.content).toContain('- [设计](设计文档.md)')
  })
})

describe('buildRelatedBullet / escapeLinkText', () => {
  it('TC-INSERT-001 条目格式为 `- [标题](路径)`', () => {
    expect(buildRelatedBullet('目标文档', 'sub/b.md')).toBe('- [目标文档](sub/b.md)')
  })

  it('标题里的方括号被转义，不破坏链接语法', () => {
    expect(escapeLinkText('[草稿] 方案')).toBe('\\[草稿\\] 方案')
    expect(buildRelatedBullet('a[b]c', 'b.md')).toBe('- [a\\[b\\]c](b.md)')
  })

  it('标题里的反斜杠被转义', () => {
    expect(escapeLinkText('a\\b')).toBe('a\\\\b')
  })

  it('转义只作用于链接文字，不碰路径', () => {
    expect(buildRelatedBullet('x', 'dir/[y].md')).toBe('- [x](dir/[y].md)')
  })
})
