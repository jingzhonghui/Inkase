// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getMindMapImageBuilder,
  registerMindMapImageBuilder,
  resetMindMapImageBuilder,
  type MindMapImageFile
} from '../mindmap/export-bridge'
import { rasterizeSvgToPng, toSvgDataUrl } from '../mindmap/png-export'

const sample: MindMapImageFile = {
  format: 'svg',
  width: 100,
  height: 50,
  bytes: new Uint8Array([1, 2, 3])
}

describe('export-bridge', () => {
  afterEach(() => {
    resetMindMapImageBuilder()
  })

  it('登记后能取回同一个构建器', () => {
    const builder = vi.fn(async () => sample)
    registerMindMapImageBuilder(builder)
    expect(getMindMapImageBuilder()).toBe(builder)
  })

  it('注销后取不到构建器', () => {
    const release = registerMindMapImageBuilder(async () => sample)
    release()
    expect(getMindMapImageBuilder()).toBeNull()
  })

  it('旧实例的注销不会清掉新实例的登记', () => {
    // 切标签时新编辑器可能已经先登记，随后旧编辑器才卸载
    const releaseOld = registerMindMapImageBuilder(async () => sample)
    const next = vi.fn(async () => sample)
    registerMindMapImageBuilder(next)

    releaseOld()
    expect(getMindMapImageBuilder()).toBe(next)
  })
})

describe('png-export', () => {
  it('把 SVG 包成 <img> 可加载的 data URL', () => {
    const url = toSvgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    // 尖括号与引号必须转义，否则浏览器把 `#`、`"` 当成 URL 片段/结束符
    expect(url).not.toContain('<')
    expect(url).toContain('%3Csvg')
  })

  it('解码不出来时以错误结束而不是挂住', async () => {
    // jsdom 既不解码 SVG 也没有 canvas 实现，`<img>` 既不 load 也不 error：
    // 必须靠超时兜底 reject，否则调用方会一直停在「导出中」
    await expect(
      rasterizeSvgToPng('<svg></svg>', 100, 50, { decodeTimeoutMs: 30 })
    ).rejects.toThrow('SVG 图像解码超时')
  })
})
