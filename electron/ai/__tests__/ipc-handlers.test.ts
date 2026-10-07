import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-ai-ipc-'))

type Handler = (...args: unknown[]) => unknown

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf8')),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, '')),
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler
  },
  app: {
    getPath: () => userData
  },
  safeStorage: {
    isEncryptionAvailable: electronMocks.isEncryptionAvailable,
    encryptString: electronMocks.encryptString,
    decryptString: electronMocks.decryptString
  }
}))

const providerMocks = vi.hoisted(() => ({
  blockResolve: null as (() => void) | null,
  completeImmediately: false,
  runStarted: vi.fn(),
  testedConfig: null as Record<string, unknown> | null,
  tool: null as 'main' | 'renderer' | null,
  toolResult: null as unknown,
  generateTextResult: null as string | null,
  generateTextCalled: vi.fn()
}))

function sender(id: number) {
  let destroyed: (() => void) | undefined
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn((event: string, callback: () => void) => {
      if (event === 'destroyed') destroyed = callback
    }),
    destroy: () => destroyed?.()
  }
}

vi.mock('../provider', () => ({
  VercelAiSdkProvider: class {
    async *run(input: { tools: Record<string, { execute: (input: unknown, options: { toolCallId: string }) => Promise<unknown> }> }): AsyncIterable<Record<string, unknown>> {
      providerMocks.runStarted()
      if (providerMocks.completeImmediately) {
        yield { type: 'completed' }
        return
      }
      if (providerMocks.tool) {
        const toolName = providerMocks.tool === 'main' ? 'read_local_file' : 'create_document'
        const tool = input.tools[toolName]
        const toolInput = providerMocks.tool === 'main'
          ? { path: 'C:\\review-source.txt', reason: 'review' }
          : { title: 'Draft', content: '# Draft', format: 'markdown', reason: 'review' }
        yield { type: 'tool-call-started', toolCallId: 'call-approval', toolName }
        providerMocks.toolResult = await tool.execute(toolInput, { toolCallId: 'call-approval' })
        yield { type: 'tool-call-completed', toolCallId: 'call-approval', result: providerMocks.toolResult }
        yield { type: 'completed' }
        return
      }
      yield { type: 'text-delta', text: '你好' }
      await new Promise<void>((resolve) => {
        providerMocks.blockResolve = resolve
      })
      yield { type: 'completed' }
    }

    async testConnection(
      config: Record<string, unknown>
    ): Promise<{ textGeneration: boolean; toolCalling: boolean }> {
      providerMocks.testedConfig = config
      return { textGeneration: true, toolCalling: true }
    }

    async generateText(
      config: Record<string, unknown>,
      system: string,
      prompt: string,
      maxOutputTokens?: number
    ): Promise<string> {
      providerMocks.generateTextCalled(config, system, prompt, maxOutputTokens)
      return providerMocks.generateTextResult ?? '工作区概要从 LLM 生成'
    }
  },
  mapProviderError: (error: unknown) => ({
    code: 'PROVIDER_UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error)
  })
}))

vi.mock('../source-access-service', () => ({
  SourceAccessService: class {
    async inspectLocalFile(requestedPath: string) {
      return {
        requestedPath,
        normalizedPath: requestedPath,
        fileType: 'text',
        size: 12
      }
    }

    async readLocalFile(requestedPath: string) {
      return {
        requestedPath,
        normalizedPath: requestedPath,
        fileType: 'text',
        content: 'source text',
        chunks: [],
        truncated: false
      }
    }
  }
}))

vi.mock('../conversation-store', () => {
  const records = new Map<string, Record<string, unknown>>()
  return {
    ConversationStore: class {
      listConversations = vi.fn((_root: string | null) => [...records.values()])
      loadConversation = vi.fn((_root: string | null, id: string) => {
        const record = records.get(id)
        if (!record) throw new Error('会话不存在')
        return record
      })
      saveConversation = vi.fn((_root: string | null, record: { id: string }) => {
        records.set(record.id, record as Record<string, unknown>)
      })
      deleteConversation = vi.fn((_root: string | null, id: string) => {
        records.delete(id)
      })
    }
  }
})

