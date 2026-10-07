/**
 * Writer 模块单元测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import AdmZip from 'adm-zip'
import { createMdxDocument } from '../schema'
import {
  generateAssetId,
  generateContentHashName,
  addImageAsset,
  removeAsset,
  validateFilePath,
  saveMdx
} from '../writer'
import { openMdx, cleanupTempDir } from '../reader'

describe('Writer Module', () => {
  let testDir: string

  beforeAll(() => {
    testDir = path.join(os.tmpdir(), 'inkase-test-' + Date.now())
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('generateAssetId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateAssetId()
      const id2 = generateAssetId()

      expect(id1).not.toBe(id2)
      expect(id1).toMatch(/^asset_/)
      expect(id2).toMatch(/^asset_/)
    })
  })

  describe('generateContentHashName', () => {
    it('should generate hash-based filename', () => {
      const content = Buffer.from('test content')
      const filename = generateContentHashName('image.png', content)

      expect(filename).toContain('_')
      expect(filename).toMatch(/\.png$/)
    })

    it('should generate different names for different content', () => {
      const content1 = Buffer.from('content 1')
      const content2 = Buffer.from('content 2')

      const name1 = generateContentHashName('image.png', content1)
      const name2 = generateContentHashName('image.png', content2)

      expect(name1).not.toBe(name2)
    })

    it('should handle filenames without extension', () => {
      const content = Buffer.from('test')
      const filename = generateContentHashName('image', content)

      expect(filename).not.toContain('.')
    })

    it('should sanitize special characters', () => {
      const content = Buffer.from('test')
      const filename = generateContentHashName('image<>?*test.png', content)

      expect(filename).not.toContain('<')
      expect(filename).not.toContain('>')
      expect(filename).not.toContain('?')
      expect(filename).not.toContain('*')
    })
  })

  describe('addImageAsset', () => {
    it('should add image to document', () => {
      const doc = createMdxDocument('Test')
      const imageData = Buffer.from('fake image data')

      const result = addImageAsset(doc, 'test.png', 'image/png', imageData)

      expect(result.asset).toBeDefined()
      expect(result.relativePath).toMatch(/^assets\/images\//)
      expect(doc.assets.images).toHaveLength(1)
      expect(doc.assets.images[0].filename).toContain('test')
      expect(doc.assets.images[0].mime_type).toBe('image/png')
    })

    it('should deduplicate same content images', () => {
      const doc = createMdxDocument('Test')
      const imageData = Buffer.from('same content')

      const result1 = addImageAsset(doc, 'image1.png', 'image/png', imageData)
      const result2 = addImageAsset(doc, 'image2.png', 'image/png', imageData)

      expect(result1.asset.id).toBe(result2.asset.id)
      expect(doc.assets.images).toHaveLength(1)
    })

    it('should calculate correct checksum', () => {
      const doc = createMdxDocument('Test')
      const imageData = Buffer.from('test data')

      const { asset } = addImageAsset(doc, 'test.png', 'image/png', imageData)

      expect(asset.checksum).toHaveLength(64) // SHA256 hex length
      expect(asset.size).toBe(imageData.length)
    })
  })

  describe('removeAsset', () => {
    it('should remove image asset', () => {
      const doc = createMdxDocument('Test')
      const imageData = Buffer.from('test')
      const { asset } = addImageAsset(doc, 'test.png', 'image/png', imageData)

      const removed = removeAsset(doc, asset.id)

      expect(removed).toBe(true)
      expect(doc.assets.images).toHaveLength(0)
    })

    it('should return false for non-existent asset', () => {
      const doc = createMdxDocument('Test')

      const removed = removeAsset(doc, 'non-existent-id')

      expect(removed).toBe(false)
    })
  })

  describe('validateFilePath', () => {
    it('should validate correct file path', () => {
      const result = validateFilePath('/path/to/file.mdx')
      expect(result.valid).toBe(true)
    })

    it('should reject file without extension', () => {
      const result = validateFilePath('/path/to/file')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('扩展名')
    })

    it('should reject file with wrong extension', () => {
      const result = validateFilePath('/path/to/file.txt')
      expect(result.valid).toBe(false)
    })

    it('should reject empty filename', () => {
      const result = validateFilePath('/path/to/.mdx')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('不能为空')
    })

    it('should reject path with invalid characters', () => {
      const result = validateFilePath('/path/to/file<>.mdx')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('非法字符')
    })
  })

  describe('saveMdx and openMdx', () => {
    it('should round-trip save and open mdx file', async () => {
      const doc = createMdxDocument('Round Trip Test', '# Hello World\n\nThis is a test.')
      const filePath = path.join(testDir, 'roundtrip.mdx')

      // Save
      const saveResult = await saveMdx(filePath, doc)
      expect(saveResult.success).toBe(true)
      expect(fs.existsSync(filePath)).toBe(true)

      // Open
      const openResult = openMdx(filePath)
      expect(openResult.success).toBe(true)
      expect(openResult.data).toBeDefined()

      if (openResult.data) {
        const { document: loadedDoc, tempDir } = openResult.data

        expect(loadedDoc.metadata.title).toBe(doc.metadata.title)
        expect(loadedDoc.content).toBe(doc.content)
        expect(loadedDoc.metadata.version).toBe(doc.metadata.version)

        cleanupTempDir(tempDir)
      }
    })

    it('should save and load document with images', async () => {
      const doc = createMdxDocument('Image Test', '![Test](assets/images/test.png)')
      const imageData = Buffer.from('fake png data')
      addImageAsset(doc, 'test.png', 'image/png', imageData)

      const filePath = path.join(testDir, 'with-image.mdx')
      const assetsData = new Map<string, Buffer>()
      assetsData.set(doc.assets.images[0].path, imageData)

      // Save
      const saveResult = await saveMdx(filePath, doc, assetsData)
      expect(saveResult.success).toBe(true)

      // Open
      const openResult = openMdx(filePath)
      expect(openResult.success).toBe(true)

      if (openResult.data) {
        const { document: loadedDoc, tempDir } = openResult.data

        expect(loadedDoc.assets.images).toHaveLength(1)
        expect(loadedDoc.assets.images[0].filename).toContain('test')

        cleanupTempDir(tempDir)
      }
    })

    it('rejects a ZIP entry whose declared inflated size exceeds the extraction cap', () => {
      const filePath = path.join(testDir, 'inflated-entry.mdx')
      const zip = new AdmZip()
      zip.addFile('mdx.json', Buffer.from(JSON.stringify({ content_file: 'content.md' })))
      zip.addFile('content.md', Buffer.from('A'.repeat(51 * 1024 * 1024)))
      zip.writeZip(filePath)

      const result = openMdx(filePath)
      expect(result).toMatchObject({ success: false })
      expect(result.error).toContain('解压后大小')
    })

    it('should return error for invalid file path', async () => {
      const doc = createMdxDocument('Test')
      const result = await saveMdx('/invalid/path/.mdx', doc)

      expect(result.success).toBe(false)
      expect(result.error).toContain('不能为空')
    })
  })
})
