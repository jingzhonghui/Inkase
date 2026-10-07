import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { BranchInfo, SyncProvider, SyncResult, SyncStatus } from './types'

export interface GitCommandResult {
  code: number
  stdout: string
  stderr: string
}

/** 执行 git 命令。进程非零退出不 reject，通过 code 返回；无法启动进程时 code 为 -1。 */
export function runGit(args: string[], cwd: string): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        const errCode = (error as NodeJS.ErrnoException).code
        const code = typeof errCode === 'number' ? errCode : -1
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      } else {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
      }
    })
  })
}

/** 判断 push 失败是否因远端领先（非快进拒绝），需要先整合远端更新。 */
export function isNonFastForward(stderr: string): boolean {
  return /rejected|fetch first|non-fast-forward|failed to push/i.test(stderr)
}

/** 判断 pull --ff-only 失败是否因分叉（本地与远端各有新提交）。 */
export function isDiverged(stderr: string): boolean {
  return /fast-forward/i.test(stderr)
}

/** 判断 pull/checkout 失败是否因本地未跟踪文件会被远端同名文件覆盖。 */
export function isUntrackedOverwrite(output: string): boolean {
  return /untracked working tree files would be overwritten|The following untracked working tree files would be overwritten/i.test(output)
}

/**
 * 自动解决 .gitignore 冲突（行级 union 合并）。
 * 对当前 unmerged 列表中名为 .gitignore 的文件：取 ours(:2:) 与 theirs(:3:) 两侧内容，
 * 行合并去重并确保包含 .inkase，写回文件后 git add 标记已解决。
 * 返回是否处理了 .gitignore（未命中或失败返回 false）。
 */
export async function autoResolveGitignoreConflict(
  workspacePath: string,
  run: (args: string[], cwd: string) => Promise<GitCommandResult> = runGit
): Promise<boolean> {
  const list = await run(['diff', '--name-only', '--diff-filter=U'], workspacePath)
  if (list.code !== 0) return false
  const gitignore = list.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .find((f) => path.basename(f.replace(/\\/g, '/')) === '.gitignore')
  if (!gitignore) return false
  const ours = await run(['show', `:2:${gitignore}`], workspacePath)
  if (ours.code !== 0) return false
  const theirs = await run(['show', `:3:${gitignore}`], workspacePath)
  if (theirs.code !== 0) return false
  const merged = unionGitignoreLines(ours.stdout, theirs.stdout)
  try {
    fs.writeFileSync(path.join(workspacePath, gitignore), merged, 'utf-8')
  } catch {
    return false
  }
  const add = await run(['add', '--', gitignore], workspacePath)
  return add.code === 0
}

/** 行级 union 合并：保留两侧非空行、按出现顺序去重，并确保 .inkase 存在。 */
function unionGitignoreLines(ours: string, theirs: string): string {
  const seen = new Set<string>()
  const lines: string[] = []
  const push = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue
      if (seen.has(line.trim())) continue
      seen.add(line.trim())
      lines.push(line)
    }
  }
  push(ours)
  push(theirs)
  if (!seen.has('.inkase')) lines.push('.inkase')
  return lines.join('\n') + '\n'
}

/**
 * 解析 `git status --porcelain -b` 输出为 SyncStatus。
 * 优先级：rebase 中间态 > conflict > error(无上游) > pendingCommit > pendingPull > pendingPush > upToDate。
 */
