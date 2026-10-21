import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearTextCache,
  emptyIndex,
  indexFilePath,
  indexPath,
  isIndexStale,
  loadIndex,
  readTextCache,
  removeIndex,
  safeHashName,
  saveIndex,
  textCacheDir,
  textCachePath,
  writeTextCache
} from '../index-store'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-index-'))

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('index paths', () => {
  it('keeps everything under the private .inkase directory', () => {
    expect(indexPath(tmp)).toBe(path.join(tmp, '.inkase', 'index'))
    expect(indexFilePath(tmp, 'index')).toBe(path.join(tmp, '.inkase', 'index', 'index.json'))
    expect(indexFilePath(tmp, 'graph')).toBe(path.join(tmp, '.inkase', 'index', 'graph.json'))
    expect(textCacheDir(tmp)).toBe(path.join(tmp, '.inkase', 'index', 'text'))
  })
})

describe('loadIndex / saveIndex', () => {
  it('returns null when nothing was saved', () => {
    expect(loadIndex(tmp)).toBeNull()
  })

  it('round-trips an index', () => {
    const index = emptyIndex(tmp)
    index.files['a.md'] = { mtime: 1, size: 2, hash: 'sha1:aa', kind: 'md' }
    index.outgoing['a.md'] = [
      { from: 'a.md', to: 'b.md', raw: '[[b]]', kind: 'link', line: 1, column: 1, target: 'b' }
    ]
    index.tags['x'] = ['a.md']

    saveIndex(tmp, index)
    const loaded = loadIndex(tmp)!

    expect(loaded.files['a.md'].kind).toBe('md')
    expect(loaded.outgoing['a.md'][0].raw).toBe('[[b]]')
    expect(loaded.tags['x']).toEqual(['a.md'])
  })

  it('creates the directory on demand', () => {
    saveIndex(tmp, emptyIndex(tmp))
    expect(fs.existsSync(indexFilePath(tmp, 'index'))).toBe(true)
  })

  it('returns null and backs up corrupt json', () => {
    fs.mkdirSync(indexPath(tmp), { recursive: true })
    fs.writeFileSync(indexFilePath(tmp, 'index'), '{oops', 'utf-8')

    expect(loadIndex(tmp)).toBeNull()
    expect(fs.existsSync(`${indexFilePath(tmp, 'index')}.bak`)).toBe(true)
  })

  it('returns null for a wrong version', () => {
    fs.mkdirSync(indexPath(tmp), { recursive: true })
    fs.writeFileSync(
      indexFilePath(tmp, 'index'),
      JSON.stringify({ meta: { version: 2, parserVersion: 1 }, files: {}, outgoing: {} }),
      'utf-8'
    )

    expect(loadIndex(tmp)).toBeNull()
  })

  it('returns null when meta is missing', () => {
    fs.mkdirSync(indexPath(tmp), { recursive: true })
    fs.writeFileSync(indexFilePath(tmp, 'index'), JSON.stringify({ files: {}, outgoing: {} }), 'utf-8')

    expect(loadIndex(tmp)).toBeNull()
  })

  it('tolerates a partially written index by falling back to empty collections', () => {
    fs.mkdirSync(indexPath(tmp), { recursive: true })
    fs.writeFileSync(
      indexFilePath(tmp, 'index'),
      JSON.stringify({ meta: { version: 1, parserVersion: 1, root: tmp }, files: {}, outgoing: {} }),
      'utf-8'
    )
    const loaded = loadIndex(tmp)!

    expect(loaded.tags).toEqual({})
    expect(loaded.unresolved).toEqual([])
    expect(loaded.errors).toEqual([])
  })

  it('leaves no .tmp file behind', () => {
    saveIndex(tmp, emptyIndex(tmp))
    expect(fs.existsSync(`${indexFilePath(tmp, 'index')}.tmp`)).toBe(false)
  })
})

describe('isIndexStale', () => {
  it('flags a missing index as stale', () => {
    expect(isIndexStale(null, 1)).toBe(true)
  })

  it('flags a parser version change as stale', () => {
    const index = emptyIndex(tmp)

    expect(isIndexStale(index, index.meta.parserVersion)).toBe(false)
    expect(isIndexStale(index, index.meta.parserVersion + 1)).toBe(true)
  })
})

describe('text cache', () => {
  it('round-trips extracted text', () => {
    writeTextCache(tmp, 'sha1:aa', '抽取的正文')

    expect(readTextCache(tmp, 'sha1:aa')).toBe('抽取的正文')
  })

  it('returns null when the cache entry is missing', () => {
    expect(readTextCache(tmp, 'sha1:missing')).toBeNull()
  })

  it('sanitizes the hash so it cannot escape the cache directory', () => {
    const escaped = textCachePath(tmp, '../../evil')

    expect(path.dirname(escaped)).toBe(textCacheDir(tmp))
    expect(path.basename(escaped)).toBe('______evil.txt')
    expect(safeHashName('sha1:aa')).toBe('sha1_aa')
  })

  it('clears the whole cache directory', () => {
    writeTextCache(tmp, 'sha1:aa', 'x')
    clearTextCache(tmp)

    expect(fs.existsSync(textCacheDir(tmp))).toBe(false)
    expect(readTextCache(tmp, 'sha1:aa')).toBeNull()
  })
})

describe('removeIndex', () => {
  it('removes the index directory including the text cache', () => {
    saveIndex(tmp, emptyIndex(tmp))
    writeTextCache(tmp, 'sha1:aa', 'x')

    removeIndex(tmp)

    expect(fs.existsSync(indexPath(tmp))).toBe(false)
  })
})
