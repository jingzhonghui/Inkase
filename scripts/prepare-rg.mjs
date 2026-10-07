import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const VERSION = '14.1.1'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESOURCES_DIR = path.join(ROOT, 'resources', 'rg')
const CHECKSUMS_PATH = path.join(RESOURCES_DIR, 'checksums.json')
const targetArg = process.argv[process.argv.indexOf('--target') + 1]
const archArg = process.argv[process.argv.indexOf('--arch') + 1] ?? process.arch

const TARGETS = {
  win: { dir: 'win32-x64', asset: `ripgrep-${VERSION}-x86_64-pc-windows-msvc.zip`, binary: 'rg.exe', archiveType: 'zip' },
  'mac-x64': { dir: 'darwin-x64', asset: `ripgrep-${VERSION}-x86_64-apple-darwin.tar.gz`, binary: 'rg', archiveType: 'tar' },
  'mac-arm64': { dir: 'darwin-arm64', asset: `ripgrep-${VERSION}-aarch64-apple-darwin.tar.gz`, binary: 'rg', archiveType: 'tar' },
  linux: { dir: 'linux-x64', asset: `ripgrep-${VERSION}-x86_64-unknown-linux-musl.tar.gz`, binary: 'rg', archiveType: 'tar' }
}

function targetInfo() {
  if (targetArg === 'win') return TARGETS.win
  if (targetArg === 'mac') return archArg === 'arm64' ? TARGETS['mac-arm64'] : TARGETS['mac-x64']
  if (targetArg === 'linux') return TARGETS.linux
  throw new Error('Usage: node scripts/prepare-rg.mjs --target <win|mac|linux> [--arch <x64|arm64>]')
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex').toUpperCase()
}

async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status} ${url}`)
  await pipeline(response.body, createWriteStream(destination))
}

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const result = await findFile(fullPath, name)
      if (result) return result
    } else if (entry.name === name) {
      return fullPath
    }
  }
  return null
}

function extract(archivePath, info, destination) {
  if (info.archiveType === 'zip') {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`
    ], { stdio: 'inherit' })
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', destination], { stdio: 'inherit' })
  }
}

async function readChecksums() {
  try {
    return JSON.parse(await readFile(CHECKSUMS_PATH, 'utf8'))
  } catch {
    return { version: VERSION, source: 'https://github.com/BurntSushi/ripgrep/releases', binaries: {} }
  }
}

async function main() {
  const info = targetInfo()
  const outputDir = path.join(RESOURCES_DIR, info.dir)
  const outputPath = path.join(outputDir, info.binary)
  const checksums = await readChecksums()
  const existing = checksums.binaries?.[info.dir]?.sha256

  if (existing) {
    try {
      if ((await sha256(outputPath)) === existing.toUpperCase()) {
        console.log(`rg ${VERSION} 已存在且校验通过：${outputPath}`)
        return
      }
    } catch {
      // 文件缺失或损坏，继续下载。
    }
  }

  const baseUrl = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}`
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'inkase-rg-'))
  const archivePath = path.join(tempDir, info.asset)
  const extractDir = path.join(tempDir, 'extract')
  try {
    await mkdir(extractDir, { recursive: true })
    console.log(`下载 rg ${VERSION}：${info.asset}`)
    await download(`${baseUrl}/${info.asset}`, archivePath)

    const archiveHash = await sha256(archivePath)
    const sumsResponse = await fetch(`${baseUrl}/${info.asset}.sha256`)
    if (!sumsResponse.ok) throw new Error(`无法下载校验文件：HTTP ${sumsResponse.status}`)
    const sums = await sumsResponse.text()
    const expectedArchiveHash = sums.trim().split(/\s+/)[0]?.toUpperCase()
    if (!expectedArchiveHash || archiveHash !== expectedArchiveHash) {
      throw new Error(`rg 归档校验失败：期望 ${expectedArchiveHash ?? '未知'}，实际 ${archiveHash}`)
    }

    extract(archivePath, info, extractDir)
    const extractedBinary = await findFile(extractDir, info.binary)
    if (!extractedBinary) throw new Error(`解压后未找到 ${info.binary}`)
    await mkdir(outputDir, { recursive: true })
    await writeFile(outputPath, await readFile(extractedBinary))
    if (info.archiveType !== 'zip') execFileSync('chmod', ['755', outputPath])

    checksums.version = VERSION
    checksums.source = `${baseUrl}/${info.asset}`
    checksums.binaries ??= {}
    checksums.binaries[info.dir] = {
      file: info.binary,
      sha256: await sha256(outputPath),
      archive: info.asset,
      archiveSha256: archiveHash
    }
    await writeFile(CHECKSUMS_PATH, `${JSON.stringify(checksums, null, 2)}\n`, 'utf8')
    console.log(`rg 已准备完成：${outputPath}`)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

await main()
