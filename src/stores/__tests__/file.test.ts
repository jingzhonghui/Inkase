import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMdxDocument, isEditableMarkdownFormat } from '../../types/mdx'
import type { MdxDocument } from '../../types/mdx'
import { useFileStore } from '../file'
import type { FileTreeNode } from '../file/types'
import { requestDialog } from '../../utils/dialog'

vi.mock('../../utils/dialog', () => ({
  dialogState: { visible: false, title: '', message: '', detail: '', buttons: [] },
  requestDialog: vi.fn(async () => 0),
  resolveDialogRequest: vi.fn()
}))

vi.mock('../../utils/pdf-export', () => ({
  pdfSource: { value: null },
  pdfHtml: { value: '' },
  preparePdfView: vi.fn(async () => {}),
  clearPdfView: vi.fn()
}))

function makeDoc(title = 'Document', content = ''): MdxDocument {
  return createMdxDocument(title, content)
}

describe('document format capabilities', () => {
  it('allows editing only for mdx and markdown formats', () => {
    expect(isEditableMarkdownFormat('mdx')).toBe(true)
    expect(isEditableMarkdownFormat('markdown')).toBe(true)
    expect(isEditableMarkdownFormat('image')).toBe(false)
    expect(isEditableMarkdownFormat('pdf')).toBe(false)
    expect(isEditableMarkdownFormat(null)).toBe(false)
  })
})

function createMockElectronAPI(overrides: Record<string, unknown> = {}) {
  return {
    newFile: vi.fn(),
    openFile: vi.fn(),
    saveFile: vi.fn(),
    saveAsFile: vi.fn(),
    closeFile: vi.fn(async () => ({ success: true })),
    getRecentFiles: vi.fn(async () => ({ success: true, data: [] })),
    addRecentFile: vi.fn(async () => ({ success: true })),
    removeRecentFile: vi.fn(async () => ({ success: true })),
    clearRecentFiles: vi.fn(async () => ({ success: true })),
    readFolder: vi.fn(async () => ({ success: false })),
    writeRecovery: vi.fn(async () => ({ success: true })),
    clearRecovery: vi.fn(async () => ({ success: true })),
    recoveryStatus: vi.fn(async () => ({ success: true, data: { available: false } })),
    ...overrides
  }
}

