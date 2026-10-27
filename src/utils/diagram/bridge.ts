/**
 * draw.io embed 协议的前端桥接。
 *
 * 职责边界很窄：只负责「往 iframe 发消息 / 收消息 / 配对请求」，
 * 不碰 Pinia、不碰 DOM 结构，方便单测与复用（例如以后给 Markdown 预览做只读渲染）。
 *
 * 两个实测得到的约束（见 A0 spike）：
 * 1. `format: 'xml'` 的导出结果在 `payload.xml`，不在 `payload.data`；
 * 2. 一次编辑会连发多条 `autosave`，第一条常常是中间态，
 *    所以**不能**用第一条做「已保存」判断，取最后一条（本类按去抖合并处理）。
 */

import {
  buildDiagramEmbedUrl,
  pickEventXml,
  type DiagramEditorEvent,
  type DiagramEmbedOptions,
  type DiagramExportEvent
} from '../../../shared/diagram/embed'

export interface DiagramBridgeOptions {
  /** 消息来源校验：只接受这个 window 发来的消息 */
  target: () => Window | null
  /** 收到 autosave / load 时回调（已去抖） */
  onAutosave?: (xml: string) => void
  /** autosave 合并窗口，默认 350ms */
  autosaveDebounceMs?: number
  /** 单次请求超时，默认 20s（大图导出会慢） */
  requestTimeoutMs?: number
}

interface PendingRequest {
  match: (event: DiagramEditorEvent) => boolean
  resolve: (event: DiagramEditorEvent) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  label: string
}

export class DiagramBridge {
  private readonly target: () => Window | null
  private readonly onAutosave?: (xml: string) => void
  private readonly autosaveDebounceMs: number
  private readonly requestTimeoutMs: number

  private pending: PendingRequest[] = []
  private listener: ((event: MessageEvent) => void) | null = null
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null
  private pendingAutosaveXml = ''
  private initResolve: ((event: DiagramEditorEvent) => void) | null = null
  private initPromise: Promise<DiagramEditorEvent> | null = null
  private disposed = false

  constructor(options: DiagramBridgeOptions) {
    this.target = options.target
    this.onAutosave = options.onAutosave
    this.autosaveDebounceMs = options.autosaveDebounceMs ?? 350
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20000
  }

  /** 拼 iframe 地址（renderer 侧唯一入口，保证参数一致） */
  static url(options: DiagramEmbedOptions = {}): string {
    return buildDiagramEmbedUrl(options)
  }

  /** 开始监听消息。必须早于 iframe 加载完成调用，否则会漏掉 `init`。 */
  start(): void {
    if (this.listener) return
    this.listener = (event: MessageEvent) => this.handleMessage(event)
    window.addEventListener('message', this.listener)
  }

