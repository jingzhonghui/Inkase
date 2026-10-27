import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileStore } from '../file'
import { MINDMAP_EXTENSION, MINDMAP_FILE_SCHEMA } from '../../types/mindmap'
import { parseMindMap } from '../../utils/mindmap/schema'
import { isEditableTextFormat, isMindMapFormat } from '../../types/mdx'
import {
  registerMindMapImageBuilder,
  resetMindMapImageBuilder
} from '../../utils/mindmap/export-bridge'

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

function createMockElectronAPI() {
  return {
    newFile: vi.fn(),
    openFile: vi.fn(),
    saveFile: vi.fn(async () => ({ success: true, data: 'C:/docs/map.inkmind' })),
    saveAsFile: vi.fn(async () => ({ success: true, data: 'C:/docs/map.inkmind' })),
    closeFile: vi.fn(async () => ({ success: true })),
    exportMindMapImage: vi.fn(async () => ({ success: true, data: 'C:/docs/未命名思维导图.png' })),
    getRecentFiles: vi.fn(async () => ({ success: true, data: [] })),
    addRecentFile: vi.fn(async () => ({ success: true })),
    removeRecentFile: vi.fn(async () => ({ success: true })),
    clearRecentFiles: vi.fn(async () => ({ success: true })),
    readFolder: vi.fn(async () => ({ success: false })),
    writeRecovery: vi.fn(async () => ({ success: true })),
    clearRecovery: vi.fn(async () => ({ success: true })),
    recoveryStatus: vi.fn(async () => ({ success: true, data: { available: false } }))
  }
}

describe('mindmap format capabilities', () => {
  it('思维导图可编辑但不属于 Markdown 语义', () => {
    expect(isMindMapFormat('mindmap')).toBe(true)
    expect(isEditableTextFormat('mindmap')).toBe(true)
    expect(isEditableTextFormat('md')).toBe(false)
    expect(isEditableTextFormat('markdown')).toBe(true)
    expect(isEditableTextFormat('pdf')).toBe(false)
  })
})

