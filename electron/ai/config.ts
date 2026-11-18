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

interface StoredAiConfig extends Omit<AiConfigInput, 'apiKey'> {
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
      model: input.model,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      contextWindow: input.contextWindow,
      maxSteps: input.maxSteps,
      maxReadBytes: input.maxReadBytes,
      idleTimeoutMs: input.idleTimeoutMs,
      approvalMode: input.approvalMode
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
      model: stored.model,
      apiKey,
      temperature: stored.temperature,
      maxOutputTokens: stored.maxOutputTokens,
      contextWindow: stored.contextWindow,
      maxSteps: stored.maxSteps,
      maxReadBytes: stored.maxReadBytes,
      idleTimeoutMs: stored.idleTimeoutMs,
      approvalMode: stored.approvalMode
    }
  }

  clear(): void {
    this.memoryKey = undefined
    this.memoryKeyOrigin = undefined
    fs.rmSync(this.configPath, { force: true })
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
        model: config.model,
        apiKey: config.apiKey,
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
        contextWindow: config.contextWindow,
        maxSteps: config.maxSteps,
        maxReadBytes: config.maxReadBytes,
        idleTimeoutMs: config.idleTimeoutMs,
        approvalMode: config.approvalMode
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
