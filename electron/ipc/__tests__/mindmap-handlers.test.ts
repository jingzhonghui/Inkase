import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    })
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({ id: 1 }))
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn()
  }
}))

import { dialog } from 'electron'
import { IPC_CHANNELS } from '../channels'
import { registerMindMapHandlers } from '../mindmap-handlers'
import { parseMindMap } from '../../../src/utils/mindmap/schema'
import { readArchive } from '../../mindmap/inkmind-archive'

const dirsToClean: string[] = []

interface HandlerResult {
  success: boolean
  data?: {
    filePath: string
    warnings: Record<string, number>
    warningsSummary: string[]
  }
  error?: string
}

async function call(channel: string, ...args: unknown[]): Promise<HandlerResult> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return (await handler(undefined, ...args)) as HandlerResult
}

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-xmind-'))
  dirsToClean.push(dir)
  return dir
}

/** 造一个 .xmind（ZIP），避免在仓库里提交二进制 fixture */
function makeXmind(
  name: string,
  content: unknown | null,
  extra: Record<string, string> = {}
): string {
  const dir = makeDir()
  const filePath = path.join(dir, name)
  const zip = new AdmZip()
  if (content !== null) {
    zip.addFile('content.json', Buffer.from(JSON.stringify(content), 'utf8'))
  }
  for (const [entryName, text] of Object.entries(extra)) {
    zip.addFile(entryName, Buffer.from(text, 'utf8'))
  }
  zip.writeZip(filePath)
  return filePath
}

function simpleSheet(rootTitle = '中心主题'): unknown[] {
  return [
    {
      id: 'sheet-1',
      class: 'sheet',
      title: '画布 1',
      rootTopic: {
        id: 'root-1',
        class: 'topic',
        title: rootTitle,
        structureClass: 'org.xmind.ui.logic.right',
        children: {
          attached: [
            {
              id: 'n1',
              class: 'topic',
              title: '分支一',
              notes: { plain: { content: '备注内容' } },
              branch: 'folded',
              children: { attached: [{ id: 'n2', title: '叶子' }] }
            }
          ]
        }
      }
    }
  ]
}

