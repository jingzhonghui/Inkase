import { describe, expect, it } from 'vitest'
import {
  buildBasenameIndex,
  dirnameOf,
  encodeLinkTarget,
  externalSchemeOf,
  resolveLink,
  resolveRelativePath,
  type ResolveContext
} from '../link-resolve'
import { normalizeGraphId } from '../types'

/**
 * 解析必须与 `Ctrl+Click`（LINK.OPEN）语义一致：
 * 图谱说「断了」而点一下能打开，是最伤信任的那种 bug。
 */

interface CtxOptions {
  from?: string
  indexed?: string[]
  known?: string[]
  attachments?: string[]
  caseInsensitive?: boolean
}

function makeCtx(options: CtxOptions = {}): ResolveContext {
  const from = options.from ?? 'a.md'
  const caseInsensitive = options.caseInsensitive ?? false
  const indexedPaths = options.indexed ?? []
  return {
    fromId: normalizeGraphId(from, caseInsensitive),
    fromPath: from,
    indexed: new Set(indexedPaths.map((p) => normalizeGraphId(p, caseInsensitive))),
    known: options.known
      ? new Set(options.known.map((p) => normalizeGraphId(p, caseInsensitive)))
      : undefined,
    attachments: options.attachments
      ? new Map(
          options.attachments.map(
            (path) => [normalizeGraphId(path, caseInsensitive), path] as const
          )
        )
      : undefined,
    basenames: buildBasenameIndex(
      indexedPaths.map((p) => ({ id: normalizeGraphId(p, caseInsensitive), path: p }))
    ),
    caseInsensitive
  }
}

describe('resolveRelativePath / dirnameOf', () => {
  it('同目录与下跳', () => {
    expect(resolveRelativePath('notes', 'b.md')).toBe('notes/b.md')
    expect(resolveRelativePath('notes/sub', '../b.md')).toBe('notes/b.md')
    expect(resolveRelativePath('', 'notes/b.md')).toBe('notes/b.md')
  })

  it('越出根目录返回 null', () => {
    expect(resolveRelativePath('', '../x.md')).toBeNull()
    expect(resolveRelativePath('notes', '../../x.md')).toBeNull()
  })

  it('反斜杠按分隔符处理', () => {
    expect(resolveRelativePath('', 'notes\\b.md')).toBe('notes/b.md')
  })

  it('取所在目录', () => {
    expect(dirnameOf('notes/a.md')).toBe('notes')
    expect(dirnameOf('notes/sub/a.md')).toBe('notes/sub')
    expect(dirnameOf('a.md')).toBe('')
  })
})

describe('externalSchemeOf', () => {
  it('认出常见外部协议', () => {
    expect(externalSchemeOf('https://a.com')).toBe('https')
    expect(externalSchemeOf('mailto:a@b.com')).toBe('mailto')
  })

  it('file 与盘符不算外链', () => {
    expect(externalSchemeOf('file:///C:/x.md')).toBeNull()
    expect(externalSchemeOf('C:/notes/a.md')).toBeNull()
    expect(externalSchemeOf('C:\\notes\\a.md')).toBeNull()
    expect(externalSchemeOf('notes/a.md')).toBeNull()
  })
})

describe('resolveLink：命中路径', () => {
  it('同目录相对路径', () => {
    const resolved = resolveLink('b.md', makeCtx({ from: 'notes/a.md', indexed: ['notes/b.md'] }))

    expect(resolved).toEqual({ kind: 'edge', targetId: 'notes/b.md' })
  })

  it('上跳一级', () => {
    const resolved = resolveLink('../root.md', makeCtx({ from: 'notes/a.md', indexed: ['root.md'] }))

    expect(resolved).toEqual({ kind: 'edge', targetId: 'root.md' })
  })

  it('无扩展名时依次补 .mdx / .md', () => {
    expect(
      resolveLink('b', makeCtx({ from: 'notes/a.md', indexed: ['notes/b.md'] }))
    ).toEqual({ kind: 'edge', targetId: 'notes/b.md' })

    expect(
      resolveLink('b', makeCtx({ from: 'notes/a.md', indexed: ['notes/b.mdx'] }))
    ).toEqual({ kind: 'edge', targetId: 'notes/b.mdx' })
  })

  it('剥离 fragment 与 query', () => {
    const ctx = makeCtx({ from: 'notes/a.md', indexed: ['notes/b.md'] })

    expect(resolveLink('b.md#小节', ctx)).toEqual({ kind: 'edge', targetId: 'notes/b.md' })
    expect(resolveLink('b.md?x=1', ctx)).toEqual({ kind: 'edge', targetId: 'notes/b.md' })
  })

  it('百分号编码先解码再查找', () => {
    const resolved = resolveLink('my%20notes/b.md', makeCtx({ indexed: ['my notes/b.md'] }))

    expect(resolved).toEqual({ kind: 'edge', targetId: 'my notes/b.md' })
  })

  it('file:// 绝对路径走 basename 兜底', () => {
    const resolved = resolveLink(
      'file:///C:/ws/notes/b.md',
      makeCtx({ from: 'notes/a.md', indexed: ['notes/b.md'] })
    )

    expect(resolved).toEqual({ kind: 'edge', targetId: 'notes/b.md' })
  })

  it('大小写不敏感时折叠 id', () => {
    const resolved = resolveLink(
      'b.md',
      makeCtx({ from: 'Notes/A.md', indexed: ['notes/B.md'], caseInsensitive: true })
    )

    expect(resolved).toEqual({ kind: 'edge', targetId: 'notes/b.md' })
  })
})

