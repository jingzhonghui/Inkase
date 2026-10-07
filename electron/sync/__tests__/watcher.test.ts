import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createWorkspaceWatcher } from '../watcher'

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('createWorkspaceWatcher', () => {
  it('reports file changes after debounce and ignores ignored dirs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-watcher-'))
    const collected: string[] = []
    const handle = createWorkspaceWatcher(
      dir,
      (files) => collected.push(...files),
      { debounceMs: 150 }
    )
    try {
      await new Promise((r) => setTimeout(r, 200))
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'docs', 'a.md'), '# a', 'utf-8')
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.git', 'index'), 'x', 'utf-8')
      fs.mkdirSync(path.join(dir, '.inkase'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.inkase', 'sync.json'), '{}', 'utf-8')

      await waitFor(() => collected.some((p) => p.endsWith('a.md')))
      expect(collected.some((p) => p.includes('.git'))).toBe(false)
      expect(collected.some((p) => p.includes('.inkase'))).toBe(false)
      // 上报的路径必须是绝对路径
      expect(collected.some((p) => p.endsWith(path.join('docs', 'a.md')))).toBe(true)
    } finally {
      handle.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows renaming a watched subdirectory (no EPERM from watcher handles)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-watcher-rename-'))
    const collected: string[] = []
    const handle = createWorkspaceWatcher(dir, (files) => collected.push(...files), { debounceMs: 150 })
    try {
      await new Promise((r) => setTimeout(r, 200))
      fs.mkdirSync(path.join(dir, 'other'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'other', 'a.md'), '# a', 'utf-8')
      await waitFor(() => collected.some((p) => p.endsWith('a.md')))

      // 关键验证：子目录已被 watcher 覆盖（产生过事件），此刻重命名不应抛 EPERM
      fs.renameSync(path.join(dir, 'other'), path.join(dir, 'renamed'))
      expect(fs.existsSync(path.join(dir, 'renamed', 'a.md'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'other'))).toBe(false)
    } finally {
      handle.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not fire when there are no changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-watcher-idle-'))
    const collected: string[] = []
    const handle = createWorkspaceWatcher(dir, (files) => collected.push(...files), { debounceMs: 100 })
    await new Promise((r) => setTimeout(r, 300))
    expect(collected).toHaveLength(0)
    handle.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
