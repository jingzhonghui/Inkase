/**
 * Word (.docx) 导入测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { importFromDocx, generateDocxImportReport } from '../docx-import'
import { htmlToMarkdown } from '../html-to-md'

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-import-test-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('htmlToMarkdown', () => {
  it('should convert basic HTML to Markdown', () => {
    const html = '<h1>Title</h1><p>Content</p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('# Title')
    expect(md).toContain('Content')
  })

  it('should convert bold and italic', () => {
    const html = '<p><strong>bold</strong> and <em>italic</em></p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('**bold**')
    expect(md).toContain('*italic*')
  })

  it('should convert lists', () => {
    const html = '<ul><li>Item 1</li><li>Item 2</li></ul>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('- Item 1')
    expect(md).toContain('- Item 2')
  })

  it('should convert tables', () => {
    const html = '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('| A | B |')
    expect(md).toContain('| 1 | 2 |')
  })
})

describe('importFromDocx', () => {
  it('should return error for non-existent file', async () => {
    const result = await importFromDocx('/non/existent/file.docx')
    expect(result.success).toBe(false)
    expect(result.error).toContain('不存在')
  })

  it('should reject legacy .doc files', async () => {
    const docPath = path.join(tmpDir, 'legacy.doc')
    fs.writeFileSync(docPath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) // OLE2 魔数
    const result = await importFromDocx(docPath)
    expect(result.success).toBe(false)
    expect(result.error).toContain('.docx')
  })

  it('should generate import report', () => {
    const report = generateDocxImportReport(['img1.png', 'img2.png'], ['img3.png'])
    expect(report).toContain('成功导入: 2 个图片')
    expect(report).toContain('导入失败: 1 个图片')
    expect(report).toContain('img1.png')
    expect(report).toContain('img3.png')
  })
})