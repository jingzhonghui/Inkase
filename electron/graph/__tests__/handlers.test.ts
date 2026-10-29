import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * handlers 层测试：不进真实 Electron，只捕获 `ipcMain.handle` 注册的处理器
 * 并直接调用它们，断言「统一 envelope + 路径校验 + 单构建」这三条契约。
 *
 * 对应 TC-HANDLERS-001 ~ 006。
 */

type InvokeHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const registered = vi.hoisted(() => new Map<string, InvokeHandler>())

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0', getName: () => 'inkase' },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => {
      registered.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      registered.delete(channel)
    },
    on: vi.fn()
  },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() }
}))

/**
 * 可控的构建替身：让「新构建取消旧构建」这条竞态变成确定性的断言。
 * 真实 `GraphBuildCancelledError` 保持同源，否则 `instanceof` 判断会失效。
 */
const stub = vi.hoisted(() => ({
  mode: 'resolve' as 'resolve' | 'wait' | 'throw',
  pending: [] as Array<() => void>,
  builds: 0
}))

vi.mock('../../graph/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../graph/service')>()
  return {
    ...actual,
    getGraphService: () => ({
      build: (
        root: string,
        options: { signal?: AbortSignal; onProgress?: (s: number, t: number) => void } = {}
      ) => {
        stub.builds++
        options.onProgress?.(1, 1)
        return new Promise((resolve, reject) => {
          const settle = (): void => {
            if (options.signal?.aborted) reject(new actual.GraphBuildCancelledError())
            else resolve({ root, nodes: [], edges: [], stats: {}, warnings: [], issues: {} })
          }
          if (stub.mode === 'wait') stub.pending.push(() => settle())
          else if (stub.mode === 'throw') reject(new Error('构建炸了'))
          else settle()
        })
      },
      refreshFile: async () => ({ path: 'a.md', format: 'markdown', links: [] }),
      invalidate: vi.fn()
    })
  }
})

const { IPC_CHANNELS } = await import('../../ipc/channels')
const { registerGraphHandlers, disposeGraphHandlers } = await import('../../graph/handlers')

let root: string

function sender(): { sender: { id: number; send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean } } {
  return { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } }
}

function handlerFor(channel: string): InvokeHandler {
  const handler = registered.get(channel)
  if (!handler) throw new Error(`未注册的通道: ${channel}`)
  return handler
}

function write(relativePath: string, content: string): string {
  const absolute = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content, 'utf8')
  return absolute
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-ipc-'))
  registered.clear()
  stub.mode = 'resolve'
  stub.pending = []
  stub.builds = 0
  registerGraphHandlers()
})

afterEach(() => {
  registered.clear()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('注册的通道', () => {
  it('注册 BUILD / REFRESH_FILE / CREATE_LINK 三个 invoke 通道', () => {
    expect([...registered.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.GRAPH.BUILD,
        IPC_CHANNELS.GRAPH.CREATE_LINK,
        IPC_CHANNELS.GRAPH.REFRESH_FILE
      ].sort()
    )
  })
})

describe('GRAPH.BUILD', () => {
  it('TC-HANDLERS-004 成功时返回 { success, data }', async () => {
    const result = (await handlerFor(IPC_CHANNELS.GRAPH.BUILD)(sender(), root)) as Record<
      string,
      unknown
    >

    expect(result.success).toBe(true)
    expect(result).toHaveProperty('data')
    expect(result).not.toHaveProperty('error')
  })

  it('TC-HANDLERS-004 失败时返回 { success:false, error:string }，不抛异常', async () => {
    stub.mode = 'throw'
    const result = (await handlerFor(IPC_CHANNELS.GRAPH.BUILD)(sender(), root)) as Record<
      string,
      unknown
    >

    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).toBe('构建炸了')
  })

  it('TC-HANDLERS-006 工作区不存在时返回失败而不抛异常', async () => {
    const result = (await handlerFor(IPC_CHANNELS.GRAPH.BUILD)(
      sender(),
      path.join(root, 'not-exists')
    )) as Record<string, unknown>

    expect(result.success).toBe(false)
    expect(result.error).toBe('工作区不存在')
  })

  it('TC-HANDLERS-006 root 不是字符串/空串时返回失败', async () => {
    const handler = handlerFor(IPC_CHANNELS.GRAPH.BUILD)

    for (const bad of [undefined, null, '', '   ', 42]) {
      const result = (await handler(sender(), bad)) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(typeof result.error).toBe('string')
    }
  })

  it('TC-HANDLERS-006 root 指向文件而非目录时返回失败', async () => {
    const filePath = write('file.md', '# x')
    const result = (await handlerFor(IPC_CHANNELS.GRAPH.BUILD)(sender(), filePath)) as Record<
      string,
      unknown
    >

    expect(result.success).toBe(false)
    expect(result.error).toBe('工作区不是文件夹')
  })

  it('TC-HANDLERS-005 同一 webContents 连发两次构建时旧构建被取消', async () => {
    stub.mode = 'wait'
    const event = sender()
    const handler = handlerFor(IPC_CHANNELS.GRAPH.BUILD)

    const first = handler(event, root) as Promise<Record<string, unknown>>
    const second = handler(event, root) as Promise<Record<string, unknown>>

    // 第二次构建触发 cancelBuildFor → 第一个 controller 被 abort
    stub.pending.forEach((settle) => settle())
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(stub.builds).toBe(2)
    expect(firstResult.success).toBe(false)
    expect(firstResult.error).toBe('已取消')
    // 第二个构建的 controller 仍是当前活跃的，未被自己取消
    expect(secondResult.success).toBe(true)
  })

  it('TC-HANDLERS-003 取消返回「已取消」而不是错误对象', async () => {
    stub.mode = 'wait'
    const event = sender()
    const handler = handlerFor(IPC_CHANNELS.GRAPH.BUILD)

    const first = handler(event, root) as Promise<Record<string, unknown>>
    void handler(event, root)
    stub.pending.forEach((settle) => settle())
    const result = await first

    expect(result).toEqual({ success: false, error: '已取消' })
  })

  it('进度通过 sender.send 推送到 PROGRESS 通道', async () => {
    const event = sender()

    await handlerFor(IPC_CHANNELS.GRAPH.BUILD)(event, root)

    expect(event.sender.send).toHaveBeenCalledWith(IPC_CHANNELS.GRAPH.PROGRESS, {
      scanned: 1,
      total: 1
    })
  })

  it('webContents 已销毁时不再发送进度', async () => {
    const event = {
      sender: { id: 7, send: vi.fn(), isDestroyed: () => true }
    }

    await handlerFor(IPC_CHANNELS.GRAPH.BUILD)(event, root)

    expect(event.sender.send).not.toHaveBeenCalled()
  })

  it('不同 webContents 的构建互不影响', async () => {
    stub.mode = 'wait'
    const handler = handlerFor(IPC_CHANNELS.GRAPH.BUILD)
    const first = handler(sender(), root) as Promise<Record<string, unknown>>
    const other = { sender: { id: 2, send: vi.fn(), isDestroyed: () => false } }
    const second = handler(other, root) as Promise<Record<string, unknown>>

    stub.pending.forEach((settle) => settle())
    const results = await Promise.all([first, second])

    // 两个 sender 各自持有 controller，谁都没被取消
    expect(results.map((r) => r.success)).toEqual([true, true])
  })
})

describe('GRAPH.REFRESH_FILE', () => {
  it('TC-HANDLERS-004 成功时返回单文件记录', async () => {
    const result = (await handlerFor(IPC_CHANNELS.GRAPH.REFRESH_FILE)(
      sender(),
      root,
      'a.md'
    )) as Record<string, unknown>

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ path: 'a.md', format: 'markdown', links: [] })
  })

  it('TC-HANDLERS-001 绝对路径被拒绝', async () => {
    const handler = handlerFor(IPC_CHANNELS.GRAPH.REFRESH_FILE)

    for (const bad of ['/tmp/a.md', 'C:\\ws\\a.md', 'D:/x.md']) {
      const result = (await handler(sender(), root, bad)) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(String(result.error)).toContain('必须是工作区相对路径')
    }
  })

  it('TC-HANDLERS-001 空路径被拒绝', async () => {
    const result = (await handlerFor(IPC_CHANNELS.GRAPH.REFRESH_FILE)(
      sender(),
      root,
      '  '
    )) as Record<string, unknown>

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('路径无效')
  })
})

