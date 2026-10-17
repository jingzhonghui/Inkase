// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import SyncPanel from '../SyncPanel.vue'
import { useSyncStore } from '../../../stores/sync'

function createMockElectronAPI(overrides: Record<string, unknown> = {}) {
  return {
    syncAttachFolder: vi.fn(async () => ({ success: true, data: { status: 'upToDate', error: null, configured: true, isGitRepo: true, branch: 'main', upstream: 'origin/main' } })),
    syncDetachFolder: vi.fn(async () => ({ success: true })),
    getSyncStatus: vi.fn(async () => ({ success: true, data: { status: 'upToDate', error: null, configured: true, isGitRepo: true, branch: 'main', upstream: 'origin/main' } })),
    syncPull: vi.fn(async () => ({ success: true })),
    syncPush: vi.fn(async () => ({ success: true })),
    syncContinueRebase: vi.fn(async () => ({ success: true })),
    syncAbortRebase: vi.fn(async () => ({ success: true })),
    syncResolveConflicts: vi.fn(async () => ({ success: true })),
    enableSync: vi.fn(async () => ({ success: true })),
    disableSync: vi.fn(async () => ({ success: true })),
    getSyncConfig: vi.fn(async () => ({ success: true, data: { version: 1, provider: 'git', autoCommit: true, autoPull: true, autoPush: false } })),
    setSyncConfig: vi.fn(async (_patch: unknown) => ({ success: true, data: { version: 1, provider: 'git', autoCommit: true, autoPull: true, autoPush: false } })),
    onSyncEvent: vi.fn(() => () => {}),
    onSyncFileChanged: vi.fn(() => () => {}),
    readFolder: vi.fn(async () => ({ success: true, data: [] })),
    openFile: vi.fn(),
    showOpenDialog: vi.fn(async () => ({ success: true, data: ['C:/ws'] })),
    authorizeWorkspaceRoot: vi.fn(async () => ({ success: true })),
    getRecentFiles: vi.fn(async () => ({ success: true, data: [] })),
    addRecentFile: vi.fn(async () => ({ success: true })),
    listAiConversations: vi.fn(async () => ({ success: true, data: [] })),
    ...overrides
  }
}

