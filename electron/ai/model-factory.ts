import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { normalizeAiApiFormat, type AiApiFormat } from '../../shared/ai/api-format'

export interface LanguageModelInput {
  /** 接口格式（协议）；缺省按 `openai-compatible` 处理 */
  apiFormat?: AiApiFormat
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 按接口格式造出语言模型实例。
 *
 * 单独抽成纯函数（而不是留在 `VercelAiSdkProvider` 的私有方法里）是为了能单测
 * 「选了哪个格式就调了哪个 provider」——私有方法只能连同整条请求一起测。
 *
 * 两个分支的差别只是协议：`openai-compatible` 走 `/chat/completions`，
 * `openai-responses` 走官方 `/responses`。鉴权、温度、工具调用对上层完全一致，
 * 所以 `run` / `testConnection` / `summarize` 都不需要知道自己用的是什么格式。
 */
export function createLanguageModel(input: LanguageModelInput): LanguageModel {
  const apiFormat = normalizeAiApiFormat(input.apiFormat)

  if (apiFormat === 'openai-responses') {
    return createOpenAI({
      name: 'inkase',
      baseURL: input.baseUrl,
      apiKey: input.apiKey
    }).responses(input.model)
  }

  return createOpenAICompatible({
    name: 'inkase',
    baseURL: input.baseUrl,
    apiKey: input.apiKey
  })(input.model)
}
