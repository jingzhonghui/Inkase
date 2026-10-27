import { describe, expect, it } from 'vitest'
import { classifyDropItem } from '../useFileDrop'

describe('classifyDropItem', () => {
  it('classifies directories as folder regardless of name', () => {
    expect(classifyDropItem('docs', true)).toBe('folder')
    expect(classifyDropItem('notes.md', true)).toBe('folder')
  })

  it('classifies .md and .mdx files as markdown (case-insensitive)', () => {
    expect(classifyDropItem('a.md', false)).toBe('markdown')
    expect(classifyDropItem('a.mdx', false)).toBe('markdown')
    expect(classifyDropItem('README.MD', false)).toBe('markdown')
    expect(classifyDropItem('Notes.MDX', false)).toBe('markdown')
  })

  it('classifies .inkmind files as mindmap (case-insensitive)', () => {
    expect(classifyDropItem('项目规划.inkmind', false)).toBe('mindmap')
    expect(classifyDropItem('MAP.INKMIND', false)).toBe('mindmap')
  })

  it('classifies other files as other', () => {
    expect(classifyDropItem('photo.png', false)).toBe('other')
    expect(classifyDropItem('data.pdf', false)).toBe('other')
    expect(classifyDropItem('archive.zip', false)).toBe('other')
  })
})
