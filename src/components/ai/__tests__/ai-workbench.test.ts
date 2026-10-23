// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import AiWorkbench from '../AiWorkbench.vue'
import { useAiStore } from '../../../stores/ai'
import { useDockStore } from '../../../stores/dock'
import { useFileStore } from '../../../stores/file'
import { useKnowledgeStore } from '../../../stores/knowledge'
import type { LinkRef } from '../../../../shared/knowledge/types'

function brokenRef(overrides: Partial<LinkRef> = {}): LinkRef {
  return {
    from: 'notes/a.md',
    raw: '[[不存在的笔记]]',
    kind: 'link',
    line: 3,
    column: 1,
    status: 'missing',
    ...overrides
  }
}

function mountWorkbench(ready = true) {
  return mount(AiWorkbench, { props: { ready }, attachTo: document.body })
}

describe('AI workbench', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    const fileStore = useFileStore()
    fileStore.openedFolderPath = 'E:/vault'
    const knowledge = useKnowledgeStore()
    knowledge.overview = {
      noteCount: 12,
      tagCount: 4,
      isolatedCount: 2,
      brokenCount: 1,
      recent: [{ path: 'notes/a.md', mtime: Date.now() - 120_000 }]
    }
    knowledge.unresolved = [brokenRef()]
  })

  it('renders the one-line vault status and recent notes', () => {
    const wrapper = mountWorkbench()

    expect(wrapper.get('[data-testid="vault-status"]').text()).toContain('笔记 12')
    expect(wrapper.get('[data-testid="vault-status"]').text()).toContain('标签 4')
    expect(wrapper.get('[data-testid="vault-status"]').text()).toContain('孤立 2')
    expect(wrapper.get('[data-testid="vault-status"]').text()).toContain('断链 1')

    const recent = wrapper.get('[data-testid="recent-note"]')
    expect(recent.text()).toContain('a')
    expect(recent.text()).toContain('notes')
  })

  it('derives quick actions from vault health', () => {
    const wrapper = mountWorkbench()

    expect(wrapper.find('[data-testid="workbench-action-orphans"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workbench-action-broken"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workbench-action-recent"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workbench-action-new"]').exists()).toBe(true)
  })

  it('hides problem actions when the vault has none', () => {
    const knowledge = useKnowledgeStore()
    knowledge.overview = {
      noteCount: 1,
      tagCount: 0,
      isolatedCount: 0,
      brokenCount: 0,
      recent: []
    }
    const wrapper = mountWorkbench()

    expect(wrapper.find('[data-testid="workbench-action-orphans"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workbench-action-broken"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workbench-action-recent"]').exists()).toBe(true)
  })

  it('opens a recent note through the file store', async () => {
    const fileStore = useFileStore()
    const openFile = vi.spyOn(fileStore, 'openFile').mockResolvedValue(true)
    const wrapper = mountWorkbench()

    await wrapper.get('[data-testid="recent-note"]').trigger('click')

    expect(openFile).toHaveBeenCalledWith('E:/vault/notes/a.md', { addToRecent: false })
  })

  it('inspects isolated notes by opening the global graph with the orphan filter', async () => {
    const knowledge = useKnowledgeStore()
    const wrapper = mountWorkbench()

    await wrapper.get('[data-testid="status-isolated"]').trigger('click')

    expect(knowledge.graphFilters.orphans).toBe('only')
    expect(knowledge.graphTabActive).toBe(true)
  })

  it('lists broken links and reveals the source line on click', async () => {
    const fileStore = useFileStore()
    const openFile = vi.spyOn(fileStore, 'openFile').mockResolvedValue(true)
    const reveal = vi.spyOn(fileStore, 'requestReveal')
    const wrapper = mountWorkbench()

    await wrapper.get('[data-testid="status-broken"]').trigger('click')
    expect(wrapper.get('[data-testid="broken-list"]').text()).toContain('[[不存在的笔记]]')

    await wrapper.get('.broken-item').trigger('click')
    expect(openFile).toHaveBeenCalledWith('E:/vault/notes/a.md', { addToRecent: false })
    expect(reveal).toHaveBeenCalledWith('E:/vault/notes/a.md', 3, 1)
  })

  it('sends from the big composer and opens the AI dock', async () => {
    const aiStore = useAiStore()
    const dock = useDockStore()
    const send = vi.spyOn(aiStore, 'sendMessage').mockResolvedValue(undefined)
    const show = vi.spyOn(dock, 'show')
    const wrapper = mountWorkbench()

    await wrapper.get('textarea').setValue('总结这个库')
    await wrapper.get('form').trigger('submit')

    expect(show).toHaveBeenCalledWith('ai')
    expect(send).toHaveBeenCalledWith('总结这个库')
  })

  it('routes AI actions to settings when the provider is not configured', async () => {
    const aiStore = useAiStore()
    const send = vi.spyOn(aiStore, 'sendMessage').mockResolvedValue(undefined)
    const wrapper = mountWorkbench(false)

    await wrapper.get('[data-testid="workbench-action-recent"]').trigger('click')

    expect(send).not.toHaveBeenCalled()
    expect(wrapper.emitted('openSettings')).toHaveLength(1)
  })
})
