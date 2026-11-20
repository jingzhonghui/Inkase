/**
 * 工作区相对路径计算（渲染层多处共用：图谱索引、右键「复制相对路径」）。
 *
 * 分隔符一律输出**正斜杠**。理由不是洁癖：相对路径最常见的去处是 Markdown 链接、
 * import 语句和 Git 命令，这三处都只认 `/`；Windows 反斜杠在 Markdown 里还会被当成
 * 转义符（`\n`、`\t`），粘进去就废了。Windows 自身的程序绝大多数也接受 `/`。
 */

/** 统一分隔符并去掉尾部斜杠（`C:\ws\` 与 `C:/ws` 必须能对上） */
function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 绝对路径 → 工作区相对路径（`/` 分隔，不带 `./` 前缀）。
 *
 * 三种结果：
 * - `'a/b.md'`：目标在工作区内；
 * - `''`：目标就是工作区根本身；
 * - `null`：目标不在工作区内（或根本拿不到根）。
 */
export function toWorkspaceRelativePath(root: string, absolutePath: string): string | null {
  const normalizedRoot = normalizeSeparators(root)
  const normalizedPath = normalizeSeparators(absolutePath)
  if (!normalizedRoot) return null

  // Windows 盘符路径大小写不敏感：`C:\Ws` 与 `c:\ws` 是同一个目录
  const caseInsensitive = /^[a-zA-Z]:/.test(normalizedRoot)
  const rootForCompare = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot
  const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath

  if (pathForCompare === rootForCompare) return ''
  // 必须带上分隔符再比，否则 `C:/ws` 会把 `C:/ws2/a.md` 也认成子路径
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null

  return normalizedPath.slice(normalizedRoot.length + 1)
}
