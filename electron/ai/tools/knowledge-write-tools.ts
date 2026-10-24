/**
 * 知识库批量写入工具
 *
 * 三个工具共用一条「先出清单、一次批准、再落盘」的链路：
 * - 预览阶段在内存里算出每个文件修改前后的内容与 diff；
 * - 批准后重新校验文件未被改动，写前快照，再逐文件写入；
 * - 任一步失败会回滚本次已写入的文件，快照仍保留供手动回滚。
 *
 * 与只读工具一致：工作区根来自 `context.snapshot.workspaceRoot`，
 * 所有相对路径经 `vault-io` 做 `resolveRelPath` + `realpath` 边界校验。
 */

import * as path from 'node:path'
import { diffLines } from 'diff'
import { z } from 'zod'
import type { ApprovalPreview } from '../../../shared/ai/types'
import type { SnapshotFileInput } from '../../../shared/ai/snapshots'
import { parseInlineTags } from '../../knowledge/index-service'
import { parseFrontmatter, readList, setFrontmatterField } from '../../knowledge/frontmatter'
import { resolveRelPath } from '../../knowledge/rel-path'
import { lineStarts, visibleSegments } from '../../knowledge/text-scan'
import { getKnowledgeService } from '../../knowledge/service-registry'
import { SnapshotService } from '../snapshot-service'
import { defineTool, type ToolDefinition, type ToolExecutionContext } from '../tool-registry'
import {
  createVaultMarkdown,
  readVaultMarkdown,
  removeCreatedVaultFile,
  writeVaultMarkdown
} from './vault-io'

const MAX_EDITS = 100
const MAX_TAGS_PER_FILE = 20
const MAX_MOC_LINKS = 200
const DIFF_LINE_LIMIT = 200

export interface LinkEditInput {
  path: string
  /** 1-based 行号 */
  line: number
  /** 1-based 列号；insert 模式允许指向行尾后一列 */
  column: number
  /** 默认 replace */
  mode?: 'replace' | 'insert'
  /** replace 时必须与原文完全一致；insert 时忽略 */
  expected?: string
  /** 新文本；replace 传空串表示删除 */
  replacement: string
}

export interface ApplyLinkEditsInput {
  edits: LinkEditInput[]
  reason: string
}

export interface TagEditInput {
  path: string
  add?: string[]
  remove?: string[]
}

export interface ApplyTagEditsInput {
  edits: TagEditInput[]
  reason: string
}

export interface MocLinkInput {
  target: string
  label?: string
  note?: string
}

export interface WriteMocInput {
  path: string
  title: string
  description?: string
  links?: MocLinkInput[]
  mode: 'create' | 'replace' | 'append'
  reason: string
}

export interface BatchPlanFile {
  path: string
  before: string | null
  after: string
  summary: string
  changes: number
  additions: number
  deletions: number
  diff: string
}

export interface BatchPlan {
  title: string
  description?: string
  files: BatchPlanFile[]
  totalChanges: number
}

export interface BatchWriteResult {
  paths: string[]
  totalChanges: number
}

export interface KnowledgeWriteToolRegistry {
  applyLinkEdits: ToolDefinition<ApplyLinkEditsInput, BatchWriteResult>
  applyTagEdits: ToolDefinition<ApplyTagEditsInput, BatchWriteResult>
  writeMoc: ToolDefinition<WriteMocInput, BatchWriteResult>
}

function requireWorkspaceRoot(context: ToolExecutionContext): string {
  const root = context.snapshot.workspaceRoot
  if (!root) throw new Error('当前没有打开工作区，无法批量写入')
  return root
}

function requireRun(context: ToolExecutionContext): { runId: string; conversationId: string } {
  const runId = context.snapshot.runId
  if (!runId) throw new Error('缺少运行时标识，无法创建写前快照')
  return { runId, conversationId: context.snapshot.conversationId || '' }
}

function lineEndOffset(text: string, starts: number[], line: number): number {
  const next = starts[line]
  let end = next === undefined ? text.length : next
  if (end > 0 && text[end - 1] === '\n') end -= 1
  if (end > 0 && text[end - 1] === '\r') end -= 1
  return end
}

