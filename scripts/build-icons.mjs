// 生成 Inkase 应用图标：由 resources/icon.svg 渲染各尺寸 PNG 与 ICO
// 用法：node scripts/build-icons.mjs（修改 icon.svg 后重新运行即可）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = path.join(root, 'resources', 'icon.svg')
const svgBuffer = fs.readFileSync(svgPath)

async function renderPng(size) {
  return sharp(svgBuffer, { density: 96 * (size / 256) })
    .resize(size, size)
    .png()
    .toBuffer()
}

// 1) 渲染各尺寸 PNG
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const pngs = new Map()
for (const size of sizes) {
  pngs.set(size, await renderPng(size))
}

// 2) 输出固定命名的图标文件
fs.writeFileSync(path.join(root, 'resources', 'icon-16.png'), pngs.get(16))
fs.writeFileSync(path.join(root, 'resources', 'icon-32.png'), pngs.get(32))
fs.writeFileSync(path.join(root, 'resources', 'icon.png'), pngs.get(512))
fs.mkdirSync(path.join(root, 'build'), { recursive: true })
fs.writeFileSync(path.join(root, 'build', 'icon.png'), pngs.get(1024))

// 3) 生成 Windows 多尺寸 ICO
const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map((s) => pngs.get(s)))
fs.writeFileSync(path.join(root, 'resources', 'icon.ico'), ico)

console.log('[build-icons] generated: icon-16/32.png, icon.png(512), build/icon.png(1024), icon.ico')
