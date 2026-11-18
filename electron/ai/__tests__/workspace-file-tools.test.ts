import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type {
  AiDocumentSnapshot,
  AiExecutionSnapshot,
  ApprovedDocumentOperation,
  WorkspaceFileSlice,
  WorkspaceFileStat
} from '../../../shared/ai/types'
import { createSourceAuthorizationContext } from '../source-authorization'
import { createDocumentTools } from '../tools/document-tools'
import type { ToolExecutionContext } from '../tool-registry'
import type { WorkspaceSearchService } from '../../workspace/workspace-search-service'

/**
 * 工作区文件读写工具：read_workspace_file 的分段读取、
 * get_workspace_file_size 的大小查询、delete_workspace_file 的审批操作。
 */

const ROOT = 'C:\\ws'

function makeSnapshot(doc: AiDocumentSnapshot | null = null): AiExecutionSnapshot {
  return {
    runId: randomUUID(),
    conversationId: 'conv-1',
    activeDocument: doc,
    selection: null,
    cursor: null,
    workspaceRoot: ROOT
  }
}

function makeContext(doc: AiDocumentSnapshot | null = null): ToolExecutionContext {
  return {
    snapshot: makeSnapshot(doc),
    sourceAuthorization: createSourceAuthorizationContext({ message: '', history: [] }),
    abortSignal: new AbortController().signal
  }
}

type MainTool<T> = {
  execute: (input: unknown, context: ToolExecutionContext) => Promise<T>
}

type RendererTool = {
  createRendererOperation: (
    input: unknown,
    context: ToolExecutionContext
  ) => Promise<ApprovedDocumentOperation>
  createApprovalPreview?: (
    input: unknown,
    context: ToolExecutionContext
  ) => Promise<{ type: string } & Record<string, unknown>>
}

function makeSlice(content: string): WorkspaceFileSlice {
  const bytes = Buffer.byteLength(content, 'utf8')
  return {
    path: 'docs/notes.md',
    format: 'markdown',
    fileSize: bytes,
    totalSize: bytes,
    offset: 0,
    length: bytes,
    content,
    eof: true,
    truncated: false,
    nextOffset: null,
    encoding: 'utf-8'
  }
}

function makeStatFor(path: string): WorkspaceFileStat {
  if (path === 'docs/big.log') {
    return { path, format: 'text', fileSize: 2_000_000, totalSize: 2_000_000, readable: true }
  }
  return { path, format: 'markdown', fileSize: 5, totalSize: 5, readable: true }
}

interface FakeService {
  service: WorkspaceSearchService
  readFileSlice: ReturnType<typeof vi.fn>
  statFile: ReturnType<typeof vi.fn>
}

function makeService(): FakeService {
  const readFileSlice = vi.fn(async () => makeSlice('hello'))
  const statFile = vi.fn(async (_root: string, path: string) => makeStatFor(path))
  const inspectEntry = vi.fn((_root: string, path: string) => ({
    relative: path.replace(/\\/g, '/'),
    absolute: `C:\\ws\\${path.replace(/\//g, '\\')}`,
    isDirectory: false,
    fileSize: 5
  }))
  const inspectDirectory = vi.fn((_root: string, path: string) => ({
    relative: path.replace(/\\/g, '/'),
    absolute: `C:\\ws\\${path.replace(/\//g, '\\')}`
  }))
  const resolveNewPath = vi.fn((_root: string, path: string) => {
    const relative = path.replace(/\\/g, '/')
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '.'
    return {
      relative,
      absolute: `C:\\ws\\${relative.replace(/\//g, '\\')}`,
      parentRelative: parent,
      parentAbsolute: `C:\\ws\\${parent.replace(/\//g, '\\')}`
    }
  })
  const service = {
    readFileSlice,
    statFile,
    inspectEntry,
    inspectDirectory,
    resolveNewPath
  } as unknown as WorkspaceSearchService
  return { service, readFileSlice, statFile }
}

