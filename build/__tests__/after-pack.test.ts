import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'

/**
 * afterPack 的图表组件校验。
 *
 * 这条防线是补一次真实事故：`resources/drawio` 不入库，构建机漏拉时
 * electron-builder 会**静默跳过** extraResources，照样产出安装包，
 * 用户新建图表只看到「组件尚未安装」。所以打包结束时必须自己验一遍产物。
 */
const require = createRequire(import.meta.url)
const { ensureDiagramWebapp, packagedResourcesDir } = require('../../build/after-pack.cjs') as {
  ensureDiagramWebapp: (context: { appOutDir: string; electronPlatformName: string }) => void
  packagedResourcesDir: (context: { appOutDir: string; electronPlatformName: string }) => string
}

const MB = 1024 * 1024

function makeAppOutDir(platform: string): { appOutDir: string; resourcesDir: string } {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-after-pack-'))
  const resourcesDir =
    platform === 'darwin' ? path.join(appOutDir, 'Contents', 'Resources') : path.join(appOutDir, 'resources')
  fs.mkdirSync(resourcesDir, { recursive: true })
  return { appOutDir, resourcesDir }
}

/** 造一个「看起来完整」的 webapp：入口 + 主脚本 + 足够体积 */
function makeWebapp(resourcesDir: string, sizeBytes = 21 * MB): string {
  const root = path.join(resourcesDir, 'drawio')
  fs.mkdirSync(path.join(root, 'js'), { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>drawio</title>')
  fs.writeFileSync(path.join(root, 'js', 'app.min.js'), Buffer.alloc(sizeBytes))
  return root
}

describe('packagedResourcesDir', () => {
  it('macOS 取 .app/Contents/Resources，其它平台取 resources', () => {
    expect(packagedResourcesDir({ appOutDir: '/tmp/app', electronPlatformName: 'darwin' })).toBe(
      path.join('/tmp/app', 'Contents', 'Resources')
    )
    expect(packagedResourcesDir({ appOutDir: '/tmp/app', electronPlatformName: 'win32' })).toBe(
      path.join('/tmp/app', 'resources')
    )
  })
})

describe('ensureDiagramWebapp', () => {
  it('组件就位时通过', () => {
    const { appOutDir, resourcesDir } = makeAppOutDir('win32')
    makeWebapp(resourcesDir)
    expect(() => ensureDiagramWebapp({ appOutDir, electronPlatformName: 'win32' })).not.toThrow()
  })

  it('缺失时让构建失败，并提示 fetch:drawio', () => {
    const { appOutDir } = makeAppOutDir('win32')
    expect(() => ensureDiagramWebapp({ appOutDir, electronPlatformName: 'win32' })).toThrow(
      /图表组件没有打进安装包/
    )
    expect(() => ensureDiagramWebapp({ appOutDir, electronPlatformName: 'win32' })).toThrow(
      /fetch:drawio/
    )
  })

  it('只有空壳（体积不足）也失败，防止半成品被打进去', () => {
    const { appOutDir, resourcesDir } = makeAppOutDir('linux')
    makeWebapp(resourcesDir, 1 * MB)
    expect(() => ensureDiagramWebapp({ appOutDir, electronPlatformName: 'linux' })).toThrow(
      /图表组件不完整/
    )
  })
})
