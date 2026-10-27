import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type {
  AiDocumentSnapshot,
  AiExecutionSnapshot,
  ApprovedDocumentOperation
} from '../../../shared/ai/types'
import { parseMindMap } from '../../../src/utils/mindmap/schema'
import { createSourceAuthorizationContext } from '../source-authorization'
import { createDocumentTools } from '../tools/document-tools'
import type { ToolExecutionContext } from '../tool-registry'
import type { WorkspaceSearchService } from '../../workspace/workspace-search-service'

/**
 * AI 生成/改写思维导图的两个工具。
 *
 * 关键契约是「模型只写大纲，JSON 由程序生成」：
 * 因此这里断言的不是模型输出，而是**产出的 JSON 一定能被解析层接受**。
 */

function makeDoc(overrides: Partial<AiDocumentSnapshot> = {}): AiDocumentSnapshot {
  return {
    id: 'doc-1',
    title: '产品规划',
    path: 'C:\\ws\\产品规划.inkmind',
    format: 'mindmap',
    content: '{"schema":"inkase.mindmap","version":2,"root":{"id":"r","text":"根"}}',
    revision: 1,
    contentHash: 'hash-1',
    modified: false,
    ...overrides
  }
}

function makeSnapshot(doc: AiDocumentSnapshot | null): AiExecutionSnapshot {
  return {
    runId: randomUUID(),
    conversationId: 'conv-1',
    activeDocument: doc,
    selection: null,
    cursor: null,
    workspaceRoot: 'C:\\ws'
  }
}

function makeContext(doc: AiDocumentSnapshot | null): ToolExecutionContext {
  return {
    snapshot: makeSnapshot(doc),
    sourceAuthorization: createSourceAuthorizationContext({ message: '', history: [] })
  }
}

type RendererTool = {
  createRendererOperation: (
    input: unknown,
    context: ToolExecutionContext
  ) => Promise<ApprovedDocumentOperation>
  createApprovalPreview?: (
    input: unknown,
    context: ToolExecutionContext
  ) => Promise<{ type: string; title: string; content: string }>
}

const OUTLINE = '# 产品规划\n\n## 目标\n\n- 九月上线\n- 覆盖三端\n\n## 风险\n\n- 排期紧'

/** 搜索服务在这两个工具里用不到，给一个会被调用就报错的替身 */
function unusedSearchService(): WorkspaceSearchService {
  return {} as WorkspaceSearchService
}

function tools(): { create: RendererTool; update: RendererTool } {
  const registry = createDocumentTools(unusedSearchService())
  return {
    create: registry.createMindmap as unknown as RendererTool,
    update: registry.updateMindmap as unknown as RendererTool
  }
}

describe('create_mindmap', () => {
  it('把大纲转成可解析的导图，落成 mindmap 格式的新文档', async () => {
    const { create } = tools()
    const operation = await create.createRendererOperation(
      { title: '产品规划', outline: OUTLINE, reason: '整理成导图' },
      makeContext(makeDoc())
    )

    expect(operation.type).toBe('create-document')
    if (operation.type !== 'create-document') return
    expect(operation.format).toBe('mindmap')
    expect(operation.title).toBe('产品规划')

    const parsed = parseMindMap(operation.content)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.root.text).toContain('产品规划')
    // 二级标题成为子主题，列表项成为它的下级
    const names = parsed.document.root.children.map((child) => child.text)
    expect(names).toContain('目标')
    expect(names).toContain('风险')
    const goal = parsed.document.root.children.find((child) => child.text === '目标')
    expect(goal?.children.map((child) => child.text)).toEqual(['九月上线', '覆盖三端'])
  })

  it('大纲为空时报错，不产出空图', async () => {
    const { create } = tools()
    await expect(
      create.createRendererOperation(
        { title: '空', outline: '   ', reason: 'x' },
        makeContext(makeDoc())
      )
    ).rejects.toThrow('大纲')
  })

  it('审批预览给人看的是大纲而不是 JSON', async () => {
    const { create } = tools()
    const preview = await create.createApprovalPreview!(
      { title: '产品规划', outline: OUTLINE, reason: 'x' },
      makeContext(makeDoc())
    )
    expect(preview.type).toBe('document')
    expect(preview.content).toContain('## 目标')
    // JSON 不该出现在审批界面里
    expect(preview.content).not.toContain('"root"')
  })
})

describe('update_mindmap', () => {
  it('当前文档是导图时复用替换操作', async () => {
    const { update } = tools()
    const doc = makeDoc()
    const operation = await update.createRendererOperation(
      { outline: OUTLINE, reason: '按新排期改写' },
      makeContext(doc)
    )

    expect(operation.type).toBe('replace-document')
    if (operation.type !== 'replace-document') return
    // 目标带上 revision 与哈希，交给渲染层做冲突检测
    expect(operation.target.id).toBe('doc-1')
    expect(operation.target.revision).toBe(1)
    expect(parseMindMap(operation.content).ok).toBe(true)
  })

  it('当前文档不是导图时明确拒绝', async () => {
    const { update } = tools()
    await expect(
      update.createRendererOperation(
        { outline: OUTLINE, reason: 'x' },
        makeContext(makeDoc({ format: 'markdown', title: '笔记' }))
      )
    ).rejects.toThrow('不是思维导图')
  })

  it('没有活动文档时报错', async () => {
    const { update } = tools()
    await expect(
      update.createRendererOperation({ outline: OUTLINE, reason: 'x' }, makeContext(null))
    ).rejects.toThrow('活动文档')
  })
})
