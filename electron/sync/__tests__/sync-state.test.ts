import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  compareFile,
  emptySyncState,
  isSuspiciousEmptyRemote,
  loadSyncState,
  saveSyncState,
  syncStatePath,
  type FileAction,
  type FileSide,
  type SyncStateEntry
} from '../sync-state'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-sync-state-'))

describe('sync state', () => {
  beforeEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); fs.mkdirSync(tmpDir, { recursive: true }) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('returns null when the file does not exist', () => {
    expect(loadSyncState(tmpDir)).toBeNull()
  })

  it('round-trips a state', () => {
    const state = emptySyncState('/inkase')
    state.files['a.mdx'] = { etag: '"1"', hash: 'sha1:aa', size: 3, mtime: 100 }
    saveSyncState(tmpDir, state)
    expect(loadSyncState(tmpDir)).toEqual(state)
  })

  it('returns null and backs up corrupt json', () => {
    fs.mkdirSync(path.join(tmpDir, '.inkase'), { recursive: true })
    fs.writeFileSync(syncStatePath(tmpDir), '{oops', 'utf-8')
    expect(loadSyncState(tmpDir)).toBeNull()
    expect(fs.existsSync(`${syncStatePath(tmpDir)}.bak`)).toBe(true)
  })

  it('returns null for a wrong version', () => {
    fs.mkdirSync(path.join(tmpDir, '.inkase'), { recursive: true })
    fs.writeFileSync(syncStatePath(tmpDir), JSON.stringify({ version: 2, provider: 'webdav', remoteRoot: '/x', files: {} }), 'utf-8')
    expect(loadSyncState(tmpDir)).toBeNull()
  })
})

describe('compareFile', () => {
  const base: SyncStateEntry = { etag: null, hash: 'sha1:base', size: 1, mtime: 1 }
  const same: FileSide = { hash: 'sha1:base' }
  const other: FileSide = { hash: 'sha1:other' }

  it.each<[FileAction, SyncStateEntry | null, FileSide, FileSide]>([
    ['none', null, null, null],
    ['upload', null, same, null],
    ['download', null, null, same],
    ['none', null, same, same],
    ['conflict', null, same, other],
    ['none', base, same, same],
    ['upload', base, other, same],
    ['download', base, same, other],
    ['conflict', base, other, other],
    ['deleteRemote', base, null, same],
    ['conflict', base, null, other],
    ['deleteLocal', base, same, null],
    ['conflict', base, other, null],
    ['none', base, null, null]
  ])('compareFile -> %s', (expected, b, l, r) => {
    expect(compareFile(b, l, r)).toBe(expected)
  })
})

describe('isSuspiciousEmptyRemote', () => {
  it('flags an empty remote while the state has files', () => {
    expect(isSuspiciousEmptyRemote(3, 0)).toBe(true)
    expect(isSuspiciousEmptyRemote(0, 0)).toBe(false)
    expect(isSuspiciousEmptyRemote(3, 1)).toBe(false)
  })
})
