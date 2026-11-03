/**
 * 把 draw.io webapp 放到 `resources/drawio/`。
 *
 * 为什么不让它进 npm 依赖、也不提交进仓库：
 * - 解包后约 45 MB / 780 个文件，塞进 git 会把每次 clone 都拖慢，diff 也毫无意义；
 * - 它是随包分发的第三方资源（Apache-2.0，必须保留 LICENSE/NOTICE），
 *   与 `resources/rg` 同性质，走「构建前拉取 + extraResources 打包」。
 *
 * 但「让用户/开发者自己想起跑一条命令」是设计错误，桌面应用必须开箱即用。
 * 因此这个脚本是**幂等**的，并被四条路径自动调用：
 * - `pnpm install` → postinstall（`--optional`：网络抖动不阻断安装）
 * - `pnpm dev`     → predev（缺了就装，装不上就给出可执行的报错）
 * - `pnpm build`   → prebuild（构建不可能产出一个没有图表组件的安装包）
 * - `electron-builder` → afterPack 再校验一次产物（见 build/after-pack.cjs）
 *
 * 用法：
 *   node scripts/fetch-drawio.mjs            # 缺了就取，已有就跳过
 *   node scripts/fetch-drawio.mjs --force    # 强制重新解包（优先复用缓存）
 *   node scripts/fetch-drawio.mjs --check    # 只检查资源是否就位，缺失以 1 退出
 *   node scripts/fetch-drawio.mjs --optional # 失败只警告不退出（postinstall 用）
 *
 * 源包：`@guowenzhang/dsh-drawioedit`（draw.io 官方 webapp 的裁剪分发版，
 * 体积约为官方的 1/3，中文语言包与 Mermaid 解析都在）。版本**钉死**在下面，
 * 保证同一份源码在任何机器、任何时间打出来的包一致。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const targetDir = path.join(repoRoot, 'resources', 'drawio')

const PACKAGE_NAME = '@guowenzhang/dsh-drawioedit'
const PACKAGE_VERSION = '1.2.1'
/** 镜像优先，官方源兜底；两个都失败才报错。内网可用 `INKASE_DRAWIO_REGISTRY` 指定前置源。 */
const REGISTRIES = [
  process.env.INKASE_DRAWIO_REGISTRY?.trim(),
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org'
].filter((registry, index, list) => registry && list.indexOf(registry) === index)

/** 完整性下限：正常产物约 780 个文件 / 45 MB，低于这个数说明解包被截断 */
const MIN_FILES = 500
const MIN_BYTES = 20 * 1024 * 1024
const MIN_TARBALL_BYTES = 5 * 1024 * 1024

/** 元数据请求 20s、tarball 下载 3min：超时即换下一个源，避免流水线死等 */
const META_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 180_000

const args = new Set(process.argv.slice(2))
const force = args.has('--force')
const checkOnly = args.has('--check')
const optional = args.has('--optional')

function log(message) {
  console.log(`[drawio] ${message}`)
}

function warn(message) {
  console.warn(`[drawio] ${message}`)
}

/** webapp 是否就位：入口与主脚本都在才算（只看目录存在会把解包到一半的残骸当成功） */
function hasWebapp(dir) {
  try {
    return (
      fs.statSync(path.join(dir, 'index.html')).isFile() &&
      fs.statSync(path.join(dir, 'js', 'app.min.js')).isFile()
    )
  } catch {
    return false
  }
}

