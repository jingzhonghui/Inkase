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
    getFocusedWindow: vi.fn(() => null)
  }
}))

vi.mock('../file-handlers', () => ({
  addRecentFile: vi.fn()
}))

import { IPC_CHANNELS } from '../channels'
import { registerMdxHandlers } from '../mdx-handlers'

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
})
