/**
 * `.mdx` 临时目录登记表
 *
 * 主进程唯一持有的「文件绝对路径 → 解压临时目录」映射。
 * 独立成模块，是为了让文件重命名/移动（`electron/ipc/file-handlers.ts`）能迁移登记，
 * 又不必与 `mdx-handlers.ts` 形成循环依赖（后者已从 `file-handlers` 导入 `addRecentFile`）。
 */

import * as path from 'node:path'

/**
 * 文件路径 → 临时目录
 *
 * key 一律经 `normalizeTempKey` 归一化；调用方若自行归一化后取值，行为一致。
 */
export const tempDirsByFile = new Map<string, string>()

/** 归一化文件路径作为 key */
export function normalizeTempKey(filePath: string): string {
  return path.normalize(path.resolve(filePath))
}

/** 登记临时目录 */
export function registerTempDir(filePath: string, tempDir: string): void {
  tempDirsByFile.set(normalizeTempKey(filePath), tempDir)
}

/** 注销临时目录 */
export function unregisterTempDir(filePath: string): void {
  tempDirsByFile.delete(normalizeTempKey(filePath))
}

/** 清空全部登记（应用退出时调用） */
export function clearTempDirs(): void {
  tempDirsByFile.clear()
}

/**
 * 迁移已登记临时目录的 key
 *
 * 修既有缺陷：登记按文件路径索引，重命名/移动后 key 失效，
 * 下次保存会报「找不到文件的临时目录」。重命名的是目录时，
 * 其下所有已登记文件一并迁移。
 *
 * @returns 迁移的登记条数
 */
export function remapTempDir(oldAbsPath: string, newAbsPath: string): number {
  const oldKey = normalizeTempKey(oldAbsPath)
  const newKey = normalizeTempKey(newAbsPath)
  if (oldKey === newKey) return 0

  const moved: Array<{ key: string; tempDir: string }> = []
  for (const [filePath, tempDir] of tempDirsByFile) {
    if (filePath === oldKey || filePath.startsWith(oldKey + path.sep)) {
      moved.push({ key: filePath, tempDir })
    }
  }

  for (const { key, tempDir } of moved) {
    tempDirsByFile.delete(key)
    tempDirsByFile.set(newKey + key.slice(oldKey.length), tempDir)
  }

  return moved.length
}