describe('resolveLink：basename 兜底', () => {
  it('路径算错但文件名唯一命中，仍然成边', () => {
    const resolved = resolveLink(
      'wrong/dir/b.md',
      makeCtx({ from: 'a.md', indexed: ['notes/b.md'] })
    )

    // 无歧义时结果里不该出现 ambiguous：它只是实现层给 warnings 的附加信息
    expect(resolved).toEqual({ kind: 'edge', targetId: 'notes/b.md' })
  })

  it('同名多个取路径最短者并标歧义', () => {
    const resolved = resolveLink(
      'wrong/b.md',
      makeCtx({ from: 'x/a.md', indexed: ['notes/b.md', 'b.md'] })
    )

    expect(resolved).toEqual({ kind: 'edge', targetId: 'b.md', ambiguous: true })
  })
})

describe('resolveLink：忽略与断链', () => {
  it('外链忽略', () => {
    expect(resolveLink('https://example.com', makeCtx())).toEqual({
      kind: 'ignore',
      reason: 'external'
    })
  })

  it('纯锚点忽略', () => {
    expect(resolveLink('#小节', makeCtx())).toEqual({ kind: 'ignore', reason: 'anchor' })
    expect(resolveLink('', makeCtx())).toEqual({ kind: 'ignore', reason: 'anchor' })
  })

  it('越出工作区根忽略', () => {
    expect(resolveLink('../../x.md', makeCtx({ from: 'a.md' }))).toEqual({
      kind: 'ignore',
      reason: 'escape'
    })
  })

  it('白名单外的扩展名忽略（图片/附件不是文档）', () => {
    expect(resolveLink('assets/images/a.png', makeCtx())).toEqual({
      kind: 'ignore',
      reason: 'not-indexed'
    })
  })

  it('TC-RESOLVE-015 非文档文件真实存在时解析成附件叶子节点', () => {
    const ctx = makeCtx({ from: 'docs/a.md', attachments: ['docs/scripts/deploy.sh'] })
    expect(resolveLink('scripts/deploy.sh', ctx)).toEqual({
      kind: 'attachment',
      targetId: 'docs/scripts/deploy.sh',
      targetPath: 'docs/scripts/deploy.sh'
    })
  })

  it('TC-RESOLVE-016 非文档文件不存在时仍然忽略，不制造假断链', () => {
    // `.gitignore` 这类点开头的文件在遍历时就被排除了，把它报成断链是误报
    const ctx = makeCtx({ from: 'docs/a.md', attachments: ['docs/scripts/deploy.sh'] })
    expect(resolveLink('scripts/missing.sh', ctx)).toEqual({
      kind: 'ignore',
      reason: 'not-indexed'
    })
    expect(resolveLink('.gitignore', ctx)).toEqual({ kind: 'ignore', reason: 'not-indexed' })
  })

  it('TC-RESOLVE-017 没有附件集合时退化为忽略（保持加入附件节点之前的行为）', () => {
    expect(resolveLink('scripts/deploy.sh', makeCtx())).toEqual({
      kind: 'ignore',
      reason: 'not-indexed'
    })
  })

  it('TC-RESOLVE-018 附件 id 大小写跟随文件系统折叠，路径保留真实大小写', () => {
    const ctx = makeCtx({
      from: 'a.md',
      attachments: ['scripts/Deploy.SH'],
      caseInsensitive: true
    })
    expect(resolveLink('scripts/deploy.sh', ctx)).toEqual({
      kind: 'attachment',
      targetId: 'scripts/deploy.sh',
      targetPath: 'scripts/Deploy.SH'
    })
  })

  it('文件存在但被限额跳过时算忽略，不算断链', () => {
    expect(resolveLink('skipped.md', makeCtx({ known: ['skipped.md'] }))).toEqual({
      kind: 'ignore',
      reason: 'not-indexed'
    })
  })

  it('真的不存在才是断链，幽灵 id 以 ! 开头', () => {
    expect(resolveLink('missing.md', makeCtx({ from: 'notes/a.md' }))).toEqual({
      kind: 'unresolved',
      ghostId: '!notes/missing.md',
      display: 'missing.md',
      targetPath: 'notes/missing.md'
    })
  })

  it('不同来源指向同一个失效目标时合并成同一个幽灵节点', () => {
    const fromNotes = resolveLink('missing.md', makeCtx({ from: 'notes/a.md' }))
    const fromRoot = resolveLink('notes/missing.md', makeCtx({ from: 'a.md' }))

    expect(fromNotes.kind).toBe('unresolved')
    expect(fromRoot.kind).toBe('unresolved')
    if (fromNotes.kind !== 'unresolved' || fromRoot.kind !== 'unresolved') return
    expect(fromNotes.ghostId).toBe(fromRoot.ghostId)
  })
})

