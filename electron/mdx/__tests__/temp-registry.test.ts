import * as path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearTempDirs,
  normalizeTempKey,
  registerTempDir,
  remapTempDir,
  tempDirsByFile,
  unregisterTempDir
} from '../temp-registry'

/** 用 path.join 构造路径，保证断言在任意平台上都成立 */
const vault = path.resolve('vault')
const oldPath = path.join(vault, 'note.mdx')
const newPath = path.join(vault, 'renamed.mdx')
const tempA = path.resolve('temp', 'a')
const tempB = path.resolve('temp', 'b')

beforeEach(() => {
  clearTempDirs()
})

describe('temp registry', () => {
  it('registers and resolves a temp dir by normalized path', () => {
    registerTempDir(oldPath, tempA)

    expect(tempDirsByFile.get(normalizeTempKey(oldPath))).toBe(tempA)
  })

  it('unregisters a temp dir', () => {
    registerTempDir(oldPath, tempA)
    unregisterTempDir(oldPath)

    expect(tempDirsByFile.size).toBe(0)
  })
})

describe('remapTempDir', () => {
  it('moves the registration to the new path so a later save can find it', () => {
    registerTempDir(oldPath, tempA)

    expect(remapTempDir(oldPath, newPath)).toBe(1)
    expect(tempDirsByFile.get(normalizeTempKey(newPath))).toBe(tempA)
    expect(tempDirsByFile.has(normalizeTempKey(oldPath))).toBe(false)
  })

  it('migrates every registered file under a renamed directory', () => {
    const docs = path.join(vault, 'docs')
    const notes = path.join(vault, 'notes')
    registerTempDir(path.join(docs, 'a.mdx'), tempA)
    registerTempDir(path.join(docs, 'sub', 'b.mdx'), tempB)

    expect(remapTempDir(docs, notes)).toBe(2)
    expect(tempDirsByFile.get(normalizeTempKey(path.join(notes, 'a.mdx')))).toBe(tempA)
    expect(tempDirsByFile.get(normalizeTempKey(path.join(notes, 'sub', 'b.mdx')))).toBe(tempB)
  })

  it('leaves unrelated registrations alone', () => {
    const other = path.join(vault, 'other.mdx')
    registerTempDir(other, tempB)
    registerTempDir(oldPath, tempA)

    expect(remapTempDir(oldPath, newPath)).toBe(1)
    expect(tempDirsByFile.get(normalizeTempKey(other))).toBe(tempB)
  })

  it('does not treat a sibling with the same prefix as a child', () => {
    const sibling = path.join(vault, 'docs-archive', 'a.mdx')
    registerTempDir(sibling, tempA)

    expect(remapTempDir(path.join(vault, 'docs'), path.join(vault, 'notes'))).toBe(0)
    expect(tempDirsByFile.get(normalizeTempKey(sibling))).toBe(tempA)
  })

  it('is a no-op when nothing is registered or the path is unchanged', () => {
    expect(remapTempDir(oldPath, newPath)).toBe(0)

    registerTempDir(oldPath, tempA)
    expect(remapTempDir(oldPath, oldPath)).toBe(0)
    expect(tempDirsByFile.get(normalizeTempKey(oldPath))).toBe(tempA)
  })
})
