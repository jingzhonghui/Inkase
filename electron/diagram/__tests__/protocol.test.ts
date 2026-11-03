import { describe, expect, it, vi } from 'vitest'

/**
 * protocol.ts 在模块顶层引用了 electron 的 app/protocol，
 * 单测里不需要真的起 Electron：桩掉 app 的路径与 protocol 注册即可。
 */
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn()
  }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import {
  createDiagramAssetResponse,
  describeDiagramWebapp,
  diagramWebappCandidates,
  injectDiagramHostStyle,
  isDiagramWebappAvailable,
  resolveDiagramAssetPath
} from '../protocol'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** 临时目录里放一个假 webapp，避免测试依赖真实 45MB 资源 */
function makeWebapp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-drawio-test-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>drawio</title>', 'utf8')
  fs.mkdirSync(path.join(root, 'js'), { recursive: true })
  fs.writeFileSync(path.join(root, 'js', 'app.min.js'), 'window.drawio = 1', 'utf8')
  fs.mkdirSync(path.join(root, 'stencils'), { recursive: true })
  fs.writeFileSync(path.join(root, 'stencils', 'basic.xml'), '<shapes />', 'utf8')
  return root
}

describe('resolveDiagramAssetPath', () => {
  const root = path.resolve('/tmp/inkase-root')

  it('把协议 URL 还原为根目录下的绝对路径', () => {
    expect(resolveDiagramAssetPath(root, 'inkase-drawio://app/js/app.min.js')).toBe(
      path.resolve(root, 'js', 'app.min.js')
    )
  })

  it('空路径落到 index.html', () => {
    expect(resolveDiagramAssetPath(root, 'inkase-drawio://app/')).toBe(
      path.resolve(root, 'index.html')
    )
  })

  it('解码 URL 里的中文与空格', () => {
    expect(resolveDiagramAssetPath(root, 'inkase-drawio://app/templates/%E6%B5%81%E7%A8%8B.xml')).toBe(
      path.resolve(root, 'templates', '流程.xml')
    )
  })

  it('明文 .. 段被 URL 规范化吃掉，解析结果仍锁在根目录内', () => {
    // standard scheme 的 URL 解析会先把 `/../` 折叠掉，所以这里拿到的不是逃逸路径
    const resolved = resolveDiagramAssetPath(root, 'inkase-drawio://app/../../etc/passwd')
    expect(resolved).toBe(path.resolve(root, 'etc', 'passwd'))
    expect(resolved?.startsWith(path.resolve(root) + path.sep)).toBe(true)
    expect(resolveDiagramAssetPath(root, 'inkase-drawio://app/js/../../secret.txt')).toBe(
      path.resolve(root, 'secret.txt')
    )
  })

  it('编码过的穿越段（%2e%2e）同样被 URL 规范化，逃不出根目录', () => {
    // WHATWG URL 把 %2e%2e 也认作双点段，解析阶段就折叠掉；真正的越界拦截靠下面的段校验
    const resolved = resolveDiagramAssetPath(root, 'inkase-drawio://app/%2e%2e/%2e%2e/etc/passwd')
    expect(resolved).toBe(path.resolve(root, 'etc', 'passwd'))
    expect(resolved?.startsWith(path.resolve(root) + path.sep)).toBe(true)
    // 单点段也是规范化掉，不是报错
    expect(resolveDiagramAssetPath(root, 'inkase-drawio://app/./x.js')).toBe(
      path.resolve(root, 'x.js')
    )
  })

  it('解码后仍含分隔符的段被拒绝', () => {
    expect(resolveDiagramAssetPath(root, 'inkase-drawio://app/a%5Cb')).toBeNull()
    expect(resolveDiagramAssetPath(root, 'inkase-drawio://app/js%5C..%5C..%5Csecret')).toBeNull()
  })

  it('拒绝其它 scheme / host', () => {
    expect(resolveDiagramAssetPath(root, 'file:///tmp/x')).toBeNull()
    expect(resolveDiagramAssetPath(root, 'inkase-drawio://evil/index.html')).toBeNull()
    expect(resolveDiagramAssetPath(root, 'not a url')).toBeNull()
  })
})

