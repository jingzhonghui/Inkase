import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LinkRef } from '../../../shared/knowledge/types'
import { buildPathMap, buildRenameMap, planRewrite, rewriteVault } from '../ref-rewriter'

const map = new Map([['old', 'new']])

let root: string

function writeFile(rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-rewrite-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('planRewrite', () => {
  it('rewrites a plain wikilink', () => {
    expect(planRewrite('[[old]]', map)).toEqual({ text: '[[new]]', changes: 1 })
  })

  it('keeps the alias', () => {
    expect(planRewrite('[[old|别名]]', map).text).toBe('[[new|别名]]')
  })

  it('keeps the anchor', () => {
    expect(planRewrite('[[old#标题]]', map).text).toBe('[[new#标题]]')
  })

  it('keeps anchor and alias together', () => {
    expect(planRewrite('[[old#标题|别名]]', map).text).toBe('[[new#标题|别名]]')
  })

  it('keeps the embed prefix', () => {
    expect(planRewrite('![[old]]', map).text).toBe('![[new]]')
  })

  it('leaves fenced code untouched', () => {
    expect(planRewrite('```\n[[old]]\n```', map)).toEqual({ text: '```\n[[old]]\n```', changes: 0 })
  })

  it('leaves inline code untouched', () => {
    expect(planRewrite('`[[old]]` 但 [[old]]', map)).toEqual({ text: '`[[old]]` 但 [[new]]', changes: 1 })
  })

  it('rewrites every occurrence', () => {
    expect(planRewrite('[[old]] 与 [[old]]', map)).toEqual({ text: '[[new]] 与 [[new]]', changes: 2 })
  })

  it('rewrites mixed forms on one line', () => {
    expect(planRewrite('[[old]] 和 [[old|x]]', map)).toEqual({ text: '[[new]] 和 [[new|x]]', changes: 2 })
  })

  it('handles a link at the very start and at the very end', () => {
    expect(planRewrite('[[old]]中间[[old]]', map).text).toBe('[[new]]中间[[new]]')
  })

  it('returns the input unchanged for an empty map', () => {
    expect(planRewrite('[[old]]', new Map())).toEqual({ text: '[[old]]', changes: 0 })
  })

  it('does not rewrite unrelated links', () => {
    expect(planRewrite('[[other]]', map)).toEqual({ text: '[[other]]', changes: 0 })
  })

  it('does not rewrite when the new target equals the old one', () => {
    expect(planRewrite('[[old]]', new Map([['old', 'old']]))).toEqual({ text: '[[old]]', changes: 0 })
  })

  it('preserves surrounding whitespace and other lines byte for byte', () => {
    const text = '# 标题\n\n  见 [[old]] 。\n'
    expect(planRewrite(text, map).text).toBe('# 标题\n\n  见 [[new]] 。\n')
  })
})

describe('rewriteVault', () => {
  it('rewrites matching files and reports the change count', async () => {
    writeFile('a.md', '见 [[old]] 和 [[old]]\n')
    writeFile('b.md', '见 [[old]]\n')
    writeFile('c.md', '无关内容\n')

    const plan = await rewriteVault(root, map)

    expect(plan.changes).toEqual([
      { path: 'a.md', count: 2 },
      { path: 'b.md', count: 1 }
    ])
    expect(plan.errors).toEqual([])
    expect(readFile('a.md')).toBe('见 [[new]] 和 [[new]]\n')
    expect(readFile('b.md')).toBe('见 [[new]]\n')
    expect(readFile('c.md')).toBe('无关内容\n')
  })

  it('does not touch files without matches', async () => {
    writeFile('c.md', '无关内容\n')

    const plan = await rewriteVault(root, map)

    expect(plan.changes).toEqual([])
    expect(plan.edits).toEqual([])
    expect(readFile('c.md')).toBe('无关内容\n')
  })

  it('does not write anything in dryRun mode', async () => {
    writeFile('a.md', '见 [[old]]\n')

    const plan = await rewriteVault(root, map, { dryRun: true })

    expect(plan.changes).toEqual([{ path: 'a.md', count: 1 }])
    expect(plan.edits).toEqual([{ path: 'a.md', text: '见 [[new]]\n' }])
    expect(readFile('a.md')).toBe('见 [[old]]\n')
  })

  it('honours the only list', async () => {
    writeFile('a.md', '见 [[old]]\n')
    writeFile('b.md', '见 [[old]]\n')

    const plan = await rewriteVault(root, map, { only: ['b.md'] })

    expect(plan.changes).toEqual([{ path: 'b.md', count: 1 }])
    expect(readFile('a.md')).toBe('见 [[old]]\n')
    expect(readFile('b.md')).toBe('见 [[new]]\n')
  })

  it('skips hidden directories by default', async () => {
    writeFile('.inkase/note.md', '见 [[old]]\n')
    writeFile('node_modules/pkg/a.md', '见 [[old]]\n')

    const plan = await rewriteVault(root, map)

    expect(plan.changes).toEqual([])
  })

  it('uses injected adapters so .mdx can be rewritten', async () => {
    writeFile('doc.mdx', 'x')
    const written: Array<{ rel: string; text: string }> = []

    const plan = await rewriteVault(root, map, {
      readText: async (_abs, rel) => (rel === 'doc.mdx' ? '内容 [[old]]' : null),
      writeText: async (_abs, rel, text) => {
        written.push({ rel, text })
      }
    })

    expect(plan.changes).toEqual([{ path: 'doc.mdx', count: 1 }])
    expect(written).toEqual([{ rel: 'doc.mdx', text: '内容 [[new]]' }])
  })

  it('records a read failure and keeps going', async () => {
    writeFile('a.md', '见 [[old]]\n')
    writeFile('bad.md', '见 [[old]]\n')

    const plan = await rewriteVault(root, map, {
      readText: async (_abs, rel) => {
        if (rel === 'bad.md') throw new Error('读取失败')
        return fs.promises.readFile(path.join(root, rel), 'utf-8')
      }
    })

    expect(plan.errors).toEqual([{ path: 'bad.md', message: '读取失败' }])
    expect(plan.changes).toEqual([{ path: 'a.md', count: 1 }])
  })

  it('skips .mdx by default because it needs unpacking', async () => {
    writeFile('doc.mdx', '见 [[old]]\n')

    const plan = await rewriteVault(root, map)

    expect(plan.changes).toEqual([])
    expect(plan.errors).toEqual([])
  })

  it('returns an empty plan for an empty map', async () => {
    writeFile('a.md', '见 [[old]]\n')

    expect(await rewriteVault(root, new Map())).toEqual({ changes: [], edits: [], errors: [] })
  })

  it('reports progress', async () => {
    writeFile('a.md', '见 [[old]]\n')
    writeFile('b.md', '见 [[old]]\n')

    const seen: Array<[number, number]> = []
    await rewriteVault(root, map, { onProgress: (done, total) => seen.push([done, total]) })

    expect(seen).toEqual([
      [1, 2],
      [2, 2]
    ])
  })

  it('reports a scan failure when the root is missing', async () => {
    const plan = await rewriteVault(path.join(root, '不存在'), map)

    expect(plan.changes).toEqual([])
    expect(plan.errors).toHaveLength(1)
  })
})

describe('buildRenameMap', () => {
  function ref(target: string, to: string): LinkRef {
    return {
      from: 'a.md',
      raw: `[[${target}]]`,
      target,
      to,
      kind: 'link',
      line: 1,
      column: 1,
      status: 'resolved'
    }
  }

  const from = 'dir/note-b.md'
  const to = 'dir/note-c.md'

  it('maps every written form of the renamed file', () => {
    const outgoing = {
      'a.md': [ref('note-b', from), ref('dir/note-b', from), ref('dir/note-b.md', from)]
    }
    const result = buildRenameMap(from, to, outgoing)

    expect(result.get('note-b')).toBe('note-c')
    expect(result.get('dir/note-b')).toBe('dir/note-c')
    expect(result.get('dir/note-b.md')).toBe('dir/note-c.md')
  })

  it('ignores references that resolve to another file', () => {
    const outgoing = { 'a.md': [ref('other', 'other.md')] }

    expect(buildRenameMap(from, to, outgoing).size).toBe(0)
  })

  it('ignores unresolved references', () => {
    const outgoing = { 'a.md': [{ ...ref('note-b', from), status: 'ambiguous' as const }] }

    expect(buildRenameMap(from, to, outgoing).size).toBe(0)
  })

  it('does not rewrite alias references', () => {
    const outgoing = { 'a.md': [ref('简称', from)] }

    expect(buildRenameMap(from, to, outgoing).size).toBe(0)
  })

  it('updates the directory part when the file moves', () => {
    const outgoing = { 'a.md': [ref('old/note-b', 'old/note-b.md')] }

    expect(buildRenameMap('old/note-b.md', 'new/note-b.md', outgoing).get('old/note-b')).toBe('new/note-b')
  })

  it('follows an extension change', () => {
    const outgoing = { 'a.md': [ref('note-b.md', from)] }

    expect(buildRenameMap(from, 'dir/note-c.mdx', outgoing).get('note-b.md')).toBe('note-c.mdx')
  })
})

describe('planRewrite with markdown relative links', () => {
  const emptyMap = new Map<string, string>()
  const pathMap = buildPathMap([{ from: 'old/note.md', to: 'new/note.md' }])

  it('recomputes a link relative to the referencing file', () => {
    expect(planRewrite('[文本](old/note.md)\n', emptyMap, { from: 'a.md', pathMap })).toEqual({
      text: '[文本](new/note.md)\n',
      changes: 1
    })
  })

  it('recomputes a link from a subdirectory', () => {
    const out = planRewrite('[文本](../old/note.md)\n', emptyMap, { from: 'sub/x.md', pathMap })

    expect(out.text).toBe('[文本](../new/note.md)\n')
  })

  it('keeps the anchor', () => {
    const out = planRewrite('[x](old/note.md#标题)', emptyMap, { from: 'a.md', pathMap })

    expect(out.text).toBe('[x](new/note.md#标题)')
  })

  it('keeps the link title', () => {
    const out = planRewrite('[x](old/note.md "标题")', emptyMap, { from: 'a.md', pathMap })

    expect(out.text).toBe('[x](new/note.md "标题")')
  })

  it('ignores links that point elsewhere', () => {
    expect(planRewrite('[x](other.md)', emptyMap, { from: 'a.md', pathMap }).changes).toBe(0)
  })

  it('does nothing without knowing the referencing file', () => {
    expect(planRewrite('[x](old/note.md)', emptyMap, { pathMap }).changes).toBe(0)
  })

  it('rewrites both link kinds in one pass', () => {
    const out = planRewrite('[[old]] 与 [x](old/note.md)\n', map, { from: 'a.md', pathMap })

    expect(out.text).toBe('[[new]] 与 [x](new/note.md)\n')
    expect(out.changes).toBe(2)
  })

  it('rewrites a file that only has a relative link', async () => {
    writeFile('a.md', '[文本](old/note.md)\n')

    const plan = await rewriteVault(root, emptyMap, { pathMap })

    expect(plan.changes).toEqual([{ path: 'a.md', count: 1 }])
    expect(readFile('a.md')).toBe('[文本](new/note.md)\n')
  })
})
