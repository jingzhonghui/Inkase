import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assetFileName,
  isAssetEntry,
  readArchive,
  sanitizeAssetName,
  storeAsset,
  writeArchive,
  writeArchiveFromDir
} from '../inkmind-archive'

/**
 * `.inkmind` 容器的读写。
 *
 * 这一层最容易出的错是「存进去的和读出来的不是一回事」，
 * 所以每个用例都走真实的 ZIP 往返，不 mock 文件系统。
 */

let tmpDir = ''

const MAP_JSON = '{"schema":"inkase.mindmap","version":2,"root":{"id":"r","text":"根"}}'

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-archive-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeFile(archivePath: string, mapJson = MAP_JSON): string {
  const result = writeArchive(archivePath, mapJson)
  expect(result.ok).toBe(true)
  return archivePath
}

describe('isAssetEntry', () => {
  it('只接受 assets/<一层>/<文件名>', () => {
    expect(isAssetEntry('assets/images/a.png')).toBe(true)
    expect(isAssetEntry('assets/files/b.pdf')).toBe(true)
    // 更深层级、目录条目、越界路径都不算资源
    expect(isAssetEntry('assets/images/sub/a.png')).toBe(false)
    expect(isAssetEntry('assets/images/')).toBe(false)
    expect(isAssetEntry('assets/../a.png')).toBe(false)
    expect(isAssetEntry('map.json')).toBe(false)
  })
})

describe('writeArchive / readArchive', () => {
  it('写入后能原样读回 map.json', () => {
    const archivePath = makeFile(path.join(tmpDir, 'a.inkmind'))
    const read = readArchive(archivePath)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.content).toBe(MAP_JSON)
    expect(read.assetMap).toEqual({})
    fs.rmSync(read.tempDir, { recursive: true, force: true })
  })

  it('读取时把资源解到临时目录并给出映射', () => {
    const tempDir = fs.mkdtempSync(path.join(tmpDir, 'src-'))
    fs.mkdirSync(path.join(tempDir, 'assets', 'images'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'map.json'), MAP_JSON)
    fs.writeFileSync(path.join(tempDir, 'assets', 'images', 'a.png'), Buffer.alloc(4, 7))

    const archivePath = path.join(tmpDir, 'b.inkmind')
    expect(writeArchiveFromDir(tempDir, archivePath).ok).toBe(true)

    const read = readArchive(archivePath)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const asset = read.assetMap['assets/images/a.png']
    expect(asset).toBeDefined()
    expect(fs.readFileSync(asset)).toEqual(Buffer.alloc(4, 7))
    fs.rmSync(read.tempDir, { recursive: true, force: true })
  })

  it('缺少 map.json 时给出明确错误', () => {
    const archivePath = path.join(tmpDir, 'c.inkmind')
    const zip = new AdmZip()
    zip.addFile('readme.txt', Buffer.from('hi'))
    zip.writeZip(archivePath)

    const read = readArchive(archivePath)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toContain('map.json')
  })

  it('不是 ZIP 的文件被拒（纯文本旧文件也一样）', () => {
    const archivePath = path.join(tmpDir, 'd.inkmind')
    fs.writeFileSync(archivePath, MAP_JSON, 'utf8')

    const read = readArchive(archivePath)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toContain('损坏')
  })

  it('文件不存在时报错而不是抛异常', () => {
    const read = readArchive(path.join(tmpDir, 'missing.inkmind'))
    expect(read.ok).toBe(false)
  })
})

describe('storeAsset', () => {
  it('按内容哈希命名，同内容重复插入只留一份', () => {
    const tempDir = fs.mkdtempSync(path.join(tmpDir, 'store-'))
    const source = path.join(tmpDir, 'hero.png')
    fs.writeFileSync(source, Buffer.alloc(16, 3))

    const first = storeAsset(tempDir, source, 'image', 1024 * 1024)
    const second = storeAsset(tempDir, source, 'image', 1024 * 1024)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.data.src).toBe(second.data.src)
    expect(first.data.src.startsWith('assets/images/')).toBe(true)
    // 目录里只有一份
    expect(fs.readdirSync(path.join(tempDir, 'assets', 'images'))).toHaveLength(1)
  })

  it('同名不同内容的文件不会互相覆盖', () => {
    const tempDir = fs.mkdtempSync(path.join(tmpDir, 'store2-'))
    const a = path.join(tmpDir, 'a.png')
    const b = path.join(tmpDir, 'b.png')
    fs.writeFileSync(a, Buffer.alloc(8, 1))
    fs.writeFileSync(b, Buffer.alloc(8, 2))

    const first = storeAsset(tempDir, a, 'image', 1024 * 1024)
    const second = storeAsset(tempDir, b, 'image', 1024 * 1024)
    if (!first.ok || !second.ok) throw new Error('写入失败')
    expect(first.data.src).not.toBe(second.data.src)
  })

  it('附件走 assets/files/，并带回原始文件名与大小', () => {
    const tempDir = fs.mkdtempSync(path.join(tmpDir, 'store3-'))
    const source = path.join(tmpDir, '方案.pdf')
    fs.writeFileSync(source, Buffer.alloc(32, 9))

    const result = storeAsset(tempDir, source, 'file', 1024 * 1024)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.src.startsWith('assets/files/')).toBe(true)
    expect(result.data.name).toBe('方案.pdf')
    expect(result.data.size).toBe(32)
  })

  it('超过上限时拒绝并说明限制', () => {
    const tempDir = fs.mkdtempSync(path.join(tmpDir, 'store4-'))
    const source = path.join(tmpDir, 'big.pdf')
    fs.writeFileSync(source, Buffer.alloc(2048, 1))

    const result = storeAsset(tempDir, source, 'file', 1024)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('MB')
  })
})

describe('命名', () => {
  it('清洗掉危险字符并限制长度', () => {
    expect(sanitizeAssetName('a b:c.png')).toBe('a-b-c.png')
    expect(sanitizeAssetName('   ')).toBe('file')
    expect(sanitizeAssetName(`${'x'.repeat(60)}.png`).length).toBeLessThanOrEqual(24)
  })

  it('哈希名保留扩展名并带内容指纹', () => {
    const name = assetFileName('hero.png', Buffer.from('abc'))
    expect(name).toMatch(/^hero_[0-9a-f]{8}\.png$/)
  })
})
