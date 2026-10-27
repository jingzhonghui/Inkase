import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  XMIND_EXTENSION,
  exportMindMapToXmindFile,
  importXmindToFile,
  readXmindContent,
  writeXmindArchive
} from '../xmind-archive'
import { readArchive, writeArchive } from '../inkmind-archive'
import { mindMapToXmind } from '../../../shared/mindmap/xmind'
import { MINDMAP_VERSION } from '../../../shared/mindmap/document'

/**
 * `.xmind` ↔ `.inkmind` 的文件层。
 *
 * 重点是**落盘格式**：`.inkmind` 是 ZIP 容器，导入时若把文本直接写进去，
 * 文件当场就是坏的（打开报「已损坏」）。这里守的就是这条边界。
 */

let tmpDir = ''

function inkmindText(): string {
  return `${JSON.stringify(
    {
      schema: 'inkase.mindmap',
      version: MINDMAP_VERSION,
      direction: 'right',
      root: {
        id: 'r',
        text: '产品规划',
        children: [{ id: 'a', text: 'Alpha 计划', children: [] }]
      }
    },
    null,
    2
  )}\n`
}

/** 造一个能读的 `.xmind` 源文件 */
function makeXmind(filePath: string): string {
  const converted = mindMapToXmind(inkmindText())
  if (!converted.ok) throw new Error(converted.error)
  writeXmindArchive(filePath, converted.files)
  return filePath
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-xmind-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('importXmindToFile', () => {
  it('落盘的是 ZIP 容器，不是裸文本', () => {
    const source = makeXmind(path.join(tmpDir, '计划.xmind'))

    const imported = importXmindToFile(source, tmpDir)
    if (!imported.ok) throw new Error(imported.error)

    expect(imported.data.filePath.endsWith('.inkmind')).toBe(true)
    // ZIP 魔数：PK\x03\x04。裸文本会在这里露馅
    const head = fs.readFileSync(imported.data.filePath).subarray(0, 4)
    expect(head.toString('binary')).toBe('PK\x03\x04')
  })

  it('容器能被正常打开，导图结构完整', () => {
    const source = makeXmind(path.join(tmpDir, '计划.xmind'))

    const imported = importXmindToFile(source, tmpDir)
    if (!imported.ok) throw new Error(imported.error)

    const archive = readArchive(imported.data.filePath)
    if (!archive.ok) throw new Error(archive.error)

    const parsed = JSON.parse(archive.content)
    expect(parsed.schema).toBe('inkase.mindmap')
    expect(parsed.root.text).toBe('产品规划')
    expect(parsed.root.children[0].text).toBe('Alpha 计划')
  })

  it('重名不覆盖，另存为 _1', () => {
    const source = makeXmind(path.join(tmpDir, '计划.xmind'))
    const first = importXmindToFile(source, tmpDir)
    if (!first.ok) throw new Error(first.error)
    const before = fs.readFileSync(first.data.filePath)

    const second = importXmindToFile(source, tmpDir)
    if (!second.ok) throw new Error(second.error)

    expect(second.data.filePath).not.toBe(first.data.filePath)
    expect(path.basename(second.data.filePath, '.inkmind')).toMatch(/_1$/)
    // 原文件一个字节都不该动
    expect(fs.readFileSync(first.data.filePath).equals(before)).toBe(true)
  })

  it('源文件不是 .xmind 时明确失败', () => {
    const bogus = path.join(tmpDir, 'note.txt')
    fs.writeFileSync(bogus, 'hello')

    const imported = importXmindToFile(bogus, tmpDir)
    expect(imported.ok).toBe(false)
    if (imported.ok) return
    expect(imported.error).toContain('XMind')
  })

  it('导入结果里的提示能解释被丢掉的内容', () => {
    // XMind 8 的 content.xml 不支持，应该给「用新版另存」的提示
    const legacy = path.join(tmpDir, '旧版.xmind')
    const zip = new AdmZip()
    zip.addFile('content.xml', Buffer.from('<xmap-content/>', 'utf8'))
    zip.writeZip(legacy)

    const imported = importXmindToFile(legacy, tmpDir)
    expect(imported.ok).toBe(false)
    if (imported.ok) return
    expect(imported.error).toContain('另存')
  })
})

describe('exportMindMapToXmindFile', () => {
  it('导出的 .xmind 能再读回来', () => {
    const target = path.join(tmpDir, '导出.xmind')

    const exported = exportMindMapToXmindFile(inkmindText(), target)
    expect(exported.ok).toBe(true)

    const read = readXmindContent(target)
    if (!read.ok) throw new Error(read.error)
    // 新版 XMind 的 content.json 是「画布数组」
    expect(Array.isArray(read.content)).toBe(true)
    expect((read.content as { rootTopic?: unknown }[])[0].rootTopic).toBeTruthy()
    // 必须是 ZIP：XMind 不认裸 JSON
    expect(fs.readFileSync(target).subarray(0, 2).toString('binary')).toBe('PK')
  })

  it('导出后文件名带 .xmind 扩展由调用方负责，这里原样写', () => {
    const target = path.join(tmpDir, 'whatever.xmind')
    const exported = exportMindMapToXmindFile(inkmindText(), target)
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    expect(exported.filePath).toBe(target)
    expect(XMIND_EXTENSION).toBe('.xmind')
  })
})

describe('容器往返', () => {
  it('新建的 .inkmind 与导入的 .inkmind 结构一致', () => {
    const direct = writeArchive(path.join(tmpDir, '直接.inkmind'), inkmindText())
    expect(direct.ok).toBe(true)

    const source = makeXmind(path.join(tmpDir, '转换.xmind'))
    const imported = importXmindToFile(source, tmpDir)
    if (!imported.ok) throw new Error(imported.error)

    const a = readArchive(path.join(tmpDir, '直接.inkmind'))
    const b = readArchive(imported.data.filePath)
    if (!a.ok || !b.ok) throw new Error('读取失败')

    // 两边都只有 map.json，且内容都能解析
    expect(Object.keys(JSON.parse(a.content)).sort()).toEqual(
      Object.keys(JSON.parse(b.content)).sort()
    )
  })
})
