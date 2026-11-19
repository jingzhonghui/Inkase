import * as fs from 'fs'
import * as path from 'path'
import { createHash, randomBytes } from 'crypto'
import { app, safeStorage } from 'electron'
import type {
  AiConfigInput,
  AiConfigView,
  AiConnectionTestResult,
  AiErrorCode,
  AiRuntimeConfig
} from '../../shared/ai/types'
import { MAX_AI_MODEL_ID_LENGTH, MAX_AI_MODELS } from '../../shared/ai/types'
import {
  normalizeAiPermissionMode,
  type AiPermissionMode
} from '../../shared/ai/permission'
import {
  normalizeAiApiFormat,
  type AiApiFormat
} from '../../shared/ai/api-format'

interface StoredAiConfig extends Omit<AiConfigInput, 'apiKey'> {
  /**
   * 旧版本存的是 `approvalMode: 'ask' | 'auto'`。
   * 读取时并入 `permissionMode`，写入时只产出新字段（一次性迁移）。
   */
  approvalMode?: string
  apiKeyEncrypted?: string
  apiKeyOrigin?: string
  capabilityTest?: {
    salt: string
    fingerprint: string
    result: AiConnectionTestResult
  }
}

export class AiConfigError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AiConfigError'
  }
}

export function normalizeAiBaseUrl(rawUrl: string): string {
  const url = rawUrl.trim().replace(/\/+$/, '')

  let protocol: string
  try {
    const parsed = new URL(url)
    protocol = parsed.protocol
  } catch {
    throw new Error('无效的 AI 服务地址')
  }

  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('AI 服务地址仅支持 HTTP 或 HTTPS')
  }

  return url
}

/**
 * 模型目录归一：去空、去重、限长、限量。
 *
 * `undefined` 与 `[]` 语义不同——前者表示「本次不改变」（设置中心保存其它
 * 参数时不携带它），后者表示「目录清空」。所以不能用 `?? []` 在入口抹平。
 */
function normalizeModelList(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id || id.length > MAX_AI_MODEL_ID_LENGTH || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_AI_MODELS) break
  }
  return out
}

/**
 * 当前模型必须出现在目录里，否则面板下拉会「打开找不到自己」。
 *
 * 手填的模型（服务商没实现 /models 时）不在已获取列表里，把它插到首位而不
 * 是丢掉；目录为空时它自然成为唯一一项——面板下拉仍可展开，把这一项勾在自己
 * 身上（一项就锁死不让点，用户只会认为按钮坏了）。
 */
function withActiveModel(models: string[], model: string | undefined): string[] {
  const id = (model ?? '').trim()
  if (!id || models.includes(id)) return models
  return [id, ...models].slice(0, MAX_AI_MODELS)
}

export class AiConfigService {
  private memoryKey: string | undefined
  private memoryKeyOrigin: string | undefined

  constructor(
    private readonly configPath = path.join(app.getPath('userData'), 'ai-config.json')
  ) {}

  getView(): AiConfigView {
    return this.toView(this.read())
  }

  save(input: AiConfigInput): AiConfigView {
    const existing = this.read()
    const baseUrl = normalizeAiBaseUrl(input.baseUrl)
    const origin = new URL(baseUrl).origin
    const stored: StoredAiConfig = {
      baseUrl,
      // 旧配置没有这个字段，归一后落回 `openai-compatible`：升级不该改变任何人的连接方式
      apiFormat: normalizeAiApiFormat(input.apiFormat),
      model: input.model,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      contextWindow: input.contextWindow,
      maxSteps: input.maxSteps,
      maxReadBytes: input.maxReadBytes,
      idleTimeoutMs: input.idleTimeoutMs,
      // 设置中心不再提供这个开关，保存其余参数时不能把用户在 AI 面板里选的模式冲掉：
      // undefined 表示「本次不改变」。
      permissionMode:
        input.permissionMode === undefined
          ? this.storedPermissionMode(existing)
          : normalizeAiPermissionMode(input.permissionMode)
    }

    // 模型目录同理：undefined = 本次不改变；给了就按「当前模型必须在其中」归一
    const models = normalizeModelList(input.models)
    if (models !== undefined) {
      stored.models = withActiveModel(models, input.model)
    } else {
      const previous = normalizeModelList(existing.models)
      if (previous !== undefined) stored.models = withActiveModel(previous, input.model)
    }

    const existingKeyOrigin = existing.apiKeyOrigin ?? this.originOf(existing.baseUrl)
    if (existing.apiKeyEncrypted && existingKeyOrigin === origin) {
      stored.apiKeyEncrypted = existing.apiKeyEncrypted
      stored.apiKeyOrigin = origin
    } else if (this.memoryKeyOrigin !== origin) {
      this.memoryKey = undefined
      this.memoryKeyOrigin = undefined
    }

    stored.capabilityTest = existing.capabilityTest

    if (typeof input.apiKey === 'string' && input.apiKey.length > 0) {
      if (safeStorage.isEncryptionAvailable()) {
        stored.apiKeyEncrypted = safeStorage.encryptString(input.apiKey).toString('base64')
        stored.apiKeyOrigin = origin
        this.memoryKey = undefined
        this.memoryKeyOrigin = undefined
      } else {
        this.memoryKey = input.apiKey
        this.memoryKeyOrigin = origin
      }
    }

    this.write(stored)
    return this.toView(stored)
  }