describe('file store', () => {
  let electronAPI: ReturnType<typeof createMockElectronAPI>

  beforeEach(() => {
    setActivePinia(createPinia())
    electronAPI = createMockElectronAPI()
    vi.stubGlobal('window', { electronAPI })
    const ls = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((k: string) => ls.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => {
        ls.set(k, v)
      }),
      removeItem: vi.fn((k: string) => {
        ls.delete(k)
      })
    })
    vi.stubGlobal('navigator', { userAgent: 'Windows', clipboard: { writeText: vi.fn() } })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  describe('newFile', () => {
    it('creates and activates a tab from the main process document', async () => {
      const doc = makeDoc('New Doc', '# hello')
      electronAPI.newFile.mockResolvedValue({ success: true, data: { document: doc, isNew: true } })

      const store = useFileStore()
      const ok = await store.newFile()

      expect(ok).toBe(true)
      expect(store.tabs).toHaveLength(1)
      expect(store.activeTabId).toBe(store.tabs[0].id)
      expect(store.fileContent).toBe('# hello')
      expect(store.document?.metadata.title).toBe('New Doc')
    })

    it('marks a brand-new file as dirty (no path yet)', async () => {
      const doc = makeDoc('New Doc')
      electronAPI.newFile.mockResolvedValue({ success: true, data: { document: doc, isNew: true } })

      const store = useFileStore()
      await store.newFile()

      expect(store.isDirty).toBe(true)
      expect(store.hasFile).toBe(true)
    })
  })

  describe('openFile', () => {
    it('creates a tab with the resolved path and format', async () => {
      const doc = makeDoc('Opened', 'content')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/opened.mdx', format: 'mdx' }
      })

      const store = useFileStore()
      const ok = await store.openFile('C:/docs/opened.mdx')

      expect(ok).toBe(true)
      expect(store.tabs).toHaveLength(1)
      expect(store.currentFile?.path).toBe('C:/docs/opened.mdx')
      expect(store.currentFile?.format).toBe('mdx')
      expect(store.currentFile?.modified).toBe(false)
      expect(store.isDirty).toBe(false)
    })

    it('reuses the existing tab for an already-open path', async () => {
      const doc = makeDoc('Opened', 'content')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/opened.mdx', format: 'mdx' }
      })

      const store = useFileStore()
      await store.openFile('C:/docs/opened.mdx')
      await store.openFile('C:/docs/opened.mdx')

      expect(store.tabs).toHaveLength(1)
      expect(electronAPI.openFile).toHaveBeenCalledTimes(1)
    })

    it('opens a preview tab and replaces it with the next preview file', async () => {
      electronAPI.openFile.mockImplementation(async (filePath: string) => ({
        success: true,
        data: { document: makeDoc(filePath, 'content'), filePath, format: 'mdx' }
      }))

      const store = useFileStore()
      await store.openFile('C:/docs/first.mdx', { preview: true })
      const firstTabId = store.tabs[0].id
      await store.openFile('C:/docs/second.mdx', { preview: true })

      expect(store.tabs).toHaveLength(1)
      expect(store.tabs[0].id).not.toBe(firstTabId)
      expect(store.tabs[0].fileInfo?.path).toBe('C:/docs/second.mdx')
      expect(store.tabs[0].isPreview).toBe(true)
    })

    it('pins an existing preview tab when opened as a permanent tab', async () => {
      const doc = makeDoc('Opened', 'content')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/opened.mdx', format: 'mdx' }
      })

      const store = useFileStore()
      await store.openFile('C:/docs/opened.mdx', { preview: true })
      await store.openFile('C:/docs/opened.mdx', { preview: false })

      expect(store.tabs).toHaveLength(1)
      expect(store.tabs[0].isPreview).toBe(false)
      expect(electronAPI.openFile).toHaveBeenCalledTimes(1)
    })

    it('pins the active preview tab via pinActivePreviewTab and ignores normal tabs', async () => {
      electronAPI.openFile.mockImplementation(async (filePath: string) => ({
        success: true,
        data: { document: makeDoc(filePath, 'content'), filePath, format: 'mdx' }
      }))

      const store = useFileStore()
      // 无标签时调用是安全无操作
      store.pinActivePreviewTab()

      await store.openFile('C:/docs/preview.mdx', { preview: true })
      expect(store.tabs[0].isPreview).toBe(true)

      store.pinActivePreviewTab()
      expect(store.tabs[0].isPreview).toBe(false)

      // 已是正式标签时再次调用无变化
      store.pinActivePreviewTab()
      expect(store.tabs[0].isPreview).toBe(false)
    })

    it('does not create a tab when the user cancels', async () => {
      electronAPI.openFile.mockResolvedValue({ success: false, error: '用户取消' })

      const store = useFileStore()
      const ok = await store.openFile()

      expect(ok).toBe(false)
      expect(store.tabs).toHaveLength(0)
    })

    it('passes addToRecent:false through to the main process', async () => {
      const doc = makeDoc('Opened', 'content')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/opened.mdx', format: 'mdx' }
      })

      const store = useFileStore()
      await store.openFile('C:/docs/opened.mdx', { addToRecent: false })

      expect(electronAPI.openFile).toHaveBeenCalledWith('C:/docs/opened.mdx', false)
    })

    it('pins a preview tab after editing its content', async () => {
      const doc = makeDoc('Opened', 'before')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/opened.mdx', format: 'mdx' }
      })

      const store = useFileStore()
      await store.openFile('C:/docs/opened.mdx', { preview: true })
      store.updateContent('after')

      expect(store.tabs[0].isPreview).toBe(false)
      expect(store.isModified).toBe(true)
    })

    it('opens an image file as a read-only image tab', async () => {
      const doc = makeDoc('pic', '')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/pic.png', format: 'image', imageDataUrl: 'data:image/png;base64,AAA' }
      })

      const store = useFileStore()
      const ok = await store.openFile('C:/docs/pic.png')

      expect(ok).toBe(true)
      expect(store.tabs).toHaveLength(1)
      const tab = store.tabs[0]
      expect(tab.fileInfo?.format).toBe('image')
      expect(tab.imageDataUrl).toBe('data:image/png;base64,AAA')
      expect(tab.content).toBe('')
      expect(store.isModified).toBe(false)
      expect(store.isDirty).toBe(false)

      // 图片 tab 拒绝保存，避免破坏图片
      const saved = await store.saveFile()
      expect(saved).toBe(false)
      expect(store.tabs[0].fileInfo?.modified).toBe(false)
    })

    it('opens a pdf file as a read-only pdf tab', async () => {
      const doc = makeDoc('doc', '')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/doc.pdf', format: 'pdf', pdfBase64: 'JVBERi0xLjQ=' }
      })

      const store = useFileStore()
      const ok = await store.openFile('C:/docs/doc.pdf')

      expect(ok).toBe(true)
      expect(store.tabs).toHaveLength(1)
      const tab = store.tabs[0]
      expect(tab.fileInfo?.format).toBe('pdf')
      expect(tab.pdfBase64).toBe('JVBERi0xLjQ=')
      expect(tab.content).toBe('')
      expect(store.isModified).toBe(false)
      expect(store.isDirty).toBe(false)
      expect(store.canSwitchEditorMode).toBe(false)
      expect(store.fileName).toBe('doc.pdf')

      // PDF tab 拒绝保存，避免破坏文件
      const saved = await store.saveFile()
      expect(saved).toBe(false)
      expect(store.error).toBe('该文件类型不支持编辑或保存')
      expect(store.tabs[0].fileInfo?.modified).toBe(false)
    })

    it('only allows switching editor mode for .md/.mdx files', async () => {
      const store = useFileStore()
      expect(store.canSwitchEditorMode).toBe(true)

      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: makeDoc('pic', ''), filePath: 'C:/docs/pic.png', format: 'image', imageDataUrl: 'data:image/png;base64,AAA' }
      })
      await store.openFile('C:/docs/pic.png')
      expect(store.canSwitchEditorMode).toBe(false)

      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: makeDoc('note', '# hi'), filePath: 'C:/docs/notes.txt', format: 'markdown' }
      })
      await store.openFile('C:/docs/notes.txt')
      expect(store.canSwitchEditorMode).toBe(false)

      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: makeDoc('doc', '# hi'), filePath: 'C:/docs/doc.mdx', format: 'mdx' }
      })
      await store.openFile('C:/docs/doc.mdx')
      expect(store.canSwitchEditorMode).toBe(true)
    })

    it('forces plain mode for non-markdown text files and follows editorMode for markdown files', async () => {
      const store = useFileStore()
      store.setEditorMode('split')
      expect(store.effectiveEditorMode).toBe('split')

      // 非 Markdown 文本文件一律纯文本，不跟随编辑器模式
      for (const name of ['run.sh', 'app.conf', 'notes.txt', 'data.json', 'Makefile', '.gitignore']) {
        electronAPI.openFile.mockResolvedValue({
          success: true,
          data: { document: makeDoc(name, 'content'), filePath: `C:/docs/${name}`, format: 'markdown' }
        })
        await store.openFile(`C:/docs/${name}`)
        expect(store.effectiveEditorMode).toBe('plain')
        expect(store.canSwitchEditorMode).toBe(false)
      }

      // Markdown 文件跟随用户编辑器模式
      for (const name of ['doc.md', 'doc.mdx', 'doc.markdown']) {
        electronAPI.openFile.mockResolvedValue({
          success: true,
          data: { document: makeDoc(name, '# hi'), filePath: `C:/docs/${name}`, format: 'markdown' }
        })
        await store.openFile(`C:/docs/${name}`)
        expect(store.effectiveEditorMode).toBe('split')
        expect(store.canSwitchEditorMode).toBe(true)
      }
    })

    it('detects html files and toggles html preview only for them', async () => {
      const store = useFileStore()

      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: makeDoc('page', '<h1>hi</h1>'), filePath: 'C:/docs/page.html', format: 'markdown' }
      })
      await store.openFile('C:/docs/page.html')
      expect(store.isHtmlFile).toBe(true)
      expect(store.htmlPreviewActive).toBe(false)
      // HTML 不参与 Markdown 模式切换
      expect(store.canSwitchEditorMode).toBe(false)
      expect(store.effectiveEditorMode).toBe('plain')

      store.toggleHtmlPreview()
      expect(store.htmlPreviewActive).toBe(true)
      store.toggleHtmlPreview()
      expect(store.htmlPreviewActive).toBe(false)

      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: makeDoc('legacy', 'x'), filePath: 'C:/docs/legacy.htm', format: 'markdown' }
      })
      await store.openFile('C:/docs/legacy.htm')
      expect(store.isHtmlFile).toBe(true)

      // 非 HTML 文件：toggle 不生效
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: makeDoc('note', 'x'), filePath: 'C:/docs/notes.txt', format: 'markdown' }
      })
      await store.openFile('C:/docs/notes.txt')
      expect(store.isHtmlFile).toBe(false)
      store.toggleHtmlPreview()
      expect(store.htmlPreviewActive).toBe(false)
    })
  })

  describe('reloadFile', () => {
    it('reloads an open tab from disk and clears modified', async () => {
      const doc = makeDoc('Opened', 'old content')
      electronAPI.openFile.mockResolvedValueOnce({ success: true, data: { document: doc, filePath: 'C:/docs/a.md', format: 'markdown' } })
      const store = useFileStore()
      await store.openFile('C:/docs/a.md')
      expect(store.fileContent).toBe('old content')

      store.updateContent('new local edit')
      expect(store.isModified).toBe(true)

      const freshDoc = makeDoc('Opened', 'remote content')
      electronAPI.openFile.mockResolvedValueOnce({ success: true, data: { document: freshDoc, filePath: 'C:/docs/a.md', format: 'markdown' } })
      const ok = await store.reloadFile('C:/docs/a.md')
      expect(ok).toBe(true)
      expect(store.fileContent).toBe('remote content')
      expect(store.isModified).toBe(false)
    })

    it('returns false when the tab is not open', async () => {
      const store = useFileStore()
      await expect(store.reloadFile('C:/docs/not-open.md')).resolves.toBe(false)
    })
  })

  describe('openFolderPath', () => {
    it('records opened folders in the recent list with type folder', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async () => ({ success: true, data: [] }))
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      const ok = await store.openFolderPath('C:/docs')

      expect(ok).toBe(true)
      expect(electronAPI.addRecentFile).toHaveBeenCalledWith('C:/docs', 'folder')
    })

    it('does not record the folder when opening fails', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async () => ({ success: false }))
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      const ok = await store.openFolderPath('C:/docs')

      expect(ok).toBe(false)
      expect(electronAPI.addRecentFile).not.toHaveBeenCalled()
    })

    it('refreshes the recent files list immediately after opening a folder', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async () => ({ success: true, data: [] })),
        getRecentFiles: vi.fn(async () => ({
          success: true,
          data: [{ path: 'C:/docs', type: 'folder' }]
        }))
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      const ok = await store.openFolderPath('C:/docs')

      expect(ok).toBe(true)
      expect(store.recentFiles).toEqual([{ path: 'C:/docs', type: 'folder' }])
    })

    it('keeps expanded folders and loaded children when the tree refreshes', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async (dirPath: string) => {
          if (dirPath === 'C:/docs') {
            return {
              success: true,
              data: [
                { name: 'A', path: 'C:/docs/A', isDirectory: true },
                { name: 'b.md', path: 'C:/docs/b.md', isDirectory: false }
              ]
            }
          }
          if (dirPath === 'C:/docs/A') {
            return {
              success: true,
              data: [{ name: 'x.mdx', path: 'C:/docs/A/x.mdx', isDirectory: false }]
            }
          }
          return { success: false }
        })
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      const root = store.fileTree[0]
      const nodeA = root.children.find((c) => c.name === 'A')!
      await store.expandNode(nodeA)
      expect(nodeA.isExpanded).toBe(true)
      expect(nodeA.children.some((c) => c.path === 'C:/docs/A/x.mdx')).toBe(true)

      // 模拟 createFile/rename/delete 等操作触发的全量刷新
      await store.readFolder('C:/docs')
      const refreshedA = store.fileTree[0].children.find((c) => c.name === 'A')!
      expect(refreshedA.isExpanded).toBe(true)
      expect(refreshedA.children.some((c) => c.path === 'C:/docs/A/x.mdx')).toBe(true)
    })

    it('re-reads expanded subfolders when the tree refreshes so disk-level changes show up', async () => {
      let subFolderContents = [
        { name: 'x.mdx', path: 'C:/docs/A/x.mdx', isDirectory: false }
      ]
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async (dirPath: string) => {
          if (dirPath === 'C:/docs') {
            return {
              success: true,
              data: [
                { name: 'A', path: 'C:/docs/A', isDirectory: true },
                { name: 'b.md', path: 'C:/docs/b.md', isDirectory: false }
              ]
            }
          }
          if (dirPath === 'C:/docs/A') {
            return { success: true, data: subFolderContents }
          }
          return { success: false }
        })
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      const root = store.fileTree[0]
      const nodeA = root.children.find((c) => c.name === 'A')!
      await store.expandNode(nodeA)
      expect(nodeA.children.some((c) => c.path === 'C:/docs/A/x.mdx')).toBe(true)

      // 模拟用户直接在磁盘上往 A 里添加了 y.mdx（watcher 只会触发根目录 readFolder）
      subFolderContents = [
        { name: 'x.mdx', path: 'C:/docs/A/x.mdx', isDirectory: false },
        { name: 'y.mdx', path: 'C:/docs/A/y.mdx', isDirectory: false }
      ]
      await store.readFolder('C:/docs')

      const refreshedA = store.fileTree[0].children.find((c) => c.name === 'A')!
      expect(refreshedA.isExpanded).toBe(true)
      expect(refreshedA.children.some((c) => c.path === 'C:/docs/A/y.mdx')).toBe(true)
    })

    it('re-reads nested expanded subfolders recursively after an external rename', async () => {
      let innerContents = [
        { name: 'i1.md', path: 'C:/docs/A/inner/i1.md', isDirectory: false }
      ]
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async (dirPath: string) => {
          if (dirPath === 'C:/docs') {
            return {
              success: true,
              data: [{ name: 'A', path: 'C:/docs/A', isDirectory: true }]
            }
          }
          if (dirPath === 'C:/docs/A') {
            return {
              success: true,
              data: [{ name: 'inner', path: 'C:/docs/A/inner', isDirectory: true }]
            }
          }
          if (dirPath === 'C:/docs/A/inner') {
            return { success: true, data: innerContents }
          }
          return { success: false }
        })
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      const nodeA = store.fileTree[0].children.find((c) => c.name === 'A')!
      await store.expandNode(nodeA)
      const nodeInner = nodeA.children.find((c) => c.name === 'inner')!
      await store.expandNode(nodeInner)
      expect(nodeInner.children.some((c) => c.path === 'C:/docs/A/inner/i1.md')).toBe(true)

      // 模拟磁盘上 inner 里新增 i2.md，随后根目录刷新（watcher/手动刷新场景）
      innerContents = [
        { name: 'i1.md', path: 'C:/docs/A/inner/i1.md', isDirectory: false },
        { name: 'i2.md', path: 'C:/docs/A/inner/i2.md', isDirectory: false }
      ]
      await store.readFolder('C:/docs')

      const refreshedA = store.fileTree[0].children.find((c) => c.name === 'A')!
      const refreshedInner = refreshedA.children.find((c) => c.name === 'inner')!
      expect(refreshedInner.isExpanded).toBe(true)
      expect(refreshedInner.children.some((c) => c.path === 'C:/docs/A/inner/i2.md')).toBe(true)
    })

    it('closes all open tabs when switching to another folder', async () => {
      const doc = makeDoc('A', 'content')
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async () => ({ success: true, data: [] })),
        openFile: vi.fn(async () => ({
          success: true,
          data: { document: doc, filePath: 'C:/docs/a.mdx', format: 'mdx' }
        }))
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      await store.openFile('C:/docs/a.mdx')
      expect(store.tabs).toHaveLength(1)

      const ok = await store.openFolderPath('C:/other')

      expect(ok).toBe(true)
      expect(store.tabs).toHaveLength(0)
      expect(store.openedFolderPath).toBe('C:/other')
    })

    it('aborts switching folders when a dirty tab close is cancelled', async () => {
      const doc = makeDoc('A', 'content')
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async () => ({ success: true, data: [] })),
        openFile: vi.fn(async () => ({
          success: true,
          data: { document: doc, filePath: 'C:/docs/a.mdx', format: 'mdx' }
        }))
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      await store.openFile('C:/docs/a.mdx')
      store.updateContent('edited')
      vi.mocked(requestDialog).mockResolvedValueOnce(2)

      const ok = await store.openFolderPath('C:/other')

      expect(ok).toBe(false)
      expect(store.tabs).toHaveLength(1)
      expect(store.openedFolderPath).toBe('C:/docs')
    })

    it('keeps open tabs when reopening the same folder', async () => {
      const doc = makeDoc('A', 'content')
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async () => ({ success: true, data: [] })),
        openFile: vi.fn(async () => ({
          success: true,
          data: { document: doc, filePath: 'C:/docs/a.mdx', format: 'mdx' }
        }))
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      await store.openFile('C:/docs/a.mdx')

      const ok = await store.openFolderPath('C:/docs')

      expect(ok).toBe(true)
      expect(store.tabs).toHaveLength(1)
    })
  })

  describe('tree CRUD updates', () => {
    function mockFolderTree(): void {
      electronAPI.readFolder.mockImplementation(async (dirPath: string) => {
        if (dirPath === 'C:/docs') {
          return {
            success: true,
            data: [
              { name: 'A', path: 'C:/docs/A', isDirectory: true },
              { name: 'a.mdx', path: 'C:/docs/a.mdx', isDirectory: false }
            ]
          }
        }
        if (dirPath === 'C:/docs/A') {
          return {
            success: true,
            data: [{ name: 'x.mdx', path: 'C:/docs/A/x.mdx', isDirectory: false }]
          }
        }
        return { success: false }
      })
    }

    async function openTree(): Promise<{ root: FileTreeNode; nodeA: FileTreeNode }> {
      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      const root = store.fileTree[0]
      const nodeA = root.children.find((c) => c.name === 'A')!
      await store.expandNode(nodeA)
      return { root, nodeA }
    }

    it('inserts a new file into an expanded subfolder without collapsing the tree', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(),
        createFile: vi.fn(async () => ({ success: true, data: { path: 'C:/docs/A/y.mdx' } })),
        openFile: vi.fn(async () => ({
          success: true,
          data: { document: makeDoc('y', ''), filePath: 'C:/docs/A/y.mdx', format: 'mdx' }
        }))
      })
      vi.stubGlobal('window', { electronAPI })
      mockFolderTree()

      const store = useFileStore()
      const { nodeA } = await openTree()
      const readCallsBefore = electronAPI.readFolder.mock.calls.length

      const ok = await store.createFile('C:/docs/A', 'y.mdx')

      expect(ok).toBe(true)
      // 新文件出现在 A 的 children 中，且树保持展开
      expect(nodeA.children.some((c) => c.path === 'C:/docs/A/y.mdx')).toBe(true)
      expect(nodeA.isExpanded).toBe(true)
      // 不再触发全量 readFolder 刷新
      expect(electronAPI.readFolder.mock.calls.length).toBe(readCallsBefore)
      // 新文件被自动打开
      expect(store.tabs[0].fileInfo?.path).toBe('C:/docs/A/y.mdx')
    })

    it('inserts a new file into the root and syncs folderItems', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(),
        createFile: vi.fn(async () => ({ success: true, data: { path: 'C:/docs/z.mdx' } })),
        openFile: vi.fn(async () => ({
          success: true,
          data: { document: makeDoc('z', ''), filePath: 'C:/docs/z.mdx', format: 'mdx' }
        }))
      })
      vi.stubGlobal('window', { electronAPI })
      mockFolderTree()

      const store = useFileStore()
      const { root } = await openTree()
      expect(root.children.some((c) => c.path === 'C:/docs/z.mdx')).toBe(false)

      const ok = await store.createFile('C:/docs', 'z.mdx')

      expect(ok).toBe(true)
      expect(root.children.some((c) => c.path === 'C:/docs/z.mdx')).toBe(true)
      expect(store.folderItems.some((c) => c.path === 'C:/docs/z.mdx')).toBe(true)
    })

    it('inserts a new folder into an expanded subfolder', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(),
        createFolder: vi.fn(async () => ({ success: true, data: { path: 'C:/docs/A/sub' } }))
      })
      vi.stubGlobal('window', { electronAPI })
      mockFolderTree()

      const store = useFileStore()
      const { nodeA } = await openTree()

      const ok = await store.createFolder('C:/docs/A', 'sub')

      expect(ok).toBe(true)
      expect(nodeA.children.some((c) => c.path === 'C:/docs/A/sub' && c.isDirectory)).toBe(true)
      expect(nodeA.isExpanded).toBe(true)
    })

    it('renames a nested file in the tree and keeps the folder expanded', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(),
        renameFile: vi.fn(async () => ({ success: true, data: { path: 'C:/docs/A/y.mdx' } }))
      })
      vi.stubGlobal('window', { electronAPI })
      mockFolderTree()

      const store = useFileStore()
      const { nodeA } = await openTree()

      const ok = await store.renameItem('C:/docs/A/x.mdx', 'y.mdx')

      expect(ok).toBe(true)
      expect(nodeA.children.some((c) => c.path === 'C:/docs/A/x.mdx')).toBe(false)
      expect(nodeA.children.some((c) => c.path === 'C:/docs/A/y.mdx')).toBe(true)
      expect(nodeA.isExpanded).toBe(true)
    })

    it('renames a nested folder and updates its descendants', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(),
        renameFile: vi.fn(async () => ({ success: true, data: { path: 'C:/docs/B' } }))
      })
      vi.stubGlobal('window', { electronAPI })
      mockFolderTree()

      const store = useFileStore()
      const { root, nodeA } = await openTree()
      expect(nodeA.children.some((c) => c.path === 'C:/docs/A/x.mdx')).toBe(true)

      const ok = await store.renameItem('C:/docs/A', 'B')

      expect(ok).toBe(true)
      expect(nodeA.name).toBe('B')
      expect(nodeA.path).toBe('C:/docs/B')
      expect(nodeA.isExpanded).toBe(true)
      expect(nodeA.children.some((c) => c.path === 'C:/docs/B/x.mdx')).toBe(true)
      expect(root.children.some((c) => c.name === 'B' && c.path === 'C:/docs/B')).toBe(true)
      expect(store.folderItems.some((c) => c.name === 'B' && c.path === 'C:/docs/B')).toBe(true)
    })

    it('renames a nested folder with backslash paths', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async (dirPath: string) => {
          if (dirPath === 'C:\\docs') {
            return {
              success: true,
              data: [
                { name: 'A', path: 'C:\\docs\\A', isDirectory: true },
                { name: 'a.mdx', path: 'C:\\docs\\a.mdx', isDirectory: false }
              ]
            }
          }
          if (dirPath === 'C:\\docs\\A') {
            return {
              success: true,
              data: [{ name: 'x.mdx', path: 'C:\\docs\\A\\x.mdx', isDirectory: false }]
            }
          }
          return { success: false }
        }),
        renameFile: vi.fn(async () => ({ success: true, data: { path: 'C:\\docs\\B' } }))
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      await store.openFolderPath('C:\\docs')
      const root = store.fileTree[0]
      const nodeA = root.children.find((c) => c.name === 'A')!
      await store.expandNode(nodeA)
      expect(nodeA.children.some((c) => c.path === 'C:\\docs\\A\\x.mdx')).toBe(true)

      const ok = await store.renameItem('C:\\docs\\A', 'B')

      expect(ok).toBe(true)
      expect(nodeA.name).toBe('B')
      expect(nodeA.path).toBe('C:\\docs\\B')
      expect(nodeA.children.some((c) => c.path === 'C:\\docs\\B\\x.mdx')).toBe(true)
    })

    it('renames the root folder and updates openedFolderPath', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(),
        renameFile: vi.fn(async () => ({ success: true, data: { path: 'C:/docs2' } }))
      })
      vi.stubGlobal('window', { electronAPI })
      mockFolderTree()

      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      const root = store.fileTree[0]
      expect(root.name).toBe('docs')

      const ok = await store.renameItem('C:/docs', 'docs2')

      expect(ok).toBe(true)
      expect(root.name).toBe('docs2')
      expect(root.path).toBe('C:/docs2')
      expect(store.openedFolderPath).toBe('C:/docs2')
    })

    it('removes a nested file from the tree without collapsing siblings', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(),
        deleteFile: vi.fn(async () => ({ success: true }))
      })
      vi.stubGlobal('window', { electronAPI })
      mockFolderTree()

      const store = useFileStore()
      const { nodeA } = await openTree()

      const ok = await store.deleteItem('C:/docs/A/x.mdx')

      expect(ok).toBe(true)
      expect(nodeA.children.some((c) => c.path === 'C:/docs/A/x.mdx')).toBe(false)
      expect(nodeA.isExpanded).toBe(true)
    })

    it('re-sorts siblings by name after rename', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async (dirPath: string) => {
          if (dirPath === 'C:/docs') {
            return {
              success: true,
              data: [
                { name: 'a.mdx', path: 'C:/docs/a.mdx', isDirectory: false },
                { name: 'b.mdx', path: 'C:/docs/b.mdx', isDirectory: false }
              ]
            }
          }
          return { success: false }
        }),
        renameFile: vi.fn(async () => ({ success: true, data: { path: 'C:/docs/0.mdx' } }))
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      const root = store.fileTree[0]
      expect(root.children.map((c) => c.name)).toEqual(['a.mdx', 'b.mdx'])

      const ok = await store.renameItem('C:/docs/b.mdx', '0.mdx')

      expect(ok).toBe(true)
      expect(root.children.map((c) => c.name)).toEqual(['0.mdx', 'a.mdx'])
    })

    it('inserts new entries in natural name order', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(async (dirPath: string) => {
          if (dirPath === 'C:/docs') {
            return {
              success: true,
              data: [{ name: 'file10.mdx', path: 'C:/docs/file10.mdx', isDirectory: false }]
            }
          }
          return { success: false }
        }),
        createFile: vi.fn(async () => ({ success: true, data: { path: 'C:/docs/file2.mdx' } })),
        openFile: vi.fn(async () => ({
          success: true,
          data: { document: makeDoc('file2', ''), filePath: 'C:/docs/file2.mdx', format: 'mdx' }
        }))
      })
      vi.stubGlobal('window', { electronAPI })

      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      const root = store.fileTree[0]
      expect(root.children.map((c) => c.name)).toEqual(['file10.mdx'])

      await store.createFile('C:/docs', 'file2.mdx')

      expect(root.children.map((c) => c.name)).toEqual(['file2.mdx', 'file10.mdx'])
    })
  })

  describe('restoreSession', () => {
    it('restores open tabs without recording them as recent files', async () => {
      const doc = makeDoc('Doc', 'content')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/a.md', format: 'markdown' }
      })

      const session = {
        openedFolderPath: null,
        openFilePaths: ['C:/docs/a.md'],
        activeFilePath: null,
        sidebarCollapsed: false,
        editorMode: 'ir',
        aiPanelOpen: false,
        aiActiveConversationId: null
      }
      vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(session))

      const store = useFileStore()
      await store.restoreSession()

      expect(electronAPI.openFile).toHaveBeenCalledWith('C:/docs/a.md', false)
    })
  })

  describe('content editing', () => {
    it('updateContent updates content and marks the tab modified', async () => {
      const doc = makeDoc('Doc', 'before')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/doc.mdx', format: 'mdx' }
      })

      const store = useFileStore()
      await store.openFile('C:/docs/doc.mdx')

      store.updateContent('after')

      expect(store.fileContent).toBe('after')
      expect(store.isModified).toBe(true)
      expect(store.isDirty).toBe(true)
    })

    it('setContent syncs content without marking the tab modified', async () => {
      const doc = makeDoc('Doc', 'before')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/doc.mdx', format: 'mdx' }
      })

      const store = useFileStore()
      await store.openFile('C:/docs/doc.mdx')

      store.setContent('synced')

      expect(store.fileContent).toBe('synced')
      expect(store.isModified).toBe(false)
    })
  })

  describe('saveFile', () => {
    it('clears the modified flag after a successful save', async () => {
      const doc = makeDoc('Doc', 'before')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/doc.mdx', format: 'mdx' }
      })
      electronAPI.saveFile.mockResolvedValue({ success: true, data: 'C:/docs/doc.mdx' })

      const store = useFileStore()
      await store.openFile('C:/docs/doc.mdx')
      store.updateContent('edited')
      expect(store.isModified).toBe(true)

      const ok = await store.saveFile()

      expect(ok).toBe(true)
      expect(store.isModified).toBe(false)
      expect(electronAPI.saveFile).toHaveBeenCalledWith('edited', 'Doc', 'C:/docs/doc.mdx', true)
    })

    it('falls back to saveAsFile when the file has no path (NEW_FILE)', async () => {
      const doc = makeDoc('Doc', 'content')
      electronAPI.newFile.mockResolvedValue({ success: true, data: { document: doc, isNew: true } })
      electronAPI.saveFile.mockResolvedValue({ success: false, error: 'NEW_FILE' })
      electronAPI.saveAsFile.mockResolvedValue({ success: true, data: 'C:/docs/saved.mdx' })

      const store = useFileStore()
      await store.newFile()

      const ok = await store.saveFile()

      expect(ok).toBe(true)
      expect(electronAPI.saveAsFile).toHaveBeenCalled()
      expect(electronAPI.saveFile).toHaveBeenCalledWith('content', 'Doc', undefined, false)
      expect(store.currentFile?.path).toBe('C:/docs/saved.mdx')
    })
  })

  describe('saveAsFile', () => {
    it('updates fileInfo path, name and format after saving as', async () => {
      const doc = makeDoc('Doc', 'content')
      electronAPI.newFile.mockResolvedValue({ success: true, data: { document: doc, isNew: true } })
      electronAPI.saveAsFile.mockResolvedValue({ success: true, data: 'C:/docs/renamed.md' })

      const store = useFileStore()
      await store.newFile()

      const ok = await store.saveAsFile()

      expect(ok).toBe(true)
      expect(store.currentFile?.path).toBe('C:/docs/renamed.md')
      expect(store.currentFile?.name).toBe('renamed.md')
      expect(store.currentFile?.format).toBe('markdown')
      expect(electronAPI.saveAsFile).toHaveBeenCalledWith('content', 'Doc', undefined, false)
    })
  })

  describe('closeTab', () => {
    it('closes a clean tab without prompting', async () => {
      const doc = makeDoc('Doc', 'content')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/doc.mdx', format: 'mdx' }
      })

      const store = useFileStore()
      await store.openFile('C:/docs/doc.mdx')
      const tabId = store.activeTabId!

      const closed = await store.closeTab(tabId)

      expect(closed).toBe(true)
      expect(store.tabs).toHaveLength(0)
      expect(store.activeTabId).toBeNull()
      expect(requestDialog).not.toHaveBeenCalled()
    })

    it('keeps the tab when the user cancels the save prompt', async () => {
      const doc = makeDoc('Doc', 'content')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/doc.mdx', format: 'mdx' }
      })
      vi.mocked(requestDialog).mockResolvedValueOnce(2) // cancel

      const store = useFileStore()
      await store.openFile('C:/docs/doc.mdx')
      store.updateContent('dirty')
      const tabId = store.activeTabId!

      const closed = await store.closeTab(tabId)

      expect(closed).toBe(false)
      expect(store.tabs).toHaveLength(1)
    })

    it('closes the tab after the user chooses to discard', async () => {
      const doc = makeDoc('Doc', 'content')
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: doc, filePath: 'C:/docs/doc.mdx', format: 'mdx' }
      })
      vi.mocked(requestDialog).mockResolvedValueOnce(1) // discard

      const store = useFileStore()
      await store.openFile('C:/docs/doc.mdx')
      store.updateContent('dirty')
      const tabId = store.activeTabId!

      const closed = await store.closeTab(tabId)

      expect(closed).toBe(true)
      expect(store.tabs).toHaveLength(0)
    })
  })

  describe('multiple tabs', () => {
    async function openTwoTabs(store: ReturnType<typeof useFileStore>): Promise<void> {
      electronAPI.openFile
        .mockResolvedValueOnce({
          success: true,
          data: { document: makeDoc('First', 'one'), filePath: 'C:/docs/first.mdx', format: 'mdx' }
        })
        .mockResolvedValueOnce({
          success: true,
          data: { document: makeDoc('Second', 'two'), filePath: 'C:/docs/second.mdx', format: 'mdx' }
        })
      await store.openFile('C:/docs/first.mdx')
      await store.openFile('C:/docs/second.mdx')
    }

    it('opens multiple tabs and activates the latest', async () => {
      const store = useFileStore()
      await openTwoTabs(store)

      expect(store.tabs).toHaveLength(2)
      expect(store.hasMultipleTabs).toBe(true)
      expect(store.fileContent).toBe('two')
    })

    it('switches the active tab via setActiveTab', async () => {
      const store = useFileStore()
      await openTwoTabs(store)
      const firstTabId = store.tabs[0].id

      await store.setActiveTab(firstTabId)

      expect(store.activeTabId).toBe(firstTabId)
      expect(store.fileContent).toBe('one')
    })

    it('closeOtherTabs keeps only the specified tab', async () => {
      const store = useFileStore()
      await openTwoTabs(store)
      const keepId = store.tabs[1].id

      await store.closeOtherTabs(keepId)

      expect(store.tabs).toHaveLength(1)
      expect(store.tabs[0].id).toBe(keepId)
    })

    it('closeAllTabs empties the tab list', async () => {
      const store = useFileStore()
      await openTwoTabs(store)

      await store.closeAllTabs()

      expect(store.tabs).toHaveLength(0)
      expect(store.activeTabId).toBeNull()
    })
  })

  describe('moveItem', () => {
    function mockFolderTree(): void {
      electronAPI.readFolder.mockImplementation(async (dirPath) => {
        if (dirPath === 'C:/docs') {
          return {
            success: true,
            data: [
              { name: 'A', path: 'C:/docs/A', isDirectory: true },
              { name: 'B', path: 'C:/docs/B', isDirectory: true },
              { name: 'a.mdx', path: 'C:/docs/a.mdx', isDirectory: false }
            ]
          }
        }
        if (dirPath === 'C:/docs/A') {
          return {
            success: true,
            data: [{ name: 'x.mdx', path: 'C:/docs/A/x.mdx', isDirectory: false }]
          }
        }
        if (dirPath === 'C:/docs/B') {
          return {
            success: true,
            data: [{ name: 'b.md', path: 'C:/docs/B/b.md', isDirectory: false }]
          }
        }
        return { success: false }
      })
    }

    async function openTreeAndTab(): Promise<{ root: FileTreeNode; nodeA: FileTreeNode; nodeB: FileTreeNode }> {
      const store = useFileStore()
      await store.openFolderPath('C:/docs')
      const root = store.fileTree[0]
      const nodeA = root.children.find((c) => c.name === 'A')!
      const nodeB = root.children.find((c) => c.name === 'B')!
      await store.expandNode(nodeA)
      await store.expandNode(nodeB)
      electronAPI.openFile.mockResolvedValue({
        success: true,
        data: { document: makeDoc('x', 'content'), filePath: 'C:/docs/A/x.mdx', format: 'mdx' }
      })
      await store.openFile('C:/docs/A/x.mdx')
      return { root, nodeA, nodeB }
    }

    it('moves a file, updates the open tab path and keeps the tree expanded', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(),
        moveFile: vi.fn(async () => ({ success: true, data: { path: 'C:/docs/x.mdx' } }))
      })
      vi.stubGlobal('window', { electronAPI })
      mockFolderTree()

      const store = useFileStore()
      const { root, nodeA } = await openTreeAndTab()
      expect(nodeA.isExpanded).toBe(true)

      const ok = await store.moveItem('C:/docs/A/x.mdx', 'C:/docs')

      expect(ok).toBe(true)
      expect(electronAPI.moveFile).toHaveBeenCalledWith('C:/docs/A/x.mdx', 'C:/docs')
      // 打开的 tab 路径更新到新位置
      expect(store.tabs[0].fileInfo?.path).toBe('C:/docs/x.mdx')
      // 树中节点被移到根目录下
      expect(root.children.some((c) => c.path === 'C:/docs/x.mdx')).toBe(true)
      expect(nodeA.children.some((c) => c.path === 'C:/docs/A/x.mdx')).toBe(false)
      // 展开状态保持
      expect(nodeA.isExpanded).toBe(true)
    })

    it('moves a folder and rewrites the prefix of tabs of files inside it', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(),
        moveFile: vi.fn(async () => ({ success: true, data: { path: 'C:/docs/B/A' } }))
      })
      vi.stubGlobal('window', { electronAPI })
      mockFolderTree()

      const store = useFileStore()
      const { root, nodeA, nodeB } = await openTreeAndTab()
      expect(nodeA.isExpanded).toBe(true)

      const ok = await store.moveItem('C:/docs/A', 'C:/docs/B')

      expect(ok).toBe(true)
      // 文件夹内打开的文件 tab 前缀更新
      expect(store.tabs[0].fileInfo?.path).toBe('C:/docs/B/A/x.mdx')
      // 节点移到 B 下，且保持展开状态
      expect(nodeB.children.some((c) => c.path === 'C:/docs/B/A')).toBe(true)
      expect(root.children.some((c) => c.path === 'C:/docs/A')).toBe(false)
      expect(nodeA.isExpanded).toBe(true)
    })

    it('reports failure and does not touch tabs when the move fails', async () => {
      electronAPI = createMockElectronAPI({
        readFolder: vi.fn(),
        moveFile: vi.fn(async () => ({ success: false, error: '目标已存在' }))
      })
      vi.stubGlobal('window', { electronAPI })
      mockFolderTree()

      const store = useFileStore()
      await openTreeAndTab()

      const ok = await store.moveItem('C:/docs/A/x.mdx', 'C:/docs')

      expect(ok).toBe(false)
      expect(store.tabs[0].fileInfo?.path).toBe('C:/docs/A/x.mdx')
      expect(store.error).toBe('目标已存在')
    })
  })

  describe('getters', () => {
    it('uses the actual pending filename instead of the document title', async () => {
      const doc = makeDoc('My Title', 'content')
      electronAPI.newFile.mockResolvedValue({ success: true, data: { document: doc, isNew: true } })

      const store = useFileStore()
      await store.newFile()

      expect(store.fileName).toBe('未命名.mdx')
    })

    it('falls back to 未命名.mdx when there is no active tab', () => {
      const store = useFileStore()
      expect(store.fileName).toBe('未命名.mdx')
    })
  })

  describe('maxOpenTabs', () => {
    it('defaults to 20', () => {
      const store = useFileStore()
      expect(store.maxOpenTabs).toBe(20)
    })

    it('openFile refuses when at the limit', async () => {
      const store = useFileStore()
      store.setMaxOpenTabs(1)
      electronAPI.openFile.mockImplementation(async (filePath: string) => ({
        success: true,
        data: { document: makeDoc('Doc', 'a'), filePath, format: 'mdx' }
      }))
      expect(await store.openFile('C:/a.mdx')).toBe(true)
      expect(await store.openFile('C:/b.mdx')).toBe(false)
      expect(store.tabs).toHaveLength(1)
      expect(requestDialog).toHaveBeenCalled()
    })

    it('openFile activates an already-open tab even at the limit', async () => {
      const store = useFileStore()
      store.setMaxOpenTabs(1)
      electronAPI.openFile.mockImplementation(async (filePath: string) => ({
        success: true,
        data: { document: makeDoc('Doc', 'a'), filePath, format: 'mdx' }
      }))
      await store.openFile('C:/a.mdx')
      expect(await store.openFile('C:/a.mdx')).toBe(true)
      expect(store.tabs).toHaveLength(1)
    })

    it('openFile silentLimit returns false without dialog', async () => {
      const store = useFileStore()
      store.setMaxOpenTabs(1)
      electronAPI.openFile.mockImplementation(async (filePath: string) => ({
        success: true,
        data: { document: makeDoc('Doc', 'a'), filePath, format: 'mdx' }
      }))
      await store.openFile('C:/a.mdx')
      requestDialog.mockClear()
      expect(await store.openFile('C:/b.mdx', { silentLimit: true })).toBe(false)
      expect(requestDialog).not.toHaveBeenCalled()
    })

    it('newFile refuses when at the limit', async () => {
      const store = useFileStore()
      store.setMaxOpenTabs(1)
      electronAPI.newFile.mockResolvedValue({ success: true, data: { document: makeDoc('A', 'a'), isNew: true } })
      expect(await store.newFile()).toBe(true)
      expect(await store.newFile()).toBe(false)
      expect(store.tabs).toHaveLength(1)
    })

    it('createGeneratedDocument returns null when at the limit', () => {
      const store = useFileStore()
      store.setMaxOpenTabs(1)
      expect(store.createGeneratedDocument('A', 'a', 'markdown')).not.toBeNull()
      expect(store.createGeneratedDocument('B', 'b', 'markdown')).toBeNull()
    })

    it('setMaxOpenTabs persists to session storage', () => {
      const store = useFileStore()
      store.setMaxOpenTabs(35)
      expect(store.maxOpenTabs).toBe(35)
      const saved = JSON.parse((localStorage.getItem('inkase-session') || '{}') as string)
      expect(saved.maxOpenTabs).toBe(35)
    })

    it('setMaxOpenTabs clamps out-of-range values', () => {
      const store = useFileStore()
      store.setMaxOpenTabs(0)
      expect(store.maxOpenTabs).toBe(1)
      store.setMaxOpenTabs(999)
      expect(store.maxOpenTabs).toBe(100)
    })
  })

  describe('closing tabs', () => {
    async function openManyTabs(count: number): Promise<ReturnType<typeof useFileStore>> {
      const store = useFileStore()
      store.setMaxOpenTabs(100)
      electronAPI.openFile.mockImplementation(async (filePath: string) => {
        const doc = makeDoc(`Doc ${filePath}`, `# ${filePath}`)
        return { success: true, data: { document: doc, filePath, format: 'mdx' } }
      })
      for (let n = 0; n < count; n++) {
        await store.openFile(`C:/ws/f${n}.mdx`)
      }
      return store
    }

    it('closeAllTabs closes every tab including non-document tabs', async () => {
      const store = await openManyTabs(60)
      expect(store.tabs).toHaveLength(60)
      // 模拟一个非文档标签（如冲突时打开失败的文件）
      // @ts-expect-error 测试注入无 document 的 tab
      store.tabs.push({ id: 'tab_broken', fileInfo: { path: 'C:/ws/.gitignore', name: '.gitignore', format: 'text' }, document: null, content: '', revision: 0 })
      expect(store.tabs).toHaveLength(61)
      await store.closeAllTabs()
      expect(store.tabs).toHaveLength(0)
    })

    it('closeOtherTabs keeps only the target tab', async () => {
      const store = await openManyTabs(10)
      const keep = store.tabs[3]
      await store.closeOtherTabs(keep.id)
      expect(store.tabs).toHaveLength(1)
      expect(store.tabs[0].id).toBe(keep.id)
    })
  })
})
