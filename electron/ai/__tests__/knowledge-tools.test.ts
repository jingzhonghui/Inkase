import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolExecutionContext } from '../tool-registry'
import { createSourceAuthorizationContext } from '../source-authorization'
import {
  createKnowledgeTools,
  type AttachmentTextResult,
  type KnowledgeToolRegistry
} from '../tools/knowledge-tools'
import { KnowledgeIndexService } from '../../knowledge/index-service'

const FIXTURES_DIR = path.join(__dirname, 'fixtures')
const SAMPLE_PDF = path.join(FIXTURES_DIR, 'sample.pdf')

let root: string
let service: KnowledgeIndexService
let tools: KnowledgeToolRegistry

function write(rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

function context(signal = new AbortController().signal): ToolExecutionContext {
  return {
    snapshot: {
      conversationId: 'c1',
      activeDocument: null,
      selection: null,
      cursor: null,
      workspaceRoot: root
    },
    sourceAuthorization: createSourceAuthorizationContext({ message: '', history: [] }),
    abortSignal: signal
  }
}

async function run<TInput, TResult>(
  tool: ToolDefinition<TInput, TResult>,
  input: TInput,
  ctx: ToolExecutionContext = context()
): Promise<TResult> {
  return (tool as unknown as {
    execute: (value: TInput, executionContext: ToolExecutionContext) => Promise<TResult>
  }).execute(input, ctx)
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-knowledge-tools-'))
  write('A.md', '# A\n\n[[B]] 与 [[Missing]]\n\n- [ ] 待办\n- [x] 完成\n\n#alpha\n')
  write('B.md', '# B\n\n#alpha #beta\n')
  write('docs/C.md', '# C\n\n[[A]]\n')
  fs.mkdirSync(path.join(root, 'files'), { recursive: true })
  fs.copyFileSync(SAMPLE_PDF, path.join(root, 'files', 'sample.pdf'))

  service = new KnowledgeIndexService(root)
  await service.build()
  tools = createKnowledgeTools({ getService: () => service })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('query_notes', () => {
  it('按标签筛选笔记并返回标签、标题与别名', async () => {
    const result = await run(tools.queryNotes, { tags: ['alpha'] })
    expect(result.items.map((item) => item.path)).toEqual(['A.md', 'B.md'])
    expect(result.items[0]).toMatchObject({ title: 'A', tags: ['alpha'] })
    expect(result.total).toBe(2)
    expect(result.truncated).toBe(false)
  })

  it('没有条件时列出全部笔记（不含附件）', async () => {
    const result = await run(tools.queryNotes, {})
    expect(result.items.map((item) => item.path)).toEqual(['A.md', 'B.md', 'docs/C.md'])
  })

  it('按未完成任务筛选，并返回任务统计', async () => {
    const result = await run(tools.queryNotes, { tasks: 'open' })
    expect(result.items.map((item) => item.path)).toEqual(['A.md'])
    expect(result.items[0].tasks).toEqual({ open: 1, done: 1 })
  })

  it('按已完成任务筛选', async () => {
    const result = await run(tools.queryNotes, { tasks: 'done' })
    expect(result.items.map((item) => item.path)).toEqual(['A.md'])
  })

  it('按 frontmatter 属性筛选', async () => {
    write('D.md', '---\nstatus: draft\ntitle: 草稿\n---\n\n# D\n')
    await service.build()
    const result = await run(tools.queryNotes, { props: { status: 'draft' } })
    expect(result.items.map((item) => item.path)).toEqual(['D.md'])
    expect(result.items[0].title).toBe('草稿')
  })
})

describe('expand_links', () => {
  it('从种子笔记沿链接与标签扩散，并标注边类型', async () => {
    const result = await run(tools.expandLinks, { seed: 'A', depth: 1 })
    const ids = result.nodes.map((node) => node.id)
    expect(ids).toContain('B.md')
    expect(ids).toContain('#alpha')
    expect(ids).toContain('docs/C.md')
    expect(result.edges).toContainEqual({
      from: 'A.md',
      to: 'B.md',
      layer: 'link',
      relation: undefined,
      embed: undefined
    })
    expect(result.nodes.find((node) => node.id === 'B.md')?.via).toMatchObject({
      from: 'A.md',
      to: 'B.md',
      layer: 'link',
      direction: 'out'
    })
  })

  it('缺失的种子笔记给出明确错误', async () => {
    await expect(run(tools.expandLinks, { seed: '不存在' })).rejects.toThrow(/找不到种子笔记/)
  })

  it('支持只看入链方向', async () => {
    const result = await run(tools.expandLinks, { seed: 'A.md', depth: 1, direction: 'in' })
    expect(result.nodes.map((node) => node.id)).toContain('docs/C.md')
    expect(result.nodes.map((node) => node.id)).not.toContain('B.md')
  })
})

describe('graph_overview', () => {
  it('返回计数、中心笔记、标签分布与断链数', async () => {
    const result = await run(tools.graphOverview, { top: 5 })
    expect(result.counts).toMatchObject({
      notes: 3,
      tags: 2,
      brokenLinks: 1,
      isolatedNotes: 0
    })
    expect(result.central[0]?.path).toBe('A.md')
    expect(result.tags).toEqual(
      expect.arrayContaining([
        { tag: 'alpha', count: 2 },
        { tag: 'beta', count: 1 }
      ])
    )
  })
})

describe('find_broken_links', () => {
  it('返回断链来源、目标与上下文', async () => {
    const result = await run(tools.findBrokenLinks, {})
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      from: 'A.md',
      fromTitle: 'A',
      target: 'Missing',
      status: 'missing',
      line: 3
    })
    expect(result.items[0].context).toContain('Missing')
  })

  it('可按来源文件过滤', async () => {
    const result = await run(tools.findBrokenLinks, { path: 'B.md' })
    expect(result.total).toBe(0)
    expect(result.items).toEqual([])
  })
})

describe('read_attachment_text', () => {
  it('读取 PDF 并返回页码出处', async () => {
    const result = await run(tools.readAttachmentText, { path: 'files/sample.pdf' })
    expect(result.kind).toBe('pdf')
    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.segments[0].locator).toBe('第 1 页')
    expect(result.segments[0].text.length).toBeGreaterThan(0)
  })

  it('拒绝工作区之外的路径', async () => {
    await expect(
      run(tools.readAttachmentText, { path: '../secret.pdf' })
    ).rejects.toThrow(/路径/)
  })

  it('拒绝非附件笔记', async () => {
    await expect(run(tools.readAttachmentText, { path: 'A.md' })).rejects.toThrow(/仅支持/)
  })

  it('使用注入的读取器时传递真实根目录与字符上限', async () => {
    const calls: unknown[][] = []
    const localTools = createKnowledgeTools({
      getService: () => service,
      readAttachment: async (...args): Promise<AttachmentTextResult> => {
        calls.push(args)
        return { path: 'files/sample.pdf', kind: 'pdf', segments: [], totalChars: 0, truncated: false }
      }
    })
    await run(localTools.readAttachmentText, { path: 'files/sample.pdf', maxChars: 2_000 })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(root)
    expect(calls[0][1]).toBe('files/sample.pdf')
    expect(calls[0][2]).toBe('pdf')
    expect(calls[0][3]).toBe(2_000)
  })
})

describe('tool policies', () => {
  it('全部是自动执行的只读工具', () => {
    for (const tool of Object.values(tools)) {
      expect(tool.policy).toMatchObject({
        effect: 'read',
        approval: 'never',
        riskLevel: 'low',
        supportsRememberDecision: false
      })
    }
  })
})
