import { describe, expect, it } from 'vitest'
import { resolveViewLabel } from '../view-label'

/**
 * 状态栏那枚只读标签与「视图 → 编辑器模式」菜单共用的展示名。
 *
 * 回归背景：这里早先是 `plainLanguageLabel ?? '纯文本'`，而 `effectiveEditorMode`
 * 对一切非 Markdown 文件都返回 `plain`，于是打开 `.png`（还有 `.drawio`）时
 * 状态栏写着「纯文本」——图片和画布根本不是文本。
 */
describe('resolveViewLabel', () => {
  it('图片 / PDF / 导图 / 图表按格式给出视图名，不按后缀猜语言', () => {
    expect(resolveViewLabel({ format: 'image', name: 'pic.png' })).toBe('图片')
    expect(resolveViewLabel({ format: 'pdf', name: 'doc.pdf' })).toBe('PDF 预览')
    expect(resolveViewLabel({ format: 'mindmap', name: 'map.inkmind' })).toBe('思维导图')
    expect(resolveViewLabel({ format: 'diagram', name: 'flow.drawio' })).toBe('图表')
  })

  it('纯文本文件仍按后缀给出语言名，未知后缀回落「纯文本」', () => {
    expect(resolveViewLabel({ format: 'markdown', name: 'deploy.sh' })).toBe('Shell')
    expect(resolveViewLabel({ format: 'markdown', name: 'notes.txt' })).toBe('纯文本')
    expect(resolveViewLabel({ format: 'markdown', name: 'notes' })).toBe('纯文本')
  })

  it('没有文件名时回落「纯文本」（空白标签）', () => {
    expect(resolveViewLabel({})).toBe('纯文本')
    expect(resolveViewLabel({ format: null, name: null })).toBe('纯文本')
  })
})
