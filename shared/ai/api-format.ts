/**
 * AI 接口格式（协议）。
 *
 * 它决定「用哪套 HTTP 协议跟服务端说话」，不是「要不要流式」这类开关：
 * - `openai-compatible`：标准 `/chat/completions`，中转站与自建服务的通用选择（默认）；
 * - `openai-responses`：官方新版 `/responses` 接口。
 *
 * 为什么不一口气支持 Anthropic / Gemini：那要再进两个 provider 包，且两者的模型列表
 * 鉴权头与响应结构都不同。目前只保留 OpenAI 家族，新增格式时在
 * `electron/ai/model-factory.ts` 与（若列表接口不同）`model-catalog.ts` 补分支即可。
 *
 * 取值与文案只在这里维护一份：主进程校验、设置页下拉、旧配置迁移都读它。
 */
export const AI_API_FORMATS = ['openai-compatible', 'openai-responses'] as const

export type AiApiFormat = (typeof AI_API_FORMATS)[number]

export const DEFAULT_AI_API_FORMAT: AiApiFormat = 'openai-compatible'

export interface AiApiFormatOption {
  value: AiApiFormat
  label: string
  /** 下拉里的一句话说明；写「它是什么」，不写「推荐」。 */
  hint: string
  /** 地址输入框的占位提示：让人一眼看出该填到哪一层。 */
  baseUrlPlaceholder: string
}

export const AI_API_FORMAT_OPTIONS: readonly AiApiFormatOption[] = [
  {
    value: 'openai-compatible',
    label: 'OpenAI 兼容',
    hint: '标准 /chat/completions，中转站与自建服务的通用选择',
    baseUrlPlaceholder: 'https://api.example.com/v1'
  },
  {
    value: 'openai-responses',
    label: 'OpenAI Responses',
    hint: '官方新版 /responses 接口，支持内置工具与更长的上下文',
    baseUrlPlaceholder: 'https://api.openai.com/v1'
  }
]

/**
 * 把配置、IPC 里的任意值收敛成合法格式。
 *
 * 旧配置根本没有这个字段，读出来是 `undefined`——它必须落回默认的
 * `openai-compatible`，否则升级后所有人的连接都会变成未知格式。
 */
export function normalizeAiApiFormat(value: unknown): AiApiFormat {
  if (typeof value !== 'string') return DEFAULT_AI_API_FORMAT
  const candidate = value.trim().toLowerCase()
  if ((AI_API_FORMATS as readonly string[]).includes(candidate)) {
    return candidate as AiApiFormat
  }
  return DEFAULT_AI_API_FORMAT
}

/** 取某个格式的展示信息；非法值走默认值，调用方不用写兜底分支。 */
export function apiFormatOption(format: AiApiFormat): AiApiFormatOption {
  return AI_API_FORMAT_OPTIONS.find((option) => option.value === format) ?? AI_API_FORMAT_OPTIONS[0]
}
