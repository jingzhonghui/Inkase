import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { resolveRelPath } from '../rel-path'

const root = path.resolve('vault-root')

describe('resolveRelPath', () => {
  it('accepts and normalizes vault-relative paths', () => {
    expect(resolveRelPath(root, 'a.md')).toBe('a.md')
    expect(resolveRelPath(root, 'dir\\a.md')).toBe('dir/a.md')
    expect(resolveRelPath(root, './a.md')).toBe('a.md')
    expect(resolveRelPath(root, 'a//b.md')).toBe('a/b.md')
    expect(resolveRelPath(root, '中文 目录/笔记.md')).toBe('中文 目录/笔记.md')
  })

  it('rejects absolute paths', () => {
    expect(() => resolveRelPath(root, path.join(root, 'a.md'))).toThrow('只接受库内相对路径')
    expect(() => resolveRelPath(root, '/etc/passwd')).toThrow('只接受库内相对路径')
    expect(() => resolveRelPath(root, 'C:\\Windows\\a.md')).toThrow('只接受库内相对路径')
  })

  it('rejects drive-relative paths', () => {
    expect(() => resolveRelPath(root, 'C:a.md')).toThrow('只接受库内相对路径')
  })

  it('rejects traversal out of the root', () => {
    expect(() => resolveRelPath(root, '../a.md')).toThrow('路径越权')
    expect(() => resolveRelPath(root, 'a/../../b.md')).toThrow('路径越权')
    expect(() => resolveRelPath(root, '..\\..\\a.md')).toThrow('路径越权')
  })

  it('rejects empty and non-string input', () => {
    expect(() => resolveRelPath(root, '')).toThrow('缺少文件路径')
    expect(() => resolveRelPath(root, '   ')).toThrow('缺少文件路径')
    expect(() => resolveRelPath(root, undefined)).toThrow('缺少文件路径')
    expect(() => resolveRelPath(root, 42)).toThrow('缺少文件路径')
  })
})
