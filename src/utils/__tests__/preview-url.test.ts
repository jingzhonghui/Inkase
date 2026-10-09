import { describe, expect, it } from 'vitest'
import { buildPreviewUrl } from '../preview-url'

describe('buildPreviewUrl', () => {
  it('converts windows paths into preview protocol urls', () => {
    expect(buildPreviewUrl('C:\\docs\\index.html')).toBe('inkase-preview://local/C%3A/docs/index.html')
  })

  it('accepts posix-style separators and strips duplicate slashes', () => {
    expect(buildPreviewUrl('C:/docs/index.html')).toBe('inkase-preview://local/C%3A/docs/index.html')
  })

  it('encodes spaces, cjk characters and hashes inside segments', () => {
    expect(buildPreviewUrl('C:\\docs\\我的 文档#1.html')).toBe(
      'inkase-preview://local/C%3A/docs/%E6%88%91%E7%9A%84%20%E6%96%87%E6%A1%A3%231.html'
    )
  })

  it('round-trips with the main-process parser', async () => {
    const { parsePreviewUrl } = await import('../../../electron/ipc/preview-protocol')
    for (const p of ['C:\\a\\b.html', 'C:\\我的 文档\\页#1.htm', 'D:\\x\\y\\z.html']) {
      const parsed = parsePreviewUrl(buildPreviewUrl(p))
      expect(parsed?.absolutePath).toBe(p)
    }
  })
})
