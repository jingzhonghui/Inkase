import { randomUUID } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalManager } from '../approval-manager'
import { SourceAccessService } from '../source-access-service'
import { WorkspaceSearchService } from '../../workspace/workspace-search-service'
import type { AiProviderEvent, LlmProvider, LlmRunInput } from '../provider'
import { AiRuntime } from '../runtime'
import { ToolRegistry } from '../tool-registry'
import type {
  AiDocumentSnapshot,
  AiExecutionSnapshot,
  AiRunEvent,
  AiRunInput,
  AiRuntimeConfig,
  SearchWorkspaceResult,
  ToolExecutionResult,
  WorkspaceFileSlice
} from '../../../shared/ai/types'

const DOCUMENT_BODY = '# Release notes\n\nPrivate roadmap details'
const API_KEY = 'integration-secret-key'

function documentSnapshot(): AiDocumentSnapshot {
  return {
    id: 'doc-integration',
    title: 'Release notes',
    path: null,
    format: 'markdown',
    content: DOCUMENT_BODY,
    revision: 7,
    contentHash: 'hash-integration',
    modified: false
  }
}

function executionSnapshot(): AiExecutionSnapshot {
  return {
    runId: randomUUID(),
    conversationId: 'conversation-integration',
    activeDocument: documentSnapshot(),
    selection: null,
    cursor: null,
    workspaceRoot: 'C:\\ws'
  }
}

function runInput(snapshot = executionSnapshot()): AiRunInput {
  return {
    conversationId: snapshot.conversationId,
    message: 'Summarize the current document',
    history: [],
    snapshot
  }
}

function runtimeConfig(): AiRuntimeConfig {
  return {
    baseUrl: 'https://api.example.com/v1',
    model: 'integration-model',
    apiKey: API_KEY,
    temperature: 0
  }
}

function makeFakeSearchService(): WorkspaceSearchService {
  return {
    search: vi.fn(async (input): Promise<SearchWorkspaceResult> => ({
      status: 'completed',
      mode: input.mode,
      query: input.query,
      matches: [],
      truncated: false,
      elapsedMs: 1
    })),
    listRoot: vi.fn(),
    readDirectory: vi.fn(),
    readFile: vi.fn(async () => DOCUMENT_BODY),
    readFileSlice: vi.fn(async () => makeFileSlice(DOCUMENT_BODY)),
    statFile: vi.fn(async () => ({
      path: 'docs/release-notes.md',
      format: 'markdown',
      fileSize: Buffer.byteLength(DOCUMENT_BODY, 'utf8'),
      totalSize: Buffer.byteLength(DOCUMENT_BODY, 'utf8'),
      readable: true
    }))
  } as unknown as WorkspaceSearchService
}

