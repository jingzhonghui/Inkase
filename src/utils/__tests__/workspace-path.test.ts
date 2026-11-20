import { describe, expect, it } from 'vitest'
import { toWorkspaceRelativePath } from '../workspace-path'

describe('toWorkspaceRelativePath', () => {
  it('把工作区内的绝对路径转成正斜杠相对路径', () => {
    expect(toWorkspaceRelativePath('C:\\ws', 'C:\\ws\\a.md')).toBe('a.md')
    expect(toWorkspaceRelativePath('C:\\ws', 'C:\\ws\\docs\\b.md')).toBe('docs/b.md')
  })

  it('工作区根自身返回空串（调用方决定显示成什么）', () => {
    expect(toWorkspaceRelativePath('C:\\ws', 'C:\\ws')).toBe('')
    expect(toWorkspaceRelativePath('C:\\ws\\', 'C:\\ws')).toBe('')
    expect(toWorkspaceRelativePath('C:\\ws', 'C:\\ws\\')).toBe('')
  })

  it('两端的分隔符风格可以不一致', () => {
    expect(toWorkspaceRelativePath('C:/ws', 'C:\\ws\\docs\\b.md')).toBe('docs/b.md')
    expect(toWorkspaceRelativePath('C:\\ws', 'C:/ws/docs/b.md')).toBe('docs/b.md')
  })

  it('Windows 盘符路径大小写不敏感', () => {
    expect(toWorkspaceRelativePath('C:\\WS', 'c:\\ws\\docs\\b.md')).toBe('docs/b.md')
    expect(toWorkspaceRelativePath('c:\\ws', 'C:\\Ws\\Docs\\B.md')).toBe('Docs/B.md')
  })

  it('同名前缀不会被误认成子路径', () => {
    expect(toWorkspaceRelativePath('C:\\ws', 'C:\\ws2\\a.md')).toBeNull()
    expect(toWorkspaceRelativePath('C:\\ws', 'C:\\ws-other\\a.md')).toBeNull()
  })

  it('工作区外的路径返回 null', () => {
    expect(toWorkspaceRelativePath('C:\\ws', 'D:\\ws\\a.md')).toBeNull()
    expect(toWorkspaceRelativePath('C:\\ws', 'C:\\elsewhere\\a.md')).toBeNull()
  })

  it('没有工作区根时返回 null', () => {
    expect(toWorkspaceRelativePath('', 'C:\\ws\\a.md')).toBeNull()
  })

  it('保留原路径的大小写，只拿小写副本做比较', () => {
    expect(toWorkspaceRelativePath('C:\\ws', 'C:\\ws\\Readme.MD')).toBe('Readme.MD')
  })
})
