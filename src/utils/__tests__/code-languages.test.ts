import { describe, expect, it } from 'vitest'
import {
  CODE_BLOCK_LANGUAGES,
  codeLanguageLabel,
  matchCodeLanguages,
  normalizeCodeLanguage
} from '../code-languages'

describe('CODE_BLOCK_LANGUAGES', () => {
  it('语言标识不重复', () => {
    const values = CODE_BLOCK_LANGUAGES.map((item) => item.value)
    expect(new Set(values).size).toBe(values.length)
  })

  it('显示名不重复（回归：早先有两个「纯文本」）', () => {
    const labels = CODE_BLOCK_LANGUAGES.map((item) => item.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('纯文本只有一条，且叫 txt', () => {
    const plain = CODE_BLOCK_LANGUAGES.filter((item) => item.value === 'txt' || item.value === 'text')
    expect(plain).toHaveLength(1)
    expect(plain[0].label).toBe('txt')
  })

  it('收录 CMake，且 cmakelists 能作为搜索词找到它', () => {
    const cmake = CODE_BLOCK_LANGUAGES.find((item) => item.value === 'cmake')
    expect(cmake).toBeDefined()
    expect(cmake?.keywords).toContain('cmakelists')
  })
})

describe('normalizeCodeLanguage', () => {
  it('空串归到 txt', () => {
    expect(normalizeCodeLanguage('')).toBe('txt')
    expect(normalizeCodeLanguage('   ')).toBe('txt')
  })

  it('纯文本的几种写法都归到 txt', () => {
    expect(normalizeCodeLanguage('text')).toBe('txt')
    expect(normalizeCodeLanguage('PlainText')).toBe('txt')
    expect(normalizeCodeLanguage('plain')).toBe('txt')
  })

  it('套用别名并忽略大小写', () => {
    expect(normalizeCodeLanguage('C++')).toBe('cpp')
    expect(normalizeCodeLanguage('C#')).toBe('csharp')
    expect(normalizeCodeLanguage('JS')).toBe('javascript')
    expect(normalizeCodeLanguage('Shell')).toBe('bash')
  })

  it('CMakeLists 的各种写法都归到 cmake', () => {
    expect(normalizeCodeLanguage('cmakelists')).toBe('cmake')
    expect(normalizeCodeLanguage('CMakeLists.txt')).toBe('cmake')
    expect(normalizeCodeLanguage('CMake')).toBe('cmake')
  })

  it('清单外的语言原样保留（不会吞成 txt）', () => {
    expect(normalizeCodeLanguage('Zig')).toBe('zig')
  })
})

describe('codeLanguageLabel', () => {
  it('空语言显示 txt', () => {
    expect(codeLanguageLabel('')).toBe('txt')
    expect(codeLanguageLabel('text')).toBe('txt')
  })

  it('已知语言显示清单里的名字', () => {
    expect(codeLanguageLabel('cmake')).toBe('CMake')
    expect(codeLanguageLabel('csharp')).toBe('C#')
  })

  it('未知语言原样显示，方便用户看出围栏写的是什么', () => {
    expect(codeLanguageLabel('zig')).toBe('zig')
  })
})

describe('matchCodeLanguages', () => {
  it('空查询按清单原顺序返回全部', () => {
    const matches = matchCodeLanguages('')
    expect(matches).toHaveLength(CODE_BLOCK_LANGUAGES.length)
    expect(matches.map((item) => item.language.value)).toEqual(
      CODE_BLOCK_LANGUAGES.map((item) => item.value)
    )
  })

  it('按标签模糊匹配', () => {
    expect(matchCodeLanguages('cmake').map((item) => item.language.value)).toEqual(['cmake'])
    expect(matchCodeLanguages('pyth').map((item) => item.language.value)).toEqual(['python'])
  })

  it('cmakelists 命中搜索词（标签本身匹配不上）', () => {
    const matches = matchCodeLanguages('cmakelists')
    expect(matches.map((item) => item.language.value)).toEqual(['cmake'])
    // 命中的是搜索词而不是标签，因此没有高亮位置
    expect(matches[0].positions).toEqual([])
  })

  it('标签命中带高亮位置', () => {
    const [first] = matchCodeLanguages('py')
    expect(first.language.value).toBe('python')
    expect(first.positions).toEqual([0, 1])
  })

  it('标签命中排在仅搜索词命中之前', () => {
    const matches = matchCodeLanguages('go')
    expect(matches[0].language.value).toBe('go')
  })

  it('匹配不到返回空数组', () => {
    expect(matchCodeLanguages('zzzzz')).toEqual([])
  })
})
