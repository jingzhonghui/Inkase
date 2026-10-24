// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SnapshotRestoreResult } from '../../../../shared/ai/snapshots'
import { useFileStore } from '../../../stores/file'
import { rollbackAiSnapshot } from '../snapshot'
import { requestDialog } from '../../dialog'

vi.mock('../../dialog', () => ({
  requestDialog: vi.fn(async () => 0)
}))

const rollbackApi = vi.fn()
const readApi = vi.fn()
const dialogMock = vi.mocked(requestDialog)

beforeEach(() => {
  setActivePinia(createPinia())
  rollbackApi.mockReset()
  readApi.mockReset()
  dialogMock.mockReset()
  dialogMock.mockResolvedValue(0)
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { readAiSnapshot: readApi, rollbackAiSnapshot: rollbackApi }
  })
})

describe('rollbackAiSnapshot', () => {
  it('restores an open generated tab from a memory snapshot', async () => {
    const fileStore = useFileStore()
    const tab = fileStore.createGeneratedDocument('A', 'old', 'markdown')
    expect(tab).not.toBeNull()
    tab!.content = 'new'

    const bundle: SnapshotRestoreResult = {
      manifest: {
        version: 1,
        runId: 'run-1',
        conversationId: 'conv-1',
        toolName: 'replace_current_document',
        createdAt: 1,
        files: []
      },
      files: [{
        record: {
          path: null,
          documentId: tab!.id,
          title: 'A',
          scope: 'memory',
          existed: true,
          storageName: 'files/0001.txt',
          contentHash: 'hash',
          size: 3
        },
        content: 'old'
      }],
      restoredDisk: [],
      skippedDisk: []
    }
    readApi.mockResolvedValue({ success: true, data: bundle })
    rollbackApi.mockResolvedValue({ success: true, data: bundle })

    await expect(rollbackAiSnapshot('run-1')).resolves.toBe(1)
    expect(tab!.content).toBe('old')
    expect(dialogMock).toHaveBeenCalled()
    expect(readApi).toHaveBeenCalledWith('run-1')
    expect(rollbackApi).toHaveBeenCalledWith({ runId: 'run-1', keys: [`id:${tab!.id}`] })
  })

  it('does not touch the document when the user cancels the dirty-tab prompt', async () => {
    const fileStore = useFileStore()
    const tab = fileStore.createGeneratedDocument('A', 'old', 'markdown')
    tab!.content = 'new'
    dialogMock.mockResolvedValueOnce(1)

    const bundle: SnapshotRestoreResult = {
      manifest: {
        version: 1,
        runId: 'run-1',
        conversationId: 'conv-1',
        toolName: 'replace_current_document',
        createdAt: 1,
        files: []
      },
      files: [{
        record: {
          path: null,
          documentId: tab!.id,
          title: 'A',
          scope: 'memory',
          existed: true,
          storageName: 'files/0001.txt',
          contentHash: 'hash',
          size: 3
        },
        content: 'old'
      }],
      restoredDisk: [],
      skippedDisk: []
    }
    readApi.mockResolvedValue({ success: true, data: bundle })

    await expect(rollbackAiSnapshot('run-1')).resolves.toBe(0)
    expect(tab!.content).toBe('new')
    expect(rollbackApi).not.toHaveBeenCalled()
  })

  it('surfaces a failed rollback instead of silently clearing state', async () => {
    readApi.mockResolvedValue({ success: false, error: '快照不存在' })

    await expect(rollbackAiSnapshot('run-1')).rejects.toThrow('快照不存在')
  })
})
