import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SyncEngine } from '../engine'
import type { SyncConfig, SyncProvider, SyncResult, SyncStatus } from '../types'
import type { GitCommandResult } from '../git-provider'

const dirsToClean: string[] = []

function makeProvider(overrides: Partial<SyncProvider> = {}): SyncProvider {
  return {
    kind: 'git',
    workspacePath: 'C:/ws',
    status: vi.fn(async (): Promise<SyncStatus> => 'upToDate'),
    pull: vi.fn(async (): Promise<SyncResult> => ({ success: true })),
    push: vi.fn(async (): Promise<SyncResult> => ({ success: true })),
    commit: vi.fn(async () => {}),
    branchInfo: vi.fn(async () => ({ branch: 'main', upstream: 'origin/main' })),
    conflictedFiles: vi.fn(async (): Promise<string[]> => []),
    rebaseInProgress: vi.fn(async (): Promise<boolean> => false),
    continueRebase: vi.fn(async (): Promise<SyncResult> => ({ success: true })),
    abortRebase: vi.fn(async (): Promise<SyncResult> => ({ success: true })),
    dispose: vi.fn(),
    ...overrides
  }
}

function makeEngine(
  opts: {
    configured?: boolean
    isGitRepo?: boolean
    fetchOk?: boolean
    hasRemoteBranch?: boolean
    hasHead?: boolean
    defaultBranch?: string | null
    currentBranch?: string | null
    porcelain?: string
    gitignoreConflict?: boolean
    gitignoreOurs?: string
    gitignoreTheirs?: string
  } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-sync-engine-'))
  dirsToClean.push(dir)
  if (opts.configured !== false) {
    fs.mkdirSync(path.join(dir, '.inkase'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.inkase', 'sync.json'),
      JSON.stringify({ version: 1, provider: 'git', autoCommit: true, autoPull: true, autoPush: false }),
      'utf-8'
    )
  }
  const fetchOk = opts.fetchOk ?? true
  const hasRemoteBranch = opts.hasRemoteBranch ?? true
  const hasHead = opts.hasHead ?? true
  const defaultBranch = opts.defaultBranch === undefined ? 'main' : opts.defaultBranch
  const currentBranch = opts.currentBranch === undefined ? 'main' : opts.currentBranch
  const porcelain = opts.porcelain ?? ''
  const provider = makeProvider()
  let watcherCallback: (files: string[]) => void = () => {}
  const watcher = { dispose: vi.fn() }
  const deps = {
    createProvider: vi.fn((_p: string, _c: SyncConfig) => provider),
    createWatcher: vi.fn((_p: string, cb: (files: string[]) => void) => {
      watcherCallback = cb
      return watcher
    }),
    runGit: vi.fn(async (args: string[]): Promise<GitCommandResult> => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return { code: 0, stdout: opts.isGitRepo === false ? 'false\n' : 'true\n', stderr: '' }
      }
      if (args[0] === 'init') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'remote' && args[1] === 'add') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'add') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'commit') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'fetch') {
        return fetchOk ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'Could not resolve host: gitee.com' }
      }
      if (args[0] === 'symbolic-ref' && args[1] === '--short') {
        return currentBranch ? { code: 0, stdout: `${currentBranch}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--quiet') {
        return hasRemoteBranch ? { code: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' } : { code: 1, stdout: '', stderr: '' }
      }
      if (args[0] === 'branch') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return hasHead ? { code: 0, stdout: 'head\n', stderr: '' } : { code: 1, stdout: '', stderr: 'no head' }
      }
      if (args[0] === 'ls-remote' && args[1] === '--symref') {
        return defaultBranch
          ? { code: 0, stdout: `ref: refs/heads/${defaultBranch}\tHEAD\nxxxx\tHEAD\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'could not find ref' }
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return { code: 0, stdout: porcelain, stderr: '' }
      }
      if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === '--diff-filter=U') {
        return opts.gitignoreConflict ? { code: 0, stdout: '.gitignore\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'show' && args[1] === ':2:.gitignore') return { code: 0, stdout: opts.gitignoreOurs ?? '', stderr: '' }
      if (args[0] === 'show' && args[1] === ':3:.gitignore') return { code: 0, stdout: opts.gitignoreTheirs ?? '', stderr: '' }
      if (args[0] === 'checkout') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
  }
  const engine = new SyncEngine(deps)
  return { engine, provider, watcher, deps, dir, triggerWatcher: (files: string[]) => watcherCallback(files) }
}

