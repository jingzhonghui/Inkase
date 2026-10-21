/**
 * 渲染进程的库内路径换算
 *
 * 渲染进程只有绝对路径（标签页、文件树），而知识库 IPC 只接受库内相对路径；
 * 浏览器环境没有 Node 的 `path`，故在此用字符串处理实现，两端保持一致（`/` 分隔）。
 */

/** 统一为 `/` 分隔并去掉尾部斜杠 */
function normalize(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 是否形如 Windows 盘符路径（大小写不敏感比较） */
function isWindowsStyle(input: string): boolean {
  return /^[a-z]:/i.test(input)
}

/**
 * 绝对路径 → 库内相对路径
 *
 * @returns 不在库内时返回 `null`；正好等于库根时返回空串
 */
export function toVaultRelativePath(root: string, absPath: string): string | null {
  if (root === '' || absPath === '') return null

  const normalizedRoot = normalize(root)
  const normalizedAbs = normalize(absPath)
  const caseInsensitive = isWindowsStyle(normalizedRoot)

  const compareRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot
  const compareAbs = caseInsensitive ? normalizedAbs.toLowerCase() : normalizedAbs

  if (compareAbs === compareRoot) return ''
  if (!compareAbs.startsWith(`${compareRoot}/`)) return null
  return normalizedAbs.slice(normalizedRoot.length + 1)
}

/** 库内相对路径 → 绝对路径（沿用库根的路径分隔符风格） */
export function toAbsolutePath(root: string, relPath: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '')
  const relative = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  return `${base}${separator}${relative.split('/').join(separator)}`
}
