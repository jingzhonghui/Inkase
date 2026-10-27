/**
 * 把 draw.io webapp 取到 `resources/drawio/`。
 *
 * 为什么不让它进 npm 依赖、也不提交进仓库：
 * - 解包后 45 MB / 767 个文件，塞进 git 会把每次 clone 都拖慢，diff 也毫无意义；
 * - 它是随包分发的第三方二进制资源（Apache-2.0，需保留 LICENSE/NOTICE），
 *   与 `resources/rg` 同性质，走「构建前拉取 + extraResources」更合适。
 *
 * 用法：
 *   pnpm run fetch:drawio          # 已存在就跳过
 *   pnpm run fetch:drawio --force  # 强制重下
 *
 * 源包：`@guowenzhang/dsh-drawioedit`（draw.io 官方 webapp 的裁剪分发版，
 * 体积约为官方的 1/3，中文语言包与 Mermaid 解析都在）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const targetDir = path.join(repoRoot, 'resources', 'drawio')
const PACKAGE_NAME = '@guowenzhang/dsh-drawioedit'
const REGISTRY = 'https://registry.npmmirror.com'

const force = process.argv.includes('--force')

function log(message) {
  console.log(`[fetch-drawio] ${message}`)
}

function hasWebapp(dir) {
  try {
    return fs.statSync(path.join(dir, 'index.html')).isFile() && fs.statSync(path.join(dir, 'js', 'app.min.js')).isFile()
  } catch {
    return false
  }
}

function dirSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else if (entry.isFile()) total += fs.statSync(full).size
  }
  return total
}

if (hasWebapp(targetDir) && !force) {
  const mb = (dirSize(targetDir) / 1024 / 1024).toFixed(1)
  log(`已存在，跳过（${mb} MB）`)
  process.exit(0)
}

if (force && fs.existsSync(targetDir)) {
  log('--force：删除旧目录')
  fs.rmSync(targetDir, { recursive: true, force: true })
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-drawio-'))
log(`下载 ${PACKAGE_NAME} …`)
// npm pack 比手动拼 URL 稳：跟随 registry 的 tarball 重定向，也自动处理版本
execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', PACKAGE_NAME, `--registry=${REGISTRY}`, '--pack-destination', staging, '--silent'],
  { stdio: 'inherit', cwd: staging }
)

const tarball = fs.readdirSync(staging).find((name) => name.endsWith('.tgz'))
if (!tarball) {
  log('没能下载到 tarball，退出')
  process.exit(1)
}

log('解包 …')
execFileSync('tar', ['-xzf', path.join(staging, tarball), '-C', staging], { stdio: 'inherit' })

const extracted = path.join(staging, 'package', 'editor')
if (!hasWebapp(extracted)) {
  log(`包结构不符合预期：${extracted} 下没有 index.html`)
  process.exit(1)
}

fs.mkdirSync(path.dirname(targetDir), { recursive: true })
fs.cpSync(extracted, targetDir, { recursive: true })
fs.rmSync(staging, { recursive: true, force: true })

// 许可文件必须随包走：Apache-2.0 要求保留 NOTICE
const pkgRoot = path.join(repoRoot, 'resources', 'drawio')
for (const name of ['LICENSE', 'NOTICE']) {
  const source = path.join(pkgRoot, name)
  if (fs.existsSync(source)) continue
  const fallback = path.join(repoRoot, 'resources', 'drawio', `${name}.txt`)
  if (fs.existsSync(fallback)) fs.copyFileSync(fallback, source)
}

const mb = (dirSize(targetDir) / 1024 / 1024).toFixed(1)
log(`完成：${targetDir}（${mb} MB）`)
