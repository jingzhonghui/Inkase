import * as fs from 'fs'
import * as path from 'path'
import type {
  EnableSyncOptions,
  SyncConfig,
  SyncProvider,
  SyncResult,
  SyncStatus,
  SyncStatusView
} from './types'
import { autoResolveGitignoreConflict, isUntrackedOverwrite } from './git-provider'
import type { GitCommandResult } from './git-provider'
import { ensureInkaseIgnored, loadSyncConfig, saveSyncConfig, syncConfigPath } from './config'

export interface SyncEngineDeps {
  createProvider: (workspacePath: string, config: SyncConfig) => SyncProvider
  createWatcher: (workspacePath: string, onChanges: (files: string[]) => void) => { dispose(): void }
  runGit: (args: string[], cwd: string) => Promise<GitCommandResult>
}

/**
 * 同步引擎（主进程单例）。管理当前工作区的 provider、状态机、watcher 生命周期。
 */
export class SyncEngine {
  private workspacePath: string | null = null
  private provider: SyncProvider | null = null
  private watcher: { dispose(): void } | null = null
  private config: SyncConfig | null = null
  private isGitRepo = false
  private currentStatus: SyncStatus = 'uninitialized'
  private error: string | null = null
  private branch: string | null = null
  private upstream: string | null = null
  private conflictedFiles: string[] = []
  private inRebase = false
  private busy = false
  private eventCbs: Array<(view: SyncStatusView) => void> = []
  private fileCbs: Array<(files: string[]) => void> = []

  constructor(private readonly deps: SyncEngineDeps) {}

  getStatusView(): SyncStatusView {
    return {
      status: this.currentStatus,
      error: this.error,
      configured: this.provider !== null,
      isGitRepo: this.isGitRepo,
      branch: this.branch,
      upstream: this.upstream,
      conflictedFiles: this.conflictedFiles,
      inRebase: this.inRebase
    }
  }

  getConfig(): SyncConfig | null {
    return this.config
  }

  onEvent(cb: (view: SyncStatusView) => void): void {
    this.eventCbs.push(cb)
  }

  onFileChanged(cb: (files: string[]) => void): void {
    this.fileCbs.push(cb)
  }

  private emit(): void {
    const view = this.getStatusView()
    for (const cb of this.eventCbs) cb(view)
  }

  private emitFiles(files: string[]): void {
    for (const cb of this.fileCbs) cb(files)
  }

  async attach(workspacePath: string): Promise<void> {
    this.detach()
    this.workspacePath = workspacePath
    this.config = loadSyncConfig(workspacePath)
    this.isGitRepo = await this.isGitRepoAt(workspacePath)

    if (this.config) {
      this.provider = this.deps.createProvider(workspacePath, this.config)
      this.watcher = this.deps.createWatcher(workspacePath, (files) => this.onWorkspaceChanges(files))
      await this.refreshStatus()
      if (this.config.autoPull) {
        const info = this.provider.branchInfo ? await this.provider.branchInfo() : null
        if (info?.upstream) {
          const r = await this.pullInternal()
          if (r.success && r.changedFiles && r.changedFiles.length > 0) {
            this.emitFiles(r.changedFiles)
          }
        }
      }
    } else {
      this.currentStatus = 'uninitialized'
    }
    this.emit()
  }

  detach(): void {
    this.watcher?.dispose()
    this.watcher = null
    this.provider?.dispose()
    this.provider = null
    this.config = null
    this.workspacePath = null
    this.currentStatus = 'uninitialized'
    this.error = null
    this.branch = null
    this.upstream = null
    this.conflictedFiles = []
    this.inRebase = false
    this.isGitRepo = false
  }