describe('createDiagramAssetResponse', () => {
  it('返回文件内容、正确的 MIME 与注入的 CSP', async () => {
    const root = makeWebapp()
    const response = createDiagramAssetResponse(path.join(root, 'index.html'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    // 严格策略：不允许 unsafe-eval（A0 实测 draw.io 不需要它）。
    // 注意 'wasm-unsafe-eval' 里包含 unsafe-eval 字样，所以要按指令判断而不是子串。
    const csp = response.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toMatch(/'wasm-unsafe-eval'/)
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/)
    expect(await response.text()).toContain('drawio')
  })

  it('js 用 JS 的 MIME', () => {
    const root = makeWebapp()
    const response = createDiagramAssetResponse(path.join(root, 'js', 'app.min.js'))
    expect(response.headers.get('Content-Type')).toContain('text/javascript')
  })

  it('目录与不存在的文件都是 404', () => {
    const root = makeWebapp()
    expect(createDiagramAssetResponse(root).status).toBe(404)
    expect(createDiagramAssetResponse(path.join(root, 'missing.js')).status).toBe(404)
  })

  it('HTML 响应注入隐藏 GitHub 图标的样式，非 HTML 不注入', async () => {
    const root = makeWebapp()
    const html = await createDiagramAssetResponse(path.join(root, 'index.html')).text()
    expect(html).toContain('inkase-diagram-host-style')
    expect(html).toContain('github.com/jgraph/drawio')

    const js = await createDiagramAssetResponse(path.join(root, 'js', 'app.min.js')).text()
    expect(js).not.toContain('inkase-diagram-host-style')
  })
})

describe('injectDiagramHostStyle', () => {
  it('插在 </head> 之前', () => {
    const out = injectDiagramHostStyle('<html><head><title>t</title></head><body></body></html>')
    const style = out.indexOf('inkase-diagram-host-style')
    expect(style).toBeGreaterThan(-1)
    expect(style).toBeLessThan(out.indexOf('</head>'))
    expect(out.indexOf('<title>')).toBeLessThan(style)
  })

  it('没有 </head> 时兜底放在最前面，不丢原文', () => {
    const out = injectDiagramHostStyle('<div>裸片段</div>')
    expect(out.startsWith('<style')).toBe(true)
    expect(out).toContain('<div>裸片段</div>')
  })

  it('重复调用不会叠加第二份', () => {
    const once = injectDiagramHostStyle('<html><head></head><body></body></html>')
    const twice = injectDiagramHostStyle(once)
    expect(twice).toBe(once)
    expect(twice.match(/inkase-diagram-host-style/g)).toHaveLength(1)
  })

  it('空输入原样返回', () => {
    expect(injectDiagramHostStyle('')).toBe('')
  })
})

describe('isDiagramWebappAvailable', () => {
  it('index.html 存在即视为可用', () => {
    expect(isDiagramWebappAvailable(makeWebapp())).toBe(true)
  })

  it('空目录视为缺失', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-drawio-empty-'))
    expect(isDiagramWebappAvailable(empty)).toBe(false)
  })
})

describe('diagramWebappCandidates / describeDiagramWebapp', () => {
  function withOverride<T>(root: string, run: () => T): T {
    const previous = process.env.INKASE_DRAWIO_ROOT
    process.env.INKASE_DRAWIO_ROOT = root
    try {
      return run()
    } finally {
      if (previous === undefined) delete process.env.INKASE_DRAWIO_ROOT
      else process.env.INKASE_DRAWIO_ROOT = previous
    }
  }

  it('INKASE_DRAWIO_ROOT 覆盖时只保留这一条候选', () => {
    const root = makeWebapp()
    withOverride(root, () => {
      expect(diagramWebappCandidates()).toEqual([path.resolve(root)])
    })
  })

  it('覆盖目录可用时 available 为真，packaged 为假（单测跑在开发模式）', () => {
    const root = makeWebapp()
    withOverride(root, () => {
      const info = describeDiagramWebapp()
      expect(info.available).toBe(true)
      expect(info.root).toBe(path.resolve(root))
      expect(info.packaged).toBe(false)
    })
  })

  it('覆盖目录为空时 available 为假，但 root 仍指回该目录（用于报错文案）', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-drawio-empty-'))
    withOverride(empty, () => {
      const info = describeDiagramWebapp()
      expect(info.available).toBe(false)
      expect(info.root).toBe(path.resolve(empty))
    })
  })
})