describe('SyncPanel', () => {
  let pinia: Pinia
  let api: ReturnType<typeof createMockElectronAPI>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    api = createMockElectronAPI()
    vi.stubGlobal('electronAPI', api)
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('renders unconfigured guide when not configured', async () => {
    api.getSyncStatus.mockResolvedValue({ success: true, data: { status: 'uninitialized', error: null, configured: false, isGitRepo: true, branch: null, upstream: null } })
    const store = useSyncStore()
    await store.init()
    const { useFileStore } = await import('../../../stores/file')
    useFileStore().openedFolderPath = 'C:/ws'
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    expect(wrapper.text()).toContain('配置同步')
  })

  it('prompts to open a folder when no workspace folder is open', async () => {
    api.getSyncStatus.mockResolvedValue({ success: true, data: { status: 'uninitialized', error: null, configured: false, isGitRepo: false, branch: null, upstream: null } })
    const store = useSyncStore()
    await store.init()
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    expect(wrapper.text()).toContain('尚未打开工作区文件夹')
    expect(wrapper.find('[data-test="sync-open-folder"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('配置同步')
  })

  it('opens a folder from the sync panel', async () => {
    api.getSyncStatus.mockResolvedValue({ success: true, data: { status: 'uninitialized', error: null, configured: false, isGitRepo: false, branch: null, upstream: null } })
    const store = useSyncStore()
    await store.init()
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    const openBtn = wrapper.find('[data-test="sync-open-folder"]')
    await openBtn.trigger('click')
    await vi.waitFor(() => expect(api.showOpenDialog).toHaveBeenCalled())
    await vi.waitFor(() => expect(wrapper.text()).toContain('配置同步'))
  })

  it('calls enableSync with remote url and toggles', async () => {
    api.getSyncStatus.mockResolvedValue({ success: true, data: { status: 'uninitialized', error: null, configured: false, isGitRepo: false, branch: null, upstream: null } })
    const store = useSyncStore()
    await store.init()
    const { useFileStore } = await import('../../../stores/file')
    useFileStore().openedFolderPath = 'C:/ws'
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    const configBtn = wrapper.findAll('button').find((b) => b.text().includes('配置同步'))!
    await configBtn.trigger('click')
    const input = wrapper.find('input[placeholder="远程仓库地址（可选）"]')
    await input.setValue('https://example.com/repo.git')
    const enableBtn = wrapper.findAll('button').find((b) => b.text().includes('启用同步'))!
    await enableBtn.trigger('click')
    await vi.waitFor(() => expect(api.enableSync).toHaveBeenCalled())
    expect(api.enableSync).toHaveBeenCalledWith('C:/ws', expect.objectContaining({ remoteUrl: 'https://example.com/repo.git' }))
  })

  it('renders pull/push buttons and toggles when configured', async () => {
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    expect(wrapper.text()).toContain('拉取')
    expect(wrapper.text()).toContain('推送')
  })

  it('surfaces action error when pull fails', async () => {
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    api.syncPull.mockResolvedValueOnce({ success: false, error: '拉取失败测试' })
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    const pullBtn = wrapper.findAll('button').find((b) => b.text().includes('拉取'))!
    await pullBtn.trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-test="sync-action-error"]').exists()).toBe(true))
    expect(wrapper.find('[data-test="sync-action-error"]').text()).toBe('拉取失败测试')
  })

  it('clears action error on panel close', async () => {
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    api.syncPull.mockResolvedValueOnce({ success: false, error: '拉取失败测试' })
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    const pullBtn = wrapper.findAll('button').find((b) => b.text().includes('拉取'))!
    await pullBtn.trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-test="sync-action-error"]').exists()).toBe(true))
    const closeBtn = wrapper.find('.sync-panel-close')
    await closeBtn.trigger('click')
    expect(wrapper.find('[data-test="sync-action-error"]').exists()).toBe(false)
  })

  it('renders conflict files and continue/abort buttons when in conflict', async () => {
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: null,
        upstream: null,
        conflictedFiles: ['C:/ws/docs/a.md'],
        inRebase: true
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    const { useFileStore } = await import('../../../stores/file')
    useFileStore().openedFolderPath = 'C:/ws'
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    expect(wrapper.find('[data-test="conflict-files"]').text()).toContain('docs/a.md')
    expect(wrapper.text()).toContain('继续')
    expect(wrapper.text()).toContain('中止')
    expect(wrapper.text()).toContain('删除冲突标记行')
    expect(wrapper.findAll('button').find((b) => b.text().includes('拉取'))).toBeUndefined()
    expect(wrapper.findAll('button').find((b) => b.text().includes('推送'))).toBeUndefined()
  })

  it('calls syncContinueRebase when continue clicked', async () => {
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: null,
        upstream: null,
        conflictedFiles: ['C:/ws/docs/a.md'],
        inRebase: true
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    const continueBtn = wrapper.findAll('button').find((b) => b.text().includes('继续'))!
    await continueBtn.trigger('click')
    await vi.waitFor(() => expect(api.syncContinueRebase).toHaveBeenCalled())
  })

  it('calls syncAbortRebase when abort clicked', async () => {
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: null,
        upstream: null,
        conflictedFiles: ['C:/ws/docs/a.md'],
        inRebase: true
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    const abortBtn = wrapper.findAll('button').find((b) => b.text().includes('中止'))!
    await abortBtn.trigger('click')
    await vi.waitFor(() => expect(api.syncAbortRebase).toHaveBeenCalled())
  })

  it('renders a provider selector and expands the webdav form when webdav is selected', async () => {
    api.getSyncStatus.mockResolvedValue({ success: true, data: { status: 'uninitialized', error: null, configured: false, isGitRepo: false, branch: null, upstream: null } })
    const store = useSyncStore()
    await store.init()
    const { useFileStore } = await import('../../../stores/file')
    useFileStore().openedFolderPath = 'C:/ws'
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    const configBtn = wrapper.findAll('button').find((b) => b.text().includes('配置同步'))!
    await configBtn.trigger('click')

    const radios = wrapper.findAll('input[type="radio"]')
    expect(radios.length).toBe(2)
    expect(wrapper.find('input[placeholder="远程仓库地址（可选）"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="webdav-url"]').exists()).toBe(false)

    await radios[1].setValue()

    expect(wrapper.find('[data-test="webdav-url"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="webdav-username"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="webdav-password"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="webdav-password"]').attributes('type')).toBe('password')
    expect(wrapper.find('[data-test="webdav-remote-root"]').exists()).toBe(true)
    expect(wrapper.find('input[placeholder="远程仓库地址（可选）"]').exists()).toBe(false)
  })

  it('toggles the webdav password visibility with an eye button', async () => {
    api.getSyncStatus.mockResolvedValue({ success: true, data: { status: 'uninitialized', error: null, configured: false, isGitRepo: false, branch: null, upstream: null } })
    const store = useSyncStore()
    await store.init()
    const { useFileStore } = await import('../../../stores/file')
    useFileStore().openedFolderPath = 'C:/ws'
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    const configBtn = wrapper.findAll('button').find((b) => b.text().includes('配置同步'))!
    await configBtn.trigger('click')
    await wrapper.findAll('input[type="radio"]')[1].setValue()

    const passwordInput = () => wrapper.find('[data-test="webdav-password"]')
    const toggle = () => wrapper.find('[data-test="webdav-password-toggle"]')

    expect(toggle().exists()).toBe(true)
    expect(toggle().attributes('aria-label')).toBe('显示密码')
    expect(passwordInput().attributes('type')).toBe('password')

    await toggle().trigger('click')
    expect(passwordInput().attributes('type')).toBe('text')
    expect(toggle().attributes('aria-label')).toBe('隐藏密码')

    await toggle().trigger('click')
    expect(passwordInput().attributes('type')).toBe('password')
    expect(toggle().attributes('aria-label')).toBe('显示密码')
  })

  it('keeps the git remote url input and git init hint when git is selected', async () => {
    api.getSyncStatus.mockResolvedValue({ success: true, data: { status: 'uninitialized', error: null, configured: false, isGitRepo: false, branch: null, upstream: null } })
    const store = useSyncStore()
    await store.init()
    const { useFileStore } = await import('../../../stores/file')
    useFileStore().openedFolderPath = 'C:/ws'
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })
    const configBtn = wrapper.findAll('button').find((b) => b.text().includes('配置同步'))!
    await configBtn.trigger('click')

    expect(wrapper.find('input[placeholder="远程仓库地址（可选）"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('将自动执行 git init')
    expect(wrapper.find('[data-test="webdav-url"]').exists()).toBe(false)
  })

  it('shows a provider-neutral hint before the provider is chosen', async () => {
    api.getSyncStatus.mockResolvedValue({ success: true, data: { status: 'uninitialized', error: null, configured: false, isGitRepo: false, branch: null, upstream: null } })
    const store = useSyncStore()
    await store.init()
    const { useFileStore } = await import('../../../stores/file')
    useFileStore().openedFolderPath = 'C:/ws'
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('配置同步')
    expect(wrapper.text()).toContain('选择同步方式')
    expect(wrapper.text()).not.toContain('git init')
  })

  it('adapts the configured panel when the provider is webdav', async () => {
    api.getSyncStatus.mockResolvedValue({ success: true, data: { status: 'upToDate', error: null, configured: true, isGitRepo: false, branch: 'main', upstream: null, provider: 'webdav' } })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })

    expect(wrapper.find('.sync-panel-branch').exists()).toBe(false)
    expect(wrapper.text()).toContain('自动上传本地变更')
    expect(wrapper.text()).not.toContain('自动提交本地变更')
    expect(wrapper.text()).not.toContain('自动推送')
  })

  async function mountWebdavConflict(files = ['C:/ws/docs/a.md', 'C:/ws/docs/b.md']) {
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        error: null,
        configured: true,
        isGitRepo: false,
        branch: null,
        upstream: null,
        provider: 'webdav',
        conflictedFiles: files,
        inRebase: false
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    const { useFileStore } = await import('../../../stores/file')
    useFileStore().openedFolderPath = 'C:/ws'
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia], stubs: { teleport: true } } })
    return { store, wrapper }
  }

  it('shows a conflict dialog for webdav conflicts instead of an inline list', async () => {
    const { store, wrapper } = await mountWebdavConflict()
    const resolveSpy = vi.spyOn(store, 'resolveConflicts')

    // 面板内不再内联列出冲突文件，也不再给 git 的 rebase 引导
    expect(wrapper.find('[data-test="conflict-files"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('删除冲突标记行')

    // 弹窗列出全部冲突文件
    const dialogFiles = wrapper.get('[data-test="conflict-dialog-files"]')
    expect(dialogFiles.text()).toContain('docs/a.md')
    expect(dialogFiles.text()).toContain('docs/b.md')

    await wrapper.findAll('[data-test="conflict-keep-local"]')[1].trigger('click')
    await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalledWith([{ path: 'C:/ws/docs/b.md', choice: 'local' }]))

    await wrapper.findAll('[data-test="conflict-take-remote"]')[0].trigger('click')
    await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalledWith([{ path: 'C:/ws/docs/a.md', choice: 'remote' }]))
  })

  it('resolves every webdav conflict at once from the dialog', async () => {
    const { store, wrapper } = await mountWebdavConflict()
    const resolveSpy = vi.spyOn(store, 'resolveConflicts')

    await wrapper.get('[data-test="conflict-resolve-all-remote"]').trigger('click')

    await vi.waitFor(() =>
      expect(resolveSpy).toHaveBeenCalledWith([
        { path: 'C:/ws/docs/a.md', choice: 'remote' },
        { path: 'C:/ws/docs/b.md', choice: 'remote' }
      ])
    )
  })

  it('collapses the conflict dialog and reopens it from the panel entry', async () => {
    const { wrapper } = await mountWebdavConflict()

    expect(wrapper.find('[data-test="conflict-dialog"]').exists()).toBe(true)

    await wrapper.get('[data-test="conflict-dialog-close"]').trigger('click')
    expect(wrapper.find('[data-test="conflict-dialog"]').exists()).toBe(false)

    const entry = wrapper.get('[data-test="open-conflict-dialog"]')
    expect(entry.text()).toContain('处理冲突')
    await entry.trigger('click')
    expect(wrapper.find('[data-test="conflict-dialog"]').exists()).toBe(true)
  })

  it('does not reopen the conflict dialog for a refresh within the same conflict episode', async () => {
    const { store, wrapper } = await mountWebdavConflict()

    await wrapper.get('[data-test="conflict-dialog-close"]').trigger('click')
    expect(wrapper.find('[data-test="conflict-dialog"]').exists()).toBe(false)

    await store.refresh()
    await nextTick()
    expect(wrapper.find('[data-test="conflict-dialog"]').exists()).toBe(false)
  })

  it('keeps continue/abort for git conflicts', async () => {
    api.getSyncStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        error: null,
        configured: true,
        isGitRepo: true,
        branch: null,
        upstream: null,
        provider: 'git',
        conflictedFiles: ['C:/ws/docs/a.md'],
        inRebase: true
      }
    })
    const store = useSyncStore()
    await store.init()
    await store.refresh()
    const { useFileStore } = await import('../../../stores/file')
    useFileStore().openedFolderPath = 'C:/ws'
    const wrapper = mount(SyncPanel, { global: { plugins: [pinia] } })

    expect(wrapper.findAll('button').find((b) => b.text().includes('继续'))).toBeDefined()
    expect(wrapper.findAll('button').find((b) => b.text().includes('中止'))).toBeDefined()
    expect(wrapper.find('[data-test="resolve-keep-local"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('删除冲突标记行')
  })
})
