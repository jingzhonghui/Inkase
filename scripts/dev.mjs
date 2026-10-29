import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'

const isWindows = process.platform === 'win32'

if (isWindows) {
  spawnSync('chcp', ['65001'], { stdio: 'ignore', shell: true })
}

// Windows 上 5173 经常落在 Hyper-V / WinNAT 的保留端口范围内，可用
//   netsh interface ipv4 show excludedportrange protocol=tcp
// 查看。落在保留段里时 bind 报的是 EACCES（permission denied）而不是 EADDRINUSE，
// 而 Vite 只会对 EADDRINUSE 自动顺延端口，于是 dev server 直接起不来：
//   Error: listen EACCES: permission denied ::1:5173
// 这里先实探一个真能绑上的端口，再通过 INKASE_DEV_PORT 交给 electron.vite.config.ts
// （那边固定 strictPort，保证 ELECTRON_RENDERER_URL 与实际监听端口一致）。
const DEV_HOST = '127.0.0.1'
const DEFAULT_PORT = 5173
const PREFERRED_PORTS = [DEFAULT_PORT, 5174, 5175, 4173, 5460, 6006, 8080, 9000]

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, DEV_HOST, () => server.close(() => resolve(true)))
  })
}

function findEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, DEV_HOST, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function resolveDevPort() {
  const fromEnv = Number(process.env.INKASE_DEV_PORT)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv

  // 显式传了 --port 就交给 electron-vite 自己处理，不覆盖用户意图
  const explicitPort = process.argv
    .slice(2)
    .some((arg) => arg === '--port' || arg.startsWith('--port='))
  if (explicitPort) return null

  for (const port of PREFERRED_PORTS) {
    if (await canListen(port)) return port
  }
  return findEphemeralPort()
}

const env = { ...process.env }

const devPort = await resolveDevPort()
if (devPort !== null) {
  env.INKASE_DEV_PORT = String(devPort)
  if (devPort !== DEFAULT_PORT) {
    console.log(
      `[dev] 端口 ${DEFAULT_PORT} 不可用（被系统保留或已被占用），渲染进程 dev server 改用 ${devPort}`
    )
  }
}

if (!isWindows) {
  env.ELECTRON_CLI_ARGS = JSON.stringify(['--disable-gpu'])
}

// 从 Electron 内嵌的终端（VS Code 扩展宿主、各种 Electron 工具）里启动时，环境里可能带着
// ELECTRON_RUN_AS_NODE=1，那会让 electron.exe 退化成普通 Node 跑 main.cjs，于是
// `require('electron')` 拿到的是路径字符串而不是 app 对象，崩在
// `Cannot read properties of undefined (reading 'isPackaged')`。这里必须剥掉。
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('electron-vite', ['dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  shell: true
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