export function parseStatus(porcelain: string): SyncStatus {
  const lines = porcelain.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return 'upToDate'
  const branchLine = lines.find((l) => l.startsWith('## '))
  const changes = lines.filter((l) => !l.startsWith('## '))

  // rebase 中间态（HEAD detached）：无论是否已解决，都视为冲突待处理
  if (branchLine && /^## HEAD \(no branch\)/.test(branchLine)) return 'conflict'

  const isUnmerged = (line: string): boolean =>
    /^[A-Z?]U[ \t]/.test(line) || /^U[A-Z?][ \t]/.test(line) || /^AA[ \t]/.test(line) || /^DD[ \t]/.test(line)
  if (changes.some(isUnmerged)) return 'conflict'

  const hasUpstream = !!branchLine?.match(/\.\.\.[^\s[]+/)
  if (!hasUpstream) return 'error'

  if (changes.length > 0) return 'pendingCommit'
  const behind = Number(branchLine?.match(/behind (\d+)/)?.[1] ?? 0)
  if (behind > 0) return 'pendingPull'
  const ahead = Number(branchLine?.match(/ahead (\d+)/)?.[1] ?? 0)
  if (ahead > 0) return 'pendingPush'
  return 'upToDate'
}

/** 判定 cwd 是否位于 git 仓库内 */
export async function isGitRepository(cwd: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--is-inside-work-tree'], cwd)
  return r.code === 0 && r.stdout.trim() === 'true'
}

/** 检测 git 是否已安装 */
export async function hasGitInstalled(): Promise<boolean> {
  const r = await runGit(['--version'], process.cwd())
  return r.code === 0
}

export class GitSyncProvider implements SyncProvider {
  readonly kind = 'git' as const
  constructor(
    readonly workspacePath: string,
    private readonly run: (args: string[], cwd: string) => Promise<GitCommandResult> = runGit
  ) {}

  private async getHead(): Promise<string | null> {
    const r = await this.run(['rev-parse', 'HEAD'], this.workspacePath)
    return r.code === 0 ? r.stdout.trim() : null
  }

  async branchInfo(): Promise<BranchInfo | null> {
    const r = await this.run(['symbolic-ref', '--short', 'HEAD'], this.workspacePath)
    if (r.code !== 0) return null
    const branch = r.stdout.trim()
    const u = await this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], this.workspacePath)
    return { branch, upstream: u.code === 0 ? u.stdout.trim() : null }
  }

  async status(): Promise<SyncStatus> {
    const r = await this.run(['status', '--porcelain', '-b'], this.workspacePath)
    if (r.code !== 0) return 'error'
    return parseStatus(r.stdout)
  }

  async commit(message: string): Promise<void> {
    const add = await this.run(['add', '-A'], this.workspacePath)
    if (add.code !== 0) throw new Error(add.stderr || 'git add 失败')
    const c = await this.run(['commit', '-m', message], this.workspacePath)
    if (c.code !== 0) throw new Error(c.stderr || 'git commit 失败')
  }

  async pull(): Promise<SyncResult> {
    const before = await this.getHead()
    const r = await this.run(['pull', '--ff-only'], this.workspacePath)
    if (r.code !== 0) {
      // 分叉（本地与远端各有新提交）：--ff-only 无法快进 → 自动 rebase 整合远端
      if (isDiverged(r.stderr)) {
        const rb = await this.run(['pull', '--rebase'], this.workspacePath)
        if (rb.code !== 0) {
          return { success: false, error: (rb.stderr || rb.stdout).trim() || 'git pull --rebase 失败' }
        }
        return this.afterPull(before)
      }
      return { success: false, error: (r.stderr || r.stdout).trim() || 'git pull 失败' }
    }
    return this.afterPull(before)
  }

  private async afterPull(before: string | null): Promise<SyncResult> {
    const after = await this.getHead()
    if (before && after && before !== after) {
      const d = await this.run(['diff', '--name-only', before, after], this.workspacePath)
      const changedFiles = d.stdout
        .split('\n')
        .filter(Boolean)
        .map((f) => path.join(this.workspacePath, f))
      return { success: true, changedFiles }
    }
    return { success: true }
  }

  async push(): Promise<SyncResult> {
    const info = await this.branchInfo()
    const args = info?.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']
    const r = await this.run(args, this.workspacePath)
    if (r.code !== 0) {
      // 非快进拒绝：远端有本地没有的提交 → 自动 rebase 整合后重试
      if (isNonFastForward(r.stderr)) {
        const rb = await this.run(['pull', '--rebase'], this.workspacePath)
        if (rb.code !== 0) {
          return { success: false, error: (rb.stderr || rb.stdout).trim() || 'git pull --rebase 失败' }
        }
        const retry = await this.run(args, this.workspacePath)
        if (retry.code !== 0) {
          return { success: false, error: (retry.stderr || retry.stdout).trim() || 'git push 失败' }
        }
      } else {
        return { success: false, error: (r.stderr || r.stdout).trim() || 'git push 失败' }
      }
    }
    return { success: true }
  }

  async conflictedFiles(): Promise<string[]> {
    const r = await this.run(['diff', '--name-only', '--diff-filter=U'], this.workspacePath)
    if (r.code !== 0) return []
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((f) => path.join(this.workspacePath, f))
  }

  async rebaseInProgress(): Promise<boolean> {
    const r = await this.run(['rev-parse', '-q', '--verify', 'REBASE_HEAD'], this.workspacePath)
    return r.code === 0
  }

  async continueRebase(): Promise<SyncResult> {
    const conflicted = await this.conflictedFiles()
    if (conflicted.length > 0) {
      // 校验是否仍有未解决的冲突标记（<<<<<<< / >>>>>>>）
      const unresolved = conflicted.filter((f) => this.hasUnresolvedMarkers(f))
      if (unresolved.length > 0) {
        const names = unresolved.map((f) => path.relative(this.workspacePath, f).split(path.sep).join('/'))
        return { success: false, error: `以下文件仍存在未解决的冲突标记，请先编辑并保存：\n- ${names.join('\n- ')}` }
      }
      const relative = conflicted.map((f) => path.relative(this.workspacePath, f).split(path.sep).join('/'))
      await this.run(['add', '--'].concat(relative), this.workspacePath)
    }
    const r = await this.run(['-c', 'core.editor=true', 'rebase', '--continue'], this.workspacePath)
    if (r.code !== 0) {
      return { success: false, error: (r.stderr || r.stdout).trim() || 'git rebase --continue 失败' }
    }
    return { success: true }
  }

  private hasUnresolvedMarkers(filePath: string): boolean {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return /^<<<<<<<|^>>>>>>>/m.test(content)
    } catch {
      return false
    }
  }

  async abortRebase(): Promise<SyncResult> {
    const r = await this.run(['rebase', '--abort'], this.workspacePath)
    if (r.code !== 0) {
      return { success: false, error: (r.stderr || r.stdout).trim() || 'git rebase --abort 失败' }
    }
    return { success: true }
  }

  dispose(): void {
    /* git provider 无资源需要释放 */
  }
}