/** 在原文上应用一组按行列定位的编辑；所有位置均基于修改前的文本 */
export function applyLinkEditsToText(text: string, edits: LinkEditInput[]): string {
  const starts = lineStarts(text)
  const spans = edits.map((edit, index) => {
    const lineStart = starts[edit.line - 1]
    if (lineStart === undefined) throw new Error(`第 ${edit.line} 行不存在`)
    const lineEnd = lineEndOffset(text, starts, edit.line)
    const offset = lineStart + edit.column - 1
    if (offset < lineStart || offset > lineEnd) {
      throw new Error(`第 ${edit.line} 行第 ${edit.column} 列超出范围`)
    }

    const mode = edit.mode ?? 'replace'
    if (mode === 'insert') {
      if (edit.replacement === '') throw new Error('插入模式必须提供 replacement')
      return { start: offset, end: offset, replacement: edit.replacement, index }
    }

    const expected = edit.expected ?? ''
    if (expected === '') throw new Error('替换模式必须提供 expected 原文')
    if (offset + expected.length > lineEnd) {
      throw new Error(`第 ${edit.line} 行的原文长度超出该行`)
    }
    if (text.slice(offset, offset + expected.length) !== expected) {
      throw new Error(`第 ${edit.line} 行第 ${edit.column} 列的原文不匹配，可能已被修改`)
    }
    return { start: offset, end: offset + expected.length, replacement: edit.replacement, index }
  })

  const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1].end > ordered[i].start) throw new Error('同一文件内的编辑区间重叠')
  }

  let result = text
  for (const span of [...spans].sort((a, b) => b.start - a.start || b.index - a.index)) {
    result = result.slice(0, span.start) + span.replacement + result.slice(span.end)
  }
  return result
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeTag(tag: string): string {
  const value = tag.trim().replace(/^#+/, '')
  if (value === '') throw new Error('标签不能为空')
  if (/[\s#[\]()`,.;:!?'"<>|\\]/.test(value)) throw new Error(`标签格式无效：${tag}`)
  return value
}

/** 删除正文中所有可见的 `#tag`（跳过代码块与行内代码） */
function removeInlineTag(text: string, tag: string): { text: string; removed: number } {
  const pattern = new RegExp(`(?:^|[^\\w#/])#${escapeRegExp(tag)}(?![\\w/-])`, 'g')
  const ranges: Array<[number, number]> = []
  for (const segment of visibleSegments(text)) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(segment.text)) !== null) {
      const hashAt = match[0].lastIndexOf(`#${tag}`)
      if (hashAt === -1) continue
      const start = segment.start + match.index + hashAt
      ranges.push([start, start + tag.length + 1])
    }
  }
  if (ranges.length === 0) return { text, removed: 0 }

  let result = text
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, start) + result.slice(end)
  }
  return { text: result, removed: ranges.length }
}

function appendInlineTags(text: string, tags: string[]): string {
  const base = text.endsWith('\n') ? text : `${text}\n`
  return `${base}\n${tags.map((tag) => `#${tag}`).join(' ')}\n`
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index])
}

/** 对单个文件应用标签增删；无实际变化时返回原文本 */
export function applyTagEditsToText(
  text: string,
  add: string[],
  remove: string[]
): { text: string; added: number; removed: number } {
  const fm = parseFrontmatter(text)
  const body = fm ? text.slice(fm.bodyOffset) : text
  const frontmatterTags = fm ? readList(fm, 'tags') : []
  const inlineTags = new Set(parseInlineTags(body).map((item) => item.tag))
  const current = new Set([...frontmatterTags, ...inlineTags])

  const addMissing = [...new Set(add.map(normalizeTag))].filter((tag) => !current.has(tag))
  const removePresent = [...new Set(remove.map(normalizeTag))].filter((tag) => current.has(tag))
  if (addMissing.length === 0 && removePresent.length === 0) {
    return { text, added: 0, removed: 0 }
  }

  let result = text

  if (fm !== null) {
    const nextTags = [...frontmatterTags]
    for (const tag of addMissing) if (!nextTags.includes(tag)) nextTags.push(tag)
    for (const tag of removePresent) {
      const at = nextTags.indexOf(tag)
      if (at !== -1) nextTags.splice(at, 1)
    }
    if (!sameTags(frontmatterTags, nextTags)) {
      result = setFrontmatterField(result, 'tags', nextTags.length > 0 ? nextTags : null)
    }
  } else if (addMissing.length > 0) {
    result = appendInlineTags(result, addMissing)
  }

  for (const tag of removePresent) {
    result = removeInlineTag(result, tag).text
  }

  return { text: result, added: addMissing.length, removed: removePresent.length }
}

