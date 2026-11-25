/**
 * AI 配置的默认值。
 *
 * 这里只放「用户可以不填、但运行期必须有一个值」的参数（目前只有温度）。
 * 「留空 = 不传给模型、由服务商决定」的字段不要搬进来——那类字段用 `undefined`
 * 表达本身就是正确的（例如 `maxOutputTokens`）。
 *
 * 温度之所以必须有应用侧默认值：各家服务商的默认温度并不一致（OpenAI / DeepSeek
 * 都是 1.0），不补值会让同一个应用换个 Provider 就变一种输出风格；而 AI 助手
 * 重度依赖工具调用，高温度会明显抬高参数不合规的概率。`0.3` 这个值与设置页的
 * 旧初始值、标题生成/通用文本生成的硬编码温度一致。
 */
export const DEFAULT_AI_TEMPERATURE = 0.3

/** 温度合法区间：主进程 schema 与设置页输入框共用同一把尺子。 */
export const MIN_AI_TEMPERATURE = 0
export const MAX_AI_TEMPERATURE = 2

/**
 * 把任意来源的温度收敛成合法值。
 *
 * 「任意来源」包括：从未保存过配置（字段缺失）、旧配置没有该字段、手改
 * `ai-config.json` 写坏（`null` / 字符串）、渲染层把空输入变成 `Number('')`
 * 或 `Number(undefined)`。这些都落回默认值，而不是把 `NaN` 递进模型请求。
 */
export function normalizeAiTemperature(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_AI_TEMPERATURE
  }
  return Math.min(Math.max(value, MIN_AI_TEMPERATURE), MAX_AI_TEMPERATURE)
}