  recordCapabilityTest(config: AiRuntimeConfig, result: AiConnectionTestResult): void {
    const stored = this.read()
    const salt = randomBytes(16).toString('hex')
    stored.capabilityTest = {
      salt,
      fingerprint: this.capabilityFingerprint(config, salt),
      result
    }
    this.write(stored)
  }

  getRuntimeConfig(): AiRuntimeConfig {
    const stored = this.read()
    const apiKey = this.resolveApiKey(stored)
    if (!apiKey) {
      throw new AiConfigError('CONFIG_MISSING', 'AI 配置缺失：未设置可用的 API Key')
    }

    return {
      baseUrl: stored.baseUrl,
      apiFormat: normalizeAiApiFormat(stored.apiFormat),
      model: stored.model,
      apiKey,
      temperature: stored.temperature,
      maxOutputTokens: stored.maxOutputTokens,
      contextWindow: stored.contextWindow,
      maxSteps: stored.maxSteps,
      maxReadBytes: stored.maxReadBytes,
      idleTimeoutMs: stored.idleTimeoutMs,
      permissionMode: this.storedPermissionMode(stored)
    }
  }

  /**
   * 只改权限模式，不碰其它字段，也不要求填完整配置。
   *
   * 面板里的下拉是独立于设置中心的入口：用户可能还没配好 API Key 就想先选模式，
   * 也可能正在跑任务时切换。因此这里单独写一条路径，而不是复用 `save()`。
   */
  setPermissionMode(mode: AiPermissionMode): AiConfigView {
    const stored = this.read()
    const next: StoredAiConfig = {
      ...stored,
      permissionMode: normalizeAiPermissionMode(mode)
    }
    // 旧字段不再保留：下次读配置时不会出现两个真相
    delete next.approvalMode
    this.write(next)
    return this.toView(next)
  }

  clear(): void {
    this.memoryKey = undefined
    this.memoryKeyOrigin = undefined
    fs.rmSync(this.configPath, { force: true })
  }

  /**
   * 只改当前模型，不碰其它字段。
   *
   * 面板里的模型下拉直接调这里。三条约束：
   * 1. 目标必须在目录内（目录为空时不限制）——防止面板拿着过期列表，把设置页
   *    刚删掉的模型写回去；
   * 2. 不重建 runtime：下一次 `AI.RUN.START` 的 `ensureRuntime` 会发现 model 变了
   *    并按需重建，运行中的那一轮不会被切换打断；
   * 3. 不改 `models`，切换模型不该改变可选范围。
   */
  setModel(model: string): AiConfigView {
    const id = model.trim()
    if (!id) throw new Error('模型名不能为空')
    if (id.length > MAX_AI_MODEL_ID_LENGTH) {
      throw new Error(`模型名过长，最多 ${MAX_AI_MODEL_ID_LENGTH} 个字符`)
    }

    const stored = this.read()
    const models = normalizeModelList(stored.models) ?? []
    if (models.length > 0 && !models.includes(id)) {
      throw new Error('该模型已不在可选列表中，请重新选择')
    }

    const next: StoredAiConfig = { ...stored, model: id }
    this.write(next)
    return this.toView(next)
  }

  /**
   * 按需返回明文 Key。
   *
   * 只给设置页的「小眼睛」用。`getView()` 永远不含明文，这条独立通道把明文
   * 的暴露面收窄到「用户显式点击」这一个动作上；没有可用 Key 时返回 undefined，
   * 不抛错——「看不了」不是错误。
   */
  revealApiKey(): string | undefined {
    return this.resolveApiKey(this.read())
  }