describe('file store · 思维导图', () => {
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
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('新建思维导图生成可解析的 .inkmind 内容', async () => {
    const store = useFileStore()
    const ok = await store.newMindMap()

    expect(ok).toBe(true)
    expect(store.tabs).toHaveLength(1)
    expect(store.activeTab.fileInfo?.format).toBe('mindmap')
    expect(store.activeTab.fileInfo?.name).toBe(`未命名思维导图${MINDMAP_EXTENSION}`)
    // 新建未落盘：应视为未保存
    expect(store.isDirty).toBe(true)

    const parsed = parseMindMap(store.fileContent)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.schema).toBe(MINDMAP_FILE_SCHEMA)
    expect(parsed.document.root.text).toBe('中心主题')
  })

  it('字数统计只统计节点文字，不含 JSON 括号引号', async () => {
    const store = useFileStore()
    await store.newMindMap()
    // 「中心主题」4 个字：JSON 结构本身不计数
    expect(store.wordCount).toBe(4)
  })

  it('导图标签不允许切换 Markdown 编辑模式', async () => {
    const store = useFileStore()
    await store.newMindMap()
    expect(store.canSwitchEditorMode).toBe(false)
    expect(store.effectiveEditorMode).toBe('plain')
  })

  it('新建导图首次保存：另存为必须显式声明 mindmap 格式', async () => {
    const store = useFileStore()
    await store.newMindMap()
    // 新建标签没有路径，主进程只能靠 format 推断扩展名
    expect(store.activeTab.fileInfo?.path).toBe('')

    electronAPI.saveFile.mockResolvedValue({ success: false, error: 'NEW_FILE' })
    const saved = await store.saveFile()

    expect(saved).toBe(true)
    expect(electronAPI.saveAsFile).toHaveBeenCalledTimes(1)
    const args = electronAPI.saveAsFile.mock.calls[0]
    // 参数顺序：content, title, filePath, addToRecent, format
    expect(args[2]).toBeUndefined()
    expect(args[4]).toBe('mindmap')
    // 保存成功后标签格式不能被 .mdx 覆盖
    expect(store.activeTab.fileInfo?.format).toBe('mindmap')
  })

  it('打开 .inkmind 文件时按 mindmap 格式入栈并可保存', async () => {
    electronAPI.openFile.mockResolvedValue({
      success: true,
      data: {
        document: {
          metadata: { title: 'map', content_file: 'content.md' },
          content: '{"schema":"inkase.mindmap","version":1,"root":{"text":"根","children":[]}}'
        },
        filePath: 'C:/docs/map.inkmind',
        format: 'mindmap',
        isNew: false
      }
    })

    const store = useFileStore()
    const ok = await store.openFile('C:/docs/map.inkmind')

    expect(ok).toBe(true)
    expect(store.activeTab.fileInfo?.format).toBe('mindmap')
    expect(store.fileContent).toContain(MINDMAP_FILE_SCHEMA)

    const saved = await store.saveFile()
    expect(saved).toBe(true)
    expect(electronAPI.saveFile).toHaveBeenCalledTimes(1)
    expect(store.activeTab.fileInfo?.modified).toBe(false)
  })

  it('把当前笔记转成导图：新建标签、默认名带 .inkmind、原文档不变', async () => {
    electronAPI.openFile.mockResolvedValue({
      success: true,
      data: {
        document: {
          metadata: { title: 'note', content_file: 'content.md' },
          content: '# 项目\n## 目标\n- 上线\n- 预算'
        },
        filePath: 'C:/docs/note.md',
        isNew: false
      }
    })

    const store = useFileStore()
    await store.openFile('C:/docs/note.md')
    const originalContent = store.fileContent

    const created = store.convertActiveToMindMap()

    expect(created).not.toBeNull()
    // 新标签：未落盘、格式为 mindmap、名字取自原文件名
    expect(store.tabs).toHaveLength(2)
    expect(store.activeTab.fileInfo?.format).toBe('mindmap')
    expect(store.activeTab.fileInfo?.name).toBe('note 思维导图.inkmind')
    const parsed = parseMindMap(store.fileContent)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.root.text).toBe('note')
    expect(parsed.document.root.children.map((c) => c.text)).toEqual(['项目'])

    // 原 Markdown 标签内容保持不变
    const source = store.tabs.find((tab) => tab.fileInfo?.format !== 'mindmap')
    expect(source?.content).toBe(originalContent)
  })

  it('内容为空或当前就是导图时不转换', async () => {
    const store = useFileStore()
    await store.newMindMap()

    expect(store.convertActiveToMindMap()).toBeNull()
    expect(store.tabs).toHaveLength(1)
  })

  it('导出思维导图大纲：只写快照，标签仍指向原 .inkmind', async () => {
    electronAPI.openFile.mockResolvedValue({
      success: true,
      data: {
        document: {
          metadata: { title: 'map', content_file: 'content.md' },
          content: JSON.stringify({
            schema: 'inkase.mindmap',
            version: 1,
            root: {
              id: 'r',
              text: '项目规划',
              children: [{ id: 'c', text: '上线时间', children: [] }]
            }
          })
        },
        filePath: 'C:/docs/规划.inkmind',
        format: 'mindmap',
        isNew: false
      }
    })

    const store = useFileStore()
    await store.openFile('C:/docs/规划.inkmind')
    const before = { path: store.activeTab.fileInfo?.path, content: store.fileContent }

    const ok = await store.exportMindMapOutline()

    expect(ok).toBe(true)
    const args = electronAPI.saveAsFile.mock.calls[0]
    // 参数顺序：content, title, filePath, addToRecent, format
    expect(args[0]).toBe('项目规划\n  上线时间\n')
    expect(args[1]).toBe('规划 大纲')
    expect(args[2]).toBeUndefined()
    // 导出不该污染最近文件，也不能改存成 Markdown
    expect(args[3]).toBe(false)
    expect(args[4]).toBe('markdown')
    // 标签状态原样保留
    expect(store.activeTab.fileInfo?.path).toBe(before.path)
    expect(store.fileContent).toBe(before.content)
  })

  it('非导图标签调用导出大纲会被拒绝', async () => {
    const store = useFileStore()
    const ok = await store.exportMindMapOutline()

    expect(ok).toBe(false)
    expect(electronAPI.saveAsFile).not.toHaveBeenCalled()
  })
})