describe('read_workspace_file', () => {
  it('默认读取整篇，并把结果原样交给模型', async () => {
    const fake = makeService()
    const tool = createDocumentTools(fake.service).readWorkspaceFile as unknown as MainTool<WorkspaceFileSlice>

    const slice = await tool.execute({ path: 'docs/notes.md' }, makeContext())

    expect(fake.readFileSlice).toHaveBeenCalledTimes(1)
    expect(fake.readFileSlice.mock.calls[0][1]).toBe('docs/notes.md')
    expect(slice).toMatchObject({ content: 'hello', eof: true })
  })

  it('把 offset/length 透传给范围读取', async () => {
    const fake = makeService()
    const tool = createDocumentTools(fake.service).readWorkspaceFile as unknown as MainTool<WorkspaceFileSlice>

    await tool.execute({ path: 'docs/notes.md', offset: 1024, length: 2048 }, makeContext())

    expect(fake.readFileSlice.mock.calls[0][2]).toEqual({
      offset: 1024,
      length: 2048,
      maxBytes: undefined
    })
  })

  it('把设置里的单次读取上限透传给服务', async () => {
    const fake = makeService()
    const tool = createDocumentTools(fake.service, { maxReadBytes: 64 * 1024 })
      .readWorkspaceFile as unknown as MainTool<WorkspaceFileSlice>

    await tool.execute({ path: 'docs/notes.md' }, makeContext())

    expect(fake.readFileSlice.mock.calls[0][2]).toMatchObject({ maxBytes: 64 * 1024 })
  })

  it('没有工作区时拒绝读取', async () => {
    const fake = makeService()
    const tool = createDocumentTools(fake.service).readWorkspaceFile as unknown as MainTool<WorkspaceFileSlice>
    const context: ToolExecutionContext = {
      snapshot: { ...makeSnapshot(), workspaceRoot: null },
      sourceAuthorization: createSourceAuthorizationContext({ message: '', history: [] })
    }

    await expect(tool.execute({ path: 'docs/notes.md' }, context)).rejects.toThrow('工作区')
  })
})

describe('get_workspace_file_size', () => {
  it('返回磁盘大小与可读正文大小，便于判断是否需要分段读取', async () => {
    const fake = makeService()
    const tool = createDocumentTools(fake.service).getWorkspaceFileSize as unknown as MainTool<WorkspaceFileStat>

    const stat = await tool.execute({ path: 'docs/big.log' }, makeContext())

    expect(fake.statFile).toHaveBeenCalledTimes(1)
    expect(stat).toMatchObject({ fileSize: 2_000_000, totalSize: 2_000_000, readable: true })
  })

  it('二进制文件如实返回 readable=false 而不是报错', async () => {
    const fake = makeService()
    fake.statFile.mockResolvedValue({
      path: 'docs/pic.png',
      format: 'text',
      fileSize: 8,
      totalSize: 0,
      readable: false,
      reason: '文件是二进制内容或非 UTF-8 文本，无法按文本读取'
    })
    const tool = createDocumentTools(fake.service).getWorkspaceFileSize as unknown as MainTool<WorkspaceFileStat>

    const stat = await tool.execute({ path: 'docs/pic.png' }, makeContext())

    expect(stat.readable).toBe(false)
    expect(stat.reason).toBeTruthy()
  })
})

describe('delete_workspace_file', () => {  function deleteTool(service: WorkspaceSearchService): RendererTool {
    return createDocumentTools(service).deleteWorkspaceFile as unknown as RendererTool
  }

  it('产出渲染进程可执行的删除操作，绝对路径落在工作区内', async () => {
    const fake = makeService()
    const operation = await deleteTool(fake.service).createRendererOperation(
      { path: 'docs/notes.md', reason: '清理过期草稿' },
      makeContext()
    )

    expect(operation).toMatchObject({
      type: 'delete-workspace-file',
      relativePath: 'docs/notes.md',
      absolutePath: 'C:\\ws\\docs\\notes.md',
      reason: '清理过期草稿'
    })
  })

  it('审批预览说明删的是哪个文件、有多大', async () => {
    const fake = makeService()
    const preview = await deleteTool(fake.service).createApprovalPreview!(
      { path: 'docs/notes.md', reason: 'x' },
      makeContext()
    )

    expect(preview).toMatchObject({
      type: 'file-delete',
      relativePath: 'docs/notes.md',
      fileSize: 'hello'.length,
      format: 'markdown'
    })
  })

  it('审批策略是不可绕过的危险操作', () => {
    const fake = makeService()
    const tool = createDocumentTools(fake.service).deleteWorkspaceFile

    expect(tool.policy).toMatchObject({
      effect: 'dangerous',
      approval: 'always',
      riskLevel: 'critical'
    })
    expect(tool.execution).toBe('renderer')
  })

  it('没有工作区时拒绝删除', async () => {
    const fake = makeService()
    const context: ToolExecutionContext = {
      snapshot: { ...makeSnapshot(), workspaceRoot: null },
      sourceAuthorization: createSourceAuthorizationContext({ message: '', history: [] })
    }

    await expect(
      deleteTool(fake.service).createRendererOperation({ path: 'docs/notes.md', reason: 'x' }, context)
    ).rejects.toThrow('工作区')
  })
})

