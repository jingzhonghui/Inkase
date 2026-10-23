import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiStore } from '../ai'
import { useFileStore } from '../file'

function mockApp() {
  setActivePinia(createPinia())
  const electronApi = {
    listAiConversations: vi.fn(async () => ({ success: true, data: [] })),
    loadAiConversation: vi.fn(),
    saveAiConversation: vi.fn(async () => ({ success: true })),
    deleteAiConversation: vi.fn(async () => ({ success: true })),
    summarizeAiConversation: vi.fn(),
    startAiRun: vi.fn(),
    cancelAiRun: vi.fn(),
    claimAiApproval: vi.fn(),
    resolveAiApproval: vi.fn(),
    getAiConfig: vi.fn(),
    onAiRunEvent: vi.fn(() => () => undefined),
    readFolder: vi.fn(async () => ({ success: true, data: [] })),
    authorizeWorkspaceRoot: vi.fn(async () => ({ success: true })),
    openFile: vi.fn(async () => ({ success: true })),
    getRecentFiles: vi.fn(async () => ({ success: true, data: [] }))
  }
  vi.stubGlobal('window', { electronAPI: electronApi })
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn()
  })
  return { electronApi }
}

describe('ai conversation workspace integration', () => {
  it('loads conversations with the workspace root after restoreSession with a folder', async () => {
    const { electronApi } = mockApp()
    electronApi.listAiConversations.mockResolvedValue({
      success: true,
      data: [{ id: 'conv_a', title: 'A', createdAt: 1, updatedAt: 2, messageCount: 1 }]
    })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => JSON.stringify({ openedFolderPath: 'C:\\ws' })),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    const fileStore = useFileStore()

    await fileStore.restoreSession()

    expect(electronApi.listAiConversations).toHaveBeenCalledWith('C:\\ws')
    expect(useAiStore().storageRoot).toBe('C:\\ws')
  })

  it('loads conversations with null root when no folder is open', async () => {
    const { electronApi } = mockApp()
    const fileStore = useFileStore()

    await fileStore.restoreSession()

    expect(electronApi.listAiConversations).toHaveBeenCalledWith(null)
  })

  it('ignores legacy AI panel fields and leaves the dock to its own store', async () => {
    const { electronApi } = mockApp()
    electronApi.openFile.mockResolvedValue({
      success: true,
      data: {
        document: { version: 1, title: 'x', content: 'hi', assets: { images: [] }, settings: {} },
        filePath: 'C:\\ws\\a.md',
        format: 'markdown'
      }
    })
    // 旧会话里还有 aiPanelOpen / aiPanelActive，恢复时必须能忽略而不报错
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => JSON.stringify({
        aiPanelOpen: true,
        aiPanelActive: true,
        openFilePaths: ['C:\\ws\\a.md'],
        activeFilePath: 'C:\\ws\\a.md'
      })),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    const fileStore = useFileStore()

    await fileStore.restoreSession()

    // AI store 不再持有面板状态，旧字段被安全丢弃
    expect(useAiStore()).not.toHaveProperty('panelOpen')
    expect(useAiStore()).not.toHaveProperty('panelActive')
    expect(fileStore.activeTab?.fileInfo?.path).toBe('C:\\ws\\a.md')
  })
})