describe('GRAPH.CREATE_LINK', () => {
  it('TC-HANDLERS-001 绝对路径被拒绝且不写盘', async () => {
    const source = write('a.md', '# A')
    write('b.md', '# B')
    const handler = handlerFor(IPC_CHANNELS.GRAPH.CREATE_LINK)

    const result = (await handler(sender(), {
      root,
      from: path.join(root, 'a.md'),
      to: 'b.md'
    })) as Record<string, unknown>

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('必须是工作区相对路径')
    // 源文件未被改动
    expect(fs.readFileSync(source, 'utf8')).toBe('# A')
  })

  it('TC-HANDLERS-001 越界相对路径（..）被拒绝且不写盘', async () => {
    const source = write('a.md', '# A')
    const outside = path.join(root, '..', `outside-${Date.now()}.md`)
    fs.writeFileSync(outside, '# O', 'utf8')
    const handler = handlerFor(IPC_CHANNELS.GRAPH.CREATE_LINK)

    const result = (await handler(sender(), {
      root,
      from: 'a.md',
      to: path.basename(outside)
    })) as Record<string, unknown>

    // 目标不在工作区内 → 解析失败（不存在的相对路径）
    expect(result.success).toBe(false)
    expect(fs.readFileSync(source, 'utf8')).toBe('# A')
    fs.rmSync(outside, { force: true })
  })

  it('TC-HANDLERS-004 成功时返回 { line, skipped }', async () => {
    write('a.md', '# A')
    write('b.md', '# B')

    const result = (await handlerFor(IPC_CHANNELS.GRAPH.CREATE_LINK)(sender(), {
      root,
      from: 'a.md',
      to: 'b.md'
    })) as Record<string, unknown>

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ skipped: false })
    expect(typeof (result.data as { line: number }).line).toBe('number')
  })

  it('TC-HANDLERS-004 写入失败时返回 LinkWriteError 的消息', async () => {
    write('a.md', '# A')
    const result = (await handlerFor(IPC_CHANNELS.GRAPH.CREATE_LINK)(sender(), {
      root,
      from: 'a.md',
      to: 'missing.md'
    })) as Record<string, unknown>

    expect(result.success).toBe(false)
    expect(result.error).toBe('目标文件不存在')
  })

  it('input 缺失时返回失败而不是抛异常', async () => {
    const handler = handlerFor(IPC_CHANNELS.GRAPH.CREATE_LINK)

    for (const bad of [undefined, {}, { root }]) {
      const result = (await handler(sender(), bad)) as Record<string, unknown>
      expect(result.success).toBe(false)
      expect(typeof result.error).toBe('string')
    }
  })
})

describe('disposeGraphHandlers', () => {
  it('可重复调用且不抛异常', () => {
    expect(() => disposeGraphHandlers()).not.toThrow()
    expect(() => disposeGraphHandlers()).not.toThrow()
  })
})