function buildDiff(relPath: string, before: string, after: string): {
  diff: string
  additions: number
  deletions: number
} {
  const parts = diffLines(before, after)
  const lines: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`]
  let additions = 0
  let deletions = 0

  for (const part of parts) {
    const prefix = part.added ? '+' : part.removed ? '-' : ' '
    const values = part.value.split('\n')
    if (values[values.length - 1] === '') values.pop()
    for (const value of values) {
      if (part.added) additions += 1
      if (part.removed) deletions += 1
      if (lines.length < DIFF_LINE_LIMIT) lines.push(prefix + value)
    }
  }

  if (lines.length >= DIFF_LINE_LIMIT) lines.push('… diff 已截断')
  return { diff: lines.join('\n'), additions, deletions }
}

function toPlanFile(
  path: string,
  before: string | null,
  after: string,
  summary: string,
  changes: number
): BatchPlanFile {
  const diff = buildDiff(path, before ?? '', after)
  return {
    path,
    before,
    after,
    summary,
    changes,
    additions: diff.additions,
    deletions: diff.deletions,
    diff: diff.diff
  }
}

function toPreview(plan: BatchPlan): ApprovalPreview {
  return {
    type: 'batch',
    title: plan.title,
    description: plan.description,
    files: plan.files.map((file) => ({
      path: file.path,
      summary: file.summary,
      additions: file.additions,
      deletions: file.deletions,
      diff: file.diff
    })),
    totalChanges: plan.totalChanges
  }
}

async function planLinkEdits(root: string, input: ApplyLinkEditsInput): Promise<BatchPlan> {
  const groups = new Map<string, LinkEditInput[]>()
  for (const edit of input.edits) {
    const rel = resolveRelPath(root, edit.path)
    const list = groups.get(rel)
    if (list === undefined) groups.set(rel, [edit])
    else list.push(edit)
  }

  const files: BatchPlanFile[] = []
  for (const [rel, edits] of groups) {
    const before = await readVaultMarkdown(root, rel)
    if (before === null) throw new Error(`文件不存在：${rel}`)
    const after = applyLinkEditsToText(before, edits)
    if (after === before) continue
    files.push(toPlanFile(rel, before, after, `修改 ${edits.length} 处链接`, edits.length))
  }

  if (files.length === 0) throw new Error('没有产生实际变更')
  return {
    title: '批量链接编辑',
    description: input.reason,
    files,
    totalChanges: files.reduce((sum, file) => sum + file.changes, 0)
  }
}

async function planTagEdits(root: string, input: ApplyTagEditsInput): Promise<BatchPlan> {
  const files: BatchPlanFile[] = []
  for (const edit of input.edits) {
    const rel = resolveRelPath(root, edit.path)
    const before = await readVaultMarkdown(root, rel)
    if (before === null) throw new Error(`文件不存在：${rel}`)
    const result = applyTagEditsToText(before, edit.add ?? [], edit.remove ?? [])
    if (result.text === before) continue
    const parts: string[] = []
    if (result.added > 0) parts.push(`新增 ${result.added} 个标签`)
    if (result.removed > 0) parts.push(`删除 ${result.removed} 个标签`)
    files.push(
      toPlanFile(
        rel,
        before,
        result.text,
        parts.join('，') || '更新标签',
        result.added + result.removed
      )
    )
  }

  if (files.length === 0) throw new Error('没有产生实际变更')
  return {
    title: '批量标签编辑',
    description: input.reason,
    files,
    totalChanges: files.reduce((sum, file) => sum + file.changes, 0)
  }
}

function mocBody(
  title: string,
  description: string | undefined,
  links: MocLinkInput[],
  level = 1
): string {
  const lines: string[] = [`${'#'.repeat(level)} ${title}`, '']
  if (description && description.trim() !== '') lines.push(description.trim(), '')

  const seen = new Set<string>()
  for (const link of links) {
    const target = link.target.trim()
    if (target === '') continue
    const label = link.label?.trim() ?? ''
    const key = `${target}\u0000${label}`
    if (seen.has(key)) continue
    seen.add(key)
    const note = link.note?.trim()
    const text = label === '' ? `[[${target}]]` : `[[${target}|${label}]]`
    lines.push(note ? `- ${text} — ${note}` : `- ${text}`)
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function mocDocument(title: string, description: string | undefined, links: MocLinkInput[]): string {
  return `---\ntitle: ${JSON.stringify(title)}\ntype: moc\n---\n\n${mocBody(title, description, links)}`
}

async function planWriteMoc(root: string, input: WriteMocInput): Promise<BatchPlan> {
  const rel = resolveRelPath(root, input.path)
  const before = await readVaultMarkdown(root, rel)
  if (before === null && path.extname(rel).toLowerCase() !== '.md') {
    throw new Error('新建索引页只支持 .md 文件')
  }
  if (input.mode === 'create' && before !== null) {
    throw new Error(`文件已存在，无法以 create 模式创建：${rel}`)
  }

  const full = mocDocument(input.title, input.description, input.links ?? [])
  let after: string
  if (input.mode === 'append' && before !== null) {
    after = `${before.trimEnd()}\n\n${mocBody(input.title, input.description, input.links ?? [], 2)}`
  } else {
    after = full
  }

  if (after === before) throw new Error('没有产生实际变更')
  const summary = before === null ? '新建索引页' : input.mode === 'append' ? '追加索引页内容' : '重写索引页'
  return {
    title: '生成 / 更新索引页',
    description: input.reason,
    files: [toPlanFile(rel, before, after, summary, 1)],
    totalChanges: 1
  }
}

async function verifyPlanFresh(root: string, plan: BatchPlan): Promise<void> {
  for (const file of plan.files) {
    const current = await readVaultMarkdown(root, file.path)
    if (current !== file.before) {
      throw new Error(`文件在批准后发生变化，请重新生成清单：${file.path}`)
    }
  }
}

async function restoreWritten(root: string, files: BatchPlanFile[]): Promise<void> {
  for (const file of [...files].reverse()) {
    try {
      if (file.before === null) await removeCreatedVaultFile(root, file.path)
      else await writeVaultMarkdown(root, file.path, file.before)
    } catch {
      // 补偿失败不覆盖原始错误；快照仍可用于手动回滚
    }
  }
}

async function persistPlan(
  context: ToolExecutionContext,
  toolName: string,
  plan: BatchPlan
): Promise<BatchWriteResult> {
  const root = requireWorkspaceRoot(context)
  const { runId, conversationId } = requireRun(context)

  const snapshotFiles: SnapshotFileInput[] = plan.files.map((file) => ({
    path: file.path,
    title: file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.[^./]+$/, ''),
    content: file.before ?? '',
    scope: 'disk',
    existed: file.before !== null
  }))
  const snapshots = new SnapshotService()
  await snapshots.create(root, {
    runId,
    conversationId,
    toolName,
    files: snapshotFiles
  })

  const written: BatchPlanFile[] = []
  try {
    for (const file of plan.files) {
      if (file.before === null) await createVaultMarkdown(root, file.path, file.after)
      else await writeVaultMarkdown(root, file.path, file.after)
      written.push(file)
    }
  } catch (error) {
    await restoreWritten(root, written)
    throw error
  }

  // 后续工具（query_notes / find_broken_links）必须看到最新索引
  await getKnowledgeService(root).build().catch(() => {})

  return {
    paths: plan.files.map((file) => file.path),
    totalChanges: plan.totalChanges
  }
}

export function createKnowledgeWriteTools(): KnowledgeWriteToolRegistry {
  const plans = new WeakMap<ToolExecutionContext, { tool: string; plan: BatchPlan }>()

  async function preview(
    context: ToolExecutionContext,
    tool: string,
    build: () => Promise<BatchPlan>
  ): Promise<ApprovalPreview> {
    const plan = await build()
    plans.set(context, { tool, plan })
    return toPreview(plan)
  }

  async function execute(
    context: ToolExecutionContext,
    tool: string,
    root: string,
    build: () => Promise<BatchPlan>
  ): Promise<BatchWriteResult> {
    const cached = plans.get(context)
    plans.delete(context)
    const plan = cached?.tool === tool ? cached.plan : await build()
    await verifyPlanFresh(root, plan)
    return persistPlan(context, tool, plan)
  }

  const linkEditSchema = z
    .object({
      path: z.string().trim().min(1),
      line: z.number().int().min(1),
      column: z.number().int().min(1),
      mode: z.enum(['replace', 'insert']).optional(),
      expected: z.string().max(2_000).optional(),
      replacement: z.string().max(2_000)
    })
    .strict()

  const applyLinkEdits = defineTool<ApplyLinkEditsInput, BatchWriteResult>({
    name: 'apply_link_edits',
    description:
      '批量插入、替换或删除链接。每条编辑用路径 + 行号 + 列号 + 原文精确指定位置；一次批准后写入所有文件，可整体回滚。用于修复断链、把未链接提及转为 [[链接]]。',
    inputSchema: z
      .object({
        edits: z.array(linkEditSchema).min(1).max(MAX_EDITS),
        reason: z.string().trim().min(1).max(500)
      })
      .strict(),
    policy: {
      effect: 'write',
      approval: 'batch',
      riskLevel: 'high',
      supportsRememberDecision: false
    },
    execution: 'main',
    createApprovalPreview: async (input, context) =>
      preview(context, 'apply_link_edits', () =>
        planLinkEdits(requireWorkspaceRoot(context), input)
      ),
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      return execute(context, 'apply_link_edits', root, () => planLinkEdits(root, input))
    }
  })

  const tagEditSchema = z
    .object({
      path: z.string().trim().min(1),
      add: z.array(z.string().trim().min(1).max(80)).max(MAX_TAGS_PER_FILE).optional(),
      remove: z.array(z.string().trim().min(1).max(80)).max(MAX_TAGS_PER_FILE).optional()
    })
    .strict()

  const applyTagEdits = defineTool<ApplyTagEditsInput, BatchWriteResult>({
    name: 'apply_tag_edits',
    description:
      '批量新增或删除标签。有 frontmatter 时写入 tags 字段，无 frontmatter 时追加行内 #标签；删除会同时清理 frontmatter 与正文中的可见标签。一次批准后写入所有文件，可整体回滚。',
    inputSchema: z
      .object({
        edits: z.array(tagEditSchema).min(1).max(MAX_EDITS),
        reason: z.string().trim().min(1).max(500)
      })
      .strict(),
    policy: {
      effect: 'write',
      approval: 'batch',
      riskLevel: 'high',
      supportsRememberDecision: false
    },
    execution: 'main',
    createApprovalPreview: async (input, context) =>
      preview(context, 'apply_tag_edits', () =>
        planTagEdits(requireWorkspaceRoot(context), input)
      ),
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      return execute(context, 'apply_tag_edits', root, () => planTagEdits(root, input))
    }
  })

  const writeMoc = defineTool<WriteMocInput, BatchWriteResult>({
    name: 'write_moc',
    description:
      '创建或更新索引页（Map of Content）。给定标题、说明与链接清单，生成带 frontmatter 的 Markdown；支持 create / replace / append。一次批准后写入，可整体回滚。',
    inputSchema: z
      .object({
        path: z.string().trim().min(1),
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).optional(),
        links: z
          .array(
            z
              .object({
                target: z.string().trim().min(1).max(500),
                label: z.string().trim().max(200).optional(),
                note: z.string().trim().max(300).optional()
              })
              .strict()
          )
          .max(MAX_MOC_LINKS)
          .optional(),
        mode: z.enum(['create', 'replace', 'append']),
        reason: z.string().trim().min(1).max(500)
      })
      .strict(),
    policy: {
      effect: 'write',
      approval: 'batch',
      riskLevel: 'medium',
      supportsRememberDecision: false
    },
    execution: 'main',
    createApprovalPreview: async (input, context) =>
      preview(context, 'write_moc', () => planWriteMoc(requireWorkspaceRoot(context), input)),
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      return execute(context, 'write_moc', root, () => planWriteMoc(root, input))
    }
  })

  return { applyLinkEdits, applyTagEdits, writeMoc }
}
