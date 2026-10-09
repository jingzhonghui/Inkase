/**
 * 多实例协同模块
 *
 * 支持多进程多开：每个实例在 userData/instances/ 下注册心跳文件，
 * 并监听专属命名管道。新进程启动时若发现存活实例且携带打开目标，
 * 则把目标转发给「最近使用」的实例并退出；否则自己成为实例。
 *
 * - 管道连接本身即存活证明，避免 pid 复用/权限导致的误判
 * - userData 保持共享（最近文件、AI 配置、恢复快照等），
 *   sessionData 由调用方按需隔离（Chromium localStorage LevelDB 锁）
 */

import { app } from 'electron'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

export interface InstanceHeartbeat {
  pid: number
  pipe: string
  lastActiveAt: string
}

const INSTANCES_DIR = 'instances'
const HEARTBEAT_TOUCH_INTERVAL = 10_000
const PROBE_TIMEOUT = 800
const SEND_TIMEOUT = 2_000
const MAX_PAYLOAD = 1_000_000

let heartbeatFile: string | null = null
let touchTimer: ReturnType<typeof setInterval> | null = null
let server: net.Server | null = null

function instancesDir(): string {
  return path.join(app.getPath('userData'), INSTANCES_DIR)
}

function pipeNameForPid(pid: number): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\inkase-${pid}`
  }
  return path.join(instancesDir(), `inkase-${pid}.sock`)
}

function readHeartbeat(file: string): InstanceHeartbeat | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<InstanceHeartbeat>
    if (typeof value?.pid !== 'number' || typeof value?.pipe !== 'string') return null
    return { pid: value.pid, pipe: value.pipe, lastActiveAt: String(value.lastActiveAt ?? '') }
  } catch {
    return null
  }
}

function toTime(iso: string): number {
  const time = Date.parse(iso)
  return Number.isNaN(time) ? 0 : time
}

function listHeartbeats(): Array<{ file: string; info: InstanceHeartbeat }> {
  let names: string[]
  try {
    names = fs.readdirSync(instancesDir())
  } catch {
    return []
  }
  const entries: Array<{ file: string; info: InstanceHeartbeat }> = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(instancesDir(), name)
    const info = readHeartbeat(file)
    if (info) entries.push({ file, info })
  }
  entries.sort((a, b) => toTime(b.info.lastActiveAt) - toTime(a.info.lastActiveAt))
  return entries
}

/**
 * 连接指定管道并执行动作。
 * payload 为 null 时仅探测存活；否则发送后等待连接关闭。
 */
function connectToPipe(pipe: string, payload: string | null, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect(pipe)
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeout)
    socket.once('connect', () => {
      if (payload === null) {
        finish(true)
        return
      }
      socket.end(payload)
      socket.once('close', () => finish(true))
    })
    socket.once('error', () => finish(false))
  })
}

/**
 * 按 lastActiveAt 降序寻找第一个存活的实例（顺带清理失效心跳文件）
 */
export async function findRecentAliveInstance(): Promise<InstanceHeartbeat | null> {
  for (const { file, info } of listHeartbeats()) {
    if (info.pid === process.pid) continue
    const alive = await connectToPipe(info.pipe, null, PROBE_TIMEOUT)
    if (alive) return info
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // 清理失败不影响发现流程
    }
  }
  return null
}

/**
 * 把打开目标（文件/目录路径列表）转发给目标实例
 */
export async function sendTargetsToInstance(
  info: InstanceHeartbeat,
  paths: string[]
): Promise<boolean> {
  if (paths.length === 0) return false
  const payload = `${JSON.stringify({ pid: process.pid, paths })}\n`
  return connectToPipe(info.pipe, payload, SEND_TIMEOUT)
}

function writeHeartbeat(): void {
  if (!heartbeatFile) return
  const info: InstanceHeartbeat = {
    pid: process.pid,
    pipe: pipeNameForPid(process.pid),
    lastActiveAt: new Date().toISOString()
  }
  try {
    fs.writeFileSync(heartbeatFile, JSON.stringify(info), 'utf8')
  } catch {
    // 心跳写入失败不致命
  }
}

/** 窗口聚焦时调用，保证「最近使用」排序准确 */
export function touchHeartbeat(): void {
  writeHeartbeat()
}

function startListening(onPaths: (paths: string[]) => void): void {
  const pipe = pipeNameForPid(process.pid)
  if (process.platform !== 'win32') {
    // Unix socket：清除上次异常退出残留的文件
    try {
      fs.rmSync(pipe, { force: true })
    } catch {
      // 忽略
    }
  }
  server = net.createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > MAX_PAYLOAD) socket.destroy()
    })
    socket.once('close', () => {
      try {
        const message = JSON.parse(buffer.trim()) as { paths?: unknown }
        if (!Array.isArray(message?.paths)) return
        const paths = message.paths.filter((item): item is string => typeof item === 'string')
        if (paths.length > 0) onPaths(paths)
      } catch {
        // 无法解析的载荷直接忽略
      }
    })
  })
  server.on('error', () => {
    // 监听失败仅影响转发接收，不影响本实例运行
  })
  server.listen(pipe)
}

/**
 * 注册本实例的心跳与管道服务。ready 前调用以消除启动窗口期竞态。
 */
export function startInstanceService(onPaths: (paths: string[]) => void): void {
  try {
    fs.mkdirSync(instancesDir(), { recursive: true })
  } catch {
    // 目录创建失败时心跳不可用，但实例仍可运行
  }
  heartbeatFile = path.join(instancesDir(), `${process.pid}.json`)
  writeHeartbeat()
  startListening(onPaths)
  touchTimer = setInterval(touchHeartbeat, HEARTBEAT_TOUCH_INTERVAL)
  touchTimer.unref?.()
}

/** 退出时清理：删除心跳、关闭服务端与定时器 */
export function stopInstanceService(): void {
  if (touchTimer) {
    clearInterval(touchTimer)
    touchTimer = null
  }
  if (server) {
    server.close()
    server = null
  }
  if (heartbeatFile) {
    try {
      fs.rmSync(heartbeatFile, { force: true })
    } catch {
      // 忽略
    }
    heartbeatFile = null
  }
}