vi.mock('../conversation-title', () => ({
  generateConversationTitle: vi.fn(async () => '生成标题')
}))

const summaryMocks = vi.hoisted(() => ({
  authorize: vi.fn((_senderId: number, root: string | null) => {
    void root
  }),
  getRoot: vi.fn((_senderId: number): string | null => null)
}))

vi.mock('../../workspace/workspace-authorization', () => ({
  authorizeWorkspaceRoot: summaryMocks.authorize,
  getAuthorizedWorkspaceRoot: summaryMocks.getRoot,
  revokeSenderWorkspace: vi.fn(),
  isPathWithinRoot: vi.fn(() => true)
}))

import { registerAiHandlers, disposeAiServices } from '../ipc-handlers'
import { IPC_CHANNELS } from '../../ipc/channels'

const AI = IPC_CHANNELS.AI

function makeConfigInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseUrl: 'https://api.example.com/v1',
    model: 'demo',
    apiKey: 'secret',
    temperature: 0.7,
    ...overrides
  }
}

function makeRunInput(): Record<string, unknown> {
  return {
    conversationId: 'conv-1',
    message: '你好',
    history: [],
    snapshot: {
      runId: 'run-1',
      conversationId: 'conv-1',
      activeDocument: null,
      selection: null,
      cursor: null,
      workspaceRoot: null
    }
  }
}

