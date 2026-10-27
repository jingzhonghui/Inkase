/**
 * draw.io webapp 的自定义协议托管。
 *
 * 为什么用自定义协议而不是本地 http server：
 * - 不占端口、不监听回环地址，安全面上更小；
 * - 与 `.mdx` 预览已有的 `inkase-preview://` 是同一套做法，行为可预期；
 * - 生产环境 webapp 走 extraResources（`process.resourcesPath/drawio`），
 *   开发环境走仓库里的 `resources/drawio`。
 *
 * 注册分两步（Electron 的硬性要求）：
 * 1. `registerDiagramSchemePrivileges()` —— app ready **之前**，声明 standard/secure 等特权；
 * 2. `registerDiagramProtocol()` —— app ready 之后，挂上真正的文件服务。
 */

import { app, protocol } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { is } from '@electron-toolkit/utils'
import {
  DIAGRAM_CONTENT_SECURITY_POLICY,
  DIAGRAM_HOST,
  DIAGRAM_SCHEME
} from '../../shared/diagram/embed'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8'
}

/**
 * webapp 所在目录。
 *
 * `INKASE_DRAWIO_ROOT` 用来在测试/排障时指向别的副本（例如裁剪前后的两版），
 * 不设置时按 dev/prod 走默认位置。
 */
export function resolveDiagramWebappRoot(): string {
  const override = process.env.INKASE_DRAWIO_ROOT
  if (override && override.trim().length > 0) return path.resolve(override)
  return is.dev
    ? path.join(app.getAppPath(), 'resources', 'drawio')
    : path.join(process.resourcesPath, 'drawio')
}

/** webapp 是否就位（`index.html` 存在即视为可用）。 */
export function isDiagramWebappAvailable(root: string = resolveDiagramWebappRoot()): boolean {
  try {
    return fs.statSync(path.join(root, 'index.html')).isFile()
  } catch {
    return false
  }
}

/**
 * 把 `inkase-drawio://app/<路径>` 还原为磁盘绝对路径。
 *
 * 越界一律返回 null：空路径、其他 scheme/host、`..` 段、绝对路径段、
 * 规范化后逃出根目录的路径，全部拒绝。
 */
export function resolveDiagramAssetPath(root: string, rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${DIAGRAM_SCHEME}:`) return null
  if (url.host.toLowerCase() !== DIAGRAM_HOST) return null

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname === '' || pathname === '/') pathname = '/index.html'

  const segments = pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  if (segments.some((segment) => /[\\/]/.test(segment))) return null

  const absolute = path.resolve(root, ...segments)
  const normalizedRoot = path.resolve(root)
  if (absolute !== normalizedRoot && !absolute.startsWith(normalizedRoot + path.sep)) return null
  return absolute
}

/** 读文件构造响应；目录或不存在一律 404，并带上注入的 CSP。 */
export function createDiagramAssetResponse(absolutePath: string): Response {
  let stat: fs.Stats
  try {
    stat = fs.statSync(absolutePath)
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  if (!stat.isFile()) return new Response('Not Found', { status: 404 })

  let body: Buffer
  try {
    body = fs.readFileSync(absolutePath)
  } catch {
    return new Response('Read Error', { status: 500 })
  }

  const mime = MIME_TYPES[path.extname(absolutePath).toLowerCase()] ?? 'application/octet-stream'
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Security-Policy': DIAGRAM_CONTENT_SECURITY_POLICY,
      'Cache-Control': is.dev ? 'no-cache' : 'public, max-age=31536000, immutable'
    }
  })
}

/** 声明协议特权。必须在 app ready 之前调用。 */
export function registerDiagramSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DIAGRAM_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        // draw.io 用 fetch/XHR 拉取 stencils、templates、形状定义
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/** 挂上协议处理器。必须在 app ready 之后调用。 */
export function registerDiagramProtocol(): void {
  const root = resolveDiagramWebappRoot()
  protocol.handle(DIAGRAM_SCHEME, (request) => {
    const target = resolveDiagramAssetPath(root, request.url)
    if (!target) return new Response('Bad Request', { status: 400 })
    return createDiagramAssetResponse(target)
  })
}

/** 给渲染层与日志用的运行时信息。 */
export function describeDiagramWebapp(): {
  available: boolean
  root: string
  scheme: string
  host: string
} {
  const root = resolveDiagramWebappRoot()
  return {
    available: isDiagramWebappAvailable(root),
    root,
    scheme: DIAGRAM_SCHEME,
    host: DIAGRAM_HOST
  }
}
