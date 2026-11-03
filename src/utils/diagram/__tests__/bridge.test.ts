import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagramBridge } from '../bridge'

type Listener = (event: MessageEvent) => void

let listeners: Set<Listener>
let target: Window

/** 极简 window：只提供 bridge 用到的 add/removeEventListener */
function installWindow(): void {
  listeners = new Set<Listener>()
  vi.stubGlobal('window', {
    addEventListener: (_type: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_type: string, cb: Listener) => listeners.delete(cb)
  })
}

/** 模拟 draw.io 发来一条消息（只认 `event.source === iframe.contentWindow`） */
function emit(payload: unknown): void {
  const event = { source: target, data: JSON.stringify(payload) } as unknown as MessageEvent
  for (const listener of [...listeners]) listener(event)
}

describe('DiagramBridge.waitForInit', () => {
  beforeEach(() => {
    installWindow()
    target = { postMessage: vi.fn() } as unknown as Window
  })

  it('init 正常到达时兑现', async () => {
    const bridge = new DiagramBridge({ target: () => target })
    bridge.start()
    const waiting = bridge.waitForInit(1000)
    emit({ event: 'init', proto: 'json' })
    await expect(waiting).resolves.toMatchObject({ event: 'init' })
    bridge.dispose()
  })

  it('init 早于 waitForInit 到达时立刻兑现，不白等满超时', async () => {
    // 回归：iframe 已经加载完才来等待（重试、重新挂载）时，
    // 老实现会一直等到 30 秒超时，表现为「第一次打开图表卡住，点重试才好」
    const bridge = new DiagramBridge({ target: () => target })
    bridge.start()
    emit({ event: 'init' })

    const startedAt = Date.now()
    const event = await bridge.waitForInit(30_000)
    expect(event.event).toBe('init')
    expect(Date.now() - startedAt).toBeLessThan(200)
    bridge.dispose()
  })

  it('超时之后 init 才到，下一次等待仍是立刻兑现', async () => {
    const bridge = new DiagramBridge({ target: () => target })
    bridge.start()
    await expect(bridge.waitForInit(5)).rejects.toThrow('初始化超时')

    emit({ event: 'init' })
    const startedAt = Date.now()
    await expect(bridge.waitForInit(30_000)).resolves.toMatchObject({ event: 'init' })
    expect(Date.now() - startedAt).toBeLessThan(200)
    bridge.dispose()
  })

  it('dispose 之后清掉已记住的 init', async () => {
    const bridge = new DiagramBridge({ target: () => target })
    bridge.start()
    emit({ event: 'init' })
    bridge.dispose()

    // 重新 start 的实例不应该继承上一次的 init
    const next = new DiagramBridge({ target: () => target })
    next.start()
    await expect(next.waitForInit(5)).rejects.toThrow('初始化超时')
    next.dispose()
  })
})
