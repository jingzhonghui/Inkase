import { describe, expect, it } from 'vitest'
import { buildLinkIndex, normalizeName, resolveLink } from '../link-resolver'

const index = buildLinkIndex(['a.md', 'dir/a.mdx', 'dir/b.md', 'dir2/b.md', 'z.md'], {
  'z.md': ['Z 的别名', '简称']
})

describe('normalizeName', () => {
  it('normalizes separators, whitespace and case', () => {
    expect(normalizeName('  Dir\\A  B ')).toBe('dir/a b')
  })

  it('returns an empty string for blank input', () => {
    expect(normalizeName('   ')).toBe('')
  })
})

describe('resolveLink', () => {
  it('resolves by exact path, with extension', () => {
    expect(resolveLink('dir/a.mdx', index)).toEqual({ status: 'resolved', targetPath: 'dir/a.mdx' })
  })

  it('resolves by exact path, without extension', () => {
    expect(resolveLink('dir/a', index)).toEqual({ status: 'resolved', targetPath: 'dir/a.mdx' })
  })

  it('resolves by basename when it is unique', () => {
    expect(resolveLink('z', index)).toEqual({ status: 'resolved', targetPath: 'z.md' })
  })

  it('reports ambiguous when a basename matches several files', () => {
    const result = resolveLink('b', index)

    expect(result.status).toBe('ambiguous')
    expect(result.status === 'ambiguous' && result.candidates).toEqual(['dir/b.md', 'dir2/b.md'])
  })

  it('reports missing for unknown targets', () => {
    expect(resolveLink('没有这个', index)).toEqual({ status: 'missing' })
  })

  it('resolves by alias, case-insensitively and ignoring surrounding blanks', () => {
    expect(resolveLink('简称', index)).toEqual({ status: 'resolved', targetPath: 'z.md' })
    expect(resolveLink('  Z 的别名 ', index)).toEqual({ status: 'resolved', targetPath: 'z.md' })
  })

  it('prefers an exact path over a basename collision', () => {
    expect(resolveLink('dir/b', index)).toEqual({ status: 'resolved', targetPath: 'dir/b.md' })
  })

  it('resolves an empty target to the current file when known', () => {
    expect(resolveLink('', index, 'z.md')).toEqual({ status: 'resolved', targetPath: 'z.md' })
  })

  it('reports missing for an empty target without a known current file', () => {
    expect(resolveLink('', index)).toEqual({ status: 'missing' })
    expect(resolveLink('', index, '不存在.md')).toEqual({ status: 'missing' })
  })

  it('ignores empty aliases when building the index', () => {
    const withEmpty = buildLinkIndex(['a.md'], { 'a.md': ['', '  '] })

    expect(resolveLink('', withEmpty, 'a.md')).toEqual({ status: 'resolved', targetPath: 'a.md' })
  })

  it('handles an index with no files', () => {
    expect(resolveLink('anything', buildLinkIndex([]))).toEqual({ status: 'missing' })
  })
})