describe('file store · 思维导图图片导出', () => {
  let electronAPI: ReturnType<typeof createMockElectronAPI>

  const image = {
    format: 'png' as const,
    width: 640,
    height: 480,
    bytes: new Uint8Array([137, 80, 78, 71])
  }

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
  })

  afterEach(() => {
    resetMindMapImageBuilder()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('把构建器产出的字节交给主进程，并按文件名去掉扩展名', async () => {
    const store = useFileStore()
    await store.newMindMap()
    const builder = vi.fn(async () => image)
    registerMindMapImageBuilder(builder)

    const ok = await store.exportMindMapImage('png')

    expect(ok).toBe(true)
    expect(builder).toHaveBeenCalledWith('png')
    expect(electronAPI.exportMindMapImage).toHaveBeenCalledWith(
      '未命名思维导图',
      'png',
      image.bytes
    )
    // 导出是快照，不改标签状态
    expect(store.activeTab.fileInfo?.format).toBe('mindmap')
    expect(store.isLoading).toBe(false)
  })

  it('SVG 走同一条链路，只是格式不同', async () => {
    const store = useFileStore()
    await store.newMindMap()
    registerMindMapImageBuilder(async () => ({ ...image, format: 'svg' }))

    const ok = await store.exportMindMapImage('svg')

    expect(ok).toBe(true)
    expect(electronAPI.exportMindMapImage).toHaveBeenCalledWith(
      '未命名思维导图',
      'svg',
      image.bytes
    )
  })

  it('用户取消时不算失败，也不写错误提示', async () => {
    const store = useFileStore()
    await store.newMindMap()
    registerMindMapImageBuilder(async () => image)
    electronAPI.exportMindMapImage.mockResolvedValue({ success: false, error: '用户取消' })

    const ok = await store.exportMindMapImage('png')

    expect(ok).toBe(false)
    expect(store.error).toBeNull()
  })

  it('没有画布（未登记构建器）时提示稍后重试', async () => {
    const store = useFileStore()
    await store.newMindMap()

    const ok = await store.exportMindMapImage('png')

    expect(ok).toBe(false)
    expect(store.error).toBe('思维导图还没准备好，请稍后重试')
    expect(electronAPI.exportMindMapImage).not.toHaveBeenCalled()
  })

  it('非导图标签直接拒绝', async () => {
    const store = useFileStore()
    await store.newMindMap()
    // 模拟普通文档标签
    store.activeTab.fileInfo!.format = 'md'
    registerMindMapImageBuilder(async () => image)

    const ok = await store.exportMindMapImage('png')

    expect(ok).toBe(false)
    expect(store.error).toBe('只有思维导图可以导出为图片')
    expect(electronAPI.exportMindMapImage).not.toHaveBeenCalled()
  })

  it('构建器抛错时把原因写进 error', async () => {
    const store = useFileStore()
    await store.newMindMap()
    registerMindMapImageBuilder(async () => {
      throw new Error('画布还没有可导出的内容')
    })

    const ok = await store.exportMindMapImage('png')

    expect(ok).toBe(false)
    expect(store.error).toBe('画布还没有可导出的内容')
    expect(store.isLoading).toBe(false)
  })

  it('主进程报错时把错误原样带出来', async () => {
    const store = useFileStore()
    await store.newMindMap()
    registerMindMapImageBuilder(async () => image)
    electronAPI.exportMindMapImage.mockResolvedValue({ success: false, error: '磁盘已满' })

    const ok = await store.exportMindMapImage('png')

    expect(ok).toBe(false)
    expect(store.error).toBe('磁盘已满')
  })
})

describe('file store · 导图容器资源登记', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('window', { electronAPI: createMockElectronAPI() })
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
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('新插入的图片补进标签的资源表（打开时给出的表只含包内已有条目）', async () => {
    const store = useFileStore()
    await store.newMindMap()
    store.tabs[0].mindMapAssets = { 'assets/images/old.png': 'C:/tmp/old.png' }

    store.registerMindMapAsset(store.tabs[0].id, 'assets/images/hero.png', 'C:/tmp/hero.png')

    expect(store.tabs[0].mindMapAssets).toEqual({
      'assets/images/old.png': 'C:/tmp/old.png',
      'assets/images/hero.png': 'C:/tmp/hero.png'
    })
  })

  it('包内路径统一成 `/`，解析时才能查得到', async () => {
    const store = useFileStore()
    await store.newMindMap()

    store.registerMindMapAsset(store.tabs[0].id, 'assets\\images\\hero.png', 'C:/tmp/hero.png')

    expect(store.tabs[0].mindMapAssets).toEqual({
      'assets/images/hero.png': 'C:/tmp/hero.png'
    })
  })

  it('标签不存在或路径为空时什么都不做', async () => {
    const store = useFileStore()
    await store.newMindMap()

    store.registerMindMapAsset('tab_missing', 'assets/images/hero.png', 'C:/tmp/hero.png')
    store.registerMindMapAsset(store.tabs[0].id, '', 'C:/tmp/hero.png')

    expect(store.tabs[0].mindMapAssets).toBeUndefined()
  })
})
