/**
 * Markdown 链接目标的编解码规则。
 *
 * 写正文时**不编码中文**（见 `shared/graph/link-resolve` 的 `encodeLinkTarget`）：
 * `encodeURI` 会把整条路径变成 `%E7%AC%94%E8%AE%B0/...`，源码模式与 Git diff 里
 * 不可读，而 markdown-it 本身就认非 ASCII。
 *
 * 但 markdown-it 解析 `![alt](dest)` / `[text](dest)` 时会过一遍 `normalizeLink`
 * （`mdurl.encode`），**把非 ASCII 字符转成 `%XX`**：
 *
 * ```
 * ![](测试.assets/a.png)  →  <img src="%E6%B5%8B%E8%AF%95.assets/a.png">
 * ![](demo.assets/a.png)  →  <img src="demo.assets/a.png">
 * ```
 *
 * 这条编码只适合浏览器发请求，不能直接拿去 `fs` 找文件——磁盘上存的是原文。
 * 所以凡是「把链接当本地路径用」的地方都要先过 `decodeLinkTarget`：
 * 预览渲染、IR 模式的图片节点、主进程读图。
 */

/**
 * 把 Markdown 链接目标还原成文件系统里的真实名字。
 *
 * 非法转义序列（文件名里本就写着 `%`，如 `100%.png`）保持原样，
 * 否则 `decodeURIComponent` 会抛 `URIError` 把整次渲染带崩。
 */
export function decodeLinkTarget(target: string): string {
  if (!target || !target.includes('%')) return target
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}
