/**
 * Import 模块单元测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  extractImageReferences,
  importFromMarkdown,
  generateImportReport
} from '../import'

describe('Import Module', () => {
  let testDir: string

  beforeAll(() => {
    testDir = path.join(os.tmpdir(), 'inkase-import-test-' + Date.now())
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('extractImageReferences', () => {
    it('should extract image references from markdown', () => {
      const content = `
# Title

![Alt text](path/to/image.png)

Some text

![Another](https://example.com/image.jpg "Title")
`

      const refs = extractImageReferences(content)

      expect(refs).toHaveLength(2)
      expect(refs[0].alt).toBe('Alt text')
      expect(refs[0].originalPath).toBe('path/to/image.png')
      expect(refs[1].alt).toBe('Another')
      expect(refs[1].originalPath).toBe('https://example.com/image.jpg')
      expect(refs[1].title).toBe('Title')
    })

    it('should handle markdown with no images', () => {
      const content = '# Title\n\nJust text'

      const refs = extractImageReferences(content)

      expect(refs).toHaveLength(0)
    })

    it('should handle multiple images on same line', () => {
      const content = '![a](1.png) ![b](2.png)'

      const refs = extractImageReferences(content)

      expect(refs).toHaveLength(2)
    })
  })

  describe('importFromMarkdown', () => {
    it('should return error for non-existent file', () => {
      const result = importFromMarkdown('/non/existent/file.md')

      expect(result.success).toBe(false)
      expect(result.error).toContain('不存在')
    })

    it('should import simple markdown file', () => {
      const mdContent = '# Test Document\n\nThis is content.'
      const mdPath = path.join(testDir, 'simple.md')
      fs.writeFileSync(mdPath, mdContent)

      const result = importFromMarkdown(mdPath)

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()

      if (result.data) {
        const { document, importedImages, failedImages } = result.data

        expect(document.metadata.title).toBe('simple')
        expect(document.content).toBe(mdContent)
        expect(importedImages).toHaveLength(0)
        expect(failedImages).toHaveLength(0)
      }
    })

    it('should import markdown with local images', () => {
      // Create test image
      const imageDir = path.join(testDir, 'images')
      fs.mkdirSync(imageDir, { recursive: true })
      const imagePath = path.join(imageDir, 'test.png')
      fs.writeFileSync(imagePath, 'fake png data')

      // Create markdown
      const mdContent = '# Doc\n\n![Test](images/test.png)\n\nText'
      const mdPath = path.join(testDir, 'with-image.md')
      fs.writeFileSync(mdPath, mdContent)

      const result = importFromMarkdown(mdPath)

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()

      if (result.data) {
        const { document, importedImages } = result.data

        expect(importedImages).toHaveLength(1)
        expect(document.assets.images).toHaveLength(1)
        expect(document.content).toContain('assets/images/')
      }
    })

    it('should skip external URLs', () => {
      const mdContent = '![External](https://example.com/image.png)'
      const mdPath = path.join(testDir, 'external.md')
      fs.writeFileSync(mdPath, mdContent)

      const result = importFromMarkdown(mdPath)

      expect(result.success).toBe(true)
      if (result.data) {
        expect(result.data.importedImages).toHaveLength(0)
        expect(result.data.failedImages).toHaveLength(0)
        // URL should remain unchanged
        expect(result.data.document.content).toContain('https://example.com/image.png')
      }
    })

    it('should report missing images as failed', () => {
      const mdContent = '![Missing](images/non-existent.png)'
      const mdPath = path.join(testDir, 'missing-image.md')
      fs.writeFileSync(mdPath, mdContent)

      const result = importFromMarkdown(mdPath)

      expect(result.success).toBe(true)
      if (result.data) {
        expect(result.data.failedImages).toHaveLength(1)
        expect(result.data.failedImages[0]).toContain('non-existent')
      }
    })
  })

  describe('generateImportReport', () => {
    it('should generate report with all successes', () => {
      const imported = ['img1.png', 'img2.jpg']
      const failed: string[] = []

      const report = generateImportReport(imported, failed)

      expect(report).toContain('导入报告')
      expect(report).toContain('成功导入: 2 个图片')
      expect(report).toContain('img1.png')
      expect(report).toContain('img2.jpg')
      expect(report).not.toContain('导入失败')
    })

    it('should generate report with failures', () => {
      const imported = ['img1.png']
      const failed = ['img2.png', 'img3.png']

      const report = generateImportReport(imported, failed)

      expect(report).toContain('成功导入: 1 个图片')
      expect(report).toContain('导入失败: 2 个图片')
      expect(report).toContain('img2.png')
    })
  })
})