describe('SyncEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirsToClean) fs.rmSync(dir, { recursive: true, force: true })
    dirsToClean.length = 0
  })

  it('attach with config creates provider and watcher', async () => {
    const { engine, provider, watcher, dir } = makeEngine()
    await engine.attach(dir)
    expect(engine.getStatusView().configured).toBe(true)
    expect(provider.status).toHaveBeenCalled()
    expect(watcher.dispose).not.toHaveBeenCalled()
  })

  it('attach without config sets uninitialized and isGitRepo', async () => {
    const { engine, dir } = makeEngine({ isGitRepo: true, configured: false })
    await engine.attach(dir)
    const view = engine.getStatusView()
    expect(view.configured).toBe(false)
    expect(view.isGitRepo).toBe(true)
    expect(view.status).toBe('uninitialized')
  })

  it('pull executes provider.pull and emits event', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    const events: unknown[] = []
    engine.onEvent((v) => events.push(v.status))
    const result = await engine.pull()
    expect(result.success).toBe(true)
    expect(provider.pull).toHaveBeenCalled()
    expect(events).toContain('upToDate')
  })

  it('pull returns error when config missing (SYNC_NOT_CONFIGURED)', async () => {
    const { engine, dir } = makeEngine({ configured: false })
    await engine.attach(dir)
    const result = await engine.pull()
    expect(result.success).toBe(false)
    expect(result.error).toBe('SYNC_NOT_CONFIGURED')
  })

  it('enable initializes git repo when absent and saves config', async () => {
    const { engine, deps, dir } = makeEngine({ isGitRepo: false })
    await engine.attach(dir)
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git', autoPush: true })
    expect(result.success).toBe(true)
    expect(deps.runGit).toHaveBeenCalledWith(['init'], dir)
    expect(engine.getConfig()).toMatchObject({ provider: 'git', autoPush: true })
  })

  it('serializes concurrent push calls via busy flag', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    ;(provider.push as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { success: true }
    })
    const [a, b] = await Promise.all([engine.push(), engine.push()])
    expect(a.success).toBe(true)
    expect(b.success).toBe(false)
    expect(b.error).toContain('同步进行中')
  })

  it('disable clears provider and config', async () => {
    const { engine, dir } = makeEngine()
    await engine.attach(dir)
    engine.disable()
    const view = engine.getStatusView()
    expect(view.configured).toBe(false)
    expect(engine.getConfig()).toBeNull()
  })

  it('disable deletes sync.json on disk', async () => {
    const { engine, dir } = makeEngine()
    await engine.attach(dir)
    const configPath = path.join(dir, '.inkase', 'sync.json')
    expect(fs.existsSync(configPath)).toBe(true)
    engine.disable()
    expect(fs.existsSync(configPath)).toBe(false)
    const view = engine.getStatusView()
    expect(view.configured).toBe(false)
  })

  it('disable removes .git and .gitignore', async () => {
    const { engine, dir } = makeEngine()
    await engine.attach(dir)
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.gitignore'), '.inkase\n', 'utf-8')
    engine.disable()
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false)
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false)
    expect(fs.existsSync(path.join(dir, '.inkase', 'sync.json'))).toBe(false)
  })

  it('enable sets error status when remote set-url fails', async () => {
    const { engine, deps, dir } = makeEngine({ isGitRepo: true })
    await engine.attach(dir)
    ;(deps.runGit as ReturnType<typeof vi.fn>).mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') return { code: 1, stdout: '', stderr: 'bad remote' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(false)
    expect(result.error).toBe('bad remote')
    const view = engine.getStatusView()
    expect(view.status).toBe('error')
    expect(view.error).toBe('bad remote')
  })

  it('enable sets error status when git init fails', async () => {
    const { engine, deps, dir } = makeEngine({ isGitRepo: false })
    await engine.attach(dir)
    ;(deps.runGit as ReturnType<typeof vi.fn>).mockImplementation(async (args: string[]) => {
      if (args[0] === 'init') return { code: 1, stdout: '', stderr: 'init failed' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(false)
    expect(result.error).toBe('init failed')
    const view = engine.getStatusView()
    expect(view.status).toBe('error')
    expect(view.error).toBe('init failed')
  })

  it('enable fetches remote and sets upstream so pull can work', async () => {
    const { engine, deps, dir } = makeEngine({ isGitRepo: true })
    await engine.attach(dir)
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(deps.runGit).toHaveBeenCalledWith(['fetch', 'origin'], dir)
    expect(deps.runGit).toHaveBeenCalledWith(['branch', '--set-upstream-to', 'origin/main', 'main'], dir)
  })

  it('enable keeps configured but reports error when fetch fails', async () => {
    const { engine, dir } = makeEngine({ isGitRepo: true, fetchOk: false })
    await engine.attach(dir)
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(engine.getConfig()).not.toBeNull()
    const view = engine.getStatusView()
    expect(view.status).toBe('error')
    expect(view.error).toContain('Could not resolve host')
  })

  it('enable skips upstream when remote lacks the branch', async () => {
    const { engine, deps, dir } = makeEngine({ isGitRepo: true, hasRemoteBranch: false })
    await engine.attach(dir)
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(deps.runGit).toHaveBeenCalledWith(['fetch', 'origin'], dir)
    expect(deps.runGit).not.toHaveBeenCalledWith(['branch', '--set-upstream-to', 'origin/main', 'main'], dir)
  })

  it('enable returns error when workspace path is empty', async () => {
    const { engine, dir } = makeEngine()
    await engine.attach(dir)
    const result = await engine.enable('', { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(false)
    expect(result.error).toBe('未打开工作区')
  })

  it('enable creates .gitignore only after aligning remote via pull', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(provider.pull).toHaveBeenCalled()
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')
    expect(content).toContain('.inkase')
  })

  it('enable does not create .gitignore when pull enters conflict', async () => {
    const { engine, provider, dir } = makeEngine()
    ;(provider.pull as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'CONFLICT' })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('conflict').mockResolvedValue('conflict')
    ;(provider.conflictedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['C:/ws/docs/a.md'])
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(engine.getStatusView().status).toBe('conflict')
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false)
  })

  it('enable appends .inkase to a remote-provided .gitignore without conflict markers', async () => {
    const { engine, dir } = makeEngine()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n', 'utf-8')
    await engine.attach(dir)
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')
    expect(content).toContain('node_modules')
    expect(content).toContain('.inkase')
    expect(content).not.toMatch(/<<<<<<<|>>>>>>>/)
  })

  it('enable auto-resolves a .gitignore-only conflict and continues rebase', async () => {
    const { engine, provider, dir } = makeEngine({
      gitignoreConflict: true,
      gitignoreOurs: 'local\n',
      gitignoreTheirs: 'remote\n'
    })
    ;(provider.pull as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'CONFLICT' })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('conflict').mockResolvedValue('upToDate')
    ;(provider.conflictedFiles as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(provider.continueRebase).toHaveBeenCalled()
    expect(engine.getStatusView().status).toBe('upToDate')
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')
    expect(content).toContain('local')
    expect(content).toContain('remote')
    expect(content).toContain('.inkase')
  })

  it('enable keeps conflict state when non-gitignore files conflict', async () => {
    const { engine, provider, dir } = makeEngine()
    ;(provider.pull as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'CONFLICT' })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('conflict').mockResolvedValue('conflict')
    ;(provider.conflictedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['C:/ws/docs/a.md'])
    const changed: string[][] = []
    await engine.attach(dir)
    engine.onFileChanged((files) => changed.push(files))
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    const view = engine.getStatusView()
    expect(view.status).toBe('conflict')
    expect(view.conflictedFiles).toEqual(['C:/ws/docs/a.md'])
    expect(changed).toContainEqual(['C:/ws/docs/a.md'])
  })

  it('enable commits local content when remote is empty (empty repo, pending push)', async () => {
    const { engine, provider, dir } = makeEngine({ hasRemoteBranch: false, porcelain: '?? notes.md\n' })
    await engine.attach(dir)
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(provider.commit).toHaveBeenCalledWith('init')
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(true)
  })

  it('enable reports friendly error when pull hits untracked overwrite (scenario 5)', async () => {
    const { engine, provider, dir } = makeEngine()
    ;(provider.pull as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'fatal: The following untracked working tree files would be overwritten by checkout: README.md'
    })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValue('pendingCommit')
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(false)
    expect(engine.getStatusView().status).toBe('error')
    expect(engine.getStatusView().error).toContain('同名')
  })

  it('enable renames local branch to align with remote default branch (scenario 9)', async () => {
    const { engine, deps, dir } = makeEngine({ currentBranch: 'master', defaultBranch: 'main' })
    await engine.attach(dir)
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(deps.runGit).toHaveBeenCalledWith(['branch', '-m', 'main'], dir)
    expect(deps.runGit).toHaveBeenCalledWith(['branch', '--set-upstream-to', 'origin/main', 'main'], dir)
  })

  it('enable skips upstream setup when remote default branch is absent (empty repo)', async () => {
    const { engine, deps, dir } = makeEngine({ defaultBranch: null, hasHead: false, porcelain: '?? a.md\n' })
    await engine.attach(dir)
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(deps.runGit).not.toHaveBeenCalledWith(['branch', '--set-upstream-to', 'origin/main', 'main'], dir)
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(true)
  })

  it('enable checks out remote default branch when local has no head (scenario 3/4)', async () => {
    const { engine, deps, provider, dir } = makeEngine({ hasHead: false, defaultBranch: 'main', porcelain: '?? notes.md\n' })
    await engine.attach(dir)
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(deps.runGit).toHaveBeenCalledWith(['checkout', '-b', 'main', '--track', 'origin/main'], dir)
    expect(provider.commit).toHaveBeenCalledWith('init')
  })

  it('pull failure sets error status and message', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    ;(provider.pull as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'Not possible to fast-forward' })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('pendingCommit')
    const result = await engine.pull()
    expect(result.success).toBe(false)
    expect(result.error).toBe('Not possible to fast-forward')
    const view = engine.getStatusView()
    expect(view.status).toBe('error')
    expect(view.error).toBe('Not possible to fast-forward')
  })

  it('pull failure surfaces conflict status when working tree reports conflict', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    ;(provider.pull as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'Not possible to fast-forward' })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('conflict')
    await engine.pull()
    const view = engine.getStatusView()
    expect(view.status).toBe('conflict')
    expect(view.error).toBe('Not possible to fast-forward')
  })

  it('push failure sets error status and message', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    ;(provider.push as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'Authentication failed' })
    const result = await engine.push()
    expect(result.success).toBe(false)
    expect(result.error).toBe('Authentication failed')
    const view = engine.getStatusView()
    expect(view.status).toBe('error')
    expect(view.error).toBe('Authentication failed')
  })

  it('manual push commits pending local changes before pushing when autoCommit disabled', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    engine.setConfig({ autoCommit: false })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('pendingCommit')
    const result = await engine.push()
    expect(result.success).toBe(true)
    expect(provider.commit).toHaveBeenCalledTimes(1)
    expect(provider.push).toHaveBeenCalledTimes(1)
    const commitOrder = (provider.commit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const pushOrder = (provider.push as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(commitOrder).toBeLessThan(pushOrder)
  })

  it('manual push does not commit when no pending changes', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('upToDate')
    const result = await engine.push()
    expect(result.success).toBe(true)
    expect(provider.commit).not.toHaveBeenCalled()
    expect(provider.push).toHaveBeenCalledTimes(1)
  })

  it('manual push surfaces commit failure when pending changes cannot be committed', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('pendingCommit')
    ;(provider.commit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('git commit failed'))
    const result = await engine.push()
    expect(result.success).toBe(false)
    expect(result.error).toContain('git commit failed')
    expect(provider.push).not.toHaveBeenCalled()
  })

  it('push failure surfaces conflict status when status reports conflict', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    ;(provider.push as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'CONFLICT' })
    // push 前状态检查与失败后 refreshStatus 各消耗一次 conflict
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('conflict')
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('conflict')
    ;(provider.conflictedFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['C:/ws/docs/a.md'])
    ;(provider.rebaseInProgress as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true)
    const result = await engine.push()
    expect(result.success).toBe(false)
    const view = engine.getStatusView()
    expect(view.status).toBe('conflict')
    expect(view.conflictedFiles).toEqual(['C:/ws/docs/a.md'])
    expect(view.inRebase).toBe(true)
  })

  it('pull failure emits conflicted files to renderer', async () => {
    const { engine, provider, dir } = makeEngine()
    await engine.attach(dir)
    const changed: string[][] = []
    engine.onFileChanged((files) => changed.push(files))
    ;(provider.pull as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'CONFLICT' })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('conflict')
    ;(provider.conflictedFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['C:/ws/docs/a.md'])
    await engine.pull()
    expect(changed).toContainEqual(['C:/ws/docs/a.md'])
  })

  it('continueRebase forwards to provider when in conflict', async () => {
    const { engine, provider, dir } = makeEngine()
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValue('conflict')
    await engine.attach(dir)
    const result = await engine.continueRebase()
    expect(result.success).toBe(true)
    expect(provider.continueRebase).toHaveBeenCalled()
  })

  it('continueRebase returns error when not in conflict', async () => {
    const { engine, dir } = makeEngine()
    await engine.attach(dir)
    const result = await engine.continueRebase()
    expect(result.success).toBe(false)
    expect(result.error).toContain('不在冲突状态')
    expect(engine.getStatusView().status).toBe('upToDate')
  })

  it('abortRebase forwards to provider when in conflict', async () => {
    const { engine, provider, dir } = makeEngine()
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValue('conflict')
    await engine.attach(dir)
    const result = await engine.abortRebase()
    expect(result.success).toBe(true)
    expect(provider.abortRebase).toHaveBeenCalled()
  })

  it('abortRebase returns error when not in conflict', async () => {
    const { engine, dir } = makeEngine()
    await engine.attach(dir)
    const result = await engine.abortRebase()
    expect(result.success).toBe(false)
    expect(result.error).toContain('不在冲突状态')
  })

  it('autoCommit pushes after commit when autoPush enabled', async () => {
    const { engine, provider, triggerWatcher, dir } = makeEngine()
    await engine.attach(dir)
    engine.setConfig({ autoPush: true })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('pendingCommit')
    triggerWatcher(['C:/ws/a.md'])
    await vi.waitFor(() => expect(provider.commit).toHaveBeenCalled())
    await vi.waitFor(() => expect(provider.push).toHaveBeenCalled())
  })

  it('autoCommit does not push when autoPush disabled', async () => {
    const { engine, provider, triggerWatcher, dir } = makeEngine()
    await engine.attach(dir)
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('pendingCommit')
    triggerWatcher(['C:/ws/a.md'])
    await vi.waitFor(() => expect(provider.commit).toHaveBeenCalled())
    expect(provider.push).not.toHaveBeenCalled()
  })

  it('autoCommit disabled does not commit on watcher changes', async () => {
    const { engine, provider, triggerWatcher, dir } = makeEngine()
    await engine.attach(dir)
    engine.setConfig({ autoCommit: false })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValue('pendingCommit')
    triggerWatcher(['C:/ws/a.md'])
    await new Promise((r) => setTimeout(r, 50))
    expect(provider.commit).not.toHaveBeenCalled()
  })

  it('autoCommit disabled still refreshes status to pendingCommit on watcher changes', async () => {
    const { engine, provider, triggerWatcher, dir } = makeEngine()
    await engine.attach(dir)
    engine.setConfig({ autoCommit: false })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValue('pendingCommit')
    const events: string[] = []
    engine.onEvent((v) => events.push(v.status))
    triggerWatcher(['C:/ws/a.md'])
    await vi.waitFor(() => expect(engine.getStatusView().status).toBe('pendingCommit'))
    expect(events).toContain('pendingCommit')
  })

  it('attach entering conflict emits conflicted files to renderer', async () => {
    const { engine, provider, dir } = makeEngine()
    const changed: string[][] = []
    engine.onFileChanged((files) => changed.push(files))
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValue('conflict')
    ;(provider.conflictedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['C:/ws/docs/a.md'])
    await engine.attach(dir)
    expect(changed).toContainEqual(['C:/ws/docs/a.md'])
    expect(engine.getStatusView().conflictedFiles).toEqual(['C:/ws/docs/a.md'])
  })

  it('autoCommit push conflict emits conflicted files to renderer', async () => {
    const { engine, provider, triggerWatcher, dir } = makeEngine()
    await engine.attach(dir)
    engine.setConfig({ autoPush: true })
    const changed: string[][] = []
    engine.onFileChanged((files) => changed.push(files))
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce('pendingCommit')
    ;(provider.push as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'CONFLICT' })
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValue('conflict')
    ;(provider.conflictedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['C:/ws/docs/a.md'])
    triggerWatcher(['C:/ws/a.md'])
    await vi.waitFor(() => expect(provider.commit).toHaveBeenCalled())
    await vi.waitFor(() => expect(provider.push).toHaveBeenCalled())
    await vi.waitFor(() => expect(changed).toContainEqual(['C:/ws/docs/a.md']))
    expect(engine.getStatusView().status).toBe('conflict')
  })

  it('enable entering conflict emits conflicted files to renderer', async () => {
    const { engine, provider, dir } = makeEngine({ isGitRepo: true })
    await engine.attach(dir)
    const changed: string[][] = []
    engine.onFileChanged((files) => changed.push(files))
    ;(provider.status as ReturnType<typeof vi.fn>).mockResolvedValue('conflict')
    ;(provider.conflictedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['C:/ws/docs/a.md'])
    const result = await engine.enable(dir, { remoteUrl: 'https://x/repo.git' })
    expect(result.success).toBe(true)
    expect(changed).toContainEqual(['C:/ws/docs/a.md'])
    expect(engine.getStatusView().conflictedFiles).toEqual(['C:/ws/docs/a.md'])
  })
})
