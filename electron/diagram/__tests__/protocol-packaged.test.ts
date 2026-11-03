import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * 打包环境（`app.isPackaged === true`）的路径解析。
 *
 * 单独一个文件是因为 `is.dev` 在模块加载时就定了，而 protocol.test.ts 固定成开发模式；
 * vitest 默认按文件隔离模块，这里可以安全地把 is.dev 关掉。
 */
const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-resources-'))
Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true })

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), isPackaged: true },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn()
  }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { describeDiagramWebapp, diagramWebappCandidates, resolveDiagramWebappRoot } from '../protocol'

function makeWebapp(dir: string): void {
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>drawio</title>')
  fs.writeFileSync(path.join(dir, 'js', 'app.min.js'), 'window.drawio = 1')
}

describe('打包环境的 draw.io webapp 解析', () => {
  it('只认 process.resourcesPath/drawio（与 extraResources 的落点一致）', () => {
    expect(diagramWebappCandidates()).toEqual([path.join(resourcesPath, 'drawio')])
  })

  it('组件缺失时 available 为假、packaged 为真', () => {
    fs.rmSync(path.join(resourcesPath, 'drawio'), { recursive: true, force: true })
    const info = describeDiagramWebapp()
    expect(info.available).toBe(false)
    expect(info.packaged).toBe(true)
    expect(info.root).toBe(path.join(resourcesPath, 'drawio'))
  })

  it('组件就位时 available 为真，root 指向 resourcesPath 下的目录', () => {
    makeWebapp(path.join(resourcesPath, 'drawio'))
    const info = describeDiagramWebapp()
    expect(info.available).toBe(true)
    expect(info.root).toBe(path.join(resourcesPath, 'drawio'))
    expect(resolveDiagramWebappRoot()).toBe(path.join(resourcesPath, 'drawio'))
  })
})
