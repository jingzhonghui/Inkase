import { describe, expect, it } from 'vitest'
import { parseLaunchTargets } from '../launch-target'

describe('parseLaunchTargets', () => {
  it('extracts existing markdown files and directories from argv', () => {
    expect(
      parseLaunchTargets(
        ['Inkase.exe', 'C:\\Docs\\notes.mdx', 'C:\\工作区', 'C:\\Docs\\readme.md'],
        (target) => target === 'C:\\工作区' ? 'directory' : 'file'
      )
    ).toEqual(['C:\\Docs\\notes.mdx', 'C:\\工作区', 'C:\\Docs\\readme.md'])
  })

  it('ignores electron flags, unsupported files, duplicates, and missing paths', () => {
    expect(
      parseLaunchTargets(
        ['app.exe', '--squirrel-firstrun', '--', 'C:\\Docs\\a.txt', 'C:\\Docs\\a.md', 'C:\\Docs\\a.md'],
        (target) => target === 'C:\\Docs\\a.txt' ? null : 'file'
      )
    ).toEqual(['C:\\Docs\\a.md'])
  })
})