describe('create_workspace_directory', () => {
  function dirTool(service: WorkspaceSearchService): RendererTool {
    return createDocumentTools(service).createWorkspaceDirectory as unknown as RendererTool
  }

  it('产出新建目录操作', async () => {
    const fake = makeService()
    const operation = await dirTool(fake.service).createRendererOperation(
      { path: '归档/2026', reason: '按年份归类' },
      makeContext()
    )

    expect(operation).toMatchObject({
      type: 'create-workspace-directory',
      relativePath: '归档/2026',
      absolutePath: 'C:\\ws\\归档\\2026'
    })
  })

  it('预览说明要建哪个目录', async () => {
    const fake = makeService()
    const preview = await dirTool(fake.service).createApprovalPreview!(
      { path: '归档/2026', reason: 'x' },
      makeContext()
    )

    expect(preview).toMatchObject({
      type: 'file-operation',
      operation: 'create-directory',
      to: '归档/2026'
    })
  })
})

describe('move_workspace_entry', () => {
  function moveTool(service: WorkspaceSearchService): RendererTool {
    return createDocumentTools(service).moveWorkspaceEntry as unknown as RendererTool
  }

  it('移动进目标目录并保留文件名', async () => {
    const fake = makeService()
    const operation = await moveTool(fake.service).createRendererOperation(
      { path: 'docs/notes.md', targetDirectory: 'docs/归档', reason: '归类' },
      makeContext()
    )

    expect(operation).toMatchObject({
      type: 'move-workspace-entry',
      fromRelative: 'docs/notes.md',
      toRelative: 'docs/归档/notes.md'
    })
  })

  it('只给 newName 时原地改名', async () => {
    const fake = makeService()
    const operation = await moveTool(fake.service).createRendererOperation(
      { path: 'docs/notes.md', newName: '会议纪要.md', reason: '改名' },
      makeContext()
    )

    expect(operation).toMatchObject({
      type: 'move-workspace-entry',
      fromRelative: 'docs/notes.md',
      toRelative: 'docs/会议纪要.md'
    })
  })

  it('两个都没给时报错，避免空操作', async () => {
    const fake = makeService()
    await expect(
      moveTool(fake.service).createRendererOperation(
        { path: 'docs/notes.md', reason: 'x' },
        makeContext()
      )
    ).rejects.toThrow('targetDirectory')
  })

  it('newName 不允许带路径分隔符', async () => {
    const fake = makeService()
    await expect(
      moveTool(fake.service).createRendererOperation(
        { path: 'docs/notes.md', newName: '../逃逸.md', reason: 'x' },
        makeContext()
      )
    ).rejects.toThrow('文件名')
  })
})

describe('write_workspace_file', () => {
  function writeTool(service: WorkspaceSearchService): RendererTool {
    return createDocumentTools(service).writeWorkspaceFile as unknown as RendererTool
  }

  it('产出写入操作，Markdown 目标标记为 markdown', async () => {
    const fake = makeService()
    const operation = await writeTool(fake.service).createRendererOperation(
      { path: 'docs/汇总.md', content: '# 汇总', reason: '合并三篇笔记' },
      makeContext()
    )

    expect(operation).toMatchObject({
      type: 'write-workspace-file',
      relativePath: 'docs/汇总.md',
      content: '# 汇总',
      format: 'markdown'
    })
  })

  it.each(['docs/a.mdx', 'docs/a.inkmind', 'docs/a.drawio'])(
    '拒绝直接写容器或图表：%s',
    async (path) => {
      const fake = makeService()
      await expect(
        writeTool(fake.service).createRendererOperation(
          { path, content: 'x', reason: 'x' },
          makeContext()
        )
      ).rejects.toThrow()
    }
  )

  it('既有文件给 diff 预览，新文件给文档预览', async () => {
    const fake = makeService()
    fake.readFileSlice.mockRejectedValueOnce(new Error('不存在'))
    const created = await writeTool(fake.service).createApprovalPreview!(
      { path: 'docs/新.md', content: '# 新' },
      makeContext()
    )
    expect(created).toMatchObject({ type: 'document', title: 'docs/新.md' })

    const updated = await writeTool(fake.service).createApprovalPreview!(
      { path: 'docs/旧.md', content: '# 新' },
      makeContext()
    )
    expect(updated).toMatchObject({ type: 'markdown-diff', before: 'hello', after: '# 新' })
  })
})
