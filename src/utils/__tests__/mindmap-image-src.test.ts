import { describe, expect, it } from 'vitest'
import { resolveMindMapImageSrc } from '../mindmap/image-src'

/**
 * 图片路径解析。
 *
 * `.inkmind` 是 ZIP 容器，图片存在包内的 `assets/images/`，
 * 打开时解到临时目录并给出「包内路径 → 绝对路径」表。
 * 这里的约定是「文件里存包内路径，渲染时查表拼成协议 URL」，
 * 一旦拼错用户看到的就是一张永远加载不出来的图，所以要把各种写法钉住。
 */

const ASSETS = {
  'assets/images/a.png': 'C:\\Temp\\inkase-mindmap-abc\\assets\\images\\a.png',
  'assets/files/方案.pdf': 'C:\\Temp\\inkase-mindmap-abc\\assets\\files\\方案.pdf'
}

describe('resolveMindMapImageSrc', () => {
  it('包内路径查表后拼成协议 URL', () => {
    const url = resolveMindMapImageSrc('assets/images/a.png', ASSETS)
    expect(url.startsWith('inkase-preview://local/')).toBe(true)
    expect(url).toContain('a.png')
    // 目录分隔符在 URL 里必须是 `/`
    expect(url).not.toContain('\\')
  })

  it('data URL 原样返回', () => {
    const src = 'data:image/png;base64,AAAA'
    expect(resolveMindMapImageSrc(src, ASSETS)).toBe(src)
  })

  it('网络图片原样返回', () => {
    expect(resolveMindMapImageSrc('https://example.com/a.png', ASSETS)).toBe(
      'https://example.com/a.png'
    )
  })

  it('手写文件里的反斜杠包内路径也能查到', () => {
    const url = resolveMindMapImageSrc('assets\\images\\a.png', ASSETS)
    expect(url).toContain('a.png')
    expect(url).not.toContain('\\')
  })

  it('表里没有的路径返回空串（走「图片缺失」占位，不抛错）', () => {
    expect(resolveMindMapImageSrc('assets/images/missing.png', ASSETS)).toBe('')
  })

  it('没有资源表时不会拼出错误 URL', () => {
    expect(resolveMindMapImageSrc('assets/images/a.png', undefined)).toBe('')
    expect(resolveMindMapImageSrc('assets/images/a.png', null)).toBe('')
  })

  it('空字符串返回空串', () => {
    expect(resolveMindMapImageSrc('   ', ASSETS)).toBe('')
  })
})
