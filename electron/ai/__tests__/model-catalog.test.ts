import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchModelCatalog, ModelCatalogError } from '../model-catalog'

function jsonResponse(payload: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: vi.fn(async () => {}) },
    json: async () => payload
  } as unknown as Response
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: vi.fn(async () => {}) },
    json: async () => JSON.parse(body)
  } as unknown as Response
}

const fetchMock = vi.fn()

describe('fetchModelCatalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  function stubFetch(response: Response | Error): void {
    fetchMock.mockImplementation(async () => {
      if (response instanceof Error) throw response
      return response
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  it('reads the standard OpenAI { data: [{ id }] } shape', async () => {
    stubFetch(jsonResponse({
      object: 'list',
      data: [
        { id: 'gpt-4o', object: 'model' },
        { id: 'gpt-4o-mini', object: 'model' }
      ]
    }))

    await expect(
      fetchModelCatalog({ baseUrl: 'https://api.example.com/v1', apiKey: 'secret' })
    ).resolves.toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('requests {baseUrl}/models with the bearer token', async () => {
    stubFetch(jsonResponse({ data: [{ id: 'demo' }] }))

    await fetchModelCatalog({ baseUrl: 'https://api.example.com/v1/', apiKey: 'secret' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // 末尾斜杠由 normalizeAiBaseUrl 收掉，避免拼出 //models
    expect(url).toBe('https://api.example.com/v1/models')
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      authorization: 'Bearer secret'
    })
  })

  it('omits the auth header when there is no key, so local services still work', async () => {
    stubFetch(jsonResponse({ data: [{ id: 'llama3' }] }))

    await fetchModelCatalog({ baseUrl: 'http://127.0.0.1:11434/v1' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).not.toHaveProperty('authorization')
  })

  it('accepts the flat-array, { models } and bare-string shapes', async () => {
    stubFetch(jsonResponse(['b-model', 'a-model']))
    await expect(
      fetchModelCatalog({ baseUrl: 'https://api.example.com/v1' })
    ).resolves.toEqual(['a-model', 'b-model'])

    stubFetch(jsonResponse({ models: [{ name: 'qwen:7b' }, { id: 'qwen:14b' }] }))
    await expect(
      fetchModelCatalog({ baseUrl: 'https://api.example.com/v1' })
    ).resolves.toEqual(['qwen:14b', 'qwen:7b'])

    stubFetch(jsonResponse({ data: ['gpt-4o'] }))
    await expect(
      fetchModelCatalog({ baseUrl: 'https://api.example.com/v1' })
    ).resolves.toEqual(['gpt-4o'])
  })

  it('trims, dedupes, skips junk entries and sorts the ids', async () => {
    stubFetch(jsonResponse({
      data: [
        { id: '  gpt-4o  ' },
        { id: 'gpt-4o' },
        { id: '' },
        { id: 'x'.repeat(201) },
        { nope: true },
        null,
        { id: 'gpt-4o-mini' }
      ]
    }))

    await expect(
      fetchModelCatalog({ baseUrl: 'https://api.example.com/v1' })
    ).resolves.toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('maps auth, missing-endpoint, rate-limit and server failures to readable text', async () => {
    for (const [status, message] of [
      [401, '鉴权失败：API Key 无效或未授权'],
      [403, '鉴权失败：API Key 无效或未授权'],
      [404, '该地址没有 /models 接口，请确认地址以 /v1 结尾'],
      [429, '请求过于频繁：已触发速率限制'],
      [500, 'AI 服务暂时不可用：服务器错误'],
      [418, '获取模型列表失败：HTTP 418']
    ] as const) {
      stubFetch(jsonResponse({ error: 'nope' }, { status }))
      await expect(
        fetchModelCatalog({ baseUrl: 'https://api.example.com/v1' })
      ).rejects.toThrow(message)
    }
  })

  it('cancels the unread body of a failed response', async () => {
    const response = jsonResponse({ error: 'nope' }, { status: 401 })
    stubFetch(response)

    await expect(
      fetchModelCatalog({ baseUrl: 'https://api.example.com/v1' })
    ).rejects.toThrow(ModelCatalogError)
    expect(response.body?.cancel).toHaveBeenCalled()
  })

  it('reports a non-JSON body as a wrong endpoint', async () => {
    stubFetch(textResponse('<html>not json</html>'))

    await expect(
      fetchModelCatalog({ baseUrl: 'https://api.example.com/v1' })
    ).rejects.toThrow('该地址返回的不是 JSON，可能不是模型列表接口')
  })

  it('reports an empty catalog instead of returning a useless empty list', async () => {
    stubFetch(jsonResponse({ data: [] }))

    await expect(
      fetchModelCatalog({ baseUrl: 'https://api.example.com/v1' })
    ).rejects.toThrow('该服务没有返回任何模型')
  })

  it('reports a timeout when the service never answers', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchModelCatalog({ baseUrl: 'https://api.example.com/v1', timeoutMs: 1 })
    ).rejects.toThrow('获取模型列表超时：AI 服务长时间无响应')
  })

  it('wraps a network failure with the underlying detail', async () => {
    stubFetch(new TypeError('fetch failed'))

    await expect(
      fetchModelCatalog({ baseUrl: 'https://api.example.com/v1' })
    ).rejects.toThrow('无法连接到 AI 服务：fetch failed')
  })

  it('rejects a non-HTTP address before making a request', async () => {
    stubFetch(jsonResponse({ data: [{ id: 'demo' }] }))

    await expect(fetchModelCatalog({ baseUrl: 'ftp://api.example.com/v1' })).rejects.toThrow(
      'AI 服务地址仅支持 HTTP 或 HTTPS'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
