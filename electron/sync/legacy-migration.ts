import * as fs from 'fs'
import * as path from 'path'

/** 旧版本使用的本机配置目录名（软件更名 Inkase 前为 .markdownPlus） */
const LEGACY_CONFIG_DIR = '.markdownPlus'
/** 旧目录中的同步配置文件名 */
const LEGACY_SYNC_FILE = 'sync.json'
/** 会话子目录与记录扩展名（与 ConversationStore 保持一致） */
const CONVERSATIONS_SUBDIR = 'conversations'
const CONVERSATION_EXT = '.json'

/**
 * 将旧版本遗留的 <工作区>/.markdownPlus 迁移到 .inkase（幂等，静默失败）。
 *
 * 规则：
 * - .inkase 不存在 → 整目录重命名（保留旧目录内全部未知内容）
 * - .inkase 已存在 → 逐项合并：sync.json 仅在目标缺失时迁入；
 *   conversations/*.json 逐文件移动、同名跳过；其余未知条目在目标缺失时随子项迁入
 * - 合并后旧目录为空则删除；清理 .gitignore 中的 .markdownPlus 行
 * - 任何失败都吞掉异常，绝不阻塞工作区打开
 */
export function migrateLegacyConfigDir(workspacePath: string): void {
  try {
    const legacyDir = path.join(workspacePath, LEGACY_CONFIG_DIR)
    if (!fs.existsSync(legacyDir)) return

    const targetDir = path.join(workspacePath, '.inkase')
    if (!fs.existsSync(targetDir)) {
      fs.renameSync(legacyDir, targetDir)
    } else {
      mergeLegacyDir(legacyDir, targetDir)
      removeDirIfEmpty(legacyDir)
    }
    removeLegacyGitignoreLine(workspacePath)
  } catch {
    /* 迁移失败忽略：不影响工作区使用，旧数据仍在原地 */
  }
}

/** 目标目录已存在时逐项合并旧目录内容。 */
function mergeLegacyDir(legacyDir: string, targetDir: string): void {
  for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
    const from = path.join(legacyDir, entry.name)
    const to = path.join(targetDir, entry.name)
    if (entry.isDirectory() && entry.name === CONVERSATIONS_SUBDIR) {
      mergeConversations(from, to)
      continue
    }
    if (fs.existsSync(to)) {
      // 已知条目（sync.json）同 id 冲突以目标为准，删除过期旧文件避免旧目录残留
      if (entry.isFile() && entry.name === LEGACY_SYNC_FILE) fs.rmSync(from, { force: true })
      continue
    }
    fs.renameSync(from, to)
  }
}

/** 会话记录逐文件移动，同名（同 id）跳过以目标为准，删除过期旧文件。 */
function mergeConversations(fromDir: string, toDir: string): void {
  fs.mkdirSync(toDir, { recursive: true })
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(CONVERSATION_EXT)) continue
    const from = path.join(fromDir, entry.name)
    const to = path.join(toDir, entry.name)
    if (fs.existsSync(to)) {
      fs.rmSync(from, { force: true })
      continue
    }
    fs.renameSync(from, to)
  }
  removeDirIfEmpty(fromDir)
}

function removeDirIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir)
  } catch {
    /* 非空目录保留 */
  }
}

/** 从 .gitignore 移除已废弃的 .markdownPlus 行（.inkase 行由 ensureInkaseIgnored 负责）。 */
function removeLegacyGitignoreLine(workspacePath: string): void {
  const gitignorePath = path.join(workspacePath, '.gitignore')
  if (!fs.existsSync(gitignorePath)) return
  const content = fs.readFileSync(gitignorePath, 'utf-8')
  if (!/^\.markdownPlus\r?$/m.test(content)) return
  const cleaned = content
    .split(/\r?\n/)
    .filter((l) => l.trim() !== LEGACY_CONFIG_DIR)
    .join('\n')
  fs.writeFileSync(gitignorePath, cleaned.endsWith('\n') || cleaned === '' ? cleaned : cleaned + '\n', 'utf-8')
}
