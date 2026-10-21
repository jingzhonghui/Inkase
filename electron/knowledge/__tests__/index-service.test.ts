import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeKind } from '../../../shared/knowledge/types'
import { readTextCache } from '../index-store'
import { KnowledgeIndexService, classifyKind, parseInlineTags } from '../index-service'

let root: string

function writeFile(rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-svc-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('classifyKind', () => {
  it('maps extensions to node kinds case-insensitively', () => {
    expect(classifyKind('a.md')).toBe('md')
    expect(classifyKind('a.MDX')).toBe('mdx')
    expect(classifyKind('a.PDF')).toBe('pdf')
    expect(classifyKind('a.docx')).toBe('office')
    expect(classifyKind('a.png')).toBe('image')
    expect(classifyKind('a.ts')).toBe('other')
  })
})

describe('parseInlineTags', () => {
  it('ignores headings, url fragments and code spans', () => {
    const tags = parseInlineTags('# 标题\n\n见 https://x.test/a#frag 与 #真标签\n\n`#no`\n')

    expect(tags.map((item) => item.tag)).toEqual(['真标签'])
    expect(tags[0].line).toBe(3)
  })

  it('ignores tags inside fenced code blocks', () => {
    expect(parseInlineTags('```\n#notatag\n```\n\n#realtag\n').map((item) => item.tag)).toEqual(['realtag'])
  })
})

describe('KnowledgeIndexService', () => {
  it('indexes links, tags and backlinks', async () => {
    writeFile('note-a.md', '# A\n\n见 [[note-b]] 与 [[缺失]]\n\n#inline\n')
    writeFile('note-b.md', '# B\n\nnote-a 只是提及\n')

    const service = new KnowledgeIndexService(root)
    const index = await service.build()

    const refs = index.outgoing['note-a.md']
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({ to: 'note-b.md', status: 'resolved', line: 3, kind: 'link' })
    expect(refs[1]).toMatchObject({ status: 'missing', target: '缺失', line: 3 })
    expect(index.unresolved).toHaveLength(1)
    expect(index.tags['inline']).toEqual(['note-a.md'])

    const linked = service.queryBacklinks('note-b.md')
    expect(linked).toContainEqual(expect.objectContaining({ path: 'note-a.md', line: 3, kind: 'linked' }))

    const unlinked = service.queryBacklinks('note-a.md')
    expect(unlinked).toContainEqual(expect.objectContaining({ path: 'note-b.md', line: 3, kind: 'unlinked' }))
  })

  it('marks ambiguous links and lists candidates', async () => {
    writeFile('dup-a/dup.md', '# dup a\n')
    writeFile('dup-b/dup.md', '# dup b\n')
    writeFile('a.md', '[[dup]]\n')

    const index = await new KnowledgeIndexService(root).build()
    const ref = index.outgoing['a.md'][0]

    expect(ref.status).toBe('ambiguous')
    expect(ref.to).toBeUndefined()
    expect(ref.candidates).toEqual(['dup-a/dup.md', 'dup-b/dup.md'])
    expect(index.unresolved).toHaveLength(1)
  })

  it('reuses unchanged files on the next build', async () => {
    writeFile('doc.mdx', 'x')
    writeFile('note-b.md', '# B\n')

    let calls = 0
    const service = new KnowledgeIndexService(root, {
      extractText: async () => {
        calls++
        return '内容 [[note-b]]'
      }
    })

    const first = await service.build()
    expect(calls).toBe(1)
    expect(first.outgoing['doc.mdx'][0]).toMatchObject({ to: 'note-b.md', status: 'resolved' })

    const second = await service.build()
    expect(calls).toBe(1)
    expect(second.outgoing['doc.mdx'][0]).toMatchObject({ to: 'note-b.md', status: 'resolved' })

    writeFile('doc.mdx', 'longer content')
    await service.build()
    expect(calls).toBe(2)
  })

  it('records a per-file error and keeps indexing the rest', async () => {
    writeFile('ok.md', '# ok\n')
    writeFile('broken.mdx', 'x')

    const service = new KnowledgeIndexService(root, {
      extractText: async (abs) => {
        if (abs.endsWith('broken.mdx')) throw new Error('解包失败')
        return ''
      }
    })
    const index = await service.build()

    expect(service.getStatus().state).toBe('ready')
    expect(index.errors).toHaveLength(1)
    expect(index.errors[0]).toMatchObject({ path: 'broken.mdx', message: '解包失败' })
    expect(index.files['ok.md']).toBeDefined()
    expect(index.files['broken.mdx']).toBeUndefined()
  })

  it('degrades instead of throwing when the root cannot be scanned', async () => {
    const service = new KnowledgeIndexService(path.join(root, '不存在'))
    const index = await service.build()

    expect(service.getStatus().state).toBe('degraded')
    expect(index.meta.fileCount).toBe(0)
    expect(index.errors).toHaveLength(1)
  })

  it('skips hidden entries and node_modules', async () => {
    writeFile('keep.md', '# keep\n')
    writeFile('.hidden.md', '# hidden\n')
    writeFile('.inkase/note.md', '# private\n')
    writeFile('node_modules/pkg/a.md', '# dep\n')
    writeFile('.git/COMMIT_EDITMSG', 'x')

    const index = await new KnowledgeIndexService(root).build()

    expect(Object.keys(index.files)).toEqual(['keep.md'])
  })

  it('classifies kinds and does not extract text for binary nodes', async () => {
    writeFile('a.md', '# a\n')
    writeFile('b.mdx', 'x')
    writeFile('c.pdf', 'pdf')
    writeFile('d.png', 'png')
    writeFile('e.docx', 'docx')
    writeFile('f.ts', 'const a = 1')

    const extracted: NodeKind[] = []
    const service = new KnowledgeIndexService(root, {
      extractText: async (_abs, kind) => {
        extracted.push(kind)
        return ''
      }
    })
    const index = await service.build()

    expect(index.files['a.md'].kind).toBe('md')
    expect(index.files['b.mdx'].kind).toBe('mdx')
    expect(index.files['c.pdf'].kind).toBe('pdf')
    expect(index.files['d.png'].kind).toBe('image')
    expect(index.files['e.docx'].kind).toBe('office')
    expect(index.files['f.ts'].kind).toBe('other')
    expect(extracted.sort()).toEqual(['mdx', 'office'])
  })

  it('caches extracted text for non-markdown nodes', async () => {
    writeFile('b.mdx', 'x')

    const service = new KnowledgeIndexService(root, { extractText: async () => '抽取出来的正文' })
    const index = await service.build()

    expect(readTextCache(root, index.files['b.mdx'].hash)).toBe('抽取出来的正文')
  })

  it('does not count a mention that is already written as a link', async () => {
    writeFile('note-b.md', '# B\n')
    writeFile('note-a.md', '[[note-b]] 与 note-b\n')

    const index = await new KnowledgeIndexService(root).build()

    expect(index.mentions['note-a.md']).toHaveLength(1)
    expect(index.mentions['note-a.md'][0]).toMatchObject({ targetPath: 'note-b.md', line: 1 })
  })

  it('never lists a file as its own unlinked mention', async () => {
    writeFile('note-a.md', 'note-a 提到自己\n')

    const index = await new KnowledgeIndexService(root).build()

    expect(index.mentions['note-a.md']).toEqual([])
  })

  it('reads frontmatter tags and ignores tags in code', async () => {
    writeFile('a.md', '---\ntags: [alpha, beta]\n---\n\n```\n#notatag\n```\n\n`#nocode` #realtag\n')

    const index = await new KnowledgeIndexService(root).build()

    expect(Object.keys(index.tags).sort()).toEqual(['alpha', 'beta', 'realtag'])
    expect(index.tags['realtag']).toEqual(['a.md'])
  })

  it('counts links written in frontmatter values', async () => {
    writeFile('note-b.md', '# B\n')
    writeFile('fm.md', '---\nrelated: "[[note-b]]"\n---\n\n正文\n')

    const index = await new KnowledgeIndexService(root).build()

    expect(index.outgoing['fm.md'][0]).toMatchObject({ to: 'note-b.md', status: 'resolved', line: 2 })
  })

  it('reports progress phases and ends ready', async () => {
    writeFile('a.md', '# a\n')

    const observed: Array<{ phase: string; state: string }> = []
    const service = new KnowledgeIndexService(root, {
      onProgress: (progress) => observed.push({ phase: progress.phase, state: service.getStatus().state })
    })
    expect(service.getStatus().state).toBe('idle')

    await service.build()

    expect(observed.map((item) => item.phase)).toEqual(['scan', 'parse', 'parse', 'write', 'idle'])
    expect(observed.slice(0, -1).every((item) => item.state === 'building')).toBe(true)
    expect(service.getStatus()).toMatchObject({ state: 'ready', fileCount: 1 })
    expect(service.getStatus().progress.phase).toBe('idle')
  })

  it('orders tags by usage count', async () => {
    writeFile('a.md', '---\ntags: [x]\n---\n\n# A\n')
    writeFile('b.md', '---\ntags: [x]\n---\n')

    const service = new KnowledgeIndexService(root)
    await service.build()

    expect(service.queryTags()).toEqual([{ tag: 'x', count: 2 }])
    expect(service.queryNotesByTag('x')).toEqual(['a.md', 'b.md'])
    expect(service.queryNotesByTag('nope')).toEqual([])
  })

  it('loads a persisted index without rebuilding', async () => {
    writeFile('a.md', '# A\n')

    await new KnowledgeIndexService(root).build()

    const fresh = new KnowledgeIndexService(root)
    expect(fresh.getIndex()).toBeNull()
    expect(fresh.load()).not.toBeNull()
    expect(fresh.getStatus().state).toBe('ready')
    expect(fresh.queryBacklinks('a.md')).toEqual([])
  })

  it('exposes an empty result before the first build', async () => {
    const service = new KnowledgeIndexService(root)

    expect(service.getIndex()).toBeNull()
    expect(service.queryBacklinks('a.md')).toEqual([])
    expect(service.queryTags()).toEqual([])
  })
})
