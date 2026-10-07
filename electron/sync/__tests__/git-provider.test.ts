import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { GitSyncProvider, autoResolveGitignoreConflict, isUntrackedOverwrite, parseStatus, runGit } from '../git-provider'
import type { GitCommandResult } from '../git-provider'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('child_process', () => ({ execFile: execFileMock }))

const dirsToClean: string[] = []

function makeConflictFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-sync-conflict-'))
  dirsToClean.push(dir)
  fs.writeFileSync(path.join(dir, 'a.md'), content, 'utf-8')
  return dir
}

describe('parseStatus', () => {
  it('parses clean repo as upToDate', () => {
    expect(parseStatus('## main...origin/main\n')).toBe('upToDate')
  })

  it('parses ahead as pendingPush', () => {
    expect(parseStatus('## main...origin/main [ahead 1]\n')).toBe('pendingPush')
  })

  it('parses behind as pendingPull', () => {
    expect(parseStatus('## main...origin/main [behind 2]\n')).toBe('pendingPull')
  })

  it('parses local changes as pendingCommit', () => {
    expect(parseStatus('## main...origin/main [ahead 1, behind 2]\n M docs/foo.md\n?? untracked.mdx\n')).toBe('pendingCommit')
  })

  it('parses no upstream as error', () => {
    expect(parseStatus('## main\n')).toBe('error')
  })

  it('parses unmerged entries as conflict', () => {
    expect(parseStatus('## main...origin/main\nUU file.txt\n')).toBe('conflict')
    expect(parseStatus('## main...origin/main\nAA file.txt\n')).toBe('conflict')
  })

  it('parses rebase in-progress (detached HEAD) as conflict', () => {
    expect(parseStatus('## HEAD (no branch)\nUU file.txt\n')).toBe('conflict')
    expect(parseStatus('## HEAD (no branch)\n M file.txt\n')).toBe('conflict')
  })

  it('parses empty output as upToDate', () => {
    expect(parseStatus('')).toBe('upToDate')
  })
})

function mockRun(script: Array<{ args: string[]; result: GitCommandResult }>) {
  const calls: string[][] = []
  const run = vi.fn(async (args: string[]): Promise<GitCommandResult> => {
    calls.push(args)
    const entry = script.shift()
    return entry?.args.join(' ') === args.join(' ') ? entry.result : { code: 1, stdout: '', stderr: 'unexpected call' }
  })
  return { run, calls }
}