  /**
   * 读出的权限模式：新字段优先，旧字段（approvalMode）兜底，缺省为 standard。
   * 旧值 `ask` 由 normalize 映射成 `standard`。
   */
  private storedPermissionMode(stored: StoredAiConfig): AiPermissionMode {
    return normalizeAiPermissionMode(stored.permissionMode ?? stored.approvalMode)
  }

  private read(): StoredAiConfig {
    try {
      if (!fs.existsSync(this.configPath)) return {} as StoredAiConfig
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as StoredAiConfig
    } catch {
      return {} as StoredAiConfig
    }
  }

  private write(stored: StoredAiConfig): void {
    const dir = path.dirname(this.configPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.configPath, JSON.stringify(stored, null, 2), 'utf8')
  }

  private resolveApiKey(stored: StoredAiConfig): string | undefined {
    const origin = this.originOf(stored.baseUrl)
    if (this.memoryKey && this.memoryKeyOrigin === origin) return this.memoryKey
    const keyOrigin = stored.apiKeyOrigin ?? origin
    if (stored.apiKeyEncrypted && keyOrigin === origin && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored.apiKeyEncrypted, 'base64'))
    }
    return undefined
  }

  private toView(stored: StoredAiConfig): AiConfigView {
    const { apiKeyEncrypted, apiKeyOrigin, capabilityTest, ...restRaw } = stored as StoredAiConfig & { systemPrompt?: string }
    const rest = { ...restRaw }
    delete rest.systemPrompt
    // 旧字段只在 storedPermissionMode 里兜底读取，视图里不能露出来
    delete rest.approvalMode
    const permissionMode = this.storedPermissionMode(stored)
    // 统一出口：配置里存的是旧格式、非法值还是什么都没有，视图里都必须是合法值
    const apiFormat: AiApiFormat = normalizeAiApiFormat(stored.apiFormat)
    // 视图出口也要归一：老配置、或「只改温度」那种不携带 models 的保存都没写过
    // 这个字段，直接读出来是空数组，面板下拉就会一个候选都没有、点了毫无反应
    const models = withActiveModel(normalizeModelList(stored.models) ?? [], stored.model)
    const origin = this.originOf(stored.baseUrl)
    const apiKey = this.resolveApiKey(stored)
    const hasApiKey = !!(
      (this.memoryKey && this.memoryKeyOrigin === origin) ||
      (apiKeyEncrypted && (apiKeyOrigin ?? origin) === origin)
    )
    const evidenceMatches = !!(
      capabilityTest &&
      apiKey &&
      capabilityTest.fingerprint === this.capabilityFingerprint({ ...rest, apiKey }, capabilityTest.salt)
    )
    return {
      ...rest,
      apiFormat,
      models,
      permissionMode,
      hasApiKey,
      /**
       * 只要地址、模型与 API Key 齐备就算就绪，不再要求先跑通能力探测。
       *
       * 探测是把已有配置「验证一遍」，不是使用的前置条件：模型能力因服务商而异，
       * 硬性要求探测会把「配置已经正确」的用户挡在发送按钮外面。探测结果仍然
       * 通过 capabilities 展示，供用户判断工具调用是否被支持。
       */
      ready: !!(hasApiKey && stored.baseUrl?.trim() && stored.model?.trim()),
      capabilities: evidenceMatches ? capabilityTest.result : undefined
    }
  }

  private capabilityFingerprint(config: AiRuntimeConfig, salt: string): string {
    return createHash('sha256')
      .update(salt)
      .update(JSON.stringify({
        baseUrl: normalizeAiBaseUrl(config.baseUrl),
        // 接口格式改变的是「用哪套协议」：同一地址/模型/Key 换了格式，能力结论不能复用
        apiFormat: normalizeAiApiFormat(config.apiFormat),
        model: config.model,
        apiKey: config.apiKey,
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
        contextWindow: config.contextWindow,
        maxSteps: config.maxSteps,
        maxReadBytes: config.maxReadBytes,
        idleTimeoutMs: config.idleTimeoutMs
        // 权限模式不参与指纹：它决定「怎么执行」，不影响模型能力，
        // 切换模式不该让「能力已验证」的结论失效
      }))
      .digest('hex')
  }

  private originOf(baseUrl: string | undefined): string | undefined {
    if (!baseUrl) return undefined
    try {
      return new URL(normalizeAiBaseUrl(baseUrl)).origin
    } catch {
      return undefined
    }
  }
}
