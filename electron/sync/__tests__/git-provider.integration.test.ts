import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { GitSyncProvider } from '../git-provider'

const execFileAsync = promisify(execFile)
const dirsToClean: string[] = []

afterAll(() => {
  for (const dir of dirsToClean) fs.rmSync(dir, { recursive: true, force: true })
})

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'])
    return true
  } catch {
    return false
  }
}

async function makeWorkspace(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-sync-integration-'))
  dirsToClean.push(dir)
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'inkase-test'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'inkase-test@example.com'], { cwd: dir })
  fs.writeFileSync(path.join(dir, '.gitignore'), '.inkase\n', 'utf-8')
  fs.writeFileSync(path.join(dir, 'notes.md'), '# 笔记\n', 'utf-8')
  fs.mkdirSync(path.join(dir, '.inkase'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.inkase', 'sync.json'), JSON.stringify({ version: 1 }), 'utf-8')
  return dir
}

async function trackedFiles(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: dir })
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

describe('GitSyncProvider (real git)', () => {
  it('commits without staging ignored .inkase (regression: addIgnoredFile error on push)', async () => {
    if (!(await gitAvailable())) return
    const dir = await makeWorkspace()
    const provider = new GitSyncProvider(dir)
    await provider.commit('同步: 集成测试')
    expect(await trackedFiles(dir)).not.toContain('.inkase/sync.json')
    expect(await trackedFiles(dir)).toContain('notes.md')
    expect(await trackedFiles(dir)).toContain('.gitignore')
  })

  it('keeps .inkase out of the index even when both ignore files are missing', async () => {
    if (!(await gitAvailable())) return
    const dir = await makeWorkspace()
    fs.rmSync(path.join(dir, '.gitignore'))
    fs.rmSync(path.join(dir, '.git', 'info', 'exclude'), { force: true })
    const provider = new GitSyncProvider(dir)
    await provider.commit('同步: 集成测试')
    expect(await trackedFiles(dir)).not.toContain('.inkase/sync.json')
  })
})
