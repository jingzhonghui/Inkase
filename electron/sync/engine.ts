import * as fs from 'fs'
import * as path from 'path'
import type {
  ConflictChoice,
  EnableSyncOptions,
  SyncConfig,
  SyncProvider,
  SyncResult,
  SyncStatus,
  SyncStatusView
} from './types'
import { autoResolveGitignoreConflict, ensureInkaseExcludedLocally, isUntrackedOverwrite, untrackInkaseIfTracked } from './git-provider'
import type { GitCommandResult } from './git-provider'
import { ensureInkaseIgnored, loadSyncConfig, saveSyncConfig, syncConfigPath } from './config'
import { migrateLegacyConfigDir } from './legacy-migration'
import { createCredentialStore, credentialsPath, type CryptoLike } from './credentials'
import { syncStatePath } from './sync-state'

export interface SyncEngineDeps {
  createProvider: (workspacePath: string, config: SyncConfig) => SyncProvider
  createWatcher: (workspacePath: string, onChanges: (files: string[]) => void) => { dispose(): void }
  runGit: (args: string[], cwd: string) => Promise<GitCommandResult>
  /**
   * 凭据加密后端（Electron `safeStorage` 的最小抽象）。
   * WebDAV `enable()` 用它加密保存密码；缺省时不写凭据文件（绝不降级为明文）。
   */
  crypto?: CryptoLike
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

  /**
   * 当前工作区是否走 git 后端（未配置时沿用历史默认 git）。
   * 仅用于圈定 git 专属副作用；git 路径下恒为 true，行为与引入前一致。
   */
  private isGit(): boolean {
    return (this.config?.provider ?? 'git') === 'git'
  }