describe('GitSyncProvider', () => {
  afterEach(() => {
    for (const dir of dirsToClean) fs.rmSync(dir, { recursive: true, force: true })
    dirsToClean.length = 0
  })
  it('status resolves via parseStatus', async () => {
    const { run } = mockRun([{ args: ['status', '--porcelain', '-b'], result: { code: 0, stdout: '## main...origin/main\n', stderr: '' } }])
    const p = new GitSyncProvider('C:/ws', run)
    await expect(p.status()).resolves.toBe('upToDate')
  })

  it('pull returns changed absolute paths after head advances', async () => {
    const { run } = mockRun([
      { args: ['rev-parse', 'HEAD'], result: { code: 0, stdout: 'aaa\n', stderr: '' } },
      { args: ['pull', '--ff-only'], result: { code: 0, stdout: '', stderr: '' } },
      { args: ['rev-parse', 'HEAD'], result: { code: 0, stdout: 'bbb\n', stderr: '' } },
      { args: ['diff', '--name-only', 'aaa', 'bbb'], result: { code: 0, stdout: 'docs/a.md\n', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.pull()
    expect(result.success).toBe(true)
    expect(result.changedFiles).toEqual([path.join('C:/ws', 'docs/a.md')])
  })

  it('pull falls back to rebase when diverged (ff-only fails fast-forward)', async () => {
    const { run, calls } = mockRun([
      { args: ['rev-parse', 'HEAD'], result: { code: 0, stdout: 'aaa\n', stderr: '' } },
      { args: ['pull', '--ff-only'], result: { code: 1, stdout: '', stderr: 'Not possible to fast-forward' } },
      { args: ['pull', '--rebase'], result: { code: 0, stdout: '', stderr: '' } },
      { args: ['rev-parse', 'HEAD'], result: { code: 0, stdout: 'bbb\n', stderr: '' } },
      { args: ['diff', '--name-only', 'aaa', 'bbb'], result: { code: 0, stdout: 'docs/a.md\n', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.pull()
    expect(result.success).toBe(true)
    expect(calls).toContainEqual(['pull', '--rebase'])
    expect(result.changedFiles).toEqual([path.join('C:/ws', 'docs/a.md')])
  })

  it('pull reports rebase conflict message when rebase fails', async () => {
    const { run, calls } = mockRun([
      { args: ['rev-parse', 'HEAD'], result: { code: 0, stdout: 'aaa\n', stderr: '' } },
      { args: ['pull', '--ff-only'], result: { code: 1, stdout: '', stderr: 'Not possible to fast-forward' } },
      { args: ['pull', '--rebase'], result: { code: 1, stdout: 'CONFLICT (content): Merge conflict in docs/a.md', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.pull()
    expect(result.success).toBe(false)
    expect(calls).toContainEqual(['pull', '--rebase'])
    expect(result.error).toContain('CONFLICT')
  })

  it('pull reports non-rebase failure without retrying rebase', async () => {
    const { run, calls } = mockRun([
      { args: ['rev-parse', 'HEAD'], result: { code: 0, stdout: 'aaa\n', stderr: '' } },
      { args: ['pull', '--ff-only'], result: { code: 1, stdout: '', stderr: 'fatal: could not read Username' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.pull()
    expect(result.success).toBe(false)
    expect(calls.filter((c) => c[0] === 'pull' && c[1] === '--rebase').length).toBe(0)
  })

  it('push retries after rebase when rejected non-fast-forward', async () => {
    const { run, calls } = mockRun([
      { args: ['symbolic-ref', '--short', 'HEAD'], result: { code: 0, stdout: 'main\n', stderr: '' } },
      { args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], result: { code: 0, stdout: 'origin/main\n', stderr: '' } },
      { args: ['push'], result: { code: 1, stdout: '', stderr: '! [rejected] HEAD -> main (fetch first)' } },
      { args: ['pull', '--rebase'], result: { code: 0, stdout: '', stderr: '' } },
      { args: ['push'], result: { code: 0, stdout: '', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.push()
    expect(result.success).toBe(true)
    expect(calls.filter((c) => c[0] === 'push').length).toBe(2)
  })

  it('push reports conflict when rebase fails after rejection', async () => {
    const { run } = mockRun([
      { args: ['symbolic-ref', '--short', 'HEAD'], result: { code: 0, stdout: 'main\n', stderr: '' } },
      { args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], result: { code: 0, stdout: 'origin/main\n', stderr: '' } },
      { args: ['push'], result: { code: 1, stdout: '', stderr: '! [rejected] HEAD -> main (non-fast-forward)' } },
      { args: ['pull', '--rebase'], result: { code: 1, stdout: 'CONFLICT (content): Merge conflict in docs/a.md', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.push()
    expect(result.success).toBe(false)
    expect(result.error).toContain('CONFLICT')
  })

  it('push reports auth failure without retrying rebase', async () => {
    const { run, calls } = mockRun([
      { args: ['symbolic-ref', '--short', 'HEAD'], result: { code: 0, stdout: 'main\n', stderr: '' } },
      { args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], result: { code: 0, stdout: 'origin/main\n', stderr: '' } },
      { args: ['push'], result: { code: 1, stdout: '', stderr: 'Permission denied (publickey)' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.push()
    expect(result.success).toBe(false)
    expect(calls.filter((c) => c[0] === 'pull' && c[1] === '--rebase').length).toBe(0)
  })

  it('conflictedFiles returns absolute paths of unmerged files', async () => {
    const { run } = mockRun([
      { args: ['diff', '--name-only', '--diff-filter=U'], result: { code: 0, stdout: 'docs/a.md\nnotes/b.mdx\n', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    await expect(p.conflictedFiles?.()).resolves.toEqual([path.join('C:/ws', 'docs/a.md'), path.join('C:/ws', 'notes/b.mdx')])
  })

  it('conflictedFiles returns empty on failure', async () => {
    const { run } = mockRun([
      { args: ['diff', '--name-only', '--diff-filter=U'], result: { code: 1, stdout: '', stderr: 'fatal' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    await expect(p.conflictedFiles?.()).resolves.toEqual([])
  })

  it('rebaseInProgress checks REBASE_HEAD', async () => {
    const { run } = mockRun([
      { args: ['rev-parse', '-q', '--verify', 'REBASE_HEAD'], result: { code: 0, stdout: 'xxx\n', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    await expect(p.rebaseInProgress?.()).resolves.toBe(true)
  })

  it('rebaseInProgress false when no REBASE_HEAD', async () => {
    const { run } = mockRun([
      { args: ['rev-parse', '-q', '--verify', 'REBASE_HEAD'], result: { code: 1, stdout: '', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    await expect(p.rebaseInProgress?.()).resolves.toBe(false)
  })

  it('continueRebase stages conflicted files then runs rebase --continue', async () => {
    const { run, calls } = mockRun([
      { args: ['diff', '--name-only', '--diff-filter=U'], result: { code: 0, stdout: 'docs/a.md\n', stderr: '' } },
      { args: ['add', '--', 'docs/a.md'], result: { code: 0, stdout: '', stderr: '' } },
      { args: ['-c', 'core.editor=true', 'rebase', '--continue'], result: { code: 0, stdout: '', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.continueRebase?.()
    expect(result?.success).toBe(true)
    expect(calls).toContainEqual(['add', '--', 'docs/a.md'])
    expect(calls).toContainEqual(['-c', 'core.editor=true', 'rebase', '--continue'])
  })

  it('continueRebase fails when no conflicted files and rebase fails', async () => {
    const { run } = mockRun([
      { args: ['diff', '--name-only', '--diff-filter=U'], result: { code: 0, stdout: '', stderr: '' } },
      { args: ['-c', 'core.editor=true', 'rebase', '--continue'], result: { code: 1, stdout: '', stderr: 'fatal: No rebase in progress?' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.continueRebase?.()
    expect(result?.success).toBe(false)
    expect(result?.error).toContain('No rebase in progress')
  })

  it('abortRebase runs git rebase --abort', async () => {
    const { run, calls } = mockRun([
      { args: ['rebase', '--abort'], result: { code: 0, stdout: '', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.abortRebase?.()
    expect(result?.success).toBe(true)
    expect(calls).toContainEqual(['rebase', '--abort'])
  })

  it('continueRebase refuses when unresolved conflict markers remain', async () => {
    const dir = makeConflictFile('# title\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> abc123\n')
    const { run, calls } = mockRun([
      { args: ['diff', '--name-only', '--diff-filter=U'], result: { code: 0, stdout: 'a.md\n', stderr: '' } }
    ])
    const p = new GitSyncProvider(dir, run)
    const result = await p.continueRebase?.()
    expect(result?.success).toBe(false)
    expect(result?.error).toContain('a.md')
    expect(result?.error).toContain('未解决')
    expect(calls).not.toContainEqual(['add', '--', 'a.md'])
    expect(calls).not.toContainEqual(['-c', 'core.editor=true', 'rebase', '--continue'])
  })

  it('continueRebase proceeds when conflict markers are resolved', async () => {
    const dir = makeConflictFile('# title\nfinal content\n')
    const { run, calls } = mockRun([
      { args: ['diff', '--name-only', '--diff-filter=U'], result: { code: 0, stdout: 'a.md\n', stderr: '' } },
      { args: ['add', '--', 'a.md'], result: { code: 0, stdout: '', stderr: '' } },
      { args: ['-c', 'core.editor=true', 'rebase', '--continue'], result: { code: 0, stdout: '', stderr: '' } }
    ])
    const p = new GitSyncProvider(dir, run)
    const result = await p.continueRebase?.()
    expect(result?.success).toBe(true)
    expect(calls).toContainEqual(['add', '--', 'a.md'])
  })

  it('push uses -u origin HEAD when no upstream', async () => {
    const { run, calls } = mockRun([
      { args: ['symbolic-ref', '--short', 'HEAD'], result: { code: 0, stdout: 'main\n', stderr: '' } },
      { args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], result: { code: 1, stdout: '', stderr: 'no upstream' } },
      { args: ['push', '-u', 'origin', 'HEAD'], result: { code: 0, stdout: '', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    const result = await p.push()
    expect(result.success).toBe(true)
    expect(calls).toContainEqual(['push', '-u', 'origin', 'HEAD'])
  })

  it('commit runs add -A then commit -m', async () => {
    const { run, calls } = mockRun([
      { args: ['add', '-A'], result: { code: 0, stdout: '', stderr: '' } },
      { args: ['commit', '-m', '同步: x'], result: { code: 0, stdout: '', stderr: '' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    await p.commit('同步: x')
    expect(calls).toEqual([['add', '-A'], ['commit', '-m', '同步: x']])
  })

  it('branchInfo returns null when not on a branch', async () => {
    const { run } = mockRun([
      { args: ['symbolic-ref', '--short', 'HEAD'], result: { code: 1, stdout: '', stderr: 'detached' } }
    ])
    const p = new GitSyncProvider('C:/ws', run)
    await expect(p.branchInfo()).resolves.toBeNull()
  })
})

describe('autoResolveGitignoreConflict', () => {
  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-gitignore-'))
    dirsToClean.push(dir)
    return dir
  }

  it('unions ours and theirs lines and ensures .inkase', async () => {
    const dir = makeDir()
    const { run, calls } = mockRun([
      { args: ['diff', '--name-only', '--diff-filter=U'], result: { code: 0, stdout: '.gitignore\n', stderr: '' } },
      { args: ['show', ':2:.gitignore'], result: { code: 0, stdout: 'local\n', stderr: '' } },
      { args: ['show', ':3:.gitignore'], result: { code: 0, stdout: 'remote\n.inkase\n', stderr: '' } },
      { args: ['add', '--', '.gitignore'], result: { code: 0, stdout: '', stderr: '' } }
    ])
    const resolved = await autoResolveGitignoreConflict(dir, run)
    expect(resolved).toBe(true)
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')
    expect(content).toContain('local')
    expect(content).toContain('remote')
    expect(content).toContain('.inkase')
    expect(calls).toContainEqual(['add', '--', '.gitignore'])
  })

  it('dedupes identical lines across sides and appends .inkase when missing', async () => {
    const dir = makeDir()
    const { run } = mockRun([
      { args: ['diff', '--name-only', '--diff-filter=U'], result: { code: 0, stdout: '.gitignore\n', stderr: '' } },
      { args: ['show', ':2:.gitignore'], result: { code: 0, stdout: 'node_modules\nshared\n', stderr: '' } },
      { args: ['show', ':3:.gitignore'], result: { code: 0, stdout: 'node_modules\nother\n', stderr: '' } },
      { args: ['add', '--', '.gitignore'], result: { code: 0, stdout: '', stderr: '' } }
    ])
    const resolved = await autoResolveGitignoreConflict(dir, run)
    expect(resolved).toBe(true)
    const lines = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8').split(/\r?\n/)
    expect(lines.filter((l) => l.trim() === 'node_modules')).toHaveLength(1)
    expect(lines).toContain('shared')
    expect(lines).toContain('other')
    expect(lines).toContain('.inkase')
  })

  it('returns false when .gitignore is not among conflicted files', async () => {
    const dir = makeDir()
    const { run } = mockRun([
      { args: ['diff', '--name-only', '--diff-filter=U'], result: { code: 0, stdout: 'docs/a.md\n', stderr: '' } }
    ])
    const resolved = await autoResolveGitignoreConflict(dir, run)
    expect(resolved).toBe(false)
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false)
  })

  it('returns false when show fails', async () => {
    const dir = makeDir()
    const { run } = mockRun([
      { args: ['diff', '--name-only', '--diff-filter=U'], result: { code: 0, stdout: '.gitignore\n', stderr: '' } },
      { args: ['show', ':2:.gitignore'], result: { code: 1, stdout: '', stderr: 'fatal' } }
    ])
    const resolved = await autoResolveGitignoreConflict(dir, run)
    expect(resolved).toBe(false)
  })
})

describe('isUntrackedOverwrite', () => {
  it('matches untracked overwrite errors', () => {
    expect(isUntrackedOverwrite('error: The following untracked working tree files would be overwritten by merge: README.md')).toBe(true)
    expect(isUntrackedOverwrite('error: The following untracked working tree files would be overwritten by checkout: .gitignore')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isUntrackedOverwrite('error: Your local changes to the following files would be overwritten')).toBe(false)
    expect(isUntrackedOverwrite('CONFLICT (content)')).toBe(false)
    expect(isUntrackedOverwrite('')).toBe(false)
  })
})

describe('runGit', () => {
  it('returns numeric code -1 when process cannot be spawned', async () => {
    execFileMock.mockClear()
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: object, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
      const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      cb(err, '', '')
    })

    const result = await runGit(['--version'], 'C:/ws')

    expect(result.code).toBe(-1)
    expect(typeof result.code).toBe('number')
  })
})
