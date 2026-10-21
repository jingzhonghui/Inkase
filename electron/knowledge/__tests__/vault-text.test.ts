import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readVaultText, writeVaultText } from '../vault-text'

let root: string

/** 构造一个真实可用的 .mdx（ZIP：mdx.json + content.md + 一张图片资源） */
function makeMdx(rel: string, content: string, imageBytes: Buffer): string {
  const imagePath = 'assets/images/pic.png'
  const manifest = {
    version: '1.0',
    created_at: '2020-01-01T00:00:00.000Z',
    modified_at: '2020-01-01T00:00:00.000Z',
    title: '笔记',
    encoding: 'UTF-8',
    content_file: 'content.md',
    assets: {
      images: [
        {
          id: 'img-1',
          filename: 'pic.png',
          path: imagePath,
          mime_type: 'image/png',
          size: imageBytes.length,
          checksum: 'deadbeef'
        }
      ]
    },
    settings: { editor_theme: 'light', preview_style: 'default' }
  }

  const zip = new AdmZip()
  zip.addFile('mdx.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))
  zip.addFile('content.md', Buffer.from(content, 'utf-8'))
  zip.addFile(imagePath, imageBytes)

  const absPath = path.join(root, rel)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  zip.writeZip(absPath)
  return absPath
}

function readEntry(absPath: string, entryName: string): Buffer {
  const zip = new AdmZip(absPath)
  const entry = zip.getEntry(entryName)
  if (entry === null) throw new Error(`缺少条目 ${entryName}`)
  return entry.getData()
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-vault-text-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('readVaultText', () => {
  it('reads plain markdown', async () => {
    const absPath = path.join(root, 'a.md')
    fs.writeFileSync(absPath, '# 标题', 'utf-8')

    expect(await readVaultText(absPath, 'a.md')).toBe('# 标题')
  })

  it('reads the content entry of an mdx', async () => {
    const absPath = makeMdx('note.mdx', '[[旧]]', Buffer.from([1, 2, 3]))

    expect(await readVaultText(absPath, 'note.mdx')).toBe('[[旧]]')
  })

  it('returns null for types that are not rewritable', async () => {
    const absPath = path.join(root, 'a.pdf')
    fs.writeFileSync(absPath, 'x', 'utf-8')

    expect(await readVaultText(absPath, 'a.pdf')).toBeNull()
  })
})

describe('writeVaultText', () => {
  it('writes plain markdown', async () => {
    const absPath = path.join(root, 'a.md')
    fs.writeFileSync(absPath, '[[旧]]', 'utf-8')

    await writeVaultText(absPath, 'a.md', '[[新]]')

    expect(fs.readFileSync(absPath, 'utf-8')).toBe('[[新]]')
  })

  it('rewrites the mdx content entry and preserves assets', async () => {
    const imageBytes = Buffer.from([137, 80, 78, 71, 9, 9])
    const absPath = makeMdx('note.mdx', '[[旧]]', imageBytes)

    await writeVaultText(absPath, 'note.mdx', '[[新]]')

    expect(readEntry(absPath, 'content.md').toString('utf8')).toBe('[[新]]')
    // 关键性质：资源条目必须原样保留
    expect(readEntry(absPath, 'assets/images/pic.png').equals(imageBytes)).toBe(true)
  })

  it('keeps the manifest valid and refreshes modified_at', async () => {
    const absPath = makeMdx('note.mdx', '[[旧]]', Buffer.from([1]))

    await writeVaultText(absPath, 'note.mdx', '[[新]]')

    const manifest = JSON.parse(readEntry(absPath, 'mdx.json').toString('utf8')) as {
      modified_at: string
      content_file: string
      assets: { images: Array<{ path: string }> }
    }
    expect(manifest.content_file).toBe('content.md')
    expect(manifest.assets.images[0].path).toBe('assets/images/pic.png')
    expect(manifest.modified_at).not.toBe('2020-01-01T00:00:00.000Z')
  })

  it('round-trips through readVaultText', async () => {
    const absPath = makeMdx('note.mdx', '[[旧]]', Buffer.from([1]))

    await writeVaultText(absPath, 'note.mdx', '[[新]]\n\n正文')

    expect(await readVaultText(absPath, 'note.mdx')).toBe('[[新]]\n\n正文')
  })

  it('rejects an mdx whose content entry is missing', async () => {
    const absPath = path.join(root, 'broken.mdx')
    const zip = new AdmZip()
    zip.addFile('mdx.json', Buffer.from(JSON.stringify({ content_file: 'content.md' }), 'utf-8'))
    zip.writeZip(absPath)

    await expect(writeVaultText(absPath, 'broken.mdx', 'x')).rejects.toThrow('MDX 内容文件不存在')
  })

  it('rejects a type it cannot rewrite', async () => {
    const absPath = path.join(root, 'a.pdf')
    fs.writeFileSync(absPath, 'x', 'utf-8')

    await expect(writeVaultText(absPath, 'a.pdf', 'x')).rejects.toThrow('不支持改写')
  })

  it('does not leave a .tmp file behind', async () => {
    const absPath = makeMdx('note.mdx', '[[旧]]', Buffer.from([1]))

    await writeVaultText(absPath, 'note.mdx', '[[新]]')

    expect(fs.existsSync(`${absPath}.tmp`)).toBe(false)
  })
})
