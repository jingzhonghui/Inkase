/**
 * HTML → Markdown 转换器测试
 */

import { describe, it, expect } from 'vitest'
import { htmlToMarkdown } from '../html-to-md'

describe('htmlToMarkdown', () => {
  it('should convert headings', () => {
    const html = '<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('# Title')
    expect(md).toContain('## Subtitle')
    expect(md).toContain('### Section')
  })

  it('should convert paragraphs', () => {
    const html = '<p>Hello world</p><p>Second paragraph</p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('Hello world')
    expect(md).toContain('Second paragraph')
  })

  it('should convert bold and italic', () => {
    const html = '<p><strong>bold</strong> and <em>italic</em></p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('**bold**')
    expect(md).toContain('*italic*')
  })

  it('should convert inline code', () => {
    const html = '<p>Use <code>console.log()</code></p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('`console.log()`')
  })

  it('should convert code blocks', () => {
    const html = '<pre><code class="language-js">const x = 1</code></pre>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('```js')
    expect(md).toContain('const x = 1')
    expect(md).toContain('```')
  })

  it('should convert links', () => {
    const html = '<p><a href="https://example.com">Example</a></p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('[Example](https://example.com)')
  })

  it('should convert images with imageMap', () => {
    const html = '<p><img src="old.png" alt="pic"></p>'
    const imageMap = new Map([['old.png', 'assets/images/new.png']])
    const md = htmlToMarkdown(html, { imageMap })
    expect(md).toContain('![pic](assets/images/new.png)')
  })

  it('should convert unordered lists', () => {
    const html = '<ul><li>Item 1</li><li>Item 2</li></ul>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('- Item 1')
    expect(md).toContain('- Item 2')
  })

  it('should convert ordered lists', () => {
    const html = '<ol><li>First</li><li>Second</li></ol>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('1. First')
    expect(md).toContain('2. Second')
  })

  it('should convert nested lists', () => {
    const html = '<ul><li>Parent<ul><li>Child</li></ul></li></ul>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('- Parent')
    expect(md).toContain('  - Child')
  })

  it('should convert blockquotes', () => {
    const html = '<blockquote><p>Quoted text</p></blockquote>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('> Quoted text')
  })

  it('should convert horizontal rules', () => {
    const html = '<p>Before</p><hr><p>After</p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('---')
  })

  it('should convert tables', () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th>Age</th></tr></thead>
        <tbody><tr><td>Alice</td><td>30</td></tr></tbody>
      </table>
    `
    const md = htmlToMarkdown(html)
    expect(md).toContain('| Name | Age |')
    expect(md).toContain('| --- | --- |')
    expect(md).toContain('| Alice | 30 |')
  })

  it('should escape special characters', () => {
    const html = '<p>text with * asterisk</p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('\\*')
  })

  it('should handle empty input', () => {
    const md = htmlToMarkdown('')
    expect(md.trim()).toBe('')
  })
})