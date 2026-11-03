import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * after-pack.cjs 是 CommonJS：默认导出是 afterPack 组合钩子
 * （sandbox 权限 + 图表组件校验），两个职责各自挂了具名属性。
 * TS 对 .cjs 只允许默认导入，所以这里走 createRequire 拿到属性。
 */
type AfterPackContext = { electronPlatformName: string; appOutDir: string }
const requireCjs = createRequire(import.meta.url)
const afterPack = requireCjs('../../build/after-pack.cjs') as ((
  context: AfterPackContext
) => void) & {
  ensureChromeSandboxPermissions: (context: AfterPackContext) => void
}
const { ensureChromeSandboxPermissions } = afterPack

function readAfterInstallScript() {
  return readFileSync(join(__dirname, '../../build/after-install.sh'), 'utf8')
}

function createAppOutDir() {
  const appOutDir = mkdtempSync(join(tmpdir(), 'inkase-after-pack-'))
  mkdirSync(appOutDir, { recursive: true })
  return appOutDir
}

describe('ensureChromeSandboxPermissions', () => {
  it.skipIf(process.platform === 'win32')('sets chrome-sandbox to root-compatible 4755 permissions on Linux', () => {
    const appOutDir = createAppOutDir()
    const sandboxPath = join(appOutDir, 'chrome-sandbox')
    writeFileSync(sandboxPath, 'sandbox')
    chmodSync(sandboxPath, 0o755)

    ensureChromeSandboxPermissions({ electronPlatformName: 'linux', appOutDir })

    expect(statSync(sandboxPath).mode & 0o7777).toBe(0o4755)
  })

  it('does not change the helper on non-Linux platforms', () => {
    const appOutDir = createAppOutDir()
    const sandboxPath = join(appOutDir, 'chrome-sandbox')
    writeFileSync(sandboxPath, 'sandbox')
    chmodSync(sandboxPath, 0o755)
    const initialMode = statSync(sandboxPath).mode & 0o7777

    ensureChromeSandboxPermissions({ electronPlatformName: 'win32', appOutDir })

    expect(statSync(sandboxPath).mode & 0o7777).toBe(initialMode)
  })

  it('fails when the Linux helper is missing', () => {
    const appOutDir = createAppOutDir()

    expect(() => ensureChromeSandboxPermissions({ electronPlatformName: 'linux', appOutDir })).toThrow(
      'Missing Chromium sandbox helper'
    )
  })
})

describe('afterPack 组合钩子', () => {
  it('缺图表组件时让打包失败（避免产出「新建图表提示组件缺失」的安装包）', () => {
    const appOutDir = createAppOutDir()
    expect(() => afterPack({ electronPlatformName: 'win32', appOutDir })).toThrow(/图表组件没有打进安装包/)
  })
})

describe('after-install.sh (deb postinst)', () => {
  it('always sets chrome-sandbox to 4755', () => {
    expect(readAfterInstallScript()).toContain("chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox'")
  })

  it('does not strip the SUID bit or rely on the user-namespace probe', () => {
    const script = readAfterInstallScript()
    expect(script).not.toContain('chmod 0755')
    expect(script).not.toContain('unshare')
  })

  it('uses only known template macros', () => {
    const macros = [...readAfterInstallScript().matchAll(/\$\{([a-zA-Z]+)\}/g)].map((m) => m[1])
    expect(new Set(macros)).toEqual(new Set(['executable', 'sanitizedProductName']))
  })
})
