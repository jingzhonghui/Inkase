/**
 * HTML 预览 URL 构造
 *
 * 与 electron/ipc/preview-protocol.ts 的解析规则互为逆操作：
 * 把本地绝对路径编码为 inkase-preview:// URL，供沙箱 iframe 加载。
 */

const PREVIEW_URL_PREFIX = 'inkase-preview://local/'

export function buildPreviewUrl(absolutePath: string): string {
  const segments = absolutePath.replace(/\\/g, '/').split('/').filter((segment) => segment.length > 0)
  return PREVIEW_URL_PREFIX + segments.map(encodeURIComponent).join('/')
}
