import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planRenames, toRelPath } from '../rename-plan'

let root: string

function writeFile(rel: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, 'x', 'utf-8')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-rename-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('toRelPath', () => {
  it('produces a forward-slash relative path', () => {
    expect(toRelPath(root, path.join(root, 'a', 'b.md'))).toBe('a/b.md')
  })
})

describe('planRenames', () => {
  it('maps a single file rename', () => {
    writeFile('note-a.md')

    expect(planRenames(root, path.join(root, 'note-a.md'), path.join(root, 'note-b.md'), false)).toEqual([
      { from: 'note-a.md', to: 'note-b.md' }
    ])
  })

  it('maps a file move across directories', () => {
    writeFile('dir/note-a.md')

    expect(planRenames(root, path.join(root, 'dir', 'note-a.md'), path.join(root, 'note-a.md'), false)).toEqual([
      { from: 'dir/note-a.md', to: 'note-a.md' }
    ])
  })

  it('expands a directory rename to every file inside', () => {
    writeFile('dir/a.md')
    writeFile('dir/sub/b.mdx')

    const renames = planRenames(root, path.join(root, 'dir'), path.join(root, 'renamed'), true)

    expect(renames).toEqual([
      { from: 'dir/a.md', to: 'renamed/a.md' },
      { from: 'dir/sub/b.mdx', to: 'renamed/sub/b.mdx' }
    ])
  })

  it('skips hidden entries and node_modules inside a renamed directory', () => {
    writeFile('dir/a.md')
    writeFile('dir/.hidden.md')
    writeFile('dir/node_modules/pkg/b.md')

    expect(planRenames(root, path.join(root, 'dir'), path.join(root, 'renamed'), true)).toEqual([
      { from: 'dir/a.md', to: 'renamed/a.md' }
    ])
  })

  it('returns null when a path is outside the workspace root', () => {
    const outside = path.resolve(root, '..', 'outside.md')

    expect(planRenames(root, outside, path.join(root, 'inside.md'), false)).toBeNull()
    expect(planRenames(root, path.join(root, 'a.md'), outside, false)).toBeNull()
  })
})
