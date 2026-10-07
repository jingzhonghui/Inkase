import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { dialog } from 'electron'
import { IPC_CHANNELS } from '../channels'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-folder-'))

type Handler = (...args: unknown[]) => unknown

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => ({}) },
  app: { getPath: () => tmpDir },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  clipboard: {
    read: vi.fn(() => ''),
    readBuffer: vi.fn(() => Buffer.from('')),
    writeBuffer: vi.fn()
  }
}))

/** 重新加载 file-handlers 模块以重置模块级缓存，并注册 handlers */
async function registerHandlersFresh(): Promise<void> {
  electronMocks.handlers.clear()
  vi.resetModules()
  const mod = await import('../file-handlers')
  mod.registerFileHandlers()
}

describe('folder:read', () => {
  beforeEach(async () => {
    await registerHandlersFresh()
  })

  it('filters dot-prefixed directories like .inkase', async () => {
    const dir = path.join(tmpDir, 'ws')
    fs.mkdirSync(path.join(dir, '.inkase'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'readme.md'), '# hi', 'utf8')

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FOLDER.READ)!
    const result = (await handler({}, dir)) as { success: boolean; data: Array<{ name: string; isDirectory: boolean }> }

    expect(result.success).toBe(true)
    const names = result.data.map((item) => item.name)
    expect(names).toContain('docs')
    expect(names).toContain('readme.md')
    expect(names).not.toContain('.inkase')
  })

  it('lists all regular files regardless of extension', async () => {
    const dir = path.join(tmpDir, 'ws-all')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.md'), 'x', 'utf8')
    fs.writeFileSync(path.join(dir, 'b.mdx'), 'x', 'utf8')
    fs.writeFileSync(path.join(dir, 'c.txt'), 'x', 'utf8')
    fs.writeFileSync(path.join(dir, 'd.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'x', 'utf8')

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FOLDER.READ)!
    const result = (await handler({}, dir)) as { success: boolean; data: Array<{ name: string; isDirectory: boolean }> }

    expect(result.success).toBe(true)
    const names = result.data.map((item) => item.name)
    expect(names).toHaveLength(5)
    for (const expected of ['LICENSE', 'a.md', 'b.mdx', 'c.txt', 'd.json']) {
      expect(names).toContain(expected)
    }
  })
})

describe('file:rename', () => {
  beforeEach(async () => {
    await registerHandlersFresh()
  })

  it('renames a folder on disk and keeps its contents', async () => {
    const dir = path.join(tmpDir, 'rename-folder')
    fs.mkdirSync(path.join(dir, 'A'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'A', 'x.mdx'), 'x', 'utf8')

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RENAME)!
    const result = (await handler({}, { oldPath: path.join(dir, 'A'), newName: 'B' })) as { success: boolean }

    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(dir, 'B'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'A'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'B', 'x.mdx'))).toBe(true)
  })

  it('rejects renaming to an existing path', async () => {
    const dir = path.join(tmpDir, 'rename-folder-conflict')
    fs.mkdirSync(path.join(dir, 'A'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'B'), { recursive: true })

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RENAME)!
    const result = (await handler({}, { oldPath: path.join(dir, 'A'), newName: 'B' })) as {
      success: boolean
      error?: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toBe('目标已存在')
  })

  it('allows renaming a folder to a different-cased name (Windows case-insensitive)', async () => {
    const dir = path.join(tmpDir, 'rename-folder-case')
    fs.mkdirSync(path.join(dir, 'Docs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Docs', 'x.mdx'), 'x', 'utf8')

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RENAME)!
    const result = (await handler({}, { oldPath: path.join(dir, 'Docs'), newName: 'docs' })) as {
      success: boolean
      error?: string
    }

    // Windows NTFS 不区分大小写：仅大小写变化时 fs.existsSync 会误判“目标已存在”
    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(dir, 'docs', 'x.mdx'))).toBe(true)
  })
})

