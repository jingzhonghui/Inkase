import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AiExecutionSnapshot } from '../../../shared/ai/types'
import { ToolRegistry, defineTool, type ToolExecutionContext } from '../tool-registry'
import { createSourceAuthorizationContext } from '../source-authorization'

const snapshot: AiExecutionSnapshot = {
  runId: 'run-1',
  conversationId: 'conv-1',
  activeDocument: {
    id: 'doc-1',
    title: '示例.md',
    path: '/tmp/示例.md',
    format: 'markdown',
    content: '# 标题',
    revision: 1,
    contentHash: 'hash-1',
    modified: false
  },
  selection: { text: '', from: 0, to: 0, cursor: 0 },
  cursor: 0,
  workspaceRoot: null
}

function context(): ToolExecutionContext {
  return {
    snapshot,
    sourceAuthorization: createSourceAuthorizationContext({ message: '', history: [] })
  }
}

const replaceTool = defineTool({
  name: 'replace_current_document',
  description: '替换当前文档，执行前需要用户批准。',
  inputSchema: z.object({ content: z.string(), reason: z.string() }),
  policy: {
    effect: 'write',
    approval: 'always',
    riskLevel: 'high',
    supportsRememberDecision: false
  },
  execution: 'renderer',
  createRendererOperation: async ({ content, reason }, context) => ({
    type: 'replace-document',
    target: context.snapshot.activeDocument!,
    content,
    reason
  })
})

const readTool = defineTool({
  name: 'read_current_document',
  description: '读取当前文档',
  inputSchema: z.object({}),
  policy: {
    effect: 'read',
    approval: 'never',
    riskLevel: 'low',
    supportsRememberDecision: false
  },
  execution: 'main',
  execute: async (_input, context) => ({ documentId: context.snapshot.activeDocument?.id })
})

describe('defineTool', () => {
  it('returns the tool definition unchanged', () => {
    expect(defineTool(replaceTool)).toBe(replaceTool)
  })
})

describe('ToolRegistry', () => {
  it('rejects duplicate tool names', () => {
    const registry = new ToolRegistry()
    registry.register(replaceTool)
    expect(() => registry.register(replaceTool)).toThrow(/已注册/)
  })

  it('converts tools into provider tools preserving description and schema', () => {
    const registry = new ToolRegistry()
    registry.register(replaceTool)
    const tools = registry.toProviderTools(context())

    const providerTool = tools.replace_current_document
    expect(providerTool.description).toBe('替换当前文档，执行前需要用户批准。')
    expect(providerTool.inputSchema).toBe(replaceTool.inputSchema)
    expect(providerTool).not.toHaveProperty('policy')
    expect(providerTool).not.toHaveProperty('execution')
    expect(providerTool).not.toHaveProperty('createApprovalPreview')
    expect(providerTool).not.toHaveProperty('name')
  })

  it('executes a renderer tool by building the approved document operation', async () => {
    const registry = new ToolRegistry()
    registry.register(replaceTool)
    const tools = registry.toProviderTools(context())

    const result = await tools.replace_current_document.execute({
      content: '新内容',
      reason: '用户要求'
    })

    expect(result).toEqual({
      status: 'completed',
      data: {
        type: 'replace-document',
        target: snapshot.activeDocument,
        content: '新内容',
        reason: '用户要求'
      }
    })
  })

  it('executes a main tool with the execution context', async () => {
    const registry = new ToolRegistry()
    registry.register(readTool)
    const tools = registry.toProviderTools(context())

    const result = await tools.read_current_document.execute({})

    expect(result).toEqual({ status: 'completed', data: { documentId: 'doc-1' } })
  })

  it('returns a failed result when input fails validation', async () => {
    const registry = new ToolRegistry()
    registry.register(replaceTool)
    const tools = registry.toProviderTools(context())

    const result = await tools.replace_current_document.execute({ content: 123 })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.message).toContain('输入')
    }
  })
})
