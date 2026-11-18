import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileStore } from '../../../stores/file'
import { createExecutionSnapshot, applyDocumentOperation } from '../workspace-context'
import { hashDocumentContent } from '../document-revision'

describe('workspace context', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
  })

  describe('createExecutionSnapshot', () => {
    it('uses the active tab content/title/path/format/revision/hash', () => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('标题', '正文内容', 'mdx')

      const snap = createExecutionSnapshot(store)

      expect(snap.activeDocument).not.toBeNull()
      expect(snap.activeDocument!.id).toBe(tab.id)
      expect(snap.activeDocument!.title).toBe('标题')
      expect(snap.activeDocument!.content).toBe('正文内容')
      expect(snap.activeDocument!.format).toBe('mdx')
      expect(snap.activeDocument!.revision).toBe(0)
      expect(snap.activeDocument!.contentHash).toBe(hashDocumentContent('正文内容'))
      expect(snap.activeDocument!.modified).toBe(true)
      expect(snap.activeDocument!.path).toBe('')
      expect(Object.keys(snap).sort()).toEqual([
        'activeDocument',
        'conversationId',
        'cursor',
        'selection',
        'workspaceRoot'
      ])
      expect(snap.selection).toBeNull()
      expect(snap.cursor).toBeNull()
    })

    it('reports null document/selection/cursor when there is no active tab', () => {
      const store = useFileStore()
      const snap = createExecutionSnapshot(store)

      expect(snap.activeDocument).toBeNull()
      expect(snap.selection).toBeNull()
      expect(snap.cursor).toBeNull()
    })

    it('carries the opened workspace root into the snapshot', () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'

      const snap = createExecutionSnapshot(store)

      expect(snap.workspaceRoot).toBe('C:\\ws')
    })

    it('keeps workspaceRoot null when no workspace folder is open', () => {
      const store = useFileStore()

      const snap = createExecutionSnapshot(store)

      expect(snap.workspaceRoot).toBeNull()
    })

    it('maps the editor selection to markdown offsets and text', () => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('标题', 'Hello world', 'markdown')
      store.updateEditorSelection({ tabId: tab.id, from: 0, to: 5, cursor: 5, text: 'Hello' })

      const snap = createExecutionSnapshot(store)

      expect(snap.selection).toEqual({ text: 'Hello', from: 0, to: 5, cursor: 5 })
      expect(snap.cursor).toBe(5)
    })

    it.each([
      ['another tab', { tabId: 'stale', from: 0, to: 5, cursor: 5, text: 'Hello' }],
      ['out-of-bounds range', { tabId: '', from: 0, to: 99, cursor: 5, text: 'Hello' }],
      ['reversed range', { tabId: '', from: 5, to: 0, cursor: 5, text: 'Hello' }],
      ['out-of-bounds cursor', { tabId: '', from: 0, to: 5, cursor: 99, text: 'Hello' }],
      ['mismatched text', { tabId: '', from: 0, to: 5, cursor: 5, text: 'wrong' }]
    ])('fails closed for a stale or invalid editor selection: %s', (_label, invalid) => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('标题', 'Hello world', 'markdown')
      store.updateEditorSelection({ ...invalid, tabId: invalid.tabId || tab.id })

      const snap = createExecutionSnapshot(store)

      expect(snap.selection).toBeNull()
      expect(snap.cursor).toBeNull()
    })
  })

  describe('applyDocumentOperation: replace-document', () => {
    it('replaces only the target tab and marks it modified', async () => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('标题', 'old content', 'markdown')
      const snap = createExecutionSnapshot(store)

      const result = await applyDocumentOperation(store, {
        type: 'replace-document',
        target: snap.activeDocument!,
        content: 'new content',
        reason: ''
      })

      expect(result.status).toBe('applied')
      expect(tab.content).toBe('new content')
      expect(tab.document!.content).toBe('new content')
      expect(tab.revision).toBe(1)
      expect(tab.fileInfo!.modified).toBe(true)
    })

    it('returns conflict when the target tab no longer exists', async () => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('标题', 'content', 'markdown')
      const snap = createExecutionSnapshot(store)
      // Remove the tab without going through the store's normal close flow.
      const idx = store.tabs.findIndex((t) => t.id === tab.id)
      store.tabs.splice(idx, 1)

      const result = await applyDocumentOperation(store, {
        type: 'replace-document',
        target: snap.activeDocument!,
        content: 'new',
        reason: ''
      })

      expect(result.status).toBe('conflict')
    })

    it('returns conflict when revision differs', async () => {
      const store = useFileStore()
      store.createGeneratedDocument('标题', 'content', 'markdown')
      const snap = createExecutionSnapshot(store)
      store.updateContent('content edited')

      const result = await applyDocumentOperation(store, {
        type: 'replace-document',
        target: snap.activeDocument!,
        content: 'new',
        reason: ''
      })

      expect(result.status).toBe('conflict')
    })

    it('returns conflict when content hash differs', async () => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('标题', 'content', 'markdown')
      const snap = createExecutionSnapshot(store)
      tab.content = 'tampered'

      const result = await applyDocumentOperation(store, {
        type: 'replace-document',
        target: snap.activeDocument!,
        content: 'new',
        reason: ''
      })

      expect(result.status).toBe('conflict')
    })
  })

  describe('applyDocumentOperation: insert-document', () => {
    it('inserts at start', async () => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('标题', 'world', 'markdown')
      const snap = createExecutionSnapshot(store)

      const result = await applyDocumentOperation(store, {
        type: 'insert-document',
        target: snap.activeDocument!,
        content: 'hello ',
        position: 'start',
        selection: null,
        cursor: null,
        reason: ''
      })

      expect(result.status).toBe('applied')
      expect(tab.content).toBe('hello world')
    })

    it('inserts at end', async () => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('标题', 'hello', 'markdown')
      const snap = createExecutionSnapshot(store)

      const result = await applyDocumentOperation(store, {
        type: 'insert-document',
        target: snap.activeDocument!,
        content: ' world',
        position: 'end',
        selection: null,
        cursor: null,
        reason: ''
      })

      expect(result.status).toBe('applied')
      expect(tab.content).toBe('hello world')
    })

    it('inserts at selection, replacing the selected range', async () => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('标题', 'hello world', 'markdown')
      store.updateEditorSelection({ tabId: tab.id, from: 6, to: 11, cursor: 11, text: 'world' })
      const snap = createExecutionSnapshot(store)

      const result = await applyDocumentOperation(store, {
        type: 'insert-document',
        target: snap.activeDocument!,
        content: 'there',
        position: 'selection',
        selection: snap.selection,
        cursor: snap.cursor,
        reason: ''
      })

      expect(result.status).toBe('applied')
      expect(tab.content).toBe('hello there')
    })

    it('inserts at cursor', async () => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('标题', 'hello', 'markdown')
      store.updateEditorSelection({ tabId: tab.id, from: 5, to: 5, cursor: 5, text: '' })
      const snap = createExecutionSnapshot(store)

      const result = await applyDocumentOperation(store, {
        type: 'insert-document',
        target: snap.activeDocument!,
        content: ' world',
        position: 'cursor',
        selection: null,
        cursor: snap.cursor,
        reason: ''
      })

      expect(result.status).toBe('applied')
      expect(tab.content).toBe('hello world')
    })

    it('returns conflict for selection position without a selection', async () => {
      const store = useFileStore()
      store.createGeneratedDocument('标题', 'hello', 'markdown')
      const snap = createExecutionSnapshot(store)

      const result = await applyDocumentOperation(store, {
        type: 'insert-document',
        target: snap.activeDocument!,
        content: 'x',
        position: 'selection',
        selection: null,
        cursor: null,
        reason: ''
      })

      expect(result.status).toBe('conflict')
    })

    it('returns conflict for cursor position without a cursor', async () => {
      const store = useFileStore()
      store.createGeneratedDocument('标题', 'hello', 'markdown')
      const snap = createExecutionSnapshot(store)

      const result = await applyDocumentOperation(store, {
        type: 'insert-document',
        target: snap.activeDocument!,
        content: 'x',
        position: 'cursor',
        selection: null,
        cursor: null,
        reason: ''
      })

      expect(result.status).toBe('conflict')
    })

    it('returns conflict when revision has changed', async () => {
      const store = useFileStore()
      store.createGeneratedDocument('标题', 'hello', 'markdown')
      const snap = createExecutionSnapshot(store)
      store.updateContent('hello edited')

      const result = await applyDocumentOperation(store, {
        type: 'insert-document',
        target: snap.activeDocument!,
        content: 'x',
        position: 'end',
        selection: null,
        cursor: null,
        reason: ''
      })

      expect(result.status).toBe('conflict')
    })
  })

  describe('applyDocumentOperation: create-document', () => {
    it('creates and activates a new unsaved tab with the requested title/content/format', async () => {
      const store = useFileStore()

      const result = await applyDocumentOperation(store, {
        type: 'create-document',
        title: '新文档',
        content: '新内容',
        format: 'markdown',
        reason: ''
      })

      expect(result.status).toBe('applied')
      const tabId = (result.data as { tabId: string }).tabId
      const tab = store.tabs.find((t) => t.id === tabId)
      expect(tab).toBeDefined()
      expect(tab!.content).toBe('新内容')
      expect(tab!.document!.metadata.title).toBe('新文档')
      expect(tab!.fileInfo!.format).toBe('markdown')
      expect(tab!.fileInfo!.modified).toBe(true)
      expect(tab!.fileInfo!.path).toBe('')
      expect(store.activeTabId).toBe(tabId)
    })

    it('notifies the caller to reveal a generated document', async () => {
      const store = useFileStore()
      const revealDocument = vi.fn()

      await applyDocumentOperation(
        store,
        {
          type: 'create-document',
          title: '新文档',
          content: '新内容',
          format: 'markdown',
          reason: ''
        },
        revealDocument
      )

      expect(revealDocument).toHaveBeenCalledTimes(1)
    })

    /*
     * AI 生成的导图走同一个创建路径，但文件名必须是 `.inkmind`：
     * 否则用户第一次保存时会被当成 Markdown 存成 `.md`，导图打不开。
     */
    it('以 mindmap 格式创建时文件名带 .inkmind 后缀', async () => {
      const store = useFileStore()
      const content =
        '{"schema":"inkase.mindmap","version":2,"root":{"id":"r","text":"规划","children":[]}}'

      const result = await applyDocumentOperation(store, {
        type: 'create-document',
        title: '产品规划',
        content,
        format: 'mindmap',
        reason: ''
      })

      expect(result.status).toBe('applied')
      const tabId = (result.data as { tabId: string }).tabId
      const tab = store.tabs.find((t) => t.id === tabId)
      expect(tab!.fileInfo!.format).toBe('mindmap')
      expect(tab!.fileInfo!.name).toBe('产品规划.inkmind')
      // 正文原样保留，交给 MindMapEditor 解析
      expect(tab!.content).toBe(content)
    })
  })

  /*
   * 回归：早先所有非 Markdown / 非思维导图的文档都被兜底成 mdx，
   * 图表与图片、PDF 于是被当成 Markdown 正文送进 AI 上下文。
   */
  describe('createExecutionSnapshot: 文档格式', () => {
    it.each([
      ['diagram', '<mxfile></mxfile>'],
      ['mindmap', '{"root":{}}'],
      ['markdown', '# 标题']
    ] as const)('把 %s 如实映射，并保留正文', (format, content) => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('文档', content, 'mdx')!
      tab.fileInfo!.format = format

      const snap = createExecutionSnapshot(store)

      expect(snap.activeDocument!.format).toBe(format)
      expect(snap.activeDocument!.content).toBe(content)
    })

    it.each(['image', 'pdf'] as const)('二进制文档（%s）不进正文', (format) => {
      const store = useFileStore()
      const tab = store.createGeneratedDocument('附件', 'data:image/png;base64,AAAA', 'mdx')!
      tab.fileInfo!.format = format

      const snap = createExecutionSnapshot(store)

      expect(snap.activeDocument!.format).toBe(format)
      expect(snap.activeDocument!.content).toBe('')
    })
  })

  describe('applyDocumentOperation: delete-workspace-file', () => {
    function stubDelete(deleteFile: ReturnType<typeof vi.fn>): void {
      vi.stubGlobal('window', { electronAPI: { deleteFile } })
    }

    it('删除工作区内的文件并报告 applied', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      const deleteFile = vi.fn(async () => ({ success: true }))
      stubDelete(deleteFile)

      const result = await applyDocumentOperation(store, {
        type: 'delete-workspace-file',
        relativePath: 'docs/a.md',
        absolutePath: 'C:\\ws\\docs\\a.md',
        fileSize: 10,
        reason: '清理'
      })

      expect(deleteFile).toHaveBeenCalledWith('C:\\ws\\docs\\a.md')
      expect(result.status).toBe('applied')
    })

    it('拒绝删除工作区之外的目标', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      const deleteFile = vi.fn(async () => ({ success: true }))
      stubDelete(deleteFile)

      const result = await applyDocumentOperation(store, {
        type: 'delete-workspace-file',
        relativePath: '../secret.md',
        absolutePath: 'C:\\secret.md',
        fileSize: 10,
        reason: ''
      })

      expect(deleteFile).not.toHaveBeenCalled()
      expect(result.status).toBe('failed')
    })

    it('文件有未保存修改时拒绝删除', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      const tab = store.createGeneratedDocument('草稿', '未保存内容', 'markdown')!
      tab.fileInfo!.path = 'C:\\ws\\docs\\a.md'
      tab.fileInfo!.modified = true
      const deleteFile = vi.fn(async () => ({ success: true }))
      stubDelete(deleteFile)

      const result = await applyDocumentOperation(store, {
        type: 'delete-workspace-file',
        relativePath: 'docs/a.md',
        absolutePath: 'C:\\ws\\docs\\a.md',
        fileSize: 10,
        reason: ''
      })

      expect(deleteFile).not.toHaveBeenCalled()
      expect(result).toMatchObject({ status: 'failed' })
      expect(result.status === 'failed' ? result.message : '').toContain('未保存')
    })

    it('没有打开工作区时不执行删除', async () => {
      const store = useFileStore()
      const deleteFile = vi.fn(async () => ({ success: true }))
      stubDelete(deleteFile)

      const result = await applyDocumentOperation(store, {
        type: 'delete-workspace-file',
        relativePath: 'docs/a.md',
        absolutePath: 'C:\\ws\\docs\\a.md',
        fileSize: 10,
        reason: ''
      })

      expect(deleteFile).not.toHaveBeenCalled()
      expect(result.status).toBe('failed')
    })
  })

  describe('applyDocumentOperation: move-workspace-entry', () => {
    function stubFs(api: Record<string, unknown>): void {
      vi.stubGlobal('window', { electronAPI: api })
    }

    it('同目录时走重命名', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      const renameFile = vi.fn(async () => ({ success: true, data: { path: 'C:\\ws\\docs\\b.md' } }))
      const moveFile = vi.fn(async () => ({ success: true, data: { path: '' } }))
      stubFs({ renameFile, moveFile })
      vi.spyOn(store, 'renameItem').mockResolvedValue(true)

      const result = await applyDocumentOperation(store, {
        type: 'move-workspace-entry',
        fromRelative: 'docs/a.md',
        fromAbsolute: 'C:\\ws\\docs\\a.md',
        toRelative: 'docs/b.md',
        toAbsolute: 'C:\\ws\\docs\\b.md',
        reason: '改名'
      })

      expect(store.renameItem).toHaveBeenCalledWith('C:\\ws\\docs\\a.md', 'b.md')
      expect(moveFile).not.toHaveBeenCalled()
      expect(result.status).toBe('applied')
    })

    it('跨目录时先移动再改名', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      stubFs({})
      const moveItem = vi.spyOn(store, 'moveItem').mockResolvedValue(true)
      const renameItem = vi.spyOn(store, 'renameItem').mockResolvedValue(true)

      const result = await applyDocumentOperation(store, {
        type: 'move-workspace-entry',
        fromRelative: 'docs/a.md',
        fromAbsolute: 'C:\\ws\\docs\\a.md',
        toRelative: '归档/b.md',
        toAbsolute: 'C:\\ws\\归档\\b.md',
        reason: '归类'
      })

      expect(moveItem).toHaveBeenCalledWith('C:\\ws\\docs\\a.md', 'C:\\ws\\归档')
      expect(renameItem).toHaveBeenCalledWith('C:\\ws\\归档\\b.md', 'b.md')
      expect(result.status).toBe('applied')
    })

    it('目标内有未保存修改时拒绝移动', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      stubFs({})
      const tab = store.createGeneratedDocument('草稿', '内容', 'markdown')!
      tab.fileInfo!.path = 'C:\\ws\\docs\\a.md'
      tab.fileInfo!.modified = true
      const moveItem = vi.spyOn(store, 'moveItem').mockResolvedValue(true)

      const result = await applyDocumentOperation(store, {
        type: 'move-workspace-entry',
        fromRelative: 'docs/a.md',
        fromAbsolute: 'C:\\ws\\docs\\a.md',
        toRelative: '归档/a.md',
        toAbsolute: 'C:\\ws\\归档\\a.md',
        reason: ''
      })

      expect(moveItem).not.toHaveBeenCalled()
      expect(result.status).toBe('conflict')
    })
  })

  describe('applyDocumentOperation: create-workspace-directory', () => {
    it('在父目录下新建一级目录', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      vi.stubGlobal('window', { electronAPI: {} })
      const createFolder = vi.spyOn(store, 'createFolder').mockResolvedValue(true)

      const result = await applyDocumentOperation(store, {
        type: 'create-workspace-directory',
        relativePath: '归档/2026',
        absolutePath: 'C:\\ws\\归档\\2026',
        reason: '按年份归类'
      })

      expect(createFolder).toHaveBeenCalledWith('C:\\ws\\归档', '2026')
      expect(result.status).toBe('applied')
    })
  })

  describe('applyDocumentOperation: write-workspace-file', () => {
    it('写盘后刷新文件树', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      const saveFile = vi.fn(async () => ({ success: true }))
      vi.stubGlobal('window', { electronAPI: { saveFile } })
      const readFolder = vi.spyOn(store, 'readFolder').mockResolvedValue(true)

      const result = await applyDocumentOperation(store, {
        type: 'write-workspace-file',
        relativePath: 'docs/汇总.md',
        absolutePath: 'C:\\ws\\docs\\汇总.md',
        content: '# 汇总',
        format: 'markdown',
        target: null,
        reason: '合并'
      })

      expect(saveFile).toHaveBeenCalledWith('# 汇总', undefined, 'C:\\ws\\docs\\汇总.md', false)
      expect(readFolder).toHaveBeenCalledWith('C:\\ws')
      expect(result.status).toBe('applied')
    })

    it('打开中的文件写完会同步标签并清掉脏标记', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      const tab = store.createGeneratedDocument('笔记', '旧内容', 'markdown')!
      tab.fileInfo!.path = 'C:\\ws\\docs\\笔记.md'
      tab.fileInfo!.modified = false
      const saveFile = vi.fn(async () => ({ success: true }))
      vi.stubGlobal('window', { electronAPI: { saveFile } })

      const result = await applyDocumentOperation(store, {
        type: 'write-workspace-file',
        relativePath: 'docs/笔记.md',
        absolutePath: 'C:\\ws\\docs\\笔记.md',
        content: '新内容',
        format: 'markdown',
        target: null,
        reason: ''
      })

      expect(tab.content).toBe('新内容')
      expect(tab.fileInfo!.modified).toBe(false)
      expect(result.status).toBe('applied')
    })

    it('打开中的文件有未保存修改时拒绝写入', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      const tab = store.createGeneratedDocument('笔记', '旧内容', 'markdown')!
      tab.fileInfo!.path = 'C:\\ws\\docs\\笔记.md'
      tab.fileInfo!.modified = true
      const saveFile = vi.fn(async () => ({ success: true }))
      vi.stubGlobal('window', { electronAPI: { saveFile } })

      const result = await applyDocumentOperation(store, {
        type: 'write-workspace-file',
        relativePath: 'docs/笔记.md',
        absolutePath: 'C:\\ws\\docs\\笔记.md',
        content: '新内容',
        format: 'markdown',
        target: null,
        reason: ''
      })

      expect(saveFile).not.toHaveBeenCalled()
      expect(result.status).toBe('conflict')
    })

    it('目标在批准期间被改过时按冲突处理', async () => {
      const store = useFileStore()
      store.openedFolderPath = 'C:\\ws'
      const tab = store.createGeneratedDocument('笔记', '旧内容', 'markdown')!
      tab.fileInfo!.path = 'C:\\ws\\docs\\笔记.md'
      tab.fileInfo!.modified = false
      const saveFile = vi.fn(async () => ({ success: true }))
      vi.stubGlobal('window', { electronAPI: { saveFile } })

      const result = await applyDocumentOperation(store, {
        type: 'write-workspace-file',
        relativePath: 'docs/笔记.md',
        absolutePath: 'C:\\ws\\docs\\笔记.md',
        content: '新内容',
        format: 'markdown',
        target: {
          id: tab.id,
          title: '笔记',
          path: 'C:\\ws\\docs\\笔记.md',
          format: 'markdown',
          content: '旧内容',
          revision: 999,
          contentHash: hashDocumentContent('旧内容'),
          modified: false
        },
        reason: ''
      })

      expect(saveFile).not.toHaveBeenCalled()
      expect(result.status).toBe('conflict')
    })
  })
})