describe('recent files', () => {
  const recentStorePath = path.join(tmpDir, 'recent-files.json')

  beforeEach(async () => {
    if (fs.existsSync(recentStorePath)) {
      fs.unlinkSync(recentStorePath)
    }
    await registerHandlersFresh()
  })

  afterEach(() => {
    if (fs.existsSync(recentStorePath)) {
      fs.unlinkSync(recentStorePath)
    }
  })

  it('adds a file to the recent list with type file', async () => {
    const file = path.join(tmpDir, 'note.md')
    fs.writeFileSync(file, 'hello', 'utf8')

    const addHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT_ADD)!
    const addResult = (await addHandler({}, file)) as { success: boolean }
    expect(addResult.success).toBe(true)

    const getHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT)!
    const getResult = (await getHandler({})) as { success: boolean; data: Array<{ path: string; type: string }> }
    expect(getResult.success).toBe(true)
    expect(getResult.data).toHaveLength(1)
    expect(getResult.data[0]).toEqual({ path: path.resolve(file), type: 'file' })
  })

  it('adds a folder to the recent list with type folder', async () => {
    const folder = path.join(tmpDir, 'docs')
    fs.mkdirSync(folder, { recursive: true })

    const addHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT_ADD)!
    const addResult = (await addHandler({}, folder, 'folder')) as { success: boolean }
    expect(addResult.success).toBe(true)

    const getHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT)!
    const getResult = (await getHandler({})) as { success: boolean; data: Array<{ path: string; type: string }> }
    expect(getResult.data[0]).toEqual({ path: path.resolve(folder), type: 'folder' })
  })

  it('migrates legacy string[] data on disk to file-type items', async () => {
    const legacyPath = path.join(tmpDir, 'legacy.md')
    fs.writeFileSync(legacyPath, 'x', 'utf8')
    fs.writeFileSync(recentStorePath, JSON.stringify([legacyPath]), 'utf8')

    const getHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT)!
    const getResult = (await getHandler({})) as { success: boolean; data: Array<{ path: string; type: string }> }
    expect(getResult.data[0]).toEqual({ path: legacyPath, type: 'file' })
  })

  it('filters out recent items whose file no longer exists', async () => {
    fs.writeFileSync(recentStorePath, JSON.stringify([
      { path: path.join(tmpDir, 'gone.md'), type: 'file' },
      { path: path.join(tmpDir, 'present.md'), type: 'file' }
    ]), 'utf8')
    fs.writeFileSync(path.join(tmpDir, 'present.md'), 'x', 'utf8')

    const getHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT)!
    const getResult = (await getHandler({})) as { success: boolean; data: Array<{ path: string }> }
    expect(getResult.data).toHaveLength(1)
    expect(getResult.data[0].path).toBe(path.join(tmpDir, 'present.md'))
  })

  it('deduplicates the same path and moves it to the front', async () => {
    const a = path.join(tmpDir, 'a.md')
    const b = path.join(tmpDir, 'b.md')
    fs.writeFileSync(a, 'a', 'utf8')
    fs.writeFileSync(b, 'b', 'utf8')

    const addHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT_ADD)!
    await addHandler({}, a)
    await addHandler({}, b)
    await addHandler({}, a)

    const getHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT)!
    const getResult = (await getHandler({})) as { success: boolean; data: Array<{ path: string }> }
    expect(getResult.data).toHaveLength(2)
    expect(getResult.data[0].path).toBe(path.resolve(a))
    expect(getResult.data[1].path).toBe(path.resolve(b))
  })

  it('clears the recent list', async () => {
    const file = path.join(tmpDir, 'note.md')
    fs.writeFileSync(file, 'hello', 'utf8')

    const addHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT_ADD)!
    await addHandler({}, file)
    const clearHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT_CLEAR)!
    const clearResult = (await clearHandler({})) as { success: boolean }
    expect(clearResult.success).toBe(true)

    const getHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.RECENT)!
    const getResult = (await getHandler({})) as { success: boolean; data: Array<{ path: string }> }
    expect(getResult.data).toHaveLength(0)
  })
})

