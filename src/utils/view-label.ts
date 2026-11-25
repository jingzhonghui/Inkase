import type { DocumentFormat } from '../types/mdx'
import { findCodeLanguage, languageDisplayName } from './editor-language'

/**
 * 「当前这个标签是什么视图」的展示名。
 *
 * 状态栏右侧那枚只读标签（不可切换编辑模式时）与「视图 → 编辑器模式」菜单里
 * 那条置灰项共用这一份判定，免得两处各写一遍、漏掉一种格式。
 *
 * 为什么不能只按「编辑模式」取名字：`effectiveEditorMode` 对**一切非 Markdown 文件**
 * 都返回 `plain`（`.sh`/`.txt`/图片/PDF/导图/图表全都一样），当时两处都是
 * `plainLanguageLabel ?? '纯文本'`，于是：
 * - 打开 `.png` 显示「纯文本」（图片根本不是文本）；
 * - 打开 `.drawio` 显示「纯文本」（那是画布）；
 * - 打开 `.inkmind` 也一样（导图在状态栏另有分支，菜单里就没有）。
 *
 * 所以先按 `format` 认图片 / PDF / 导图 / 图表，剩下的才按后缀猜编程语言——
 * 纯文本文件（`.txt`）确实只该叫「纯文本」，`.sh` 叫 Shell 也是对的。
 */
export function resolveViewLabel(input: {
  format?: DocumentFormat | null
  name?: string | null
}): string {
  switch (input.format) {
    case 'pdf':
      return 'PDF 预览'
    case 'image':
      return '图片'
    case 'mindmap':
      return '思维导图'
    case 'diagram':
      return '图表'
    default:
      break
  }

  const name = input.name
  if (!name) return '纯文本'
  const desc = findCodeLanguage(name)
  return desc ? languageDisplayName(desc) : '纯文本'
}