  /** 等到 draw.io 发来 `{event:'init'}`：此时编辑器已就绪，可以发指令了。 */
  waitForInit(timeoutMs = 30000): Promise<DiagramEditorEvent> {
    if (this.initPromise) return this.initPromise
    this.start()
    this.initPromise = new Promise<DiagramEditorEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.initPromise = null
        this.initResolve = null
        reject(new Error('draw.io 编辑器初始化超时'))
      }, timeoutMs)
      this.initResolve = (event) => {
        clearTimeout(timer)
        resolve(event)
      }
    })
    return this.initPromise
  }

  /** 装载一份图表（XML 字符串）。 */
  async load(xml: string, options: { title?: string } = {}): Promise<void> {
    await this.waitForInit()
    await this.request('load', (event) => event.event === 'load', {
      action: 'load',
      xml,
      autosave: 1,
      title: options.title
    })
  }

  /** 用 Mermaid 文本生成图表（draw.io 内置 descriptor 解析，离线可用）。 */
  async loadMermaid(text: string, options: { title?: string } = {}): Promise<void> {
    await this.waitForInit()
    await this.request('loadMermaid', (event) => event.event === 'load', {
      action: 'load',
      descriptor: { format: 'mermaid', data: text, wrap: true },
      autosave: 1,
      title: options.title
    })
  }

  /** 导出：`xml` 拿回当前模型的完整 mxfile，`svg`/`png` 拿回 data URL。 */
  async exportAs(format: 'xml' | 'svg' | 'png' | 'xmlpng'): Promise<DiagramExportEvent> {
    await this.waitForInit()
    const event = await this.request(
      `export:${format}`,
      (candidate) => candidate.event === 'export' && (candidate as DiagramExportEvent).format === format,
      { action: 'export', format, border: 10, spinKey: 'export' }
    )
    return event as DiagramExportEvent
  }

  /** 立刻要一份当前 XML：用于「保存前冲刷」，避免去抖窗口里丢最后一次改动。 */
  async flushXml(): Promise<string> {
    const event = await this.exportAs('xml')
    return pickEventXml(event)
  }

  /** 让画布适配窗口。 */
  async fit(): Promise<void> {
    const target = this.target()
    if (!target) return
    target.postMessage(JSON.stringify({ action: 'fit' }), '*')
  }

  /** 取消挂起的 autosave（关闭标签 / 切换文件时调用）。 */
  flushPendingAutosave(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer)
      this.autosaveTimer = null
    }
    if (this.pendingAutosaveXml) {
      const xml = this.pendingAutosaveXml
      this.pendingAutosaveXml = ''
      this.onAutosave?.(xml)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.listener) window.removeEventListener('message', this.listener)
    this.listener = null
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer)
    this.autosaveTimer = null
    this.pendingAutosaveXml = ''
    for (const request of this.pending.splice(0)) {
      clearTimeout(request.timer)
      request.reject(new Error('图表编辑器已关闭'))
    }
    this.initResolve = null
    this.initPromise = null
  }

  private handleMessage(event: MessageEvent): void {
    const target = this.target()
    if (!target) return
    // 只认自己 iframe 发来的消息：同一个窗口里可能还有别的 iframe（PDF、HTML 预览）
    if (event.source !== target) return

    let payload: unknown = event.data
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload)
      } catch {
        // 非 JSON 的纯文本协议是旧版行为，图表这一侧不需要
        return
      }
    }
    if (!payload || typeof payload !== 'object') return
    const message = payload as DiagramEditorEvent

    if (message.event === 'init') {
      this.initResolve?.(message)
      this.initResolve = null
      return
    }

    if (message.event === 'autosave') {
      const xml = pickEventXml(message as { xml?: string })
      if (xml) this.scheduleAutosave(xml)
      return
    }

    // 配对等待者：从后往前找第一个匹配的（同类请求可能并发）
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const request = this.pending[index]
      if (!request.match(message)) continue
      this.pending.splice(index, 1)
      clearTimeout(request.timer)
      request.resolve(message)
      return
    }
  }

  private scheduleAutosave(xml: string): void {
    this.pendingAutosaveXml = xml
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer)
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null
      const latest = this.pendingAutosaveXml
      this.pendingAutosaveXml = ''
      if (latest) this.onAutosave?.(latest)
    }, this.autosaveDebounceMs)
  }

  private request<T extends DiagramEditorEvent>(
    label: string,
    match: (event: DiagramEditorEvent) => boolean,
    payload: Record<string, unknown>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const target = this.target()
      if (!target) {
        reject(new Error('图表编辑器尚未就绪'))
        return
      }
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.timer === timer)
        if (index >= 0) this.pending.splice(index, 1)
        reject(new Error(`等待 draw.io 响应超时：${label}`))
      }, this.requestTimeoutMs)
      this.pending.push({
        label,
        match,
        resolve: (event) => resolve(event as T),
        reject,
        timer
      })
      target.postMessage(JSON.stringify(payload), '*')
    })
  }
}
