import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolExecutionContext } from '../tool-registry'
import { createSourceAuthorizationContext } from '../source-authorization'
import { SnapshotService } from '../snapshot-service'
import {
  applyLinkEditsToText,
  applyTagEditsToText,
  createKnowledgeWriteTools,
  type KnowledgeWriteToolRegistry
} from '../tools/knowledge-write-tools'

let root: string
let tools: KnowledgeWriteToolRegistry

function write(rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

function context(runId = 'run-1'): ToolExecutionContext {
  return {
    snapshot: {
      runId,
      conversationId: 'c1',
      activeDocument: null,
      selection: null,
      cursor: null,
      workspaceRoot: root
    },
    sourceAuthorization: createSourceAuthorizationContext({ message: '', history: [] }),
    abortSignal: new AbortController().signal
  }
}

async function preview<TInput, TResult>(
  tool: ToolDefinition<TInput, TResult>,
  input: TInput,
  ctx: ToolExecutionContext
): Promise<unknown> {
  const definition = tool as unknown as {
    createApprovalPreview?: (value: TInput, context: ToolExecutionContext) => Promise<unknown>
  }
  if (!definition.createApprovalPreview) throw new Error('工具缺少审批预览')
  return definition.createApprovalPreview(input, ctx)
}

async function execute<TInput, TResult>(
  tool: ToolDefinition<TInput, TResult>,
  input: TInput,
  ctx: ToolExecutionContext
): Promise<TResult> {
  return (tool as unknown as {
    execute: (value: TInput, context: ToolExecutionContext) => Promise<TResult>
  }).execute(input, ctx)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-write-tools-'))
  tools = createKnowledgeWriteTools()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('applyLinkEditsToText', () => {
  const text = '# A\n\nLink [[Old]] here\nsecond [[Old]] line\n'

  it('替换、插入与删除都基于修改前的行列位置', () => {
    const after = applyLinkEditsToText(text, [
      { path: 'A.md', line: 3, column: 6, expected: '[[Old]]', replacement: '[[New]]' },
      { path: 'A.md', line: 4, column: 1, mode: 'insert', replacement: '> ' },
      { path: 'A.md', line: 4, column: 8, expected: '[[Old]]', replacement: '' }
    ])
    expect(after).toBe('# A\n\nLink [[New]] here\n> second  line\n')
  })

  it('原文不匹配时拒绝', () => {
    expect(() =>
      applyLinkEditsToText(text, [
        { path: 'A.md', line: 3, column: 6, expected: '[[Nope]]', replacement: '[[New]]' }
      ])
    ).toThrow(/原文不匹配/)
  })

  it('重叠编辑被拒绝', () => {
    expect(() =>
      applyLinkEditsToText(text, [
        { path: 'A.md', line: 3, column: 6, expected: '[[Old]]', replacement: '[[New]]' },
        { path: 'A.md', line: 3, column: 8, expected: 'Old', replacement: 'X' }
      ])
    ).toThrow(/重叠/)
  })
})

describe('applyTagEditsToText', () => {
  it('有 frontmatter 时增删 tags 字段并清理行内标签', () => {
    const before = '---\ntitle: B\ntags: [old]\n---\n\n# B\n\n#inline\n'
    const result = applyTagEditsToText(before, ['new'], ['old', 'inline'])
    expect(result.added).toBe(1)
    expect(result.removed).toBe(2)
    expect(result.text).toContain('tags:')
    expect(result.text).toContain('  - new')
    expect(result.text).not.toContain('old')
    expect(result.text).not.toContain('#inline')
  })

  it('无 frontmatter 时追加行内标签，删除时还原', () => {
    const before = '# C\n'
    const added = applyTagEditsToText(before, ['x'], [])
    expect(added.text).toBe('# C\n\n#x\n')

    const removed = applyTagEditsToText(added.text, [], ['x'])
    expect(removed.removed).toBe(1)
    expect(removed.text).toBe('# C\n\n\n')
  })

  it('已存在的标签不重复添加', () => {
    const before = '# C\n\n#x\n'
    expect(applyTagEditsToText(before, ['x'], []).added).toBe(0)
  })
})

describe('apply_link_edits', () => {
  it('生成批量预览、写入文件并建立可回滚快照', async () => {
    write('A.md', '# A\n\nLink [[Old]] here\n')
    const ctx = context()
    const input = {
      edits: [{ path: 'A.md', line: 3, column: 6, expected: '[[Old]]', replacement: '[[New]]' }],
      reason: '修复断链'
    }

    const view = await preview(tools.applyLinkEdits, input, ctx) as {
      type: string
      files: Array<{ path: string; summary: string; diff: string }>
      totalChanges: number
    }
    expect(view.type).toBe('batch')
    expect(view.files).toHaveLength(1)
    expect(view.files[0]).toMatchObject({ path: 'A.md', summary: '修改 1 处链接' })
    expect(view.files[0].diff).toContain('-Link [[Old]] here')
    expect(view.files[0].diff).toContain('+Link [[New]] here')

    const result = await execute(tools.applyLinkEdits, input, ctx)
    expect(result).toEqual({ paths: ['A.md'], totalChanges: 1 })
    expect(read('A.md')).toContain('[[New]]')

    const manifest = await new SnapshotService().read(root, 'run-1')
    expect(manifest.manifest.files[0]).toMatchObject({ path: 'A.md', scope: 'disk', existed: true })
    await new SnapshotService().restore(root, 'run-1')
    expect(read('A.md')).toBe('# A\n\nLink [[Old]] here\n')
  })

  it('批准后文件被改动则整批拒绝，不写入', async () => {
    write('A.md', '# A\n\nLink [[Old]] here\n')
    const ctx = context()
    const input = {
      edits: [{ path: 'A.md', line: 3, column: 6, expected: '[[Old]]', replacement: '[[New]]' }],
      reason: '修复断链'
    }
    await preview(tools.applyLinkEdits, input, ctx)
    fs.writeFileSync(path.join(root, 'A.md'), '# A\n\nLink [[Changed]] here\n', 'utf-8')

    await expect(execute(tools.applyLinkEdits, input, ctx)).rejects.toThrow(/发生变化/)
    expect(read('A.md')).toContain('[[Changed]]')
  })

  it('没有实际变更时不弹审批', async () => {
    write('A.md', '# A\n\nLink [[Old]] here\n')
    const ctx = context()
    await expect(
      preview(
        tools.applyLinkEdits,
        {
          edits: [
            { path: 'A.md', line: 3, column: 6, expected: '[[Old]]', replacement: '[[Old]]' }
          ],
          reason: '无变化'
        },
        ctx
      )
    ).rejects.toThrow(/没有产生实际变更/)
  })
})

describe('apply_tag_edits', () => {
  it('批量写入标签并保留 frontmatter 其它字段', async () => {
    write('B.md', '---\ntitle: B\ntags: [old]\nstatus: draft\n---\n\n# B\n\n#inline\n')
    const ctx = context('run-tags')
    const input = {
      edits: [{ path: 'B.md', add: ['new'], remove: ['old', 'inline'] }],
      reason: '整理标签'
    }
    const view = await preview(tools.applyTagEdits, input, ctx) as { files: Array<{ diff: string }> }
    expect(view.files[0].diff).toContain('tags:')

    const result = await execute(tools.applyTagEdits, input, ctx)
    expect(result.totalChanges).toBe(3)
    const after = read('B.md')
    expect(after).toContain('  - new')
    expect(after).toContain('status: draft')
    expect(after).not.toContain('#inline')

    await new SnapshotService().restore(root, 'run-tags')
    expect(read('B.md')).toContain('tags: [old]')
  })
})

describe('write_moc', () => {
  it('create 模式新建索引页，快照可在回滚时删除新文件', async () => {
    const ctx = context('run-moc')
    const input = {
      path: 'moc/Index.md',
      title: '项目索引',
      description: '所有项目入口',
      links: [
        { target: 'A', label: '项目 A' },
        { target: 'B', note: '待整理' }
      ],
      mode: 'create' as const,
      reason: '生成索引页'
    }
    const view = await preview(tools.writeMoc, input, ctx) as { files: Array<{ summary: string }> }
    expect(view.files[0].summary).toBe('新建索引页')

    await execute(tools.writeMoc, input, ctx)
    const content = read('moc/Index.md')
    expect(content).toContain('title: "项目索引"')
    expect(content).toContain('type: moc')
    expect(content).toContain('- [[A|项目 A]]')
    expect(content).toContain('- [[B]] — 待整理')

    await new SnapshotService().restore(root, 'run-moc')
    expect(fs.existsSync(path.join(root, 'moc/Index.md'))).toBe(false)
  })

  it('append 模式保留原内容并在末尾追加', async () => {
    write('Index.md', '# 已有索引\n\n- [[Old]]\n')
    const ctx = context('run-append')
    await execute(
      tools.writeMoc,
      {
        path: 'Index.md',
        title: '追加区块',
        links: [{ target: 'New' }],
        mode: 'append',
        reason: '追加'
      },
      ctx
    )
    const content = read('Index.md')
    expect(content.startsWith('# 已有索引')).toBe(true)
    expect(content).toContain('## 追加区块')
    expect(content).toContain('- [[New]]')
  })

  it('create 模式遇到已存在文件时拒绝', async () => {
    write('Index.md', '# 已有\n')
    await expect(
      preview(
        tools.writeMoc,
        { path: 'Index.md', title: 'X', mode: 'create', reason: 'x' },
        context()
      )
    ).rejects.toThrow(/已存在/)
  })
})

describe('批处理安全边界', () => {
  it('所有工具都走批量审批且声明为写入', () => {
    for (const tool of Object.values(tools)) {
      expect(tool.policy).toMatchObject({
        effect: 'write',
        approval: 'batch',
        supportsRememberDecision: false
      })
    }
  })

  it('拒绝越界路径', async () => {
    await expect(
      preview(
        tools.applyLinkEdits,
        {
          edits: [{ path: '../A.md', line: 1, column: 1, mode: 'insert', replacement: 'x' }],
          reason: '越界'
        },
        context()
      )
    ).rejects.toThrow(/路径/)
  })
})