describe('XMind IPC handlers', () => {
  afterEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    for (const dir of dirsToClean) fs.rmSync(dir, { recursive: true, force: true })
    dirsToClean.length = 0
  })

  it('导入：落盘 .inkmind，内容与层级都能被渲染层解析', async () => {
    registerMindMapHandlers()
    const source = makeXmind('产品规划.xmind', simpleSheet('产品规划'))
    const targetDir = makeDir()

    const result = await call(IPC_CHANNELS.MINDMAP.IMPORT_XMIND, source, targetDir)
    expect(result.success).toBe(true)
    expect(result.data?.filePath).toBe(path.join(targetDir, '产品规划.inkmind'))
    expect(fs.existsSync(result.data!.filePath)).toBe(true)

    // 渲染层必须能直接打开这个文件（.inkmind 是 ZIP 容器，要先解包）
    const archive = readArchive(result.data!.filePath)
    if (!archive.ok) throw new Error(archive.error)
    const parsed = parseMindMap(archive.content)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.direction).toBe('right')
    expect(parsed.document.root.text).toBe('产品规划')
    expect(parsed.document.root.children[0]).toMatchObject({
      text: '分支一',
      note: '备注内容',
      collapsed: true
    })
    expect(parsed.document.root.children[0].children[0].text).toBe('叶子')
    // 没有丢弃内容时不打扰用户
    expect(result.data?.warningsSummary).toEqual([])
  })

  it('导入：重名不覆盖，自动加 _1', async () => {
    registerMindMapHandlers()
    const source = makeXmind('周会.xmind', simpleSheet('周会'))
    const targetDir = makeDir()
    fs.writeFileSync(path.join(targetDir, '周会.inkmind'), '{"schema":"inkase.mindmap"}\n', 'utf8')

    const result = await call(IPC_CHANNELS.MINDMAP.IMPORT_XMIND, source, targetDir)
    expect(result.success).toBe(true)
    expect(result.data?.filePath).toBe(path.join(targetDir, '周会_1.inkmind'))
    // 原文件一个字节都没动
    expect(fs.readFileSync(path.join(targetDir, '周会.inkmind'), 'utf8')).toBe(
      '{"schema":"inkase.mindmap"}\n'
    )
  })

  it('导入：不支持的内容汇总成提示，而不是逐条弹窗', async () => {
    registerMindMapHandlers()
    const sheet = simpleSheet()
    ;(sheet[0] as any).rootTopic.children.attached[0].markers = [
      { markerId: 'priority-1' },
      { markerId: 'flag-red' }
    ]
    ;(sheet[0] as any).rootTopic.children.attached[0].href = 'https://example.com'
    const source = makeXmind('带标记.xmind', sheet)
    const targetDir = makeDir()

    const result = await call(IPC_CHANNELS.MINDMAP.IMPORT_XMIND, source, targetDir)
    expect(result.success).toBe(true)
    // 标记与超链接现在能落进模型，不再计入提示
    expect(result.data?.warningsSummary).toEqual([])
    // 落盘文件里能读到对应的标签与链接
    const archive = readArchive(result.data!.filePath)
    if (!archive.ok) throw new Error(archive.error)
    const saved = JSON.parse(archive.content)
    expect(saved.root.children[0].tags).toEqual([{ text: 'P1', color: '#ef4444' }, { text: 'red' }])
    expect(saved.root.children[0].href).toBe('https://example.com')
  })

  it('导入：XMind 8 的 content.xml 给出可执行的提示', async () => {
    registerMindMapHandlers()
    const source = makeXmind('老文件.xmind', null, {
      'content.xml': '<xmap-content version="2.0"></xmap-content>'
    })
    const targetDir = makeDir()

    const result = await call(IPC_CHANNELS.MINDMAP.IMPORT_XMIND, source, targetDir)
    expect(result.success).toBe(false)
    expect(result.error).toContain('XMind 8')
    // 失败时不能在磁盘上留半成品
    expect(fs.readdirSync(targetDir)).toEqual([])
  })

  it('导入：不是 ZIP 的文件报错且不产生文件', async () => {
    registerMindMapHandlers()
    const dir = makeDir()
    const source = path.join(dir, '假的.xmind')
    fs.writeFileSync(source, '这不是压缩包', 'utf8')
    const targetDir = makeDir()

    const result = await call(IPC_CHANNELS.MINDMAP.IMPORT_XMIND, source, targetDir)
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    expect(fs.readdirSync(targetDir)).toEqual([])
  })

  it('导入：扩展名不是 .xmind 时直接拒绝', async () => {
    registerMindMapHandlers()
    const source = makeXmind('伪装.png', simpleSheet())
    const result = await call(IPC_CHANNELS.MINDMAP.IMPORT_XMIND, source, makeDir())
    expect(result.success).toBe(false)
    expect(result.error).toBe('只能导入 .xmind 文件')
  })

  it('导入：用户取消选择时返回「用户取消」', async () => {
    registerMindMapHandlers()
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] } as never)
    const result = await call(IPC_CHANNELS.MINDMAP.IMPORT_XMIND)
    expect(result).toEqual({ success: false, error: '用户取消' })
  })

  it('导出：写出 XMind 压缩包，content.json 结构与输入一致', async () => {
    registerMindMapHandlers()
    const dir = makeDir()
    const target = path.join(dir, '导出结果.xmind')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: target
    } as never)

    const content = `${JSON.stringify(
      {
        schema: 'inkase.mindmap',
        version: 1,
        direction: 'down',
        root: {
          id: 'r',
          text: '路线图',
          children: [
            { id: 'a', text: 'Q1', note: '启动', color: '#4c8dff', children: [] },
            { id: 'b', text: 'Q2', collapsed: true, children: [] }
          ]
        }
      },
      null,
      2
    )}\n`

    const result = await call(IPC_CHANNELS.MINDMAP.EXPORT_XMIND, '导出结果', content)
    expect(result.success).toBe(true)
    expect(result.data).toBe(target)
    expect(fs.existsSync(target)).toBe(true)

    const zip = new AdmZip(target)
    const entries = zip.getEntries().map((entry) => entry.entryName)
    expect(entries).toEqual(
      expect.arrayContaining(['content.json', 'metadata.json', 'manifest.json'])
    )

    const sheet = JSON.parse(zip.readAsText('content.json'))[0]
    expect(sheet.rootTopic).toMatchObject({
      id: 'r',
      title: '路线图',
      structureClass: 'org.xmind.ui.org-chart.down'
    })
    const [q1, q2] = sheet.rootTopic.children.attached
    expect(q1).toMatchObject({
      title: 'Q1',
      notes: { plain: { content: '启动' } },
      style: { 'svg:fill': '#4c8dff' }
    })
    expect(q2).toMatchObject({ title: 'Q2', branch: 'folded' })
  })

  it('导出：用户取消与空内容都不写文件', async () => {
    registerMindMapHandlers()
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true } as never)
    expect(await call(IPC_CHANNELS.MINDMAP.EXPORT_XMIND, 'x', '{"root":{}}')).toEqual({
      success: false,
      error: '用户取消'
    })

    const empty = await call(IPC_CHANNELS.MINDMAP.EXPORT_XMIND, 'x', '   ')
    expect(empty.success).toBe(false)
    expect(empty.error).toBe('没有可导出的导图内容')
    // 没有弹过保存框，就不该有文件落盘
    expect(dialog.showSaveDialog).toHaveBeenCalledTimes(1)
  })

  it('导出：内容不是合法 JSON 时报错且不留文件', async () => {
    registerMindMapHandlers()
    const dir = makeDir()
    const target = path.join(dir, '坏.xmind')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: target
    } as never)

    const result = await call(IPC_CHANNELS.MINDMAP.EXPORT_XMIND, '坏', '{ 不是 JSON')
    expect(result.success).toBe(false)
    expect(result.error).toBe('思维导图内容不是合法的 JSON，无法导出')
    expect(fs.existsSync(target)).toBe(false)
    // 临时文件也不能残留
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
