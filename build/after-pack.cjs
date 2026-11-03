const fs = require('node:fs')
const path = require('node:path')

/**
 * electron-builder 的 afterPack 钩子。
 *
 * 两个作用：修 Linux 的 Chromium sandbox 权限；以及**拦住没有图表组件的安装包**。
 *
 * 第二条是补一次事故之后的保险：`resources/drawio` 是构建前拉取的第三方资源
 * （`pnpm run fetch:drawio`，已被 pnpm install / dev / build 自动调用），
 * 但它不进 git；一旦某台构建机漏拉，electron-builder 只是静默跳过
 * `extraResources.from`，照样生成安装包——用户新建图表时只会看到
 * 「图表组件尚未安装」。与其相信构建机，不如在打包完成时直接验证产物。
 */

function ensureChromeSandboxPermissions(context) {
  if (context.electronPlatformName !== 'linux') return

  const sandboxPath = path.join(context.appOutDir, 'chrome-sandbox')
  if (!fs.existsSync(sandboxPath)) {
    throw new Error(`Missing Chromium sandbox helper: ${sandboxPath}`)
  }

  fs.chmodSync(sandboxPath, 0o4755)

  const mode = fs.statSync(sandboxPath).mode & 0o7777
  if (mode !== 0o4755) {
    throw new Error(`Invalid chrome-sandbox permissions: expected 4755, got ${mode.toString(8)}`)
  }
}

/** 打包产物里 extraResources 的落点（macOS 在 .app/Contents/Resources，其它平台在 resources/） */
function packagedResourcesDir(context) {
  return context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
}

function dirSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else if (entry.isFile()) total += fs.statSync(full).size
  }
  return total
}

/**
 * 校验 draw.io webapp 真的进了安装包。
 *
 * 判据与运行时一致：`index.html` + `js/app.min.js` 都在（见 electron/diagram/protocol.ts），
 * 再加一条体积下限，防止半成品目录被打进去。
 */
function ensureDiagramWebapp(context) {
  const root = path.join(packagedResourcesDir(context), 'drawio')
  const entry = path.join(root, 'index.html')
  const mainScript = path.join(root, 'js', 'app.min.js')

  if (!fs.existsSync(entry) || !fs.existsSync(mainScript)) {
    throw new Error(
      [
        '图表组件没有打进安装包：',
        `  缺少 ${entry}`,
        '  resources/drawio 是构建前拉取的资源，未入库。',
        '  先执行 `pnpm run fetch:drawio`（pnpm install / pnpm build 会自动调用）后重新打包。',
        '  否则打出来的程序新建图表只会显示「图表组件尚未安装」。'
      ].join('\n')
    )
  }

  const bytes = dirSize(root)
  if (bytes < 20 * 1024 * 1024) {
    throw new Error(
      `图表组件不完整：${root} 只有 ${(bytes / 1024 / 1024).toFixed(1)} MB（应约 45 MB）。` +
        ' 先 `pnpm run fetch:drawio --force` 重新解包再打包。'
    )
  }
}

function afterPack(context) {
  ensureChromeSandboxPermissions(context)
  ensureDiagramWebapp(context)
}

module.exports = afterPack
module.exports.ensureChromeSandboxPermissions = ensureChromeSandboxPermissions
module.exports.ensureDiagramWebapp = ensureDiagramWebapp
module.exports.packagedResourcesDir = packagedResourcesDir