describe('registerAiHandlers', () => {
  beforeEach(() => {
    electronMocks.handlers.clear()
    electronMocks.handle.mockClear()
    electronMocks.removeHandler.mockClear()
    providerMocks.blockResolve = null
    providerMocks.completeImmediately = false
    providerMocks.runStarted.mockClear()
    providerMocks.testedConfig = null
    providerMocks.tool = null
    providerMocks.toolResult = null
    disposeAiServices()
  })

  it('registers the AI channels', () => {
    registerAiHandlers(() => null)

    expect(Array.from(electronMocks.handlers.keys()).sort()).toEqual(
      [
        AI.CONFIG.GET,
        AI.CONFIG.SET,
        AI.CONFIG.TEST,
        AI.RUN.START,
        AI.RUN.CANCEL,
        AI.APPROVAL.CLAIM,
        AI.APPROVAL.RESOLVE,
        AI.CONVERSATION.LIST,
        AI.CONVERSATION.LOAD,
        AI.CONVERSATION.SAVE,
        AI.CONVERSATION.DELETE,
        AI.CONVERSATION.SUMMARIZE,
        AI.WORKSPACE.AUTHORIZE
      ].sort()
    )
    expect(Array.from(electronMocks.handlers.keys())).not.toContainEqual(
      expect.stringMatching(/^ai:material:/)
    )
  })

  it('返回清理器并移除已注册的 handler', () => {
    const cleanup = registerAiHandlers(() => null)
    expect(electronMocks.handlers.size).toBe(13)

    cleanup()
    expect(electronMocks.handlers.size).toBe(0)
  })

  it('非法 payload 返回 {success:false,error} 而非抛异常', async () => {
    registerAiHandlers(() => null)
    const setHandler = electronMocks.handlers.get(AI.CONFIG.SET)!

    const result = await setHandler({}, makeConfigInput({ baseUrl: 'ftp://api.example.com/v1' }))
    expect(result).toMatchObject({ success: false })
    expect((result as { error?: string }).error).toBeTruthy()
  })

  it('config:set 保存后 config:get 返回已保存配置（不含明文 Key）', async () => {
    registerAiHandlers(() => null)
    const setHandler = electronMocks.handlers.get(AI.CONFIG.SET)!
    const getHandler = electronMocks.handlers.get(AI.CONFIG.GET)!

    await setHandler({}, makeConfigInput())
    const view = (await getHandler({})) as { success: boolean; data?: Record<string, unknown> }

    expect(view.success).toBe(true)
    expect(view.data).toMatchObject({
      baseUrl: 'https://api.example.com/v1',
      model: 'demo',
      hasApiKey: true
    })
    expect(view.data).not.toHaveProperty('apiKey')
  })

  it('config:test uses the saved key when the test input omits apiKey', async () => {
    registerAiHandlers(() => null)
    const setHandler = electronMocks.handlers.get(AI.CONFIG.SET)!
    const testHandler = electronMocks.handlers.get(AI.CONFIG.TEST)!

    await setHandler({}, makeConfigInput())
    const result = await testHandler({}, makeConfigInput({ apiKey: undefined, model: 'updated' }))

    expect(result).toMatchObject({ success: true })
    expect(providerMocks.testedConfig).toMatchObject({ apiKey: 'secret', model: 'updated' })
  })

  it('config:test does not substitute a saved key for another provider origin', async () => {
    registerAiHandlers(() => null)
    const setHandler = electronMocks.handlers.get(AI.CONFIG.SET)!
    const testHandler = electronMocks.handlers.get(AI.CONFIG.TEST)!

    await setHandler({}, makeConfigInput())
    const result = await testHandler({}, makeConfigInput({
      baseUrl: 'https://other.example.com/v1',
      apiKey: undefined
    }))

    expect(result).toMatchObject({ success: false })
    expect(providerMocks.testedConfig).toBeNull()
  })

  it.each([AI.CONFIG.SET, AI.CONFIG.TEST])('strictly rejects unknown fields for %s', async (channel) => {
    registerAiHandlers(() => null)
    const handler = electronMocks.handlers.get(channel)!

    const result = await handler({}, makeConfigInput({ unexpected: true }))

    expect(result).toMatchObject({ success: false })
    expect(providerMocks.testedConfig).toBeNull()
  })

  it('persists a successful config:test result for the exact saved config', async () => {
    registerAiHandlers(() => null)
    await electronMocks.handlers.get(AI.CONFIG.SET)!({}, makeConfigInput())

    await electronMocks.handlers.get(AI.CONFIG.TEST)!({}, makeConfigInput({ apiKey: undefined }))
    const result = await electronMocks.handlers.get(AI.CONFIG.GET)!({})

    expect(result).toMatchObject({
      success: true,
      data: { ready: true, capabilities: { textGeneration: true, toolCalling: true } }
    })
  })

  it('accepts source-looking strings without renderer candidates and rejects legacy materialIds', async () => {
    registerAiHandlers(() => null)
    await electronMocks.handlers.get(AI.CONFIG.SET)!({}, makeConfigInput())
    const start = electronMocks.handlers.get(AI.RUN.START)!
    const input = makeRunInput()
    input.message = 'Read https://example.com/a and C:\\notes\\source.md'
    input.history = [{ id: 'msg-1', role: 'user', content: 'Also /tmp/reference.txt' }]
    expect(await start({ sender: sender(31) }, input)).toMatchObject({ success: true })

    providerMocks.blockResolve?.()
    providerMocks.blockResolve = null
    await vi.waitFor(() => expect(providerMocks.runStarted).toHaveBeenCalled())

    const legacy = makeRunInput()
    ;(legacy.snapshot as Record<string, unknown>).materialIds = []
    expect(await start({ sender: sender(31) }, legacy)).toMatchObject({ success: false })
  })

  it('运行事件只发送给发起请求的 sender', async () => {
    registerAiHandlers(() => null)
    const setHandler = electronMocks.handlers.get(AI.CONFIG.SET)!
    const startHandler = electronMocks.handlers.get(AI.RUN.START)!

    await setHandler({}, makeConfigInput())

    const send = vi.fn()
    const owner = sender(1)
    owner.send = send

    const result = (await startHandler({ sender: owner }, makeRunInput())) as {
      success: boolean
      data?: { runId: string }
    }
    expect(result.success).toBe(true)
    expect(result.data?.runId).toBeTruthy()

    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0][0]).toBe(AI.EVENT)

    providerMocks.blockResolve?.()
    providerMocks.blockResolve = null
  })

  it('运行中再次 start 返回失败而非取消首运行', async () => {
    registerAiHandlers(() => null)
    const setHandler = electronMocks.handlers.get(AI.CONFIG.SET)!
    const startHandler = electronMocks.handlers.get(AI.RUN.START)!

    await setHandler({}, makeConfigInput())

    const send1 = vi.fn()
    const result1 = (await startHandler(
      { sender: Object.assign(sender(2), { send: send1 }) },
      makeRunInput()
    )) as { success: boolean }
    expect(result1.success).toBe(true)

    const result2 = (await startHandler(
      { sender: sender(3) },
      makeRunInput()
    )) as { success: boolean; error?: string }
    expect(result2.success).toBe(false)
    expect(result2.error).toContain('已有激活的 AI 运行')

    providerMocks.blockResolve?.()
    providerMocks.blockResolve = null
  })

  it.each([
    [AI.RUN.START, null],
    [AI.RUN.START, { conversationId: '', message: 1 }],
    [AI.RUN.CANCEL, ''],
    [AI.RUN.CANCEL, { runId: 'run-1' }],
    [AI.APPROVAL.RESOLVE, '']
  ])('rejects malformed %s payloads', async (channel, payload) => {
    registerAiHandlers(() => null)
    const handler = electronMocks.handlers.get(channel)!
    const result = await handler({ sender: sender(1) }, payload)
    expect(result).toMatchObject({ success: false })
  })

  it('rejects malformed approval decisions and renderer results', async () => {
    registerAiHandlers(() => null)
    const handler = electronMocks.handlers.get(AI.APPROVAL.RESOLVE)!

    expect(handler({ sender: sender(1) }, 'approval-1', { status: 'approved' })).toMatchObject({
      success: false
    })
    expect(
      handler(
        { sender: sender(1) },
        'approval-1',
        { status: 'approved', scope: 'once' },
        { status: 'failed' }
      )
    ).toMatchObject({ success: false })
  })

  it('only the sender that started a run may cancel it', async () => {
    registerAiHandlers(() => null)
    await electronMocks.handlers.get(AI.CONFIG.SET)!({}, makeConfigInput())
    const start = electronMocks.handlers.get(AI.RUN.START)!
    const cancel = electronMocks.handlers.get(AI.RUN.CANCEL)!
    const owner = sender(10)
    const result = (await start({ sender: owner }, makeRunInput())) as { data: { runId: string } }

    await expect(cancel({ sender: sender(11) }, result.data.runId)).resolves.toMatchObject({
      success: false
    })
    await expect(cancel({ sender: owner }, result.data.runId)).resolves.toMatchObject({
      success: true
    })
  })

  it('lets the owner cancel synchronously from the run-started event', async () => {
    registerAiHandlers(() => null)
    await electronMocks.handlers.get(AI.CONFIG.SET)!({}, makeConfigInput())
    const start = electronMocks.handlers.get(AI.RUN.START)!
    const cancel = electronMocks.handlers.get(AI.RUN.CANCEL)!
    const owner = sender(12)
    let cancellation: Promise<unknown> | undefined
    owner.send.mockImplementation((_channel, event: { type: string; runId: string }) => {
      if (event.type === 'run-started') {
        cancellation = cancel({ sender: owner }, event.runId) as Promise<unknown>
      }
    })

    await start({ sender: owner }, makeRunInput())

    await expect(cancellation).resolves.toMatchObject({ success: true })
  })

  it('does not retain an owner when a run terminates before start returns', async () => {
    registerAiHandlers(() => null)
    await electronMocks.handlers.get(AI.CONFIG.SET)!({}, makeConfigInput())
    providerMocks.completeImmediately = true
    const owner = sender(13)
    const start = electronMocks.handlers.get(AI.RUN.START)!
    const cancel = electronMocks.handlers.get(AI.RUN.CANCEL)!

    const result = await start({ sender: owner }, makeRunInput()) as { data: { runId: string } }
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(
      AI.EVENT,
      expect.objectContaining({ type: 'run-completed' })
    ))

    await expect(cancel({ sender: owner }, result.data.runId)).resolves.toMatchObject({ success: false })
  })

  it('only the run owner may resolve its approval', async () => {
    registerAiHandlers(() => null)
    await electronMocks.handlers.get(AI.CONFIG.SET)!({}, makeConfigInput())
    const start = electronMocks.handlers.get(AI.RUN.START)!
    const resolve = electronMocks.handlers.get(AI.APPROVAL.RESOLVE)!
    const owner = sender(20)
    await start({ sender: owner }, makeRunInput())

    expect(resolve({ sender: sender(21) }, 'unknown', { status: 'rejected' })).toMatchObject({
      success: false
    })
  })

  it('cancels owned runs when a sender is destroyed', async () => {
    registerAiHandlers(() => null)
    await electronMocks.handlers.get(AI.CONFIG.SET)!({}, makeConfigInput())
    const owner = sender(40)
    const start = electronMocks.handlers.get(AI.RUN.START)!
    const cancel = electronMocks.handlers.get(AI.RUN.CANCEL)!
    const input = makeRunInput()
    const run = (await start({ sender: owner }, input) as { data: { runId: string } }).data

    owner.destroy()

    await expect(cancel({ sender: owner }, run.runId)).resolves.toMatchObject({ success: false })
  })

  it('registers an owner-only one-time approval claim channel', () => {
    registerAiHandlers(() => null)
    const claim = electronMocks.handlers.get(AI.APPROVAL.CLAIM)!

    expect(claim({ sender: sender(50) }, 'approval-1')).toMatchObject({ success: false })
    expect(claim({ sender: sender(51) }, '')).toMatchObject({ success: false })
  })

  it('resolves a Main source approval without claim or renderer result', async () => {
    registerAiHandlers(() => null)
    await electronMocks.handlers.get(AI.CONFIG.SET)!({}, makeConfigInput())
    providerMocks.tool = 'main'
    const owner = sender(60)
    const input = makeRunInput()
    input.message = 'Read `C:\\review-source.txt`'

    await electronMocks.handlers.get(AI.RUN.START)!({ sender: owner }, input)
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(
      AI.EVENT,
      expect.objectContaining({ type: 'approval-required' })
    ))
    const approval = owner.send.mock.calls.find((call) => call[1].type === 'approval-required')![1].approval

    expect(electronMocks.handlers.get(AI.APPROVAL.CLAIM)!({ sender: owner }, approval.id)).toMatchObject({ success: false })
    expect(electronMocks.handlers.get(AI.APPROVAL.RESOLVE)!(
      { sender: owner }, approval.id, { status: 'approved', scope: 'once' }
    )).toMatchObject({ success: true })
    await vi.waitFor(() => expect(providerMocks.toolResult).not.toBeNull())
  })

  it('requires the owner to claim, apply and resolve a Renderer write approval', async () => {
    registerAiHandlers(() => null)
    await electronMocks.handlers.get(AI.CONFIG.SET)!({}, makeConfigInput())
    providerMocks.tool = 'renderer'
    const owner = sender(70)

    await electronMocks.handlers.get(AI.RUN.START)!({ sender: owner }, makeRunInput())
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(
      AI.EVENT,
      expect.objectContaining({ type: 'approval-required' })
    ))
    const approval = owner.send.mock.calls.find((call) => call[1].type === 'approval-required')![1].approval
    const resolve = electronMocks.handlers.get(AI.APPROVAL.RESOLVE)!

    expect(resolve({ sender: owner }, approval.id, { status: 'approved', scope: 'once' }, { status: 'applied' })).toMatchObject({ success: false })
    expect(electronMocks.handlers.get(AI.APPROVAL.CLAIM)!({ sender: owner }, approval.id)).toMatchObject({ success: true })
    expect(resolve({ sender: owner }, approval.id, { status: 'approved', scope: 'once' }, { status: 'applied' })).toMatchObject({ success: true })
    await vi.waitFor(() => expect(providerMocks.toolResult).toEqual({ status: 'applied' }))
  })

  it('rejects cross-sender claim and resolution of a real approval', async () => {
    registerAiHandlers(() => null)
    await electronMocks.handlers.get(AI.CONFIG.SET)!({}, makeConfigInput())
    providerMocks.tool = 'renderer'
    const owner = sender(80)
    const stranger = sender(81)

    await electronMocks.handlers.get(AI.RUN.START)!({ sender: owner }, makeRunInput())
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(
      AI.EVENT,
      expect.objectContaining({ type: 'approval-required' })
    ))
    const approval = owner.send.mock.calls.find((call) => call[1].type === 'approval-required')![1].approval

    expect(electronMocks.handlers.get(AI.APPROVAL.CLAIM)!({ sender: stranger }, approval.id)).toMatchObject({ success: false })
    expect(electronMocks.handlers.get(AI.APPROVAL.RESOLVE)!({ sender: stranger }, approval.id, { status: 'rejected' })).toMatchObject({ success: false })
    expect(electronMocks.handlers.get(AI.APPROVAL.CLAIM)!({ sender: owner }, approval.id)).toMatchObject({ success: true })
  })
})

