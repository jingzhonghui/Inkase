import { describe, expect, it } from 'vitest'
import { parseFrontmatter, readField, readList, setFrontmatterField } from '../frontmatter'

const doc = [
  '---',
  'title: A',
  'tags: [x, y]',
  'aliases:',
  '  - 别名一',
  '  - 别名二',
  '# 注释保留',
  'custom: keepme',
  '---',
  '',
  '# 正文'
].join('\n')

describe('parseFrontmatter', () => {
  it('parses tags, aliases and unknown fields', () => {
    const fm = parseFrontmatter(doc)!

    expect(readList(fm, 'tags')).toEqual(['x', 'y'])
    expect(readList(fm, 'aliases')).toEqual(['别名一', '别名二'])
    expect(readField(fm, 'custom')).toBe('keepme')
    expect(readField(fm, 'title')).toBe('A')
  })

  it('splits the raw frontmatter from the body', () => {
    const fm = parseFrontmatter(doc)!

    expect(fm.raw.startsWith('---\n')).toBe(true)
    expect(fm.raw.endsWith('---\n')).toBe(true)
    // 不变式：raw + 正文 = 原文
    expect(fm.raw + doc.slice(fm.bodyOffset)).toBe(doc)
    expect(doc.slice(fm.bodyOffset).trimStart().startsWith('# 正文')).toBe(true)
  })

  it('returns null when there is no frontmatter', () => {
    expect(parseFrontmatter('# just a heading')).toBeNull()
  })

  it('returns null when the closing delimiter is missing', () => {
    expect(parseFrontmatter('---\ntitle: A\n\n# 正文')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseFrontmatter('')).toBeNull()
  })

  it('handles BOM and CRLF without breaking parsing', () => {
    const withBom = `\uFEFF${doc}`
    expect(readList(parseFrontmatter(withBom)!, 'tags')).toEqual(['x', 'y'])

    const crlf = doc.replace(/\n/g, '\r\n')
    const fm = parseFrontmatter(crlf)!
    expect(readList(fm, 'tags')).toEqual(['x', 'y'])
    expect(readList(fm, 'aliases')).toEqual(['别名一', '别名二'])
    expect(fm.raw + crlf.slice(fm.bodyOffset)).toBe(crlf)
  })

  it('treats an empty scalar as an empty list', () => {
    const fm = parseFrontmatter('---\ntags:\n---\n正文')!
    expect(readList(fm, 'tags')).toEqual([])
  })

  it('returns an empty list for a missing field', () => {
    expect(readList(parseFrontmatter(doc)!, 'nope')).toEqual([])
  })
})

describe('setFrontmatterField', () => {
  it('keeps unknown fields, comments and order when setting a known field', () => {
    const next = setFrontmatterField(doc, 'source', 'https://x')

    expect(next).toContain('# 注释保留')
    expect(next).toContain('custom: keepme')
    expect(next).toContain('source: https://x')
    // 新字段插入在闭合分隔符之前
    expect(next.indexOf('custom: keepme')).toBeLessThan(next.indexOf('---', 4))
    expect(next.endsWith('# 正文')).toBe(true)
    // 原有字段未被破坏
    expect(readList(parseFrontmatter(next)!, 'aliases')).toEqual(['别名一', '别名二'])
  })

  it('does not quote a plain URL', () => {
    expect(setFrontmatterField(doc, 'source', 'https://x')).toContain('source: https://x')
  })

  it('quotes a value that would be invalid YAML', () => {
    expect(setFrontmatterField(doc, 'source', '[a, b]')).toContain('source: "[a, b]"')
  })

  it('replaces an existing field instead of duplicating it', () => {
    const next = setFrontmatterField(doc, 'title', 'B')
    expect(next).toContain('title: B')
    expect(next).not.toContain('title: A')
    expect(next.match(/title:/g)).toHaveLength(1)
  })

  it('converts a scalar into a block list', () => {
    const next = setFrontmatterField(doc, 'title', ['B', 'C'])
    expect(readList(parseFrontmatter(next)!, 'title')).toEqual(['B', 'C'])
    expect(next).toContain('# 注释保留')
  })

  it('inserts a frontmatter block when the file has none', () => {
    const next = setFrontmatterField('# 正文', 'tags', ['a'])

    expect(next.startsWith('---\n')).toBe(true)
    expect(next.endsWith('# 正文')).toBe(true)
    expect(readList(parseFrontmatter(next)!, 'tags')).toEqual(['a'])
  })

  it('leaves a file without frontmatter untouched when removing a field', () => {
    expect(setFrontmatterField('# 正文', 'tags', null)).toBe('# 正文')
  })

  it('removes a field when value is null', () => {
    const next = setFrontmatterField(doc, 'custom', null)

    expect(next).not.toContain('custom: keepme')
    expect(next).toContain('# 注释保留')
    expect(next.endsWith('# 正文')).toBe(true)
  })

  it('round-trips untouched text byte for byte on a no-op set', () => {
    const next = setFrontmatterField(doc, 'title', 'A')
    expect(next).toBe(doc)
  })

  it('preserves CRLF line endings', () => {
    const crlf = doc.replace(/\n/g, '\r\n')
    const next = setFrontmatterField(crlf, 'source', 'https://x')
    expect(next).toContain('\r\n')
    expect(next.endsWith('# 正文')).toBe(true)
  })
})
