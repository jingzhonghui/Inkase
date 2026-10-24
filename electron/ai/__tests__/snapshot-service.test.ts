import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotService } from '../snapshot-service'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'inkase-snapshot-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function createInput(overrides: Partial<Parameters<SnapshotService['create']>[1]> = {}) {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    toolName: 'replace_current_document',
    files: [
      {
        path: 'notes/a.md',
        documentId: 'tab-1',
        title: 'A',
        content: '# old',
        scope: 'memory' as const
      }
    ],
    ...overrides
  }
}

describe('SnapshotService', () => {
  it('writes a manifest and returns memory content without touching the worktree', async () => {
    const service = new SnapshotService()
    const manifest = await service.create(root, createInput())
    const file = path.join(root, '.inkase', 'snapshots', 'run-1', 'manifest.json')

    expect(manifest.files).toHaveLength(1)
    expect(manifest.files[0]).toMatchObject({ path: 'notes/a.md', scope: 'memory', size: 5 })
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1)
    await expect(readFile(path.join(root, 'notes', 'a.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const summaries = await service.list(root)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ runId: 'run-1', fileCount: 1, paths: ['notes/a.md'] })

    const restored = await service.restore(root, 'run-1')
    expect(restored.files[0].content).toBe('# old')
    expect(restored.restoredDisk).toEqual([])

    const read = await service.read(root, 'run-1')
    expect(read.files[0].content).toBe('# old')
    expect(read.manifest.files).toHaveLength(1)
  })

  it('keeps the earliest content when the same document is written twice in one run', async () => {
    const service = new SnapshotService()
    await service.create(root, createInput())
    await service.create(
      root,
      createInput({
        files: [
          {
            path: 'notes/a.md',
            documentId: 'tab-1',
            title: 'A',
            content: '# intermediate',
            scope: 'memory'
          }
        ]
      })
    )

    const restored = await service.restore(root, 'run-1')
    expect(restored.files).toHaveLength(1)
    expect(restored.files[0].content).toBe('# old')
  })

  it('restores disk files and removes files that did not exist before the run', async () => {
    const service = new SnapshotService()
    const file = path.join(root, 'notes', 'a.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'before', 'utf8')

    await service.create(
      root,
      createInput({
        files: [
          { path: 'notes/a.md', title: 'A', content: 'before', scope: 'disk', existed: true },
          { path: 'notes/new.md', title: 'New', content: '', scope: 'disk', existed: false }
        ]
      })
    )
    await writeFile(file, 'after', 'utf8')
    await writeFile(path.join(root, 'notes', 'new.md'), 'created', 'utf8')

    const restored = await service.restore(root, 'run-1')

    expect(await readFile(file, 'utf8')).toBe('before')
    await expect(readFile(path.join(root, 'notes', 'new.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(restored.restoredDisk).toEqual(['notes/a.md', 'notes/new.md'])
    expect(restored.skippedDisk).toEqual([])
  })

  it('rejects traversal, internal directories and invalid run ids', async () => {
    const service = new SnapshotService()

    await expect(service.create(root, createInput({
      files: [{ path: '../escape.md', title: 'x', content: '', scope: 'memory' }]
    }))).rejects.toThrow('不在工作区内')
    await expect(service.create(root, createInput({
      files: [{ path: '.inkase/secret.md', title: 'x', content: '', scope: 'memory' }]
    }))).rejects.toThrow('不能快照内部目录')
    await expect(service.create(root, createInput({ runId: '../bad' }))).rejects.toThrow('无效的快照 runId')
  })

  it('prunes old runs beyond the retention limit', async () => {
    const service = new SnapshotService({ maxRuns: 2 })
    for (const runId of ['run-1', 'run-2', 'run-3']) {
      await service.create(root, createInput({ runId }))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const summaries = await service.list(root)
    expect(summaries.map((summary) => summary.runId)).toEqual(['run-3', 'run-2'])
  })
})
