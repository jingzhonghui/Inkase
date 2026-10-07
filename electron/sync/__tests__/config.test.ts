import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DEFAULT_SYNC_CONFIG,
  ensureInkaseIgnored,
  loadSyncConfig,
  saveSyncConfig,
  syncConfigPath
} from '../config'
import type { SyncConfig } from '../types'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-sync-config-'))

describe('sync config', () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when config file does not exist', () => {
    expect(loadSyncConfig(tmpDir)).toBeNull()
  })

  it('round-trips a saved config', () => {
    const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG, autoPush: true }
    saveSyncConfig(tmpDir, config)
    expect(fs.existsSync(syncConfigPath(tmpDir))).toBe(true)
    expect(loadSyncConfig(tmpDir)).toEqual(config)
  })

  it('fills missing boolean fields from defaults', () => {
    fs.mkdirSync(path.join(tmpDir, '.inkase'), { recursive: true })
    fs.writeFileSync(syncConfigPath(tmpDir), JSON.stringify({ version: 1, provider: 'git' }), 'utf-8')
    expect(loadSyncConfig(tmpDir)).toEqual(DEFAULT_SYNC_CONFIG)
  })

  it('returns null and backs up corrupt json', () => {
    fs.mkdirSync(path.join(tmpDir, '.inkase'), { recursive: true })
    fs.writeFileSync(syncConfigPath(tmpDir), '{oops', 'utf-8')
    expect(loadSyncConfig(tmpDir)).toBeNull()
    expect(fs.existsSync(`${syncConfigPath(tmpDir)}.bak`)).toBe(true)
  })

  it('appends .inkase to a fresh .gitignore', () => {
    ensureInkaseIgnored(tmpDir)
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(content).toContain('.inkase')
  })

  it('does not duplicate the ignore line', () => {
    ensureInkaseIgnored(tmpDir)
    ensureInkaseIgnored(tmpDir)
    const lines = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8').split(/\r?\n/)
    expect(lines.filter((l) => l.trim() === '.inkase')).toHaveLength(1)
  })

  it('appends to an existing .gitignore that lacks the entry', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n', 'utf-8')
    ensureInkaseIgnored(tmpDir)
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(content).toContain('node_modules')
    expect(content).toContain('.inkase')
  })

  it('skips appending when .gitignore is in an unresolved conflict state', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> abc\n', 'utf-8')
    ensureInkaseIgnored(tmpDir)
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(content).not.toContain('.inkase')
  })
})
