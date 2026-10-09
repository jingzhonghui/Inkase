import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { createPreviewResponse, parsePreviewUrl, PREVIEW_SCHEME } from '../preview-protocol'

describe('parsePreviewUrl', () => {
  it('parses a windows path built by buildPreviewUrl style encoding', () => {
    const parsed = parsePreviewUrl('inkase-preview://local/C%3A/docs/index.html')
    expect(parsed).not.toBeNull()
    expect(parsed!.absolutePath).toBe(path.normalize('C:\\docs\\index.html'))
  })

  it('parses plain (unencoded) drive paths as produced by browsers', () => {
    const parsed = parsePreviewUrl('inkase-preview://local/C:/docs/index.html')
    expect(parsed).not.toBeNull()
    expect(parsed!.absolutePath).toBe(path.normalize('C:\\docs\\index.html'))
  })

  it('decodes encoded segments (spaces, cjk, hash)', () => {
    const parsed = parsePreviewUrl('inkase-preview://local/C%3A/docs/%E6%88%91%E7%9A%84%20%E6%96%87%E6%A1%A3%231.html')
    expect(parsed).not.toBeNull()
    expect(parsed!.absolutePath).toBe(path.normalize('C:\\docs\\我的 文档#1.html'))
  })

  it('rejects non-preview schemes and unexpected hosts', () => {
    expect(parsePreviewUrl('file:///C:/docs/index.html')).toBeNull()
    expect(parsePreviewUrl('inkase-preview://evil/C:/docs/index.html')).toBeNull()
    expect(parsePreviewUrl('not a url')).toBeNull()
  })

  it('rejects empty paths and traversal payloads inside segments', () => {
    expect(parsePreviewUrl('inkase-preview://local/')).toBeNull()
    expect(parsePreviewUrl('inkase-preview://local/C%3A/docs/..%2Fsecret.txt')).toBeNull()
    expect(parsePreviewUrl('inkase-preview://local/C%3A/..%5Csecret.txt')).toBeNull()
  })

  it('normalizes encoded dot segments per the URL spec before parsing', () => {
    // WHATWG URL 会在解析层消化 %2E%2E 段，处理器拿到的是已规范化的路径
    const parsed = parsePreviewUrl('inkase-preview://local/C%3A/docs/%2E%2E/secret.txt')
    expect(parsed).not.toBeNull()
    expect(parsed!.absolutePath).toBe(path.normalize('C:\\secret.txt'))
  })
})

describe('createPreviewResponse', () => {
  it('returns file content with the mapped mime type', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inkase-preview-'))
    const file = path.join(dir, 'page.html')
    writeFileSync(file, '<h1>ok</h1>', 'utf8')
    const res = createPreviewResponse(file)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html')
    expect(await res.text()).toBe('<h1>ok</h1>')
  })

  it('falls back to octet-stream for unknown extensions', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inkase-preview-'))
    const file = path.join(dir, 'asset.weird')
    writeFileSync(file, 'x', 'utf8')
    const res = createPreviewResponse(file)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
  })

  it('returns 404 for missing files and directories', () => {
    expect(createPreviewResponse(path.join(tmpdir(), 'inkase-preview-missing.html')).status).toBe(404)
    expect(createPreviewResponse(tmpdir()).status).toBe(404)
  })
})

describe('scheme constant', () => {
  it('uses the agreed scheme name', () => {
    expect(PREVIEW_SCHEME).toBe('inkase-preview')
  })
})
