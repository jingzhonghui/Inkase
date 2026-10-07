import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-conv-'))
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-ws-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

import { ConversationStore } from '../conversation-store'
import type { ConversationRecord } from '../../../shared/ai/types'

function makeRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    version: 1,
    id: 'conv_test',
    title: '测试会话',
    createdAt: 1000,
    updatedAt: 2000,
    messageCount: 1,
    messages: [{ id: 'm1', role: 'user', content: '你好', createdAt: 1000 }],
    toolSummaries: [],
    ...overrides
  }
}

describe('ConversationStore', () => {
  const store = new ConversationStore()

  beforeEach(() => {
    fs.rmSync(path.join(userData, 'conversations'), { recursive: true, force: true })
    fs.rmSync(path.join(workspace, '.inkase'), { recursive: true, force: true })
  })

  it('resolves the userData directory when root is null', () => {
    expect(store.resolveConversationsDir(null)).toBe(path.join(userData, 'conversations'))
  })

  it('resolves the workspace directory when root is given', () => {
    expect(store.resolveConversationsDir(workspace)).toBe(
      path.join(workspace, '.inkase', 'conversations')
    )
  })

  it('lists conversations sorted by updatedAt descending', () => {
    store.saveConversation(null, makeRecord({ id: 'conv_a', updatedAt: 1000, title: 'A' }))
    store.saveConversation(null, makeRecord({ id: 'conv_b', updatedAt: 3000, title: 'B' }))

    const list = store.listConversations(null)
    expect(list.map((c) => c.id)).toEqual(['conv_b', 'conv_a'])
    expect(list[0]).toMatchObject({ id: 'conv_b', title: 'B', messageCount: 1 })
  })

  it('recomputes messageCount from messages on save', () => {
    store.saveConversation(null, makeRecord({ messageCount: 99 }))
    const loaded = store.loadConversation(null, 'conv_test')
    expect(loaded.messageCount).toBe(1)
  })

  it('loads a saved conversation', () => {
    store.saveConversation(null, makeRecord())
    const loaded = store.loadConversation(null, 'conv_test')
    expect(loaded).toMatchObject({ id: 'conv_test', title: '测试会话' })
    expect(loaded.messages[0].content).toBe('你好')
  })

  it('skips corrupt files in listConversations', () => {
    const dir = store.resolveConversationsDir(null)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'conv_bad.json'), 'not json', 'utf8')
    store.saveConversation(null, makeRecord({ id: 'conv_good' }))

    const list = store.listConversations(null)
    expect(list.map((c) => c.id)).toEqual(['conv_good'])
  })

  it('returns an empty list when the directory is missing', () => {
    expect(store.listConversations(null)).toEqual([])
  })

  it('loadConversation throws for a missing or invalid id', () => {
    expect(() => store.loadConversation(null, 'conv_missing')).toThrow()
    expect(() => store.loadConversation(null, '../../evil')).toThrow()
  })

  it('deleteConversation removes the file', () => {
    store.saveConversation(null, makeRecord())
    store.deleteConversation(null, 'conv_test')
    expect(store.listConversations(null)).toEqual([])
  })
})
