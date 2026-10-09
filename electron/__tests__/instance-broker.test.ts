import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-broker-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => userData
  }
}))

import {
  findRecentAliveInstance,
  sendTargetsToInstance,
  startInstanceService,
  stopInstanceService,
  touchHeartbeat
} from '../instance-broker'
import type { InstanceHeartbeat } from '../instance-broker'

function pipeFor(pid: number): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\inkase-test-${pid}` : path.join(userData, `inkase-test-${pid}.sock`)
}

function writeHeartbeat(pid: number, lastActiveAt: string, pipe = pipeFor(pid)): void {
  fs.mkdirSync(path.join(userData, 'instances'), { recursive: true })
  const info: InstanceHeartbeat = { pid, pipe, lastActiveAt }
  fs.writeFileSync(path.join(userData, 'instances', `${pid}.json`), JSON.stringify(info), 'utf8')
}

/** 启动一个模拟实例：监听管道并把收到的 paths 写入 captured */
function startFakeInstance(pid: number, captured: string[][]): void {
  const server = net.createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
    })
    socket.once('close', () => {
      try {
        const message = JSON.parse(buffer.trim()) as { paths?: string[] }
        if (Array.isArray(message?.paths)) captured.push(message.paths)
      } catch {
        // 探测性空连接或坏载荷
      }
    })
  })
  server.listen(pipeFor(pid))
  fakeServers.push(server)
}

const fakeServers: net.Server[] = []

function cleanupInstancesDir(): void {
  try {
    fs.rmSync(path.join(userData, 'instances'), { recursive: true, force: true })
  } catch {
    // 忽略
  }
}

describe('Instance broker', () => {
  afterEach(() => {
    stopInstanceService()
    for (const server of fakeServers.splice(0)) server.close()
    cleanupInstancesDir()
  })

  it('registers a heartbeat on start and removes it on stop', () => {
    startInstanceService(() => {})
    const file = path.join(userData, 'instances', `${process.pid}.json`)
    expect(fs.existsSync(file)).toBe(true)
    const info = JSON.parse(fs.readFileSync(file, 'utf8')) as InstanceHeartbeat
    expect(info.pid).toBe(process.pid)
    expect(info.pipe.length).toBeGreaterThan(0)

    touchHeartbeat()
    const updated = JSON.parse(fs.readFileSync(file, 'utf8')) as InstanceHeartbeat
    expect(new Date(updated.lastActiveAt).getTime()).toBeGreaterThanOrEqual(new Date(info.lastActiveAt).getTime())

    stopInstanceService()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('returns null when no instances exist', async () => {
    await expect(findRecentAliveInstance()).resolves.toBeNull()
  })

  it('discovers the alive instance and cleans up stale heartbeats', async () => {
    const captured: string[][] = []
    const deadPid = 111111
    const alivePid = 222222
    // 僵尸心跳最新（排序优先被尝试），连接失败被清理后降级到较旧的活实例
    writeHeartbeat(deadPid, new Date().toISOString())
    startFakeInstance(alivePid, captured)
    writeHeartbeat(alivePid, new Date(Date.now() - 60_000).toISOString())

    const recent = await findRecentAliveInstance()
    expect(recent?.pid).toBe(alivePid)
    // 僵尸心跳被清理
    expect(fs.existsSync(path.join(userData, 'instances', `${deadPid}.json`))).toBe(false)
    // 探测连接不应触发目标分发
    expect(captured).toEqual([])
  })

  it('picks the most recently active among alive instances', async () => {
    const captured: string[][] = []
    const olderPid = 333333
    const newerPid = 444444
    startFakeInstance(olderPid, captured)
    startFakeInstance(newerPid, captured)
    writeHeartbeat(olderPid, new Date(Date.now() - 30_000).toISOString())
    writeHeartbeat(newerPid, new Date().toISOString())

    const recent = await findRecentAliveInstance()
    expect(recent?.pid).toBe(newerPid)
  })

  it('forwards paths to a listening instance', async () => {
    const captured: string[][] = []
    const peerPid = 555555
    startFakeInstance(peerPid, captured)
    writeHeartbeat(peerPid, new Date().toISOString())

    const recent = await findRecentAliveInstance()
    expect(recent).not.toBeNull()
    const sent = await sendTargetsToInstance(recent!, ['C:\\docs\\a.md', 'C:\\docs\\b.mdx'])
    expect(sent).toBe(true)
    // 等待服务端 close 回调完成
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(captured).toEqual([['C:\\docs\\a.md', 'C:\\docs\\b.mdx']])
  })

  it('receives forwarded paths through its own pipe service', async () => {
    const received: string[][] = []
    startInstanceService((paths) => received.push(paths))

    const info = JSON.parse(
      fs.readFileSync(path.join(userData, 'instances', `${process.pid}.json`), 'utf8')
    ) as InstanceHeartbeat
    const sent = await sendTargetsToInstance(info, ['C:\\docs\\x.md'])
    expect(sent).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(received).toEqual([['C:\\docs\\x.md']])
  })
})
