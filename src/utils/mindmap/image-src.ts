/**
 * 节点图片的路径解析
 *
 * `.inkmind` 是 ZIP 容器，图片存在包内的 `assets/images/`，
 * 打开时解到临时目录，并给出一张「包内路径 → 绝对路径」的表。
 * 这一层把包内路径换成浏览器能直接加载的 URL：
 * - `assets/images/x.png` → 查表 → `inkase-preview://` 协议 URL；
 * - `data:` / `http(s):` 原样返回（老文件与外部导入可能这么存）；
 * - 表里没有（比如刚插入还没落盘）或没有表时返回空串，
 *   图片画不出来但不会让整个画布报错。
 *
 * 独立成纯函数是为了能直接测：真正的 URL 拼装规则在 `preview-url.ts`。
 */

import { buildPreviewUrl } from '../preview-url'

/** 包内路径统一用 `/`：Windows 上手写的文件可能写成 `assets\images\a.png` */
function normalizePackaged(src: string): string {
  return src.replace(/\\/g, '/')
}

/**
 * 包内路径 → 可加载的 URL。
 *
 * `assetMap` 由主进程在打开容器时给出（包内路径 → 解压后的绝对路径）。
 */
export function resolveMindMapImageSrc(
  src: string,
  assetMap?: Record<string, string> | null
): string {
  const trimmed = src.trim()
  if (trimmed === '') return ''
  if (/^(data:|https?:|inkase-preview:)/i.test(trimmed)) return trimmed

  const absolute = assetMap?.[normalizePackaged(trimmed)]
  // 没有映射说明资源不在当前容器里：给空串，让 UI 走「图片缺失」占位
  return absolute ? buildPreviewUrl(absolute) : ''
}
