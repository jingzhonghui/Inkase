import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readArchive, writeArchive } from '../../mindmap/inkmind-archive'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    })
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null)
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn()
  }
}))

vi.mock('../file-handlers', () => ({
  addRecentFile: vi.fn()
}))

import { IPC_CHANNELS } from '../channels'
import { registerMdxHandlers, getTempDirForFile } from '../mdx-handlers'
import { registerMindMapHandlers } from '../mindmap-handlers'

const dirsToClean: string[] = []

async function call(channel: string, ...args: unknown[]): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return (await handler(undefined, ...args)) as { success: boolean; data?: unknown; error?: string }
}

describe('mdx file handlers', () => {
  afterEach(() => {
    vi.clearAllMocks()
    for (const dir of dirsToClean) fs.rmSync(dir, { recursive: true, force: true })
    dirsToClean.length = 0
  })

  function makeFile(name: string, content: Buffer | string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-mdx-handlers-'))
    dirsToClean.push(dir)
    const filePath = path.join(dir, name)
    fs.writeFileSync(filePath, content)
    return filePath
  }

  /** 只建目录，文件由容器写入函数自己创建 */
  function newDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-mdx-handlers-'))
    dirsToClean.push(dir)
    return dir
  }

  it('opens a non-mdx text file (.gitignore) as plain text markdown', async () => {
    registerMdxHandlers()
    const filePath = makeFile('.gitignore', 'node_modules/\n.inkase\n')
    const result = await call(IPC_CHANNELS.FILE.OPEN, filePath, false)
    expect(result.success).toBe(true)
    const data = result.data as { format?: string; document?: { content?: string } }
    expect(data.format).toBe('markdown')
    expect(data.document?.content).toBe('node_modules/\n.inkase\n')
  })

  it('opens a .md file as markdown plain text', async () => {
    registerMdxHandlers()
    const filePath = makeFile('notes.md', '# Title\n\ntext')
    const result = await call(IPC_CHANNELS.FILE.OPEN, filePath, false)
    expect(result.success).toBe(true)
    const data = result.data as { format?: string; document?: { content?: string } }
    expect(data.format).toBe('markdown')
    expect(data.document?.content).toBe('# Title\n\ntext')
  })

  it('rejects a binary file with NUL bytes', async () => {
    registerMdxHandlers()
    const filePath = makeFile('image.bin', Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]))
    const result = await call(IPC_CHANNELS.FILE.OPEN, filePath, false)
    expect(result.success).toBe(false)
    expect(result.error).toContain('二进制')
  })

  it('opens a png file as a read-only image with a data URL', async () => {
    registerMdxHandlers()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    const filePath = makeFile('pic.png', png)
    const result = await call(IPC_CHANNELS.FILE.OPEN, filePath, false)
    expect(result.success).toBe(true)
    const data = result.data as { format?: string; imageDataUrl?: string }
    expect(data.format).toBe('image')
    expect(data.imageDataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('opens an svg file as an image instead of plain text', async () => {
    registerMdxHandlers()
    const filePath = makeFile('drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const result = await call(IPC_CHANNELS.FILE.OPEN, filePath, false)
    expect(result.success).toBe(true)
    const data = result.data as { format?: string; imageDataUrl?: string }
    expect(data.format).toBe('image')
    expect(data.imageDataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('opens a pdf file as a read-only pdf with base64 content', async () => {
    registerMdxHandlers()
    const pdf = Buffer.from('%PDF-1.4\n%fake pdf content')
    const filePath = makeFile('doc.pdf', pdf)
    const result = await call(IPC_CHANNELS.FILE.OPEN, filePath, false)
    expect(result.success).toBe(true)
    const data = result.data as { format?: string; pdfBase64?: string }
    expect(data.format).toBe('pdf')
    expect(data.pdfBase64).toBe(pdf.toString('base64'))
  })

  it('rejects a .pdf file without the %PDF header', async () => {
    registerMdxHandlers()
    const filePath = makeFile('fake.pdf', 'not a pdf at all')
    const result = await call(IPC_CHANNELS.FILE.OPEN, filePath, false)
    expect(result.success).toBe(false)
    expect(result.error).toContain('PDF')
  })

  it('still routes .mdx files through the MDX reader', async () => {
    registerMdxHandlers()
    // 纯文本冒充 .mdx：openMdx 应失败（非 ZIP），证明 .mdx 未走纯文本分支
    const filePath = makeFile('doc.mdx', '# not a zip\n')
    const result = await call(IPC_CHANNELS.FILE.OPEN, filePath, false)
    expect(result.success).toBe(false)
  })

  it('saves plain text to a non-mdx file (.gitignore)', async () => {
    registerMdxHandlers()
    const filePath = makeFile('.gitignore', 'old')
    const result = await call(IPC_CHANNELS.FILE.SAVE, 'new content\n', 'title', filePath)
    expect(result.success).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content\n')
  })

  it('saves .md as plain text', async () => {
    registerMdxHandlers()
    const filePath = makeFile('notes.md', 'old')
    const result = await call(IPC_CHANNELS.FILE.SAVE, '# updated\n', 'title', filePath)
    expect(result.success).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('# updated\n')
  })

  it('opens a .inkmind container and hands back its map.json text', async () => {
    registerMdxHandlers()
    const content = JSON.stringify({
      schema: 'inkase.mindmap',
      version: 1,
      root: { id: 'n_root', text: '中心主题', children: [] }
    })
    const filePath = path.join(newDir(), 'map.inkmind')
    expect(writeArchive(filePath, content).ok).toBe(true)

    const result = await call(IPC_CHANNELS.FILE.OPEN, filePath, false)
    expect(result.success).toBe(true)
    const data = result.data as {
      format?: string
      document?: { content?: string }
      filePath?: string
      assetMap?: Record<string, string>
    }
    expect(data.format).toBe('mindmap')
    // 内容原样交给渲染层解析，主进程不做 schema 校验
    expect(data.document?.content).toBe(content)
    expect(data.filePath).toBe(filePath)
    // 新容器没有资源，映射是空对象而不是 undefined
    expect(data.assetMap).toEqual({})
  })

  it('rejects a .inkmind file that is not a container', async () => {
    registerMdxHandlers()
    // 旧的纯文本格式：现在应当被明确拒绝，而不是当成 JSON 打开
    const filePath = makeFile('broken.inkmind', Buffer.from([0x7b, 0x00, 0x7d]))
    const result = await call(IPC_CHANNELS.FILE.OPEN, filePath, false)
    expect(result.success).toBe(false)
    expect(result.error).toContain('损坏')
  })

  it('saves .inkmind as a zip container holding map.json', async () => {
    registerMdxHandlers()
    const filePath = path.join(newDir(), 'map.inkmind')
    expect(writeArchive(filePath, 'old').ok).toBe(true)

    const content =
      '{\n  "schema": "inkase.mindmap",\n  "version": 1,\n  "root": { "id": "n", "text": "根", "children": [] }\n}\n'
    const result = await call(IPC_CHANNELS.FILE.SAVE, content, 'title', filePath)
    expect(result.success).toBe(true)

    // 落盘的是 ZIP，不再是纯文本
    expect(fs.readFileSync(filePath).subarray(0, 2).toString()).toBe('PK')
    const read = readArchive(filePath)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.content).toBe(content)
    fs.rmSync(read.tempDir, { recursive: true, force: true })
  })

  it('save-as keeps the .inkmind extension instead of appending .mdx', async () => {
    registerMdxHandlers()
    const electron = await import('electron')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-mdx-handlers-'))
    dirsToClean.push(dir)
    const sourcePath = path.join(dir, 'origin.inkmind')
    fs.writeFileSync(sourcePath, '{"schema":"inkase.mindmap","version":1,"root":{"id":"n","text":"根","children":[]}}')

    // 用户在对话框里只输入了文件名，没有后缀
    const typedPath = path.join(dir, 'renamed')
    vi.mocked(electron.dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: typedPath
    } as unknown as Awaited<ReturnType<typeof electron.dialog.showSaveDialog>>)

    const content = '{"schema":"inkase.mindmap","version":1,"root":{"id":"n","text":"改名","children":[]}}'
    const result = await call(IPC_CHANNELS.FILE.SAVE_AS, content, 'renamed', sourcePath, false)

    // 失败时先暴露真实原因，便于定位是扩展名推断还是写盘问题
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    expect(fs.existsSync(`${typedPath}.inkmind`)).toBe(true)
    expect(fs.existsSync(`${typedPath}.mdx`)).toBe(false)
    // 另存为写的是 .inkmind 容器（ZIP），不是裸 JSON
    expect(fs.readFileSync(`${typedPath}.inkmind`).subarray(0, 2).toString()).toBe('PK')
    const read = readArchive(`${typedPath}.inkmind`)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.content).toBe(content)
    fs.rmSync(read.tempDir, { recursive: true, force: true })
  })

  it('save-as of an unsaved mindmap uses .inkmind by the declared format', async () => {
    registerMdxHandlers()
    const electron = await import('electron')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-mdx-handlers-'))
    dirsToClean.push(dir)

    // 新建的思维导图还没有路径：sourcePath 为空，只能靠 format 判定
    const typedPath = path.join(dir, '未命名思维导图')
    vi.mocked(electron.dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: typedPath
    } as unknown as Awaited<ReturnType<typeof electron.dialog.showSaveDialog>>)

    const content = '{"schema":"inkase.mindmap","version":1,"root":{"id":"n","text":"中心主题","children":[]}}'
    const result = await call(IPC_CHANNELS.FILE.SAVE_AS, content, '未命名思维导图', undefined, false, 'mindmap')

    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    expect(fs.existsSync(`${typedPath}.inkmind`)).toBe(true)
    expect(fs.existsSync(`${typedPath}.mdx`)).toBe(false)
    /*
     * 必须是真正的 .inkmind 容器：写成裸 JSON 的话，下次打开会被 readArchive
     * 判成「不是 Inkase 思维导图」，等于另存为之后文件就坏了。
     */
    expect(fs.readFileSync(`${typedPath}.inkmind`).subarray(0, 2).toString()).toBe('PK')
    const read = readArchive(`${typedPath}.inkmind`)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.content).toBe(content)
    fs.rmSync(read.tempDir, { recursive: true, force: true })
    // 新容器要有自己的临时目录，另存为之后才能直接插入图片/附件
    expect(getTempDirForFile(`${typedPath}.inkmind`)).toBeTruthy()

    // 对话框要按思维导图给出默认名与过滤器，避免用户糊里糊涂存成 .mdx
    // （electron 的类型只声明了单参重载，这里按真实调用形态取第二个实参）
    const firstSaveCall = vi.mocked(electron.dialog.showSaveDialog).mock.calls[0] as unknown as unknown[]
    const saveOptions = firstSaveCall[1] as {
      defaultPath?: string
      filters?: Array<{ extensions: string[] }>
    }
    expect(saveOptions.defaultPath).toBe('未命名思维导图.inkmind')
    expect(saveOptions.filters?.[0].extensions).toEqual(['inkmind'])
  })

  it('save-as honours the declared format for a new markdown document', async () => {
    registerMdxHandlers()
    const electron = await import('electron')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-mdx-handlers-'))
    dirsToClean.push(dir)

    const typedPath = path.join(dir, '新笔记')
    vi.mocked(electron.dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: typedPath
    } as unknown as Awaited<ReturnType<typeof electron.dialog.showSaveDialog>>)

    const result = await call(IPC_CHANNELS.FILE.SAVE_AS, '# 标题\n', '新笔记', undefined, false, 'markdown')

    expect(result.success).toBe(true)
    expect(fs.existsSync(`${typedPath}.md`)).toBe(true)
    expect(fs.existsSync(`${typedPath}.mdx`)).toBe(false)
    expect(fs.readFileSync(`${typedPath}.md`, 'utf-8')).toBe('# 标题\n')
  })

  it('save-as of a new mindmap leaves a usable temp dir for the next asset insert', async () => {
    registerMdxHandlers()
    registerMindMapHandlers()
    const electron = await import('electron')
    const dir = newDir()

    const typedPath = path.join(dir, '规划')
    vi.mocked(electron.dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: typedPath
    } as unknown as Awaited<ReturnType<typeof electron.dialog.showSaveDialog>>)

    const content = '{"schema":"inkase.mindmap","version":2,"root":{"id":"n","text":"根","children":[]}}'
    const saved = await call(IPC_CHANNELS.FILE.SAVE_AS, content, '规划', undefined, false, 'mindmap')
    expect(saved.success).toBe(true)
    // 新容器没有资源，映射是空对象（不是 undefined）
    expect((saved as { assetMap?: Record<string, string> }).assetMap).toEqual({})

    // 紧接着插图片：没有登记临时目录的话这里会报「导图尚未打开」
    const png = makeFile('hero.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const added = await call(
      IPC_CHANNELS.MINDMAP.ADD_ASSET,
      `${typedPath}.inkmind`,
      'image',
      png
    )
    expect(added.success).toBe(true)
    expect((added.data as { src: string }).src).toMatch(/^assets\/images\/hero_[0-9a-f]{8}\.png$/)
  })

  it('save-as of an opened mindmap packages the source container, assets included', async () => {
    registerMdxHandlers()
    registerMindMapHandlers()
    const electron = await import('electron')
    const dir = newDir()

    const sourcePath = path.join(dir, 'origin.inkmind')
    const content = '{"schema":"inkase.mindmap","version":2,"root":{"id":"n","text":"根","children":[]}}'
    expect(writeArchive(sourcePath, content).ok).toBe(true)
    // 打开源导图 → 主进程解到临时目录并登记
    expect((await call(IPC_CHANNELS.FILE.OPEN, sourcePath, false)).success).toBe(true)

    // 先往源导图里插一张图片（资源落在源临时目录里）
    const png = makeFile('pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const added = await call(IPC_CHANNELS.MINDMAP.ADD_ASSET, sourcePath, 'image', png)
    expect(added.success).toBe(true)
    const assetSrc = (added.data as { src: string }).src

    const typedPath = path.join(dir, 'copy')
    vi.mocked(electron.dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: typedPath
    } as unknown as Awaited<ReturnType<typeof electron.dialog.showSaveDialog>>)

    const newContent =
      '{"schema":"inkase.mindmap","version":2,"root":{"id":"n","text":"改名","children":[]}}'
    const saved = await call(IPC_CHANNELS.FILE.SAVE_AS, newContent, 'copy', sourcePath, false, 'mindmap')
    expect(saved.error).toBeUndefined()
    expect(saved.success).toBe(true)

    const target = `${typedPath}.inkmind`
    const read = readArchive(target)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    // 新容器里既要带新内容，也要把图片一起带走
    expect(read.content).toBe(newContent)
    expect(read.assetMap[assetSrc]).toBeTruthy()
    fs.rmSync(read.tempDir, { recursive: true, force: true })

    // 沿用的临时目录已登记到新路径：可以继续插图
    expect(getTempDirForFile(target)).toBeTruthy()
    const second = await call(
      IPC_CHANNELS.MINDMAP.ADD_ASSET,
      target,
      'image',
      makeFile('pic2.png', Buffer.from([0x89, 0x50, 0x4e, 0x48]))
    )
    expect(second.success).toBe(true)
  })
})
