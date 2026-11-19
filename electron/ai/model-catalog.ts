import { MAX_AI_MODEL_ID_LENGTH } from '../../shared/ai/types'
import { normalizeAiBaseUrl } from './config'

/**
 * 拉取模型目录（`GET {baseUrl}/models`）。
 *
 * 为什么在主进程做：API Key 只存在于主进程（加密落盘 / 内存回退），把请求交给
 * 渲染进程意味着把明文 Key 递出去。这里和「测试连接」同一条原则——渲染层只发
 * 「地址 + 我要列模型」，不接触凭据。
 *
 * 两种接口格式（`openai-compatible` / `openai-responses`）的列表端点与鉴权头
 * 完全相同，所以这里不按格式分派；将来若接入 Anthropic / Gemini 原生端点，
 * 分派点就在这个函数里。
 */
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_ENTRIES = 500

export class ModelCatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelCatalogError'
  }
}

export interface ModelCatalogInput {
  baseUrl: string
  /** 缺省表示「没有可用 Key」：不发 Authorization 头，支持本地无鉴权服务 */
  apiKey?: string
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 状态码到人话。
 *
 * 不复用 `mapProviderError`：那套措辞是围绕「对话请求」写的（404 会说成
 * 「模型不存在」），套在「列举模型」上只会误导。
 */
function statusMessage(status: number): string {
  if (status === 401 || status === 403) return '鉴权失败：API Key 无效或未授权'
  if (status === 404) return '该地址没有 /models 接口，请确认地址以 /v1 结尾'
  if (status === 429) return '请求过于频繁：已触发速率限制'
  if (status >= 500) return 'AI 服务暂时不可用：服务器错误'
  return `获取模型列表失败：HTTP ${status}`
}

/**
 * 从响应体里挖出模型标识。
 *
 * 公开实现至少有三种形态，全都接住：OpenAI 标准 `{ data: [{ id }] }`、
 * 部分网关的 `{ data: ["gpt-4o"] }`、本地服务的 `{ models: [...] }` 或裸数组。
 */
function extractModelIds(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : []

  const ids: string[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      ids.push(item)
      continue
    }
    if (!isRecord(item)) continue
    if (typeof item.id === 'string') ids.push(item.id)
    else if (typeof item.name === 'string') ids.push(item.name)
  }
  return ids
}

/** 去空、去重、限长、限量，最后按字典序排——用户找模型时顺序必须稳定。 */
function normalizeIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const id = raw.trim()
    if (!id || id.length > MAX_AI_MODEL_ID_LENGTH || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_ENTRIES) break
  }
  if (out.length === 0) throw new ModelCatalogError('该服务没有返回任何模型')
  return out.sort((a, b) => a.localeCompare(b))
}

export async function fetchModelCatalog(input: ModelCatalogInput): Promise<string[]> {
  const baseUrl = normalizeAiBaseUrl(input.baseUrl)
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const apiKey = input.apiKey?.trim()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      }
    })

    if (!response.ok) {
      // 不读的响应体要主动取消，否则连接会挂着不放
      await response.body?.cancel().catch(() => {})
      throw new ModelCatalogError(statusMessage(response.status))
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new ModelCatalogError('该地址返回的不是 JSON，可能不是模型列表接口')
    }

    return normalizeIds(extractModelIds(payload))
  } catch (error) {
    if (error instanceof ModelCatalogError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ModelCatalogError('获取模型列表超时：AI 服务长时间无响应')
    }
    const detail = error instanceof Error ? error.message : ''
    throw new ModelCatalogError(detail ? `无法连接到 AI 服务：${detail}` : '无法连接到 AI 服务')
  } finally {
    clearTimeout(timer)
  }
}
