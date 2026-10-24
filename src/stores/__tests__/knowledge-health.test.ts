// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useKnowledgeStore } from '../knowledge'
import type { KnowledgeHealth } from '../../../shared/knowledge/types'

function report(): KnowledgeHealth {
  return {
    counts: { isolated: 1, broken: 2, duplicateTitles: 3, unlinkedMentions: 4 },
    isolated: ['lonely.md'],
    broken: [],
    duplicates: [{ title: '同名', paths: ['a.md', 'b.md'] }],
    unlinked: [],
    truncated: false
  }
}

describe('knowledge health store', () => {
  const original = window.electronAPI

  beforeEach(() => {
    setActivePinia(createPinia())
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      onKnowledgeProgress: () => () => {},
      getKnowledgeHealth: vi.fn().mockResolvedValue({ success: true, data: report() })
    }
  })

  afterEach(() => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = original
  })

  it('loads the health report and marks it available', async () => {
    const store = useKnowledgeStore()

    await store.loadHealth()

    expect(store.healthLoaded).toBe(true)
    expect(store.health.counts).toEqual({
      isolated: 1,
      broken: 2,
      duplicateTitles: 3,
      unlinkedMentions: 4
    })
    expect(store.health.duplicates[0].title).toBe('同名')
  })

  it('keeps the fallback state when the bridge is missing', async () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = undefined
    const store = useKnowledgeStore()

    await store.loadHealth()

    expect(store.healthLoaded).toBe(false)
    expect(store.health.counts).toEqual({
      isolated: 0,
      broken: 0,
      duplicateTitles: 0,
      unlinkedMentions: 0
    })
  })
})
