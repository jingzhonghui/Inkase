import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { createMdxDocument } from '../../types/mdx'
import { createExternalWatch } from '../file/external-watch'
import type { TabInfo } from '../file/types'
import { requestDialog } from '../../utils/dialog'

vi.mock('../../utils/dialog', () => ({
  dialogState: { visible: false, title: '', message: '', detail: '', buttons: [] },
  requestDialog: vi.fn(async () => 0),
  resolveDialogRequest: vi.fn()
}))

function makeTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: `tab_${Math.random().toString(36).slice(2)}`,
    fileInfo: null,
    document: null,
    content: '',
    revision: 0,
    ...overrides
  }
}

function makeMdTab(path: string, { dirty = false, name = 'doc.md' } = {}): TabInfo {
  return makeTab({
    fileInfo: { path, name, modified: dirty, format: 'markdown' },
    document: createMdxDocument('doc', ''),
    content: ''
  })
}

function makeMediaTab(path: string, name: string, format: 'pdf' | 'image'): TabInfo {
  return makeTab({
    fileInfo: { path, name, modified: false, format },
    document: createMdxDocument(name, ''),
    pdfBase64: format === 'pdf' ? 'xxx' : undefined
  })
}

function makeDeps(tabs: TabInfo[], openedFolderPath: string | null = null) {
  return {
    tabs: ref(tabs),
    openedFolderPath: ref(openedFolderPath),
    readFolder: vi.fn(async () => true),
    reloadFile: vi.fn(async () => true),
    isTabDirty: (tab: TabInfo) => !!tab.document && ((tab.fileInfo?.modified ?? false) || !tab.fileInfo?.path)
  }
}

function stubElectronAPI(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    onExternalFileChanged: vi.fn(() => () => undefined),
    watchExternalChanges: vi.fn(async () => ({ success: true })),
    ...overrides
  }
  vi.stubGlobal('window', { electronAPI: api })
  return api
}

