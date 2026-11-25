/**
 * 「光标处格式」快照：编辑工具栏靠它决定哪个按钮该高亮。
 *
 * 这份类型是编辑器（即时渲染 / 源码）与工具栏之间唯一的约定。两边各自从
 * 自己的模型里读（ProseMirror 读 marks 与祖先节点，CodeMirror 读语法树），
 * 但产出的必须是同一副形状——工具栏不理解任何一个编辑器的内部。
 */
export interface EditorFormatState {
  bold: boolean
  italic: boolean
  strikethrough: boolean
  /** 内联代码 */
  code: boolean
  /** 0 = 正文，1–6 = 对应级别的标题 */
  heading: number
  blockquote: boolean
  bulletList: boolean
  orderedList: boolean
  codeBlock: boolean
}

export const EMPTY_EDITOR_FORMAT_STATE: EditorFormatState = {
  bold: false,
  italic: false,
  strikethrough: false,
  code: false,
  heading: 0,
  blockquote: false,
  bulletList: false,
  orderedList: false,
  codeBlock: false
}

/**
 * 编辑器 → 工具栏的状态通道。
 *
 * 用窗口事件而不是 props：工具栏挂在 `EditorPanel` 上，编辑器是它的**后代**，
 * 而同一时刻真正在跑的是哪一个（即时渲染 / 源码 / 分屏左栏）由一大堆 `v-if`
 * 决定。走事件后双方互不引用，工具栏也不必知道当前是哪种模式。
 * 与 `editor:format`、`editor:image` 那几条命令通道是同一种做法。
 */
export const EDITOR_FORMAT_STATE_EVENT = 'editor:format-state'

export function publishEditorFormatState(state: EditorFormatState): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(EDITOR_FORMAT_STATE_EVENT, { detail: state }))
}