describe('conversation handlers', () => {
  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const handler = electronMocks.handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler({}, ...args)
  }

  beforeEach(() => {
    electronMocks.handlers.clear()
    electronMocks.handle.mockClear()
    electronMocks.removeHandler.mockClear()
    providerMocks.blockResolve = null
    providerMocks.completeImmediately = false
    providerMocks.runStarted.mockClear()
    providerMocks.testedConfig = null
    providerMocks.tool = null
    providerMocks.toolResult = null
    disposeAiServices()
    registerAiHandlers(() => null)
  })

  it('lists, saves, loads and deletes conversations', () => {
    const record = {
      version: 1 as const,
      id: 'conv_1',
      title: 'T',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      messages: [{ id: 'm1', role: 'user', content: 'hi' }],
      toolSummaries: []
    }
    const saved = invoke(IPC_CHANNELS.AI.CONVERSATION.SAVE, null, record) as { success: boolean }
    expect(saved.success).toBe(true)

    const listed = invoke(IPC_CHANNELS.AI.CONVERSATION.LIST, null) as { success: boolean; data: unknown[] }
    expect(listed.success).toBe(true)
    expect(listed.data).toHaveLength(1)

    const loaded = invoke(IPC_CHANNELS.AI.CONVERSATION.LOAD, null, 'conv_1') as { success: boolean; data: unknown }
    expect(loaded.success).toBe(true)
    expect(loaded.data).toMatchObject({ id: 'conv_1' })

    const deleted = invoke(IPC_CHANNELS.AI.CONVERSATION.DELETE, null, 'conv_1') as { success: boolean }
    expect(deleted.success).toBe(true)
    expect(invoke(IPC_CHANNELS.AI.CONVERSATION.LIST, null) as { data: unknown[] }).toMatchObject({ data: [] })
  })

  it('summarizes a conversation title', async () => {
    // SUMMARIZE handler 依赖 getRuntimeConfig()，需先保存带 API Key 的配置
    const setResult = invoke(IPC_CHANNELS.AI.CONFIG.SET, {
      baseUrl: 'https://api.example.com/v1',
      model: 'demo',
      apiKey: 'secret',
      temperature: 0.7
    }) as { success: boolean }
    expect(setResult.success).toBe(true)

    const result = (await invoke(IPC_CHANNELS.AI.CONVERSATION.SUMMARIZE, '请总结')) as {
      success: boolean
      data?: { title: string }
    }
    expect(result.success).toBe(true)
    expect(result.data?.title).toBe('生成标题')
  })

  it('authorizes a workspace root for the sender', async () => {
    summaryMocks.authorize.mockClear()
    const snd = sender(77)
    const handler = electronMocks.handlers.get(IPC_CHANNELS.AI.WORKSPACE.AUTHORIZE)!

    const result = (await handler({ sender: snd }, 'C:\\ws')) as { success: boolean }

    expect(result.success).toBe(true)
    expect(summaryMocks.authorize).toHaveBeenCalledWith(77, 'C:\\ws')
  })

  it('authorize with null revokes the sender workspace', async () => {
    summaryMocks.authorize.mockClear()
    const snd = sender(78)
    const handler = electronMocks.handlers.get(IPC_CHANNELS.AI.WORKSPACE.AUTHORIZE)!

    const result = (await handler({ sender: snd }, null)) as { success: boolean }

    expect(result.success).toBe(true)
    expect(summaryMocks.authorize).toHaveBeenCalledWith(78, null)
  })
})
