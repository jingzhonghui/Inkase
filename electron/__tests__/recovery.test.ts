import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-recovery-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => userData
  }
}))

import {
  clearRecoveryData,
  clearRecoverySnapshot,
  hadAbnormalExit,
  markAppRunning,
  readRecoverySnapshot,
  writeRecoverySnapshot,
  type RecoverySnapshot
} from '../recovery'

describe('Recovery module', () => {
  afterEach(() => {
    clearRecoveryData()
  })

  it('detects an interrupted session with a snapshot', () => {
    const snapshot: RecoverySnapshot = {
      version: 1,
      createdAt: new Date().toISOString(),
      activeTabId: 'tab_1',
      tabs: []
    }

    markAppRunning()
    expect(hadAbnormalExit()).toBe(false)
    writeRecoverySnapshot(snapshot)
    expect(hadAbnormalExit()).toBe(true)
    expect(readRecoverySnapshot()).toEqual(snapshot)
  })

  it('returns null for a malformed snapshot', () => {
    markAppRunning()
    writeRecoverySnapshot({ version: 1, createdAt: '', activeTabId: null, tabs: [] })
    const recoveryDir = path.join(userData, 'recovery')
    const snapshotFile = fs
      .readdirSync(recoveryDir)
      .find((name) => name.startsWith('snapshot-') && name.endsWith('.json'))!
    fs.writeFileSync(path.join(recoveryDir, snapshotFile), '{broken', 'utf8')
    expect(readRecoverySnapshot()).toBeNull()
  })

  it('clears snapshots and the running marker', () => {
    markAppRunning()
    writeRecoverySnapshot({ version: 1, createdAt: '', activeTabId: null, tabs: [] })
    clearRecoveryData()
    expect(hadAbnormalExit()).toBe(false)
    expect(readRecoverySnapshot()).toBeNull()
  })

  it('can clear a snapshot while keeping the current session marker', () => {
    markAppRunning()
    writeRecoverySnapshot({ version: 1, createdAt: '', activeTabId: null, tabs: [] })
    clearRecoverySnapshot()
    expect(readRecoverySnapshot()).toBeNull()
    writeRecoverySnapshot({ version: 1, createdAt: '', activeTabId: null, tabs: [] })
    expect(hadAbnormalExit()).toBe(true)
  })

  it('preserves embedded recovery asset data', () => {
    const snapshot: RecoverySnapshot = {
      version: 1,
      createdAt: new Date().toISOString(),
      activeTabId: 'tab_1',
      tabs: [{
        id: 'tab_1',
        filePath: 'document.mdx',
        fileName: 'document.mdx',
        format: 'mdx',
        content: '![image](assets/images/test.png)',
        document: {},
        modifiedAt: new Date().toISOString(),
        assetData: { 'assets/images/test.png': Buffer.from('image').toString('base64') }
      }]
    }

    writeRecoverySnapshot(snapshot)
    expect(readRecoverySnapshot()).toEqual(snapshot)
  })
})