/** 构造一次全文读取的结果，供 mock 的 readFileSlice 复用。 */
function makeFileSlice(content: string): WorkspaceFileSlice {
  const bytes = Buffer.byteLength(content, 'utf8')
  return {
    path: 'docs/release-notes.md',
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

class ScriptedProvider implements LlmProvider {
  input: LlmRunInput | null = null

  constructor(private readonly script: (input: LlmRunInput) => AsyncGenerator<AiProviderEvent>) {}

  async *run(input: LlmRunInput): AsyncIterable<AiProviderEvent> {
    this.input = input
    yield* this.script(input)
  }

  async testConnection(): Promise<{ textGeneration: boolean; toolCalling: boolean }> {
    return { textGeneration: true, toolCalling: true }
  }

  async summarize(): Promise<string> {
    return 'scripted'
  }
}

function createRuntime(
  provider: LlmProvider,
  sourceAccessService = new SourceAccessService(),
  approvalTimeoutMs = 60_000,
  searchService: WorkspaceSearchService = makeFakeSearchService()
): AiRuntime {
  return new AiRuntime({
    provider,
    registry: new ToolRegistry(),
    approvalManager: new ApprovalManager({ approvalTimeoutMs }),
    sourceAccessService,
    searchService,
    config: runtimeConfig(),
    approvalTimeoutMs
  })
}

async function waitForEvent<T extends AiRunEvent['type']>(
  events: AiRunEvent[],
  type: T
): Promise<Extract<AiRunEvent, { type: T }>> {
  await vi.waitFor(() => expect(events.some((event) => event.type === type)).toBe(true))
  return events.find((event): event is Extract<AiRunEvent, { type: T }> => event.type === type)!
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AI main-process integration', () => {
  it('keeps the document body out of initial provider input, exposes it through workspace tools, and streams final text', async () => {
    let searchResult: ToolExecutionResult | undefined
    let readResult: ToolExecutionResult | undefined
    const search = vi.fn(async (): Promise<SearchWorkspaceResult> => ({
      status: 'completed',
      mode: 'filename',
      query: 'release-notes',
      matches: [{ type: 'filename', path: 'docs/release-notes.md', extension: 'md' }],
      truncated: false,
      elapsedMs: 1
    }))
    const readFileSlice = vi.fn(async () => makeFileSlice(DOCUMENT_BODY))
    const searchService = makeFakeSearchService()
    searchService.search = search
    searchService.readFileSlice = readFileSlice
    const provider = new ScriptedProvider(async function* (input) {
      yield { type: 'tool-call-started', toolCallId: 'search-1', toolName: 'search_workspace' }
      searchResult = await input.tools.search_workspace.execute({ query: 'release-notes', mode: 'filename' })
      yield { type: 'tool-call-completed', toolCallId: 'search-1', result: searchResult }
      yield { type: 'tool-call-started', toolCallId: 'read-1', toolName: 'read_workspace_file' }
      readResult = await input.tools.read_workspace_file.execute({ path: 'docs/release-notes.md' })
      yield { type: 'tool-call-completed', toolCallId: 'read-1', result: readResult }
      yield { type: 'text-delta', text: 'Roadmap summarized.' }
      yield { type: 'completed' }
    })
    const events: AiRunEvent[] = []
    const service = new SourceAccessService()
    const runtime = createRuntime(provider, service, 60_000, searchService)

    await runtime.start(runInput(), (event) => events.push(event))
    await waitForEvent(events, 'run-completed')

    expect(JSON.stringify(provider.input?.messages)).not.toContain(DOCUMENT_BODY)
    expect(provider.input?.system).not.toContain(DOCUMENT_BODY)
    expect(searchResult).toMatchObject({
      status: 'completed',
      data: {
        status: 'completed',
        mode: 'filename',
        matches: [{ type: 'filename', path: 'docs/release-notes.md', extension: 'md' }]
      }
    })
    expect(readResult).toMatchObject({
      status: 'completed',
      data: { content: DOCUMENT_BODY }
    })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text-delta', text: 'Roadmap summarized.' })
    )
  })

  it('continues the provider with the approved renderer result after presenting the exact write preview', async () => {
    let rendererResult: ToolExecutionResult | undefined
    const provider = new ScriptedProvider(async function* (input) {
      yield { type: 'tool-call-started', toolCallId: 'write-1', toolName: 'replace_current_document' }
      rendererResult = await input.tools.replace_current_document.execute({
        content: '# Published\n\nPublic release notes',
        reason: 'Publish the final copy'
      })
      yield { type: 'tool-call-completed', toolCallId: 'write-1', result: rendererResult }
      yield { type: 'text-delta', text: rendererResult.status === 'applied' ? 'Applied.' : 'Not applied.' }
      yield { type: 'completed' }
    })
    const events: AiRunEvent[] = []
    const runtime = createRuntime(provider)

    await runtime.start(runInput(), (event) => events.push(event))
    const approval = (await waitForEvent(events, 'approval-required')).approval

    expect(approval.preview).toEqual({
      type: 'markdown-diff',
      title: 'Release notes',
      before: DOCUMENT_BODY,
      after: '# Published\n\nPublic release notes'
    })
    expect(approval.execution).toEqual({
      location: 'renderer',
      operation: {
        type: 'replace-document',
        target: documentSnapshot(),
        content: '# Published\n\nPublic release notes',
        reason: 'Publish the final copy'
      }
    })

    runtime.claimApproval(approval.id)
    runtime.resolveApproval(
      approval.id,
      { status: 'approved', scope: 'once' },
      { status: 'applied', data: { revision: 8 } }
    )
    await waitForEvent(events, 'run-completed')

    expect(rendererResult).toEqual({ status: 'applied', data: { revision: 8 } })
    expect(events).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Applied.' }))
  })

  it('returns rejection to the provider without waiting for a renderer result', async () => {
    let toolResult: ToolExecutionResult | undefined
    const provider = new ScriptedProvider(async function* (input) {
      toolResult = await input.tools.replace_current_document.execute({ content: 'Denied', reason: 'Test' })
      yield { type: 'tool-call-completed', toolCallId: 'write-rejected', result: toolResult }
      yield { type: 'completed' }
    })
    const events: AiRunEvent[] = []
    const runtime = createRuntime(provider)

    await runtime.start(runInput(), (event) => events.push(event))
    const approval = (await waitForEvent(events, 'approval-required')).approval
    runtime.resolveApproval(approval.id, { status: 'rejected', reason: 'Keep current draft' })
    await waitForEvent(events, 'run-completed')

    expect(toolResult).toEqual({ status: 'rejected', message: 'Keep current draft' })
  })

  it('cancels an in-flight write approval and the provider run', async () => {
    let toolResult: ToolExecutionResult | undefined
    const provider = new ScriptedProvider(async function* (input) {
      toolResult = await input.tools.replace_current_document.execute({ content: 'Cancelled', reason: 'Test' })
      if (input.abortSignal.aborted) throw new DOMException('Aborted', 'AbortError')
      yield { type: 'tool-call-completed', toolCallId: 'write-cancelled', result: toolResult }
    })
    const events: AiRunEvent[] = []
    const runtime = createRuntime(provider)

    const { runId } = await runtime.start(runInput(), (event) => events.push(event))
    await waitForEvent(events, 'approval-required')
    await runtime.cancel(runId)
    await waitForEvent(events, 'run-cancelled')

    expect(toolResult).toEqual({ status: 'cancelled', message: '运行已取消' })
  })

  it('continues with an approved exact web source and performs no access before approval', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<title>Report</title><p>source body</p>', { headers: { 'content-type': 'text/html' } })
    )
    const service = new SourceAccessService()
    let toolResult: ToolExecutionResult | undefined
    const provider = new ScriptedProvider(async function* (input) {
      toolResult = await input.tools.read_web_url.execute(
        { url: 'https://example.com/report', reason: 'Summarize the report' },
        { toolCallId: 'web-1' }
      )
      yield { type: 'tool-call-completed', toolCallId: 'web-1', result: toolResult }
      yield { type: 'text-delta', text: toolResult.status === 'completed' ? 'Source summarized.' : 'Failed.' }
      yield { type: 'completed' }
    })
    const events: AiRunEvent[] = []
    const input = runInput()
    input.message = 'Please read https://example.com/report'
    const runtime = createRuntime(provider, service)

    await runtime.start(input, (event) => events.push(event))
    const approval = (await waitForEvent(events, 'approval-required')).approval
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(approval.preview).toEqual({
      type: 'network-request', method: 'GET', url: 'https://example.com/report', reason: 'Summarize the report'
    })
    expect(approval.execution).toEqual({ location: 'main' })
    runtime.resolveApproval(approval.id, { status: 'approved', scope: 'once' })
    await waitForEvent(events, 'run-completed')

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/report', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(toolResult).toMatchObject({ status: 'completed', data: { content: 'Report\nsource body' } })
    expect(events).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Source summarized.' }))
    fetchSpy.mockRestore()
  })

  it('continues with an approved exact local source after metadata-only preview', async () => {
    const inspection = {
      requestedPath: 'C:\\Docs\\Report.md', normalizedPath: 'C:\\Docs\\Report.md', fileType: 'markdown' as const, size: 24
    }
    const result = { ...inspection, content: '# Report\n\nlocal body', chunks: [], truncated: false }
    const inspectLocalFile = vi.fn().mockResolvedValue(inspection)
    const readLocalFile = vi.fn().mockResolvedValue(result)
    const service = { inspectLocalFile, readLocalFile, readWebUrl: vi.fn() } as unknown as SourceAccessService
    let toolResult: ToolExecutionResult | undefined
    const provider = new ScriptedProvider(async function* (input) {
      toolResult = await input.tools.read_local_file.execute(
        { path: 'C:\\Docs\\Report.md', reason: 'Summarize the file' },
        { toolCallId: 'local-1' }
      )
      yield { type: 'tool-call-completed', toolCallId: 'local-1', result: toolResult }
      yield { type: 'text-delta', text: toolResult.status === 'completed' ? 'File summarized.' : 'Failed.' }
      yield { type: 'completed' }
    })
    const input = runInput()
    input.message = 'Please read `C:\\Docs\\Report.md`'
    const events: AiRunEvent[] = []
    const runtime = createRuntime(provider, service)

    await runtime.start(input, (event) => events.push(event))
    const approval = (await waitForEvent(events, 'approval-required')).approval
    expect(inspectLocalFile).toHaveBeenCalledWith('C:\\Docs\\Report.md')
    expect(readLocalFile).not.toHaveBeenCalled()
    expect(approval.preview).toEqual({
      ...inspection, type: 'local-file-read', requestedPath: 'C:\\Docs\\Report.md', reason: 'Summarize the file'
    })
    runtime.resolveApproval(approval.id, { status: 'approved', scope: 'once' })
    await waitForEvent(events, 'run-completed')

    expect(readLocalFile).toHaveBeenCalledWith('C:\\Docs\\Report.md', expect.any(AbortSignal), inspection)
    expect(toolResult).toEqual({ status: 'completed', data: result })
    expect(events).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'File summarized.' }))
  })

  it('emits approval for any valid URL and respects user rejection', async () => {
    const readWebUrl = vi.fn()
    const service = { inspectLocalFile: vi.fn(), readLocalFile: vi.fn(), readWebUrl } as unknown as SourceAccessService
    let toolResult: ToolExecutionResult | undefined
    const provider = new ScriptedProvider(async function* (input) {
      toolResult = await input.tools.read_web_url.execute({
        url: 'https://assistant.example/private', reason: 'Read it'
      }, { toolCallId: 'web-1' })
      yield { type: 'tool-call-completed', toolCallId: 'web-1', result: toolResult }
      yield { type: 'completed' }
    })
    const input = runInput()
    input.message = 'Summarize my request'
    input.history = [{ id: 'a1', role: 'assistant', content: 'https://assistant.example/private' }]
    const events: AiRunEvent[] = []
    const runtime = createRuntime(provider, service)

    await runtime.start(input, (event) => events.push(event))
    // 审批弹窗弹出（不再检查白名单，格式有效即可）
    const approval = (await waitForEvent(events, 'approval-required')).approval
    // 用户拒绝后工具返回 rejected，不执行实际读取
    runtime.resolveApproval(approval.id, { status: 'rejected' })
    await waitForEvent(events, 'run-completed')
    expect(toolResult).toEqual({ status: 'rejected', message: '用户拒绝了该操作' })
    expect(readWebUrl).not.toHaveBeenCalled()
  })

  it('does not log API keys, prompts, or document bodies during a run', async () => {
    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {})
    ]
    const provider = new ScriptedProvider(async function* (input) {
      await input.tools.search_workspace.execute({ query: 'release', mode: 'filename' })
      yield { type: 'text-delta', text: 'Safe response' }
      yield { type: 'completed' }
    })
    const events: AiRunEvent[] = []

    await createRuntime(provider).start(runInput(), (event) => events.push(event))
    await waitForEvent(events, 'run-completed')

    const logged = JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls))
    expect(logged).not.toContain(API_KEY)
    expect(logged).not.toContain('Summarize the current document')
    expect(logged).not.toContain(DOCUMENT_BODY)
  })
})
