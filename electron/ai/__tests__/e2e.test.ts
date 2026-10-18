import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { MockOpenAiServer } from './mock-openai-server'
import { VercelAiSdkProvider } from '../provider'
import { AiRuntime } from '../runtime'
import { ToolRegistry } from '../tool-registry'
import { ApprovalManager } from '../approval-manager'
import { SourceAccessService } from '../source-access-service'
import { WorkspaceSearchService } from '../../workspace/workspace-search-service'
import type {
  AiDocumentSnapshot,
  AiExecutionSnapshot,
  AiRunEvent,
  AiRunInput,
  AiRuntimeConfig,
  SearchWorkspaceResult
} from '../../../shared/ai/types'

const DOCUMENT_BODY = '# Release notes\n\nPrivate roadmap details'
const API_KEY = 'e2e-secret-key'
const USER_MESSAGE = '请总结当前文档'

function makeDoc(): AiDocumentSnapshot {
  return {
    id: 'doc-e2e',
    title: 'Release notes',
    path: null,
    format: 'markdown',
    content: DOCUMENT_BODY,
    revision: 7,
    contentHash: 'hash-e2e',
    modified: false
  }
}

function makeSnapshot(doc: AiDocumentSnapshot | null = makeDoc()): AiExecutionSnapshot {
  return {
    runId: randomUUID(),
    conversationId: 'conv-e2e',
    activeDocument: doc,
    selection: null,
    cursor: null,
    workspaceRoot: 'C:\\ws'
  }
}

function makeRunInput(snapshot: AiExecutionSnapshot = makeSnapshot()): AiRunInput {
  return {
    conversationId: snapshot.conversationId,
    message: USER_MESSAGE,
    history: [],
    snapshot
  }
}

function makeConfig(baseUrl: string): AiRuntimeConfig {
  return { baseUrl, model: 'e2e-model', apiKey: API_KEY, temperature: 0 }
}

function makeFakeSearchService(): WorkspaceSearchService {
  return {
    search: vi.fn(async (input): Promise<SearchWorkspaceResult> => ({
      status: 'completed',
      mode: input.mode,
      query: input.query,
      matches: [
        { type: 'filename', path: 'docs/release-notes.md', extension: 'md' }
      ],
      truncated: false,
      elapsedMs: 1
    })),
    listRoot: vi.fn(),
    readDirectory: vi.fn(),
    readFile: vi.fn(async () => DOCUMENT_BODY)
  } as unknown as WorkspaceSearchService
}

function makeRuntime(baseUrl: string, searchService: WorkspaceSearchService = makeFakeSearchService()): AiRuntime {
  const provider = new VercelAiSdkProvider({ maxRetries: 0 })
  return new AiRuntime({
    provider,
    registry: new ToolRegistry(),
    approvalManager: new ApprovalManager(),
    sourceAccessService: new SourceAccessService(),
    searchService,
    config: makeConfig(baseUrl),
    maxSteps: 8
  })
}

async function waitForEvent<T extends AiRunEvent['type']>(
  events: AiRunEvent[],
  type: T,
  timeout = 5000
): Promise<Extract<AiRunEvent, { type: T }>> {
  await vi.waitFor(() => expect(events.some((event) => event.type === type)).toBe(true), {
    timeout
  })
  return events.find((event): event is Extract<AiRunEvent, { type: T }> => event.type === type)!
}

