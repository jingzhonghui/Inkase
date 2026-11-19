import { beforeEach, describe, expect, it, vi } from 'vitest'

const factoryMocks = vi.hoisted(() => ({
  createOpenAICompatible: vi.fn((settings: Record<string, unknown>) => {
    const factory = vi.fn((model: string) => ({ kind: 'compatible', model, settings }))
    return Object.assign(factory, { settings })
  }),
  createOpenAI: vi.fn((settings: Record<string, unknown>) => ({
    settings,
    responses: vi.fn((model: string) => ({ kind: 'responses', model, settings }))
  }))
}))

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: factoryMocks.createOpenAICompatible
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: factoryMocks.createOpenAI
}))

import { createLanguageModel } from '../model-factory'

describe('createLanguageModel', () => {
  beforeEach(() => {
    factoryMocks.createOpenAICompatible.mockClear()
    factoryMocks.createOpenAI.mockClear()
  })

  it('uses the chat-completions provider for openai-compatible', () => {
    const model = createLanguageModel({
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'secret',
      model: 'gpt-4o'
    }) as unknown as { kind: string; model: string }

    expect(model.kind).toBe('compatible')
    expect(model.model).toBe('gpt-4o')
    expect(factoryMocks.createOpenAI).not.toHaveBeenCalled()
    expect(factoryMocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: 'inkase',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'secret'
    })
  })

  it('uses the responses endpoint for openai-responses', () => {
    const model = createLanguageModel({
      apiFormat: 'openai-responses',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'secret',
      model: 'gpt-4o'
    }) as unknown as { kind: string; model: string }

    expect(model.kind).toBe('responses')
    expect(model.model).toBe('gpt-4o')
    expect(factoryMocks.createOpenAICompatible).toHaveBeenCalledTimes(0)
    expect(factoryMocks.createOpenAI).toHaveBeenCalledWith({
      name: 'inkase',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'secret'
    })
  })

  it('defaults to openai-compatible when the format is missing or unknown', () => {
    for (const apiFormat of [undefined, 'nope' as never]) {
      const model = createLanguageModel({
        apiFormat,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        model: 'demo'
      }) as unknown as { kind: string }

      expect(model.kind).toBe('compatible')
    }

    expect(factoryMocks.createOpenAI).not.toHaveBeenCalled()
  })
})