function survey(dir) {
  let files = 0
  let bytes = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        files += 1
        bytes += fs.statSync(full).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

function describe(surveyResult) {
  return `${surveyResult.files} 个文件 / ${(surveyResult.bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 缓存放 node_modules 下：pnpm 清依赖时它跟着走，不会在仓库里留隐形垃圾 */
function cacheDir() {
  if (fs.existsSync(path.join(repoRoot, 'node_modules'))) {
    return path.join(repoRoot, 'node_modules', '.cache', 'inkase-drawio')
  }
  return path.join(os.tmpdir(), 'inkase-drawio-cache')
}

function cachedTarballPath() {
  const base = `${PACKAGE_NAME.replace(/^@/, '').replace('/', '-')}-${PACKAGE_VERSION}.tgz`
  return path.join(cacheDir(), base)
}

function readCachedTarball() {
  const cached = cachedTarballPath()
  try {
    const stat = fs.statSync(cached)
    if (stat.isFile() && stat.size >= MIN_TARBALL_BYTES) return cached
  } catch {
    /* 没缓存 */
  }
  return null
}

async function fetchJson(url) {
  // 必须带超时：镜像偶发「连接建立但一直不回」时，没有超时会卡到 CI job 上限，
  // 有了超时才轮到下一个源（这是流水线上最容易踩的死等）。
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(META_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** 从 registry 取 tarball；逐个镜像尝试，成功一份就落盘到缓存。 */
async function downloadTarball() {
  const cached = readCachedTarball()
  if (cached) {
    log(`复用缓存 ${path.relative(repoRoot, cached)}`)
    return cached
  }

  fs.mkdirSync(cacheDir(), { recursive: true })
  let lastError = null

  for (const registry of REGISTRIES) {
    const base = registry.replace(/\/+$/, '')
    try {
      log(`查询 ${base} …`)
      const meta = await fetchJson(`${base}/${encodeURIComponent(PACKAGE_NAME)}`)
      const version = meta?.versions?.[PACKAGE_VERSION]
      if (!version) {
        const known = Object.keys(meta?.versions ?? {}).slice(-3).join(', ') || '(空)'
        throw new Error(`源里没有 ${PACKAGE_VERSION} 版本，最近可用：${known}`)
      }
      const tarballUrl = version?.dist?.tarball
      if (!tarballUrl) throw new Error('元数据里没有 dist.tarball')

      log(`下载 ${PACKAGE_NAME}@${PACKAGE_VERSION} …`)
      const response = await fetch(tarballUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength < MIN_TARBALL_BYTES) {
        throw new Error(`下载不完整（${bytes.byteLength} 字节）`)
      }

      const cachedPath = cachedTarballPath()
      const tempPath = `${cachedPath}.${process.pid}.part`
      fs.writeFileSync(tempPath, bytes)
      fs.renameSync(tempPath, cachedPath)
      log(`已缓存 ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB`)
      return cachedPath
    } catch (error) {
      lastError = error
      warn(`${base} 不可用：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(`所有源都失败了：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * 纯 Node 解 tar.gz。
 *
 * 为什么不用系统 `tar`：Windows 上 PATH 里可能先是 Git 自带的 GNU tar，
 * 它会把 `-f C:\...` 里的盘符冒号当成「远程主机」，直接报
 * `Cannot connect to C: resolve failed`；bsdtar 与 GNU tar 的参数行为也不完全一致。
 * npm tarball 是标准的 ustar + pax 扩展头，自己解只有几十行，还省掉一个外部依赖。
 */
function readString(block, start, length) {
  const slice = block.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

/** pax 扩展头：`<长度> <key>=<value>\n` 重复 */
function parsePaxRecords(buffer) {
  const records = {}
  let offset = 0
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(buffer.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = buffer.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return records
}

/** 把包内路径拆成安全段：拒绝绝对路径与 `..`（zip-slip） */
function safeSegments(entryPath) {
  const normalized = entryPath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.some((segment) => segment === '..')) return null
  return segments
}

function extractTarGz(tarball, destination) {
  const archive = zlib.gunzipSync(fs.readFileSync(tarball))
  let offset = 0
  let pendingPath = null

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    // 全零块是归档结束标记
    if (header.every((byte) => byte === 0)) break

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const sizeText = readString(header, 124, 12).trim()
    const size = Number.parseInt(sizeText || '0', 8)
    const type = String.fromCharCode(header[156] || 0x30)
    const dataStart = offset + 512
    const dataEnd = dataStart + (Number.isFinite(size) ? size : 0)
    const data = archive.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512

    if (type === 'x') {
      // pax 扩展头：只关心长路径
      const records = parsePaxRecords(data)
      if (records.path) pendingPath = records.path
      continue
    }
    if (type === 'L') {
      pendingPath = data.toString('utf8').replace(/\0[\s\S]*$/, '')
      continue
    }
    if (type === 'g' || type === 'K') continue

    const entryName = pendingPath ?? (prefix ? `${prefix}/${name}` : name)
    pendingPath = null
    const segments = safeSegments(entryName)
    if (!segments || segments.length === 0) throw new Error(`包内路径不安全：${entryName}`)

    const target = path.join(destination, ...segments)
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    if (type === '2') continue // 符号链接：该包里没有，出现也不跟随
    if (type !== '0' && type !== '\0' && type !== '7') continue

    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
  }
}

function extract(tarball) {
  // 解包放到 resources 下的临时目录（同盘 rename 才能原子替换）
  const staging = fs.mkdtempSync(path.join(repoRoot, 'resources', '.drawio-staging-'))
  try {
    log('解包 …')
    extractTarGz(tarball, staging)

    const pkgRoot = path.join(staging, 'package')
    const editorRoot = path.join(pkgRoot, 'editor')
    if (!hasWebapp(editorRoot)) {
      throw new Error(`包结构不符合预期：${editorRoot} 下没有 index.html / js/app.min.js`)
    }

    const surveyResult = survey(editorRoot)
    if (surveyResult.files < MIN_FILES || surveyResult.bytes < MIN_BYTES) {
      throw new Error(`解包结果不完整（${describe(surveyResult)}），拒绝安装`)
    }

    // 先删旧目录再 rename：避免「删一半失败」留下空壳被当成已安装
    fs.rmSync(targetDir, { recursive: true, force: true })
    fs.renameSync(editorRoot, targetDir)

    // Apache-2.0 要求随分发保留许可与 NOTICE（包根目录才有，editor 里没有）
    for (const name of ['LICENSE', 'NOTICE']) {
      const from = path.join(pkgRoot, name)
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(targetDir, name))
    }

    return survey(targetDir)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

async function main() {
  if (checkOnly) {
    if (hasWebapp(targetDir)) {
      log(`就位：${targetDir}`)
      return 0
    }
    warn(`缺失：${targetDir}`)
    return 1
  }

  if (hasWebapp(targetDir) && !force) {
    log(`已就位，跳过（${describe(survey(targetDir))}）`)
    return 0
  }

  try {
    const tarball = await downloadTarball()
    const surveyResult = extract(tarball)
    log(`完成：${targetDir}（${describe(surveyResult)}）`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (optional) {
      warn(`本次跳过：${message}`)
      warn('图表编辑器需要本地 draw.io webapp；`pnpm run fetch:drawio` 可随时重试。')
      return 0
    }
    console.error('')
    console.error(`[drawio] 取 draw.io webapp 失败：${message}`)
    console.error('[drawio] 处理办法：')
    console.error('[drawio]   1. 检查网络 / 代理后重试：pnpm run fetch:drawio')
    console.error('[drawio]   2. 走内网镜像：INKASE_DRAWIO_REGISTRY=<镜像地址> pnpm run fetch:drawio')
    console.error('[drawio]   3. 也可以把 tarball 手动放进 node_modules/.cache/inkase-drawio/ 后重试')
    console.error('[drawio]   4. 已手动放好 resources/drawio 时可直接校验：pnpm run fetch:drawio --check')
    return 1
  }
}

process.exitCode = await main()
