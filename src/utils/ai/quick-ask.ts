/**
 * Quick Ask 的纯逻辑
 *
 * 编辑器只负责提供「归一化后的 Markdown 选区」，这里负责把 AI 答案
 * 以替换 / 插入 / 追加三种方式写回原文。把校验放在纯函数里，IR 与
 * 源码两种模式才能共用同一条路径。
 */

export type QuickAskAction = 'replace' | 'insert' | 'append'

export interface QuickAskTarget {
  from: number
  to: number
  text: string
}

export type QuickAskApplyResult =
  | { ok: true; content: string }
  | { ok: false; reason: string }

/** 送给模型的原文上限，避免一次选中整篇长文把上下文撑爆 */
const PROMPT_TEXT_LIMIT = 6000

function appendSeparator(content: string): string {
  if (content.length === 0) return ''
  if (content.endsWith('\n\n')) return ''
  if (content.endsWith('\n')) return '\n'
  return '\n\n'
}

/**
 * 把答案写回文档。
 *
 * - replace：替换当前选区
 * - insert：插入到选区之后，保留已选中的文字
 * - append：追加到文档末尾
 *
 * replace / insert 会校验原文是否仍与选区快照一致，避免 AI 回答期间
 * 用户已经改过文档却把旧答案盖上去。
 */
export function applyQuickAskAction(
  content: string,
  target: QuickAskTarget,
  action: QuickAskAction,
  answer: string
): QuickAskApplyResult {
  const text = answer.trim()
  if (!text) {
    return { ok: false, reason: 'AI 还没有返回可用内容' }
  }

  if (action === 'append') {
    return { ok: true, content: content + appendSeparator(content) + text }
  }

  if (target.from < 0 || target.to > content.length || target.from > target.to) {
    return { ok: false, reason: '选区已失效，请重新选择文本' }
  }

  if (content.slice(target.from, target.to) !== target.text) {
    return { ok: false, reason: '原文已变化，请重新选择文本' }
  }

  if (action === 'replace') {
    return {
      ok: true,
      content: content.slice(0, target.from) + text + content.slice(target.to)
    }
  }

  // 插入到选区之后：不覆盖用户已经选中的内容
  return {
    ok: true,
    content: content.slice(0, target.to) + text + content.slice(target.to)
  }
}

/**
 * 构造一次性的 Quick Ask 提示词。
 *
 * 明确要求「只输出最终结果」，这样替换/插入时不会把「好的，我来帮你改写」
 * 这类客套话写进笔记。解释类问题仍然可以直接给出答案。
 */
export function buildQuickAskPrompt(question: string, selection: string): string {
  const source = selection.trim()
  const excerpt =
    source.length > PROMPT_TEXT_LIMIT
      ? `${source.slice(0, PROMPT_TEXT_LIMIT)}\n…（原文过长，已截断）`
      : source

  return [
    '请基于下面这段笔记内容完成任务。',
    '只输出最终结果，不要解释你做了什么，不要调用工具。',
    '如果任务是在解释、总结或回答提问，直接给出简洁答案；',
    '如果任务是在改写、润色、续写或翻译，只给可以直接放回笔记的最终文本。',
    '',
    '【选中的原文】',
    excerpt,
    '',
    '【任务】',
    question.trim()
  ].join('\n')
}
