import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../markdown'
import { parseMarkdown, serializeMarkdown } from '../prosemirror/markdown'
import { decodeLinkTarget } from '../../../shared/markdown/link-encoding'

/** 取出预览 HTML 里第一张图片的 src */
function firstImageSrc(html: string): string | null {
  const match = /<img[^>]*\ssrc="([^"]*)"/.exec(html)
  return match ? match[1] : null
}

describe('markdown 图片路径编码', () => {
  it('keeps a Chinese relative path readable in the preview HTML', () => {
    // markdown-it 的 normalizeLink 会把中文转成 %E6%B5%8B…，
    // 预览随后拿 src 去读本地文件，编码串在磁盘上不存在。
    const html = renderMarkdown('![截图](测试.assets/a.png)')
    expect(firstImageSrc(html)).toBe('测试.assets/a.png')
    expect(html).not.toContain('%E6')
  })

  it('keeps an ASCII path untouched', () => {
    const html = renderMarkdown('![shot](demo.assets/a.png)')
    expect(firstImageSrc(html)).toBe('demo.assets/a.png')
  })

  it('decodes a link that was already percent-encoded on disk', () => {
    // 旧版本写坏的文件：链接被存成了编码串，但磁盘上是中文名
    const html = renderMarkdown('![截图](%E6%B5%8B%E8%AF%95.assets/a.png)')
    expect(firstImageSrc(html)).toBe('测试.assets/a.png')
  })

  it('leaves a literal % in the file name alone', () => {
    // `100%.png` 不是合法转义序列，decodeURIComponent 会抛错——必须原样保留
    const html = renderMarkdown('![进度](pics/100%.png)')
    expect(firstImageSrc(html)).toBe('pics/100%.png')
  })
})

describe('renderMarkdown 图片内联', () => {
  const dataUrl = 'data:image/png;base64,AAAA'

  it('inlines an already-loaded image so v-html rebuilds do not flash', () => {
    // 预览是 v-html 整段替换：渲染时就带上 data URL，重建出来的 <img> 才有 src。
    const html = renderMarkdown('![截图](测试.assets/a.png)', [], {
      resolveImage: (src) => (src === '测试.assets/a.png' ? dataUrl : undefined)
    })
    expect(firstImageSrc(html)).toBe(dataUrl)
  })

  it('keeps the decoded path when the resolver has nothing yet', () => {
    const html = renderMarkdown('![截图](%E6%B5%8B%E8%AF%95.assets/a.png)', [], {
      resolveImage: () => undefined
    })
    expect(firstImageSrc(html)).toBe('测试.assets/a.png')
  })

  it('does not touch remote images', () => {
    const html = renderMarkdown('![远程](https://example.com/a.png)', [], {
      resolveImage: () => dataUrl
    })
    expect(firstImageSrc(html)).toBe('https://example.com/a.png')
  })
})

describe('IR 图片节点路径', () => {
  it('stores the decoded path on the node and writes it back unchanged', () => {
    const source = '![截图](测试.assets/a.png)\n'
    const doc = parseMarkdown(source)

    let nodeSrc = ''
    doc.descendants((node) => {
      if (node.type.name === 'image') nodeSrc = node.attrs.src as string
      return true
    })
    expect(nodeSrc).toBe('测试.assets/a.png')

    // 往返不脏写：打开中文链接的文档再保存，链接不能被改成 %E6%B5%8B…
    expect(serializeMarkdown(doc)).toContain('测试.assets/a.png')
    expect(serializeMarkdown(doc)).not.toContain('%E6')
  })
})

describe('decodeLinkTarget', () => {
  it('decodes percent-encoded non-ASCII paths', () => {
    expect(decodeLinkTarget('%E6%B5%8B%E8%AF%95.assets/a.png')).toBe('测试.assets/a.png')
  })

  it('returns the input when there is nothing to decode', () => {
    expect(decodeLinkTarget('demo.assets/a.png')).toBe('demo.assets/a.png')
    expect(decodeLinkTarget('')).toBe('')
  })

  it('does not throw on malformed escapes', () => {
    expect(decodeLinkTarget('100%.png')).toBe('100%.png')
    expect(decodeLinkTarget('%E6%B5')).toBe('%E6%B5')
  })
})