describe('createExternalWatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('setup 立即上报当前监视范围（根目录 + 根外独立文件）', () => {
    const api = stubElectronAPI()
    const deps = makeDeps([makeMdTab('C:/ws/a.md', { name: 'a.md' }), makeMdTab('C:/standalone/b.md')], 'C:/ws')
    createExternalWatch(deps).setup()

    expect(api.watchExternalChanges).toHaveBeenCalledTimes(1)
    expect(api.watchExternalChanges).toHaveBeenCalledWith('C:/ws', ['C:/standalone/b.md'])
  })

  it('根内文件不计入独立文件列表，切换根目录后重新上报', async () => {
    const api = stubElectronAPI()
    const deps = makeDeps([makeMdTab('C:/ws/a.md')], null)
    createExternalWatch(deps).setup()

    expect(api.watchExternalChanges).toHaveBeenLastCalledWith(null, ['C:/ws/a.md'])
    deps.openedFolderPath.value = 'C:/ws'
    await nextTick()
    expect(api.watchExternalChanges).toHaveBeenLastCalledWith('C:/ws', [])
  })

  it('根目录内的变更触发文件树刷新，干净标签直接重载', async () => {
    stubElectronAPI()
    const deps = makeDeps([makeMdTab('C:/ws/a.md')], 'C:/ws')
    await createExternalWatch(deps).handleExternalChanges(['C:/ws/a.md', 'C:/ws/new-folder/x.md'])

    expect(deps.readFolder).toHaveBeenCalledWith('C:/ws')
    expect(deps.reloadFile).toHaveBeenCalledWith('C:/ws/a.md')
    expect(requestDialog).not.toHaveBeenCalled()
  })

  it('脏标签弹窗确认：保留本地不重载，重新加载才重载', async () => {
    stubElectronAPI()
    const deps = makeDeps(
      [makeMdTab('C:/ws/a.md', { dirty: true }), makeMdTab('C:/ws/b.md', { dirty: true, name: 'b.md' })],
      'C:/ws'
    )
    const watch = createExternalWatch(deps)

    vi.mocked(requestDialog).mockResolvedValueOnce(0)
    await watch.handleExternalChanges(['C:/ws/a.md'])
    expect(requestDialog).toHaveBeenCalledTimes(1)
    expect(deps.reloadFile).not.toHaveBeenCalled()

    vi.mocked(requestDialog).mockResolvedValueOnce(1)
    await watch.handleExternalChanges(['C:/ws/b.md'])
    expect(deps.reloadFile).toHaveBeenCalledWith('C:/ws/b.md')
  })

  it('只读媒体（PDF/图片）与非打开文件不触发重载，但树仍刷新', async () => {
    stubElectronAPI()
    const deps = makeDeps([makeMediaTab('C:/ws/doc.pdf', 'doc.pdf', 'pdf')], 'C:/ws')
    await createExternalWatch(deps).handleExternalChanges(['C:/ws/doc.pdf', 'C:/ws/not-opened.md'])

    expect(deps.readFolder).toHaveBeenCalledWith('C:/ws')
    expect(deps.reloadFile).not.toHaveBeenCalled()
    expect(requestDialog).not.toHaveBeenCalled()
  })

  it('markExternalHandled 在窗口期内跳过重复处理', async () => {
    stubElectronAPI()
    const deps = makeDeps([makeMdTab('C:/ws/a.md')], 'C:/ws')
    const watch = createExternalWatch(deps)
    watch.markExternalHandled('C:/ws/a.md')

    await watch.handleExternalChanges(['C:/ws/a.md'])
    expect(deps.reloadFile).not.toHaveBeenCalled()
  })

  it('reloadFile 记录处理状态，窗口期内第二批事件不重复重载', async () => {
    stubElectronAPI()
    const deps = makeDeps([makeMdTab('C:/ws/a.md')], 'C:/ws')
    const watch = createExternalWatch(deps)
    // 模拟 sync 流程已通过 markExternalHandled 记录（reloadFile 内部同样记录）
    deps.reloadFile.mockImplementation(async (filePath: string) => {
      watch.markExternalHandled(filePath)
      return true
    })
    await watch.handleExternalChanges(['C:/ws/a.md'])
    await watch.handleExternalChanges(['C:/ws/a.md'])
    // 树刷新不受去重影响
    expect(deps.readFolder).toHaveBeenCalledTimes(2)
    expect(deps.reloadFile).toHaveBeenCalledTimes(1)
  })

  it('queueExternalChanges 合并短时间内的多批事件并防抖处理', async () => {
    vi.useFakeTimers()
    try {
      stubElectronAPI()
      const deps = makeDeps([makeMdTab('C:/ws/a.md')], 'C:/ws')
      const watch = createExternalWatch(deps)

      watch.queueExternalChanges(['C:/ws/a.md'])
      watch.queueExternalChanges(['C:/ws/b.md'])
      await vi.advanceTimersByTimeAsync(300)

      expect(deps.reloadFile).toHaveBeenCalledTimes(1)
      expect(deps.reloadFile).toHaveBeenCalledWith('C:/ws/a.md')
    } finally {
      vi.useRealTimers()
    }
  })

  it('onExternalFileChanged 收到事件后经防抖处理', async () => {
    vi.useFakeTimers()
    try {
      let listener: ((files: string[]) => void) | undefined
      const api = stubElectronAPI({
        onExternalFileChanged: vi.fn((cb: (files: string[]) => void) => {
          listener = cb
          return () => undefined
        })
      })
      const deps = makeDeps([makeMdTab('C:/ws/a.md')], 'C:/ws')
      createExternalWatch(deps).setup()

      expect(api.onExternalFileChanged).toHaveBeenCalledTimes(1)
      listener?.(['C:/ws/a.md'])
      await vi.advanceTimersByTimeAsync(300)

      expect(deps.reloadFile).toHaveBeenCalledTimes(1)
      expect(deps.reloadFile).toHaveBeenCalledWith('C:/ws/a.md')
    } finally {
      vi.useRealTimers()
    }
  })
})