  getStatusView(): SyncStatusView {
    return {
      status: this.currentStatus,
      error: this.error,
      configured: this.provider !== null,
      isGitRepo: this.isGitRepo,
      branch: this.branch,
      upstream: this.upstream,
      provider: this.config?.provider ?? 'git',
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
    // 先迁移旧目录再读配置，旧 .markdownPlus/sync.json 才能被读到
    migrateLegacyConfigDir(workspacePath)
    this.config = loadSyncConfig(workspacePath)
    // §5.7：WebDAV 下 isGitRepo 恒为 false（且不执行任何 git 命令）
    this.isGitRepo = this.isGit() ? await this.isGitRepoAt(workspacePath) : false

    if (this.config) {
      this.provider = this.deps.createProvider(workspacePath, this.config)
      this.watcher = this.deps.createWatcher(workspacePath, (files) => this.onWorkspaceChanges(files))
      await this.refreshStatus()
      if (this.config.autoPull) {
        if (this.isGit()) {
          // git 需要先确认存在 upstream 才 pull（否则 pull 会因无跟踪分支失败）
          const info = this.provider.branchInfo ? await this.provider.branchInfo() : null
          if (info?.upstream) {
            const r = await this.pullInternal()
            if (r.success && r.changedFiles && r.changedFiles.length > 0) {
              this.emitFiles(r.changedFiles)
            }
          }
        } else {
          // webdav 无分支概念：直接拉取
          const r = await this.pullInternal()
          if (r.success && r.changedFiles && r.changedFiles.length > 0) {
            this.emitFiles(r.changedFiles)
          }
        }
      }
    } else {
      this.currentStatus = 'uninitialized'
    }
    // 自愈：git 工作区补齐 .gitignore，并把被误跟踪的 .inkase 移出版本控制
    // （历史版本 bug 或远端污染所致；置于 autoPull 之后，可清理 pull 带入的污染）
    if (this.isGitRepo && this.isGit()) {
      ensureInkaseIgnored(workspacePath)
      await untrackInkaseIfTracked(workspacePath, (args, cwd) => this.deps.runGit(args, cwd))
      await ensureInkaseExcludedLocally(workspacePath, (args, cwd) => this.deps.runGit(args, cwd))
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
    // 必须在 detach() 清空 this.config 之前判定 provider
    const isGit = this.isGit()
    this.detach()
    if (workspacePath) {
      const configPath = syncConfigPath(workspacePath)
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath)
      if (isGit) {
        // 停用同步：删除 git 仓库与 .gitignore（.inkase 目录保留，可能含 AI 会话等其它数据）
        const gitDir = path.join(workspacePath, '.git')
        if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true })
        const gitignorePath = path.join(workspacePath, '.gitignore')
        if (fs.existsSync(gitignorePath)) fs.unlinkSync(gitignorePath)
      } else {
        // WebDAV：保留工作区文件与 .git/.gitignore，只清理同步清单与凭据（磁盘不残留凭据密文）
        const statePath = syncStatePath(workspacePath)
        if (fs.existsSync(statePath)) fs.unlinkSync(statePath)
        const credPath = credentialsPath(workspacePath)
        if (fs.existsSync(credPath)) fs.unlinkSync(credPath)
      }
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

  /**
   * 人工裁决冲突文件（WebDAV 等无 rebase 的后端）。
   * provider 不支持时返回明确错误；成功后刷新状态（全部解决应回到 upToDate）。
   */
  async resolveConflicts(choices: ConflictChoice[]): Promise<SyncResult> {
    if (this.busy) return { success: false, error: '同步进行中，请稍候' }
    if (!this.provider?.resolveConflicts) return { success: false, error: '当前提供者不支持此操作' }
    this.busy = true
    try {
      const result = await this.provider.resolveConflicts(choices)
      if (!result.success) {
        this.error = result.error ?? '解决冲突失败'
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
      migrateLegacyConfigDir(workspacePath)
      // provider 分支必须由入参显式驱动：此时 this.config 仍为 null，复用 isGit() 会被默认值判成 git
      const providerKind = options.provider ?? 'git'
      if (providerKind === 'webdav') {
        return await this.enableWebdav(workspacePath, options)
      }
      this.isGitRepo = await this.isGitRepoAt(workspacePath)
      if (this.isGit() && !this.isGitRepo) {
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
      if (this.isGit() && options.remoteUrl) {
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
        provider: providerKind,
        autoCommit: options.autoCommit ?? true,
        autoPull: options.autoPull ?? true,
        autoPush: options.autoPush ?? false
      }
      saveSyncConfig(workspacePath, this.config)
      this.provider = this.deps.createProvider(workspacePath, this.config)

      let remoteError: string | null = null
      let align: 'ok' | 'conflict' | 'error' = 'ok'
      if (this.isGit() && options.remoteUrl) {
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
      if (this.isGit()) {
        ensureInkaseIgnored(workspacePath)
        // 远端若已含被跟踪的 .inkase（历史污染），checkout 后立即移出版本控制
        await untrackInkaseIfTracked(workspacePath, (args, cwd) => this.deps.runGit(args, cwd))
        // 本地排除兜底：即使 .gitignore 缺失/冲突，git add 也不会带入 .inkase
        await ensureInkaseExcludedLocally(workspacePath, (args, cwd) => this.deps.runGit(args, cwd))
      }
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
   * WebDAV 启用：**不执行任何 git 命令**。
   * 校验必填项 → 保存配置 → 加密保存密码 → 建 provider → `provider.push()` 完成首次对齐
   * （空远端=全量上传；非空=取并集，冲突交由用户选边）→ 建 watcher → 刷新状态。
   * 首次对齐失败（网络/认证）不阻塞配置保存，以 `error` 状态呈现，用户可重试
   * （与 git 版 `remoteError` 处理一致）。
   */
  private async enableWebdav(workspacePath: string, options: EnableSyncOptions): Promise<SyncResult> {
    const url = options.url?.trim() ?? ''
    const username = options.username?.trim() ?? ''
    const remoteRoot = options.remoteRoot?.trim() ?? ''
    const missing: string[] = []
    if (!url) missing.push('服务地址')
    if (!username) missing.push('用户名')
    if (!options.password) missing.push('密码')
    if (!remoteRoot) missing.push('远端目录')
    if (missing.length > 0) {
      const error = `必填项缺失：${missing.join('、')}`
      this.currentStatus = 'error'
      this.error = error
      this.emit()
      return { success: false, error }
    }

    this.config = {
      version: 1,
      provider: 'webdav',
      // WebDAV 无提交概念，恒为 false
      autoCommit: false,
      autoPull: options.autoPull ?? true,
      autoPush: options.autoPush ?? false,
      url,
      username,
      remoteRoot
    }
    saveSyncConfig(workspacePath, this.config)

    // 密码只以密文落盘；加密不可用时（crypto 整体缺失，或 crypto 存在但
    // isEncryptionAvailable()===false）一律**拒绝保存并回滚**刚写入的配置，
    // 避免留下「已配置但无凭据」的半成品，且绝不静默跳过（绝不降级为明文）。
    // 错误文案与 credentials.ts 的「加密不可用」分支逐字一致。
    if (options.password) {
      try {
        if (!this.deps.crypto) throw new Error('当前系统不支持安全存储，无法保存密码')
        createCredentialStore(workspacePath, this.deps.crypto).save(options.password)
      } catch (e) {
        const error = e instanceof Error ? e.message : '保存密码失败'
        const configPath = syncConfigPath(workspacePath)
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath)
        this.config = null
        this.currentStatus = 'error'
        this.error = error
        this.emit()
        return { success: false, error }
      }
    }

    this.provider = this.deps.createProvider(workspacePath, this.config)

    // 首次绑定对齐（§5.6/§10.1 步骤 5）：真正取并集——先 pull 下载「远端独有」，
    // 再 push 上传「本地独有」，两侧同名按 §5.6 处理（冲突留给用户选边）。
    // 与 git 版「先对齐（pull）再推送（push）」的节奏一致：pull 时基准尚为空，
    // 结构上不可能产生 deleteLocal，故「首次绑定不产生任何删除」。
    // 对齐失败（网络/认证）不阻塞配置保存，以 error 状态呈现，用户可重试。
    let alignError: string | null = null
    const pulled = await this.provider.pull()
    if (!pulled.success) {
      alignError = pulled.error ?? '首次同步失败'
    } else {
      const pushed = await this.provider.push()
      if (!pushed.success) alignError = pushed.error ?? '首次同步失败'
    }

    this.watcher = this.deps.createWatcher(workspacePath, (files) => this.onWorkspaceChanges(files))
    await this.refreshStatus()
    if (alignError) {
      this.currentStatus = 'error'
      this.error = alignError
    }
    this.emit()
    return { success: true }
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
    // WebDAV 无提交概念（autoCommit 恒为 false）：变更后按 autoPush 直接 push（设计 §5.3）。
    // 必须与 git 路径分开判断，否则会因 autoCommit=false 提前返回，autoPush 永不触发（静默失败）。
    if (!this.isGit()) {
      if (!this.config.autoPush) {
        await this.refreshStatus()
        this.emit()
        return
      }
      this.busy = true
      try {
        const pushResult = await this.provider.push()
        if (!pushResult.success) {
          await this.refreshStatus()
          if (this.currentStatus !== 'conflict') this.currentStatus = 'error'
          this.error = pushResult.error ?? '自动上传失败'
        }
      } catch (e) {
        this.error = e instanceof Error ? e.message : '自动上传失败'
      } finally {
        this.busy = false
      }
      await this.refreshStatus()
      this.emit()
      return
    }
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
    this.error =
      st === 'error'
        ? this.isGit()
          ? '仓库状态异常（可能未配置远程分支），请在同步面板中检查'
          : '无法连接到远端，请检查网络、地址与凭据'
        : null
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