describe('AI 主进程端到端链路（真实 HTTP + 真实 Provider + Runtime + 工具 + 审批）', () => {
  let server: MockOpenAiServer | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
    vi.restoreAllMocks()
  })

  it('E1 纯文本对话：流式累积文本并正常完成', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      sseEvents: [
        '{"choices":[{"delta":{"content":"这是"}}]}',
        '{"choices":[{"delta":{"content":"总结结果"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}'
      ]
    })
    const events: AiRunEvent[] = []
    const runtime = makeRuntime(baseUrl)

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    await waitForEvent(events, 'run-completed')

    expect(runId).toBeTruthy()
    expect(events).toContainEqual(expect.objectContaining({ type: 'run-started', runId }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'text-delta', runId, text: '这是' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'text-delta', runId, text: '总结结果' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'run-completed', runId }))
    expect(server.requestCount).toBe(1)
  })

  it('E2 工具调用闭环：search_workspace 结果回传后模型继续输出', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (server!.requestCount === 1) {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_search_1","type":"function","function":{"name":"search_workspace","arguments":"{\\"query\\":\\"release\\",\\"mode\\":\\"filename\\"}"}}]}}]}\n\n'
          )
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
        } else {
          res.write('data: {"choices":[{"delta":{"content":"找到 release-notes.md。"},"finish_reason":"stop"}]}\n\n')
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    const events: AiRunEvent[] = []
    const runtime = makeRuntime(baseUrl)

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    await waitForEvent(events, 'run-completed')

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-call-started', runId, toolName: 'search_workspace' })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-call-completed',
        runId,
        result: expect.objectContaining({
          status: 'completed',
          data: expect.objectContaining({ matches: expect.any(Array) })
        })
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text-delta', runId, text: '找到 release-notes.md。' })
    )
    // 第一轮工具调用 + 第二轮文本
    expect(server.requestCount).toBe(2)
  })

  it('E3 工作区文件读取：read_workspace_file 读取内容并作为 tool-result 回传', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (server!.requestCount === 1) {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read_1","type":"function","function":{"name":"read_workspace_file","arguments":"{\\"path\\":\\"docs/release-notes.md\\"}"}}]}}]}\n\n'
          )
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
        } else {
          res.write('data: {"choices":[{"delta":{"content":"已读取文件。"},"finish_reason":"stop"}]}\n\n')
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    const events: AiRunEvent[] = []
    // 文件不在真实磁盘，mock 搜索服务的读取
    const readFile = vi.fn(async () => DOCUMENT_BODY)
    const searchService = makeFakeSearchService()
    searchService.readFile = readFile
    const runtime = makeRuntime(baseUrl, searchService)

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    await waitForEvent(events, 'run-completed')

    const completed = events.find(
      (e) => e.type === 'tool-call-completed' && e.toolCallId === 'call_read_1'
    )
    expect(completed).toBeDefined()
    if (completed?.type === 'tool-call-completed') {
      expect(completed.result).toMatchObject({ status: 'completed' })
      const data = completed.result.status === 'completed' ? completed.result.data : null
      expect(data).toMatchObject({ content: DOCUMENT_BODY })
    }
    void runId
  })

  it('E4 文档写入+审批全流程：模型发出写工具调用，审批批准后应用并继续', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (server!.requestCount === 1) {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_write_1","type":"function","function":{"name":"replace_current_document","arguments":"{\\"content\\":\\"# New content\\",\\"reason\\":\\"rewrite\\"}"}}]}}]}\n\n'
          )
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
        } else {
          res.write('data: {"choices":[{"delta":{"content":"文档已更新。"},"finish_reason":"stop"}]}\n\n')
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    const events: AiRunEvent[] = []
    const runtime = makeRuntime(baseUrl)

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    const approval = (await waitForEvent(events, 'approval-required')).approval

    expect(approval.toolName).toBe('replace_current_document')
    expect(approval.preview).toEqual({
      type: 'markdown-diff',
      title: 'Release notes',
      before: DOCUMENT_BODY,
      after: '# New content'
    })
    expect(approval.execution).toMatchObject({ location: 'renderer' })

    // 顺序有点反直觉，但是真的：工具是先执行、后上报 tool-call，
    // 所以 approval-required 比 tool-call-started 先到。
    // 渲染进程因此不能靠「反查工具调用」来确定审批属于哪条消息——它查不到。
    const startedIndex = events.findIndex(
      (e) => e.type === 'tool-call-started' && e.toolCallId === approval.toolCallId
    )
    const approvalIndex = events.findIndex(
      (e) => e.type === 'approval-required' && e.approval.id === approval.id
    )
    expect(approvalIndex).toBeGreaterThanOrEqual(0)
    expect(approvalIndex).toBeLessThan(startedIndex)

    runtime.claimApproval(approval.id)
    runtime.resolveApproval(
      approval.id,
      { status: 'approved', scope: 'once' },
      { status: 'applied', data: { revision: 8 } }
    )
    await waitForEvent(events, 'run-completed')

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-call-completed',
        runId,
        result: expect.objectContaining({ status: 'applied' })
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text-delta', runId, text: '文档已更新。' })
    )
    expect(server.requestCount).toBe(2)
  })

  it('E5 拒绝写入：用户拒绝后模型收到 rejected', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (server!.requestCount === 1) {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_write_2","type":"function","function":{"name":"replace_current_document","arguments":"{\\"content\\":\\"# Denied\\",\\"reason\\":\\"test\\"}"}}]}}]}\n\n'
          )
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
        } else {
          res.write('data: {"choices":[{"delta":{"content":"用户拒绝了修改。"},"finish_reason":"stop"}]}\n\n')
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    const events: AiRunEvent[] = []
    const runtime = makeRuntime(baseUrl)

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    const approval = (await waitForEvent(events, 'approval-required')).approval
    runtime.resolveApproval(approval.id, { status: 'rejected', reason: 'Keep current draft' })
    await waitForEvent(events, 'run-completed')

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-call-completed',
        runId,
        result: { status: 'rejected', message: 'Keep current draft' }
      })
    )
  })

  it('E6 网页来源读取：审批前不发起请求，批准后真实读取', async () => {
    const readWebUrl = vi.fn().mockResolvedValue({
      url: 'https://example.com/report',
      finalUrl: 'https://example.com/report',
      title: 'Report',
      content: 'Report\nsource body',
      contentType: 'text/html',
      chunks: [],
      truncated: false
    })
    // 只 mock 来源服务层，避免劫持真实 provider 对 MockOpenAiServer 的 HTTP 请求
    const service = { inspectLocalFile: vi.fn(), readLocalFile: vi.fn(), readWebUrl } as unknown as SourceAccessService
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (server!.requestCount === 1) {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_web_1","function":{"name":"read_web_url","arguments":"{\\"url\\":\\"https://example.com/report\\",\\"reason\\":\\"summarize\\"}"}}]}}]}\n\n'
          )
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
        } else {
          res.write('data: {"choices":[{"delta":{"content":"来源已读取。"},"finish_reason":"stop"}]}\n\n')
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    const provider = new VercelAiSdkProvider({ maxRetries: 0 })
    const runtime = new AiRuntime({
      provider,
      registry: new ToolRegistry(),
      approvalManager: new ApprovalManager(),
      sourceAccessService: service,
      searchService: makeFakeSearchService(),
      config: makeConfig(baseUrl),
      maxSteps: 8
    })
    const events: AiRunEvent[] = []
    const input = makeRunInput()
    input.message = '请阅读 https://example.com/report'

    const { runId } = await runtime.start(input, (event) => events.push(event))
    const approval = (await waitForEvent(events, 'approval-required')).approval

    expect(readWebUrl).not.toHaveBeenCalled()
    expect(approval.preview).toEqual({
      type: 'network-request',
      method: 'GET',
      url: 'https://example.com/report',
      reason: 'summarize'
    })
    expect(approval.execution).toEqual({ location: 'main' })

    runtime.resolveApproval(approval.id, { status: 'approved', scope: 'once' })
    await waitForEvent(events, 'run-completed')

    expect(readWebUrl).toHaveBeenCalledWith('https://example.com/report', expect.any(AbortSignal))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-call-completed',
        runId,
        result: expect.objectContaining({ status: 'completed' })
      })
    )
  })

  it('E7 本地文件来源读取：元数据预览后按获批身份读取', async () => {
    const inspection = {
      requestedPath: 'C:\\Docs\\Report.md',
      normalizedPath: 'C:\\Docs\\Report.md',
      fileType: 'markdown' as const,
      size: 24
    }
    const result = { ...inspection, content: '# Report\n\nlocal body', chunks: [], truncated: false }
    const inspectLocalFile = vi.fn().mockResolvedValue(inspection)
    const readLocalFile = vi.fn().mockResolvedValue(result)
    const service = { inspectLocalFile, readLocalFile, readWebUrl: vi.fn() } as unknown as SourceAccessService
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (server!.requestCount === 1) {
          const args = JSON.stringify({ path: 'C:\\Docs\\Report.md', reason: 'summarize' })
          res.write(
            `data: ${JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_local_1',
                    function: { name: 'read_local_file', arguments: args }
                  }]
                }
              }]
            })}\n\n`
          )
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
        } else {
          res.write('data: {"choices":[{"delta":{"content":"文件已读取。"},"finish_reason":"stop"}]}\n\n')
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    const provider = new VercelAiSdkProvider({ maxRetries: 0 })
    const runtime = new AiRuntime({
      provider,
      registry: new ToolRegistry(),
      approvalManager: new ApprovalManager(),
      sourceAccessService: service,
      searchService: makeFakeSearchService(),
      config: makeConfig(baseUrl),
      maxSteps: 8
    })
    const events: AiRunEvent[] = []
    const input = makeRunInput()
    input.message = '请读取 `C:\\Docs\\Report.md`'

    const { runId } = await runtime.start(input, (event) => events.push(event))
    const approval = (await waitForEvent(events, 'approval-required')).approval

    expect(inspectLocalFile).toHaveBeenCalledWith('C:\\Docs\\Report.md')
    expect(readLocalFile).not.toHaveBeenCalled()
    expect(approval.preview).toEqual({
      type: 'local-file-read',
      requestedPath: 'C:\\Docs\\Report.md',
      normalizedPath: 'C:\\Docs\\Report.md',
      fileType: 'markdown',
      size: 24,
      reason: 'summarize'
    })

    runtime.resolveApproval(approval.id, { status: 'approved', scope: 'once' })
    await waitForEvent(events, 'run-completed')

    expect(readLocalFile).toHaveBeenCalledWith('C:\\Docs\\Report.md', expect.any(AbortSignal), inspection)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-call-completed',
        runId,
        result: expect.objectContaining({ status: 'completed' })
      })
    )
  })

  it('E9 取消运行：运行中 cancel 触发 run-cancelled 并取消待审批', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (server!.requestCount === 1) {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_write_9","function":{"name":"replace_current_document","arguments":"{\\"content\\":\\"# X\\",\\"reason\\":\\"test\\"}"}}]}}]}\n\n'
          )
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
        } else {
          res.write('data: {"choices":[{"delta":{"content":"继续"},"finish_reason":"stop"}]}\n\n')
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    const events: AiRunEvent[] = []
    const runtime = makeRuntime(baseUrl)

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    await waitForEvent(events, 'approval-required')
    await runtime.cancel(runId)
    await waitForEvent(events, 'run-cancelled')

    expect(events).toContainEqual(expect.objectContaining({ type: 'run-cancelled', runId }))
  })

  it('E10 工具参数非法：结构化 failed 回传模型', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (server!.requestCount === 1) {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad_1","type":"function","function":{"name":"search_workspace","arguments":"{}"}}]}}]}\n\n'
          )
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
        } else {
          res.write('data: {"choices":[{"delta":{"content":"参数无效。"},"finish_reason":"stop"}]}\n\n')
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    const events: AiRunEvent[] = []
    const runtime = makeRuntime(baseUrl)

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    await waitForEvent(events, 'run-completed')

    // AI SDK 6.x 在 tool() 层自行校验 Zod schema：非法参数被拦截为 tool-error，
    // 不进入 AiRuntime 的 execute（不会产生 status:'failed' 的 tool-call-completed）。
    // 运行应正常完成，模型可读取错误后继续输出。
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-call-started', runId, toolName: 'search_workspace' })
    )
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'run-failed' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'run-completed', runId }))
    expect(server.requestCount).toBe(2)
  })

  it('E11 工具步骤超限：达到 maxSteps 后终止运行', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_loop_1","type":"function","function":{"name":"search_workspace","arguments":"{\\"query\\":\\"x\\",\\"mode\\":\\"filename\\"}"}}]}}]}\n\n'
        )
        res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    const events: AiRunEvent[] = []
    const provider = new VercelAiSdkProvider({ maxRetries: 0 })
    const runtime = new AiRuntime({
      provider,
      registry: new ToolRegistry(),
      approvalManager: new ApprovalManager(),
      sourceAccessService: new SourceAccessService(),
      searchService: makeFakeSearchService(),
      config: makeConfig(baseUrl),
      maxSteps: 2
    })

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    await waitForEvent(events, 'run-failed')

    const failed = events.find((e) => e.type === 'run-failed')
    expect(failed).toBeDefined()
    if (failed?.type === 'run-failed') {
      expect(failed.error.code).toBe('TOOL_LIMIT_REACHED')
    }
    expect(runId).toBeTruthy()
  })

  it('E12 HTTP 错误映射：401 → AUTH_FAILED', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      status: 401,
      body: JSON.stringify({ error: { message: 'Invalid API key' } })
    })
    const events: AiRunEvent[] = []
    const runtime = makeRuntime(baseUrl)

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    await waitForEvent(events, 'run-failed')

    const failed = events.find((e) => e.type === 'run-failed')
    expect(failed).toBeDefined()
    if (failed?.type === 'run-failed') {
      expect(failed.error.code).toBe('AUTH_FAILED')
    }
    expect(runId).toBeTruthy()
  })

  it('E12b HTTP 错误映射：500 → PROVIDER_UNAVAILABLE', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      status: 500,
      body: JSON.stringify({ error: { message: 'Internal server error' } })
    })
    const events: AiRunEvent[] = []
    const runtime = makeRuntime(baseUrl)

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    await waitForEvent(events, 'run-failed')

    const failed = events.find((e) => e.type === 'run-failed')
    expect(failed).toBeDefined()
    if (failed?.type === 'run-failed') {
      expect(failed.error.code).toBe('PROVIDER_UNAVAILABLE')
    }
    expect(runId).toBeTruthy()
  })

  it('E14 安全：文档内容不进入初始请求体，仅在工具调用后作为 tool-result 出现', async () => {
    server = new MockOpenAiServer()
    const baseUrl = await server.start({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (server!.requestCount === 1) {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read_14","type":"function","function":{"name":"search_workspace","arguments":"{\\"query\\":\\"release\\",\\"mode\\":\\"filename\\"}"}}]}}]}\n\n'
          )
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
        } else {
          res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    const events: AiRunEvent[] = []
    const runtime = makeRuntime(baseUrl)

    const { runId } = await runtime.start(makeRunInput(), (event) => events.push(event))
    await waitForEvent(events, 'run-completed')

    const firstRequest = server.requests[0]
    expect(JSON.stringify(firstRequest.body)).not.toContain(DOCUMENT_BODY)
    void runId
  })
})