  disable(): void {
    const workspacePath = this.workspacePath
    this.detach()
    if (workspacePath) {
      const configPath = syncConfigPath(workspacePath)
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath)
      // 停用同步：删除 git 仓库与 .gitignore（.inkase 目录保留，可能含 AI 会话等其它数据）
      const gitDir = path.join(workspacePath, '.git')
      if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true })
      const gitignorePath = path.join(workspacePath, '.gitignore')
      if (fs.existsSync(gitignorePath)) fs.unlinkSync(gitignorePath)
    }
    this.emit()
  }

  async pull(): Promise<SyncResult> {
    if (this.busy) return { success: false, error: '同步进行中，请稍候' }
    if (!this.provider) return { success: false, error: 'SYNC_NOT_CONFIGURED' }
    this.busy = true
    this.currentStatus = 'syncing'
    this.error = null
    this.emit()
    try {
      return await this.pullInternal()
    } finally {
      this.busy = false
    }
  }

  private async pullInternal(): Promise<SyncResult> {
    if (!this.provider) return { success: false, error: 'SYNC_NOT_CONFIGURED' }
    const result = await this.provider.pull()
    if (!result.success) {
      const st = await this.refreshStatus()
      if (st !== 'conflict') this.currentStatus = 'error'
      this.error = result.error ?? '拉取失败'
      this.emit()
      return result
    }
    await this.refreshStatus()
    this.emit()
    return result
  }

  async push(): Promise<SyncResult> {
    if (this.busy) return { success: false, error: '同步进行中，请稍候' }
    if (!this.provider) return { success: false, error: 'SYNC_NOT_CONFIGURED' }
    this.busy = true
    this.currentStatus = 'syncing'
    this.error = null
    this.emit()
    try {
      const st = await this.provider.status()
      if (st === 'pendingCommit') {
        try {
          await this.provider.commit(`同步: ${new Date().toISOString()}`)
        } catch (e) {
          this.currentStatus = 'error'
          this.error = e instanceof Error ? e.message : '提交失败'
          this.emit()
          return { success: false, error: this.error }
        }
      }
      const result = await this.provider.push()
      if (!result.success) {
        const st = await this.refreshStatus()
        if (st !== 'conflict') this.currentStatus = 'error'
        this.error = result.error ?? '推送失败'
        this.emit()
        return result
      }
      await this.refreshStatus()
      this.emit()
      return result
    } finally {
      this.busy = false
    }
  }

  /** 继续 rebase（解决冲突后调用；仅冲突状态可用） */
  async continueRebase(): Promise<SyncResult> {
    if (this.busy) return { success: false, error: '同步进行中，请稍候' }
    if (!this.provider?.continueRebase) return { success: false, error: '当前提供者不支持此操作' }
    if (this.currentStatus !== 'conflict') return { success: false, error: '当前不在冲突状态' }
    this.busy = true
    try {
      const result = await this.provider.continueRebase()
      if (!result.success) {
        this.error = result.error ?? '继续合并失败'
        this.emit()
        return result
      }
      await this.refreshStatus()
      this.emit()
      return result
    } finally {
      this.busy = false
    }
  }

  /** 中止 rebase（放弃本次合并；仅冲突状态可用） */
  async abortRebase(): Promise<SyncResult> {
    if (this.busy) return { success: false, error: '同步进行中，请稍候' }
    if (!this.provider?.abortRebase) return { success: false, error: '当前提供者不支持此操作' }
    if (this.currentStatus !== 'conflict') return { success: false, error: '当前不在冲突状态' }
    this.busy = true
    try {
      const result = await this.provider.abortRebase()
      if (!result.success) {
        this.error = result.error ?? '中止合并失败'
        this.emit()
        return result
      }
      await this.refreshStatus()
      this.emit()
      return result
    } finally {
      this.busy = false
    }
  }

  async enable(workspacePath: string, options: EnableSyncOptions): Promise<SyncResult> {
    if (this.busy) return { success: false, error: '同步进行中，请稍候' }
    if (!workspacePath) return { success: false, error: '未打开工作区' }
    this.busy = true
    this.currentStatus = 'syncing'
    this.error = null
    this.emit()
    try {
      this.detach()
      this.workspacePath = workspacePath
      this.isGitRepo = await this.isGitRepoAt(workspacePath)
      if (!this.isGitRepo) {
        const r = await this.deps.runGit(['init'], workspacePath)
        if (r.code !== 0) {
          const error = r.stderr.trim() || 'git init 失败'
          this.currentStatus = 'error'
          this.error = error
          this.emit()
          return { success: false, error }
        }
        this.isGitRepo = true
      }
      if (options.remoteUrl) {
        const add = await this.deps.runGit(['remote', 'add', 'origin', options.remoteUrl], workspacePath)
        if (add.code !== 0) {
          const set = await this.deps.runGit(['remote', 'set-url', 'origin', options.remoteUrl], workspacePath)
          if (set.code !== 0) {
            const error = set.stderr.trim() || '配置远程地址失败'
            this.currentStatus = 'error'
            this.error = error
            this.emit()
            return { success: false, error }
          }
        }
      }
      // 保存配置并提前创建 provider，供后续 pull/commit/push 复用
      this.config = {
        version: 1,
        provider: 'git',
        autoCommit: options.autoCommit ?? true,
        autoPull: options.autoPull ?? true,
        autoPush: options.autoPush ?? false
      }
      saveSyncConfig(workspacePath, this.config)
      this.provider = this.deps.createProvider(workspacePath, this.config)

      let remoteError: string | null = null
      let align: 'ok' | 'conflict' | 'error' = 'ok'
      if (options.remoteUrl) {
        const fetch = await this.deps.runGit(['fetch', 'origin'], workspacePath)
        if (fetch.code !== 0) {
          remoteError = (fetch.stderr || fetch.stdout).trim() || '远程拉取失败（请检查网络或认证）'
        } else {
          align = await this.alignRemote(workspacePath)
        }
      }

      // 对齐进入冲突状态 → 交给用户在面板解决，返回后由事件推送冲突文件
      if (align === 'conflict') {
        this.watcher = this.deps.createWatcher(workspacePath, (files) => this.onWorkspaceChanges(files))
        await this.refreshStatus()
        if (this.conflictedFiles.length > 0) this.emitFiles(this.conflictedFiles)
        this.emit()
        return { success: true }
      }
      // 对齐失败（如同名未跟踪文件被远端覆盖）→ 返回错误，配置保留，用户处理后可重试
      if (align === 'error') {
        const err = this.error ?? '拉取失败'
        this.watcher = this.deps.createWatcher(workspacePath, (files) => this.onWorkspaceChanges(files))
        this.emit()
        return { success: false, error: err }
      }

      // 对齐成功（含空远端）：此时再创建/追加 .gitignore，避免先动 .gitignore 造成首次同步冲突
      ensureInkaseIgnored(workspacePath)
      // 本地有变更（首次内容 + .gitignore 等）则提交；空提交 guard 已由 porcelain 判断
      const porcelain = await this.deps.runGit(['status', '--porcelain'], workspacePath)
      if (porcelain.code === 0 && porcelain.stdout.trim() !== '') {
        try {
          await this.provider.commit('init')
        } catch (e) {
          this.error = e instanceof Error ? e.message : '首次提交失败'
        }
        if (this.config.autoPush && !this.error) {
          const pushResult = await this.provider.push()
          if (!pushResult.success) {
            const st = await this.refreshStatus()
            if (st !== 'conflict') this.currentStatus = 'error'
            this.error = pushResult.error ?? '自动推送失败'
          }
        }
      }

      this.watcher = this.deps.createWatcher(workspacePath, (files) => this.onWorkspaceChanges(files))
      await this.refreshStatus()
      // fetch 失败（网络/认证）不阻塞配置保存，但以错误状态呈现，提示用户检查后重试
      if (remoteError) {
        this.currentStatus = 'error'
        this.error = remoteError
      }
      this.emit()
      return { success: true }
    } catch (e) {
      this.currentStatus = 'error'
      this.error = e instanceof Error ? e.message : '启用同步失败'
      this.emit()
      return { success: false, error: this.error }
    } finally {
      this.busy = false
    }
  }

  /**
   * 对齐远端内容（仅在 fetch 成功后调用）：
   * - 本地已有历史：处理分支名不匹配（自动重命名对齐远端默认分支）→ 建立 upstream → pull
   * - 本地无历史：检出远端默认分支到工作区
   * 返回 'ok'（含空远端）/ 'conflict'（进入冲突状态）/ 'error'（对齐失败）。
   */
  private async alignRemote(workspacePath: string): Promise<'ok' | 'conflict' | 'error'> {
    const defaultBranch = await this.resolveRemoteDefaultBranch(workspacePath)
    const head = await this.deps.runGit(['rev-parse', 'HEAD'], workspacePath)
    if (head.code === 0) {
      // 本地已有历史
      const cur = await this.currentBranchName(workspacePath)
      let branchName = cur
      if (cur && defaultBranch && cur !== defaultBranch) {
        // 分支名不匹配：自动重命名本地分支对齐远端默认分支
        const rename = await this.deps.runGit(['branch', '-m', defaultBranch], workspacePath)
        if (rename.code === 0) branchName = defaultBranch
      }
      if (!branchName) return 'ok'
      const verify = await this.deps.runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchName}`], workspacePath)
      if (verify.code !== 0) return 'ok' // 远端无此分支（空远端或分支不同），交由后续 commit 待推
      await this.deps.runGit(['branch', '--set-upstream-to', `origin/${branchName}`, branchName], workspacePath)
      return await this.pullAfterEnable(workspacePath)
    }
    // 本地无 HEAD
    if (defaultBranch) {
      const co = await this.deps.runGit(['checkout', '-b', defaultBranch, '--track', `origin/${defaultBranch}`], workspacePath)
      if (co.code !== 0) {
        if (isUntrackedOverwrite(`${co.stderr} ${co.stdout}`)) {
          this.currentStatus = 'error'
          this.error = '本地存在与远端同名的未跟踪文件（如 README.md 或 .gitignore），请先移动或删除后重试'
          return 'error'
        }
        this.currentStatus = 'error'
        this.error = co.stderr.trim() || '拉取远端内容失败'
        return 'error'
      }
    }
    // defaultBranch 为空（远端空仓库）：不做任何事，交由后续 ensure + commit 待推
    return 'ok'
  }

  /**
   * enable 阶段执行 pull；进入冲突时先自动解决 .gitignore（方案 B），
   * 若仅剩 .gitignore 冲突则自动 rebase --continue，否则保持冲突状态交给用户。
   */
  private async pullAfterEnable(workspacePath: string): Promise<'ok' | 'conflict' | 'error'> {
    if (!this.provider) return 'ok'
    const result = await this.provider.pull()
    if (result.success) return 'ok'
    const st = await this.provider.status()
    if (st !== 'conflict') {
      if (isUntrackedOverwrite(result.error ?? '')) {
        this.currentStatus = 'error'
        this.error = '本地存在与远端同名的未跟踪文件（如 README.md 或 .gitignore），请先移动或删除后重试'
        return 'error'
      }
      this.currentStatus = 'error'
      this.error = result.error ?? '拉取失败'
      return 'error'
    }
    // 冲突：自动解决 .gitignore
    const resolvedGitignore = await autoResolveGitignoreConflict(workspacePath, this.deps.runGit)
    const files = (await this.provider.conflictedFiles?.()) ?? []
    if (!resolvedGitignore || files.length > 0) {
      // 仍有其它冲突文件 → 进入冲突状态，由用户在面板解决
      this.currentStatus = 'conflict'
      this.error = result.error ?? '同步存在冲突，请解决后继续'
      return 'conflict'
    }
    // 仅 .gitignore 冲突且已自动解决 → 自动继续 rebase（可能跨越多个提交）
    const cont = await this.provider.continueRebase?.()
    if (cont && !cont.success) {
      const st2 = await this.provider.status()
      if (st2 === 'conflict') {
        const files2 = (await this.provider.conflictedFiles?.()) ?? []
        if (files2.length > 0) {
          this.currentStatus = 'conflict'
          this.error = '同步存在冲突，请解决后继续'
          return 'conflict'
        }
      }
    }
    return 'ok'
  }

  /** 解析远端默认分支名（git ls-remote --symref origin HEAD）。 */
  private async resolveRemoteDefaultBranch(workspacePath: string): Promise<string | null> {
    const r = await this.deps.runGit(['ls-remote', '--symref', 'origin', 'HEAD'], workspacePath)
    if (r.code !== 0) return null
    const m = r.stdout.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/)
    return m ? m[1] : null
  }

  /** 当前分支名（未在分支上返回 null）。 */
  private async currentBranchName(workspacePath: string): Promise<string | null> {
    const r = await this.deps.runGit(['symbolic-ref', '--short', 'HEAD'], workspacePath)
    return r.code === 0 ? r.stdout.trim() : null
  }

  setConfig(patch: Partial<Omit<SyncConfig, 'version' | 'provider'>>): SyncConfig | null {
    if (!this.config) return null
    this.config = {
      ...this.config,
      autoCommit: patch.autoCommit ?? this.config.autoCommit,
      autoPull: patch.autoPull ?? this.config.autoPull,
      autoPush: patch.autoPush ?? this.config.autoPush
    }
    if (this.workspacePath) saveSyncConfig(this.workspacePath, this.config)
    return this.config
  }

  private onWorkspaceChanges(files: string[]): void {
    this.emitFiles(files)
    void this.autoCommit()
  }

  private async autoCommit(): Promise<void> {
    if (!this.provider || !this.config) return
    if (this.busy) return
    if (!this.config.autoCommit) {
      await this.refreshStatus()
      this.emit()
      return
    }
    const st = await this.provider.status()
    if (st !== 'pendingCommit') {
      await this.refreshStatus()
      this.emit()
      return
    }
    this.busy = true
    try {
      await this.provider.commit(`同步: ${new Date().toISOString()}`)
      if (this.config.autoPush) {
        const pushResult = await this.provider.push()
        if (!pushResult.success) {
          await this.refreshStatus()
          if (this.currentStatus !== 'conflict') this.currentStatus = 'error'
          this.error = pushResult.error ?? '自动推送失败'
        }
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : '自动提交失败'
    } finally {
      this.busy = false
    }
    await this.refreshStatus()
    this.emit()
  }

  private async refreshStatus(): Promise<SyncStatus> {
    if (!this.provider) {
      this.currentStatus = 'uninitialized'
      this.conflictedFiles = []
      this.inRebase = false
      return this.currentStatus
    }
    const prev = this.currentStatus
    const st = await this.provider.status()
    this.currentStatus = st
    this.error = st === 'error' ? '仓库状态异常（可能未配置远程分支），请在同步面板中检查' : null
    if (st === 'conflict') {
      this.conflictedFiles = this.provider.conflictedFiles ? await this.provider.conflictedFiles() : []
      this.inRebase = this.provider.rebaseInProgress ? await this.provider.rebaseInProgress() : false
    } else {
      this.conflictedFiles = []
      this.inRebase = false
    }
    // 统一「进入冲突」的事件语义：无论从哪条路径（attach/enable/autoCommit/pull/push）进入，
    // 都先发状态事件再发冲突文件事件，保证渲染进程能可靠自动打开冲突文件。
    if (st === 'conflict' && prev !== 'conflict' && this.conflictedFiles.length > 0) {
      this.emit()
      this.emitFiles(this.conflictedFiles)
    }
    if (this.provider.branchInfo) {
      const info = await this.provider.branchInfo()
      this.branch = info?.branch ?? null
      this.upstream = info?.upstream ?? null
    }
    return this.currentStatus
  }

  private async isGitRepoAt(cwd: string): Promise<boolean> {
    const r = await this.deps.runGit(['rev-parse', '--is-inside-work-tree'], cwd)
    return r.code === 0 && r.stdout.trim() === 'true'
  }

  dispose(): void {
    this.detach()
    this.eventCbs = []
    this.fileCbs = []
  }
}
