import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { migrateLegacyConfigDir } from '../legacy-migration'

const dirsToClean: string[] = []

function makeWs(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-legacy-migration-'))
  dirsToClean.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirsToClean) fs.rmSync(dir, { recursive: true, force: true })
  dirsToClean.length = 0
})

describe('migrateLegacyConfigDir', () => {
  it('does nothing when legacy dir is absent', () => {
    const ws = makeWs()
    migrateLegacyConfigDir(ws)
    expect(fs.existsSync(path.join(ws, '.inkase'))).toBe(false)
  })

  it('renames the whole legacy dir when target is absent', () => {
    const ws = makeWs()
    fs.mkdirSync(path.join(ws, '.markdownPlus', 'conversations'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.markdownPlus', 'sync.json'), '{"version":1}', 'utf-8')
    fs.writeFileSync(path.join(ws, '.markdownPlus', 'conversations', 'conv_a.json'), '{}', 'utf-8')

    migrateLegacyConfigDir(ws)

    expect(fs.existsSync(path.join(ws, '.markdownPlus'))).toBe(false)
    expect(fs.existsSync(path.join(ws, '.inkase', 'sync.json'))).toBe(true)
    expect(fs.existsSync(path.join(ws, '.inkase', 'conversations', 'conv_a.json'))).toBe(true)
  })

  it('keeps existing target sync.json when merging', () => {
    const ws = makeWs()
    fs.mkdirSync(path.join(ws, '.markdownPlus'), { recursive: true })
    fs.mkdirSync(path.join(ws, '.inkase'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.markdownPlus', 'sync.json'), '{"old":true}', 'utf-8')
    fs.writeFileSync(path.join(ws, '.inkase', 'sync.json'), '{"new":true}', 'utf-8')

    migrateLegacyConfigDir(ws)

    expect(fs.readFileSync(path.join(ws, '.inkase', 'sync.json'), 'utf-8')).toBe('{"new":true}')
    expect(fs.existsSync(path.join(ws, '.markdownPlus'))).toBe(false)
  })

  it('merges conversations file-by-file and skips name clashes', () => {
    const ws = makeWs()
    fs.mkdirSync(path.join(ws, '.markdownPlus', 'conversations'), { recursive: true })
    fs.mkdirSync(path.join(ws, '.inkase', 'conversations'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.markdownPlus', 'conversations', 'conv_old.json'), 'old-only', 'utf-8')
    fs.writeFileSync(path.join(ws, '.markdownPlus', 'conversations', 'conv_clash.json'), 'legacy', 'utf-8')
    fs.writeFileSync(path.join(ws, '.inkase', 'conversations', 'conv_clash.json'), 'current', 'utf-8')

    migrateLegacyConfigDir(ws)

    expect(fs.readFileSync(path.join(ws, '.inkase', 'conversations', 'conv_old.json'), 'utf-8')).toBe('old-only')
    expect(fs.readFileSync(path.join(ws, '.inkase', 'conversations', 'conv_clash.json'), 'utf-8')).toBe('current')
    expect(fs.existsSync(path.join(ws, '.markdownPlus'))).toBe(false)
  })

  it('keeps legacy dir when it still has unknown leftover entries', () => {
    const ws = makeWs()
    fs.mkdirSync(path.join(ws, '.markdownPlus'), { recursive: true })
    fs.mkdirSync(path.join(ws, '.inkase'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.markdownPlus', 'unknown.bin'), 'x', 'utf-8')
    fs.writeFileSync(path.join(ws, '.inkase', 'unknown.bin'), 'y', 'utf-8')

    migrateLegacyConfigDir(ws)

    // unknown.bin 同名跳过且旧目录非空 → 旧目录保留
    expect(fs.existsSync(path.join(ws, '.markdownPlus', 'unknown.bin'))).toBe(true)
  })

  it('removes the .markdownPlus line from .gitignore', () => {
    const ws = makeWs()
    fs.mkdirSync(path.join(ws, '.markdownPlus'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules\n.markdownPlus\n', 'utf-8')

    migrateLegacyConfigDir(ws)

    const content = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8')
    expect(content).not.toContain('.markdownPlus')
    expect(content).toContain('node_modules')
  })

  it('does not throw when workspace path does not exist', () => {
    expect(() => migrateLegacyConfigDir(path.join(os.tmpdir(), 'mdp-not-exist-xyz'))).not.toThrow()
  })
})
