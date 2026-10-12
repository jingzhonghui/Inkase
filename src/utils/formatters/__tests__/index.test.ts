import { describe, expect, it } from 'vitest'
import { fileExtension, formatCode, isFormattable } from '../index'

describe('fileExtension', () => {
  it('returns the lowercase extension', () => {
    expect(fileExtension('a/b/Config.JSON')).toBe('json')
    expect(fileExtension('script.sh')).toBe('sh')
  })

  it('returns null for files without an extension or dotfiles', () => {
    expect(fileExtension('Makefile')).toBeNull()
    expect(fileExtension('.gitignore')).toBeNull()
  })
})

describe('isFormattable', () => {
  it('accepts supported code extensions', () => {
    for (const name of ['a.json', 'a.js', 'a.ts', 'a.tsx', 'a.css', 'a.scss', 'a.less', 'a.html', 'a.vue', 'a.yaml', 'a.yml', 'a.graphql']) {
      expect(isFormattable(name)).toBe(true)
    }
  })

  it('rejects unsupported extensions and plain text', () => {
    for (const name of ['a.txt', 'a.py', 'a.sh', 'a.conf', 'Makefile', '.env']) {
      expect(isFormattable(name)).toBe(false)
    }
  })
})

describe('formatCode', () => {
  it('formats JSON with two-space indentation', async () => {
    const result = await formatCode('{"a":1,"b":[1,2]}', 'data.json')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toBe('{ "a": 1, "b": [1, 2] }\n')
    }
  })

  it('formats JavaScript', async () => {
    const result = await formatCode('const x=1\n', 'a.js')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toContain('const x = 1;')
    }
  })

  it('formats CSS', async () => {
    const result = await formatCode('a{color:red}', 'a.css')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toBe('a {\n  color: red;\n}\n')
    }
  })

  it('formats YAML', async () => {
    const result = await formatCode('a:   1\nb:\n    - x', 'a.yaml')
    expect(result.ok).toBe(true)
  })

  it('returns an error result for unsupported files', async () => {
    const result = await formatCode('print(1)', 'a.py')
    expect(result.ok).toBe(false)
  })

  it('returns an error result for invalid input instead of throwing', async () => {
    const result = await formatCode('{ not json', 'data.json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })
})