describe('encodeLinkTarget：写回正文的路径必须能解析回来', () => {
  it('同目录', () => {
    expect(encodeLinkTarget('notes/a.md', 'notes/b.md')).toBe('b.md')
  })

  it('下跳与上跳', () => {
    expect(encodeLinkTarget('a.md', 'notes/b.md')).toBe('notes/b.md')
    expect(encodeLinkTarget('notes/a.md', 'root.md')).toBe('../root.md')
  })

  it('空格转义、中文保留', () => {
    expect(encodeLinkTarget('a.md', 'my notes/b.md')).toBe('my%20notes/b.md')
    // 设计 §4.6：中文保留原文，不做百分号转码（否则源码与 diff 不可读）
    expect(encodeLinkTarget('a.md', '笔记/目标.md')).toBe('笔记/目标.md')
  })

  it('只转义会破坏语法的字符', () => {
    // `#`/`?` 不转会被当成 fragment / query 剥掉
    expect(encodeLinkTarget('a.md', 'a#b.md')).toBe('a%23b.md')
    expect(encodeLinkTarget('a.md', 'a?b.md')).toBe('a%3Fb.md')
    // `%` 必须先转，否则文件名里本就有的 `%20` 会被解码成空格
    expect(encodeLinkTarget('a.md', 'a%20b.md')).toBe('a%2520b.md')
    // 尖括号目标语法
    expect(encodeLinkTarget('a.md', 'a<b>.md')).toBe('a%3Cb%3E.md')
    // `(` `)` 等常规字符保持原文
    expect(encodeLinkTarget('a.md', 'notes (v2)/b.md')).toBe('notes%20(v2)/b.md')
  })

  it('写出去的解码后能解析回原目标', () => {
    const target = 'my notes/目标.md'
    const encoded = encodeLinkTarget('notes/a.md', target)
    const resolved = resolveLink(encoded, makeCtx({ from: 'notes/a.md', indexed: [target] }))

    expect(resolved).toEqual({ kind: 'edge', targetId: target })
  })

  it('含空格的路径往返一致', () => {
    const target = 'my notes/b.md'
    const encoded = encodeLinkTarget('a.md', target)

    expect(resolveLink(encoded, makeCtx({ from: 'a.md', indexed: [target] }))).toEqual({
      kind: 'edge',
      targetId: target
    })
  })

  it('含 `#` 的路径往返一致（不被当成 fragment 剥掉）', () => {
    const target = 'notes/a#1.md'
    const encoded = encodeLinkTarget('a.md', target)

    expect(encoded).toContain('%23')
    expect(resolveLink(encoded, makeCtx({ from: 'a.md', indexed: [target] }))).toEqual({
      kind: 'edge',
      targetId: target
    })
  })

  it('含 `%` 的路径往返一致（% 不被二次解码）', () => {
    const target = 'notes/100%.md'
    const encoded = encodeLinkTarget('a.md', target)

    // `%` → `%25`；若漏转，解码后会把后续字符当转义序列吞掉
    expect(encoded).toBe('notes/100%25.md')
    expect(resolveLink(encoded, makeCtx({ from: 'a.md', indexed: [target] }))).toEqual({
      kind: 'edge',
      targetId: target
    })
  })

  it('文件名里本就写着 %20 时往返不变成空格', () => {
    const target = 'notes/a%20b.md'
    const encoded = encodeLinkTarget('a.md', target)

    expect(encoded).toBe('notes/a%2520b.md')
    // 关键：不能被解成 'notes/a b.md'
    expect(resolveLink(encoded, makeCtx({ from: 'a.md', indexed: [target] }))).toEqual({
      kind: 'edge',
      targetId: target
    })
  })

  it('中文目录与空格混合时往返一致', () => {
    const target = '笔记/我的 目标.md'
    const encoded = encodeLinkTarget('src/a.md', target)

    expect(encoded).toBe('../笔记/我的%20目标.md')
    expect(resolveLink(encoded, makeCtx({ from: 'src/a.md', indexed: [target] }))).toEqual({
      kind: 'edge',
      targetId: target
    })
  })
})
