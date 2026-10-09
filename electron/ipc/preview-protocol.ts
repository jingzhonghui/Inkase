import { protocol } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getMimeType } from '../mdx/mime'

/**
 * HTML 预览自定义协议
 *
 * 渲染进程通过 inkase-preview://local/<路径> 在沙箱 iframe 中加载本地 HTML
 * 及其相对资源（CSS/JS/图片）。协议处理器把 URL 还原为本地磁盘路径读取文件。
 */

export const PREVIEW_SCHEME = 'inkase-preview'
export const PREVIEW_HOST = 'local'

export interface ParsedPreviewUrl {
  absolutePath: string
}

/**
 * 将 inkase-preview:// URL 解析为本地绝对路径。
 * 无效协议/host、空路径、包含穿越段（..）的 URL 一律返回 null。
 */
export function parsePreviewUrl(rawUrl: string): ParsedPreviewUrl | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${PREVIEW_SCHEME}:` || url.host.toLowerCase() !== PREVIEW_HOST) {
    return null
  }
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const segments = pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  if (segments.some((segment) => /[\\/]/.test(segment))) return null
  const absolutePath = path.normalize(segments.join(path.sep))
  return { absolutePath }
}

/**
 * 读取本地文件构造协议响应。
 * 目录、不存在的文件返回 404；读取失败返回 500。
 */
export function createPreviewResponse(absolutePath: string): Response {
  try {
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile()) {
      return new Response('Not Found', { status: 404 })
    }
    const mime = getMimeType(path.extname(absolutePath)) || 'application/octet-stream'
    const data = fs.readFileSync(absolutePath)
    return new Response(data, {
      status: 200,
      headers: { 'Content-Type': mime }
    })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}

/**
 * 注册 privileged scheme（必须在 app ready 之前调用，且只能调用一次）。
 */
export function registerPreviewSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false
      }
    }
  ])
}

/**
 * 注册协议处理器（在 app ready 之后调用）。
 */
export function registerPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, (request) => {
    const parsed = parsePreviewUrl(request.url)
    if (!parsed) {
      return new Response('Bad Request', { status: 400 })
    }
    return createPreviewResponse(parsed.absolutePath)
  })
}