describe('file:search', () => {
  beforeEach(async () => {
    await registerHandlersFresh()
  })

  it('recursively lists files only, with full nested paths', async () => {
    const dir = path.join(tmpDir, 'search-ws')
    fs.mkdirSync(path.join(dir, 'docs', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'root.md'), 'x', 'utf8')
    fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), 'x', 'utf8')
    fs.writeFileSync(path.join(dir, 'docs', 'nested', 'deep.txt'), 'x', 'utf8')

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.SEARCH)!
    const result = (await handler({}, dir)) as { success: boolean; data: Array<{ name: string; path: string }> }

    expect(result.success).toBe(true)
    const paths = result.data.map((item) => item.path)
    expect(paths).toContain(path.join(dir, 'root.md'))
    expect(paths).toContain(path.join(dir, 'docs', 'guide.md'))
    expect(paths).toContain(path.join(dir, 'docs', 'nested', 'deep.txt'))
    expect(result.data).toHaveLength(3)
  })

  it('skips dot-prefixed directories like .git and .inkase', async () => {
    const dir = path.join(tmpDir, 'search-ignore')
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true })
    fs.mkdirSync(path.join(dir, '.inkase'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'x', 'utf8')
    fs.writeFileSync(path.join(dir, '.inkase', 'sync.json'), 'x', 'utf8')
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8')
    fs.writeFileSync(path.join(dir, 'keep.md'), 'x', 'utf8')

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.SEARCH)!
    const result = (await handler({}, dir)) as { success: boolean; data: Array<{ name: string }> }

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].name).toBe('keep.md')
  })

  it('truncates results when the limit is reached', async () => {
    const dir = path.join(tmpDir, 'search-limit')
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.md`), 'x', 'utf8')
    }

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.SEARCH)!
    const result = (await handler({}, dir, 3)) as { success: boolean; data: unknown[] }

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(3)
  })

  it('returns a failure for a non-existent directory', async () => {
    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.SEARCH)!
    const result = (await handler({}, path.join(tmpDir, 'no-such-dir'))) as { success: boolean; error?: string }

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('folder:importFiles / folder:importDirectory', () => {
  const showOpenDialog = dialog.showOpenDialog as unknown as ReturnType<typeof vi.fn>
  const showMessageBox = dialog.showMessageBox as unknown as ReturnType<typeof vi.fn>

  beforeEach(async () => {
    showOpenDialog.mockReset()
    showMessageBox.mockReset()
    showMessageBox.mockResolvedValue({ response: 2 })
    await registerHandlersFresh()
  })

  it('copies multiple selected files into the target folder', async () => {
    const srcDir = path.join(tmpDir, 'import-src-files')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'a.md'), 'aa', 'utf8')
    fs.writeFileSync(path.join(srcDir, 'b.txt'), 'bb', 'utf8')
    const target = path.join(tmpDir, 'import-target-files')
    fs.mkdirSync(target, { recursive: true })

    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join(srcDir, 'a.md'), path.join(srcDir, 'b.txt')]
    })

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FOLDER.IMPORT_FILES)!
    const result = (await handler({}, target)) as {
      success: boolean
      data: { imported: Array<{ target: string }>; failed: unknown[] }
    }

    expect(result.success).toBe(true)
    expect(result.data.imported).toHaveLength(2)
    expect(fs.readFileSync(path.join(target, 'a.md'), 'utf8')).toBe('aa')
    expect(fs.readFileSync(path.join(target, 'b.txt'), 'utf8')).toBe('bb')
    expect(fs.existsSync(path.join(srcDir, 'a.md'))).toBe(true)
  })

  it('keeps all conflicting files with a numeric suffix when requested', async () => {
    const srcDir = path.join(tmpDir, 'import-src-conflict')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'a.md'), 'new', 'utf8')
    const target = path.join(tmpDir, 'import-target-conflict')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'a.md'), 'old', 'utf8')

    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join(srcDir, 'a.md')]
    })

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FOLDER.IMPORT_FILES)!
    const result = (await handler({}, target, undefined, 'keep')) as {
      success: boolean
      data: { imported: Array<{ target: string }> }
    }

    expect(result.success).toBe(true)
    expect(fs.readFileSync(path.join(target, 'a.md'), 'utf8')).toBe('old')
    expect(fs.readFileSync(path.join(target, 'a (1).md'), 'utf8')).toBe('new')
  })

  it('skips all conflicting files when requested', async () => {
    const srcDir = path.join(tmpDir, 'import-src-skip-conflicts')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'a.md'), 'new a', 'utf8')
    fs.writeFileSync(path.join(srcDir, 'b.md'), 'new b', 'utf8')
    const target = path.join(tmpDir, 'import-target-skip-conflicts')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'a.md'), 'old a', 'utf8')
    fs.writeFileSync(path.join(target, 'b.md'), 'old b', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path.join(srcDir, 'a.md'), path.join(srcDir, 'b.md')] })

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FOLDER.IMPORT_FILES)!
    const result = (await handler({}, target, undefined, 'skip')) as { data: { imported: unknown[] } }

    expect(result.data.imported).toHaveLength(0)
    expect(fs.readFileSync(path.join(target, 'a.md'), 'utf8')).toBe('old a')
    expect(fs.readFileSync(path.join(target, 'b.md'), 'utf8')).toBe('old b')
  })

  it('overwrites all conflicting files when requested', async () => {
    const srcDir = path.join(tmpDir, 'import-src-overwrite-conflicts')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'a.md'), 'new a', 'utf8')
    fs.writeFileSync(path.join(srcDir, 'b.md'), 'new b', 'utf8')
    const target = path.join(tmpDir, 'import-target-overwrite-conflicts')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'a.md'), 'old a', 'utf8')
    fs.writeFileSync(path.join(target, 'b.md'), 'old b', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path.join(srcDir, 'a.md'), path.join(srcDir, 'b.md')] })

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FOLDER.IMPORT_FILES)!
    const result = (await handler({}, target, undefined, 'overwrite')) as { data: { imported: unknown[] } }

    expect(result.data.imported).toHaveLength(2)
    expect(fs.readFileSync(path.join(target, 'a.md'), 'utf8')).toBe('new a')
    expect(fs.readFileSync(path.join(target, 'b.md'), 'utf8')).toBe('new b')
  })

  it('copies an external folder as a subdirectory of the target', async () => {
    const src = path.join(tmpDir, 'import-src-dir')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'x.md'), 'x', 'utf8')
    const target = path.join(tmpDir, 'import-target-dir')
    fs.mkdirSync(target, { recursive: true })

    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [src]
    })

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FOLDER.IMPORT_DIRECTORY)!
    const result = (await handler({}, target)) as { success: boolean; data?: { imported: unknown[] } }

    expect(result.success).toBe(true)
    expect(result.data?.imported).toHaveLength(1)
    expect(fs.existsSync(path.join(target, path.basename(src), 'x.md'))).toBe(true)
    expect(fs.existsSync(src)).toBe(true)
  })

  it('returns canceled without copying when the dialog is dismissed', async () => {
    const target = path.join(tmpDir, 'import-target-cancel')
    fs.mkdirSync(target, { recursive: true })

    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FOLDER.IMPORT_FILES)!
    const result = (await handler({}, target)) as {
      success: boolean
      data: { imported: unknown[]; failed: unknown[]; canceled: boolean }
    }

    expect(result.success).toBe(true)
    expect(result.data.imported).toHaveLength(0)
    expect(result.data.canceled).toBe(true)
  })
})

describe('file:clipboardReadFiles / file:clipboardWriteFiles', () => {
  it('reads and writes file paths through the clipboard abstraction', async () => {
    await registerHandlersFresh()
    const { clipboard } = await import('electron')
    ;(clipboard.read as ReturnType<typeof vi.fn>).mockReturnValue('file:///tmp/a.md')

    const readHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.CLIPBOARD_READ_FILES)!
    const readResult = (await readHandler({})) as { success: boolean; data?: string[] }
    expect(readResult.success).toBe(true)
    expect(readResult.data).toEqual(['/tmp/a.md'])

    const writeHandler = electronMocks.handlers.get(IPC_CHANNELS.FILE.CLIPBOARD_WRITE_FILES)!
    const writeResult = (await writeHandler({}, { paths: ['/tmp/a.md'], mode: 'copy' })) as { success: boolean }
    expect(writeResult.success).toBe(true)
    expect(clipboard.writeBuffer).toHaveBeenCalledWith('text/uri-list', Buffer.from('file:///tmp/a.md', 'utf8'))
  })
})

describe('file:copyInto', () => {
  const showMessageBox = dialog.showMessageBox as unknown as ReturnType<typeof vi.fn>

  beforeEach(async () => {
    showMessageBox.mockReset()
    showMessageBox.mockResolvedValue({ response: 2 })
    await registerHandlersFresh()
  })

  it('copies a file into the target folder', async () => {
    const src = path.join(tmpDir, 'copy-src')
    const target = path.join(tmpDir, 'copy-target')
    fs.mkdirSync(src, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(src, 'a.md'), 'aa', 'utf8')

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.COPY_INTO)!
    const result = (await handler({}, {
      sources: [path.join(src, 'a.md')],
      targetDir: target,
      mode: 'copy'
    })) as { success: boolean; data: { items: Array<{ target: string }> } }

    expect(result.success).toBe(true)
    expect(fs.readFileSync(path.join(target, 'a.md'), 'utf8')).toBe('aa')
    expect(fs.existsSync(path.join(src, 'a.md'))).toBe(true)
  })

  it('copies a folder recursively and renames on conflict', async () => {
    const src = path.join(tmpDir, 'copy-folder-src')
    const target = path.join(tmpDir, 'copy-folder-target')
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(src, 'sub', 'x.md'), 'x', 'utf8')
    fs.mkdirSync(path.join(target, 'copy-folder-src'), { recursive: true })

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.COPY_INTO)!
    const result = (await handler({}, {
      sources: [src],
      targetDir: target,
      mode: 'copy',
      conflictAction: 'keep'
    })) as { success: boolean; data: { items: Array<{ target: string }> } }

    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(target, 'copy-folder-src (1)', 'sub', 'x.md'))).toBe(true)
    expect(fs.readdirSync(path.join(target, 'copy-folder-src'))).toHaveLength(0)
  })

  it('applies the selected conflict action to every conflicting paste item', async () => {
    const src = path.join(tmpDir, 'copy-all-conflicts-src')
    const target = path.join(tmpDir, 'copy-all-conflicts-target')
    fs.mkdirSync(src, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(src, 'a.md'), 'new a', 'utf8')
    fs.writeFileSync(path.join(src, 'b.md'), 'new b', 'utf8')
    fs.writeFileSync(path.join(target, 'a.md'), 'old a', 'utf8')
    fs.writeFileSync(path.join(target, 'b.md'), 'old b', 'utf8')
    showMessageBox.mockResolvedValue({ response: 1 })

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.COPY_INTO)!
    const result = (await handler({}, {
      sources: [path.join(src, 'a.md'), path.join(src, 'b.md')],
      targetDir: target,
      mode: 'copy',
      conflictAction: 'overwrite'
    })) as { success: boolean; data: { items: unknown[] } }

    expect(result.success).toBe(true)
    expect(result.data.items).toHaveLength(2)
    expect(fs.readFileSync(path.join(target, 'a.md'), 'utf8')).toBe('new a')
    expect(fs.readFileSync(path.join(target, 'b.md'), 'utf8')).toBe('new b')
  })

  it('moves a file out of the source folder when mode is cut', async () => {
    const src = path.join(tmpDir, 'cut-src')
    const target = path.join(tmpDir, 'cut-target')
    fs.mkdirSync(src, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(src, 'a.md'), 'aa', 'utf8')

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.COPY_INTO)!
    const result = (await handler({}, {
      sources: [path.join(src, 'a.md')],
      targetDir: target,
      mode: 'cut'
    })) as { success: boolean }

    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(target, 'a.md'))).toBe(true)
    expect(fs.existsSync(path.join(src, 'a.md'))).toBe(false)
  })

  it('rejects copying a folder into itself', async () => {
    const src = path.join(tmpDir, 'self-src')
    fs.mkdirSync(src, { recursive: true })

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.COPY_INTO)!
    const result = (await handler({}, {
      sources: [src],
      targetDir: src,
      mode: 'copy'
    })) as { success: boolean; data: { failed: Array<{ error: string }> } }

    expect(result.success).toBe(true)
    expect(result.data.failed).toHaveLength(1)
    expect(result.data.failed[0].error).toContain('自身')
  })

  it('skips cut into the same parent folder', async () => {
    const dir = path.join(tmpDir, 'cut-same')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.md'), 'aa', 'utf8')

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.COPY_INTO)!
    const result = (await handler({}, {
      sources: [path.join(dir, 'a.md')],
      targetDir: dir,
      mode: 'cut'
    })) as { success: boolean; data: { items: unknown[] } }

    expect(result.success).toBe(true)
    expect(result.data.items).toHaveLength(0)
    expect(fs.existsSync(path.join(dir, 'a.md'))).toBe(true)
  })

  it('dedupes a directory and its descendant so the file is copied only once', async () => {
    const dir = path.join(tmpDir, 'dedupe-src')
    const target = path.join(tmpDir, 'dedupe-target')
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(dir, 'x.md'), 'x', 'utf8')

    const handler = electronMocks.handlers.get(IPC_CHANNELS.FILE.COPY_INTO)!
    const result = (await handler({}, {
      sources: [dir, path.join(dir, 'x.md')],
      targetDir: target,
      mode: 'copy'
    })) as { success: boolean; data: { items: Array<{ target: string }> } }

    expect(result.success).toBe(true)
    expect(result.data.items).toHaveLength(1)
    expect(fs.existsSync(path.join(target, path.basename(dir), 'x.md'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'x.md'))).toBe(false)
  })
})
