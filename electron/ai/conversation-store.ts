import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import type { ConversationMeta, ConversationRecord } from '../../shared/ai/types'

const CONVERSATIONS_SUBDIR = path.join('.inkase', 'conversations')
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_]+$/

export class ConversationStore {
  resolveConversationsDir(root: string | null): string {
    if (root && root.length > 0) {
      return path.join(root, CONVERSATIONS_SUBDIR)
    }
    return path.join(app.getPath('userData'), 'conversations')
  }

  listConversations(root: string | null): ConversationMeta[] {
    const dir = this.resolveConversationsDir(root)
    if (!fs.existsSync(dir)) return []
    const metas: ConversationMeta[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.replace(/\.json$/, '')
      if (!CONVERSATION_ID_PATTERN.test(id)) continue
      try {
        const record = this.readRecord(dir, entry.name)
        metas.push(this.toMeta(record))
      } catch {
        // 损坏文件跳过
      }
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt)
    return metas
  }

  loadConversation(root: string | null, id: string): ConversationRecord {
    this.assertValidId(id)
    const dir = this.resolveConversationsDir(root)
    return this.readRecord(dir, `${id}.json`)
  }

  saveConversation(root: string | null, record: ConversationRecord): void {
    this.assertValidId(record.id)
    const dir = this.resolveConversationsDir(root)
    fs.mkdirSync(dir, { recursive: true })
    const normalized: ConversationRecord = {
      ...record,
      version: 1,
      messageCount: record.messages.length,
      updatedAt: record.updatedAt || Date.now()
    }
    const target = path.join(dir, `${record.id}.json`)
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8')
    fs.renameSync(tmp, target)
  }

  deleteConversation(root: string | null, id: string): void {
    this.assertValidId(id)
    const target = path.join(this.resolveConversationsDir(root), `${id}.json`)
    fs.rmSync(target, { force: true })
  }

  private assertValidId(id: string): void {
    if (!CONVERSATION_ID_PATTERN.test(id)) {
      throw new Error('无效的会话 ID')
    }
  }

  private readRecord(dir: string, filename: string): ConversationRecord {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8')) as ConversationRecord
    if (parsed.version !== 1 || !Array.isArray(parsed.messages)) {
      throw new Error('会话文件格式无效')
    }
    return parsed
  }

  private toMeta(record: ConversationRecord): ConversationMeta {
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messages.length
    }
  }
}
