import { reactive } from 'vue'

/**
 * 单行文本输入对话框的全局状态。
 *
 * 与 `utils/dialog.ts`（按钮式确认框）同一套思路：状态是模块级单例，由
 * `src/components/common/PromptDialog.vue` 在 `App.vue` 里挂载一次渲染，
 * 任何地方都能 `await requestPrompt(...)` 拿到用户输入。
 *
 * 为什么不放在使用它的组件里：新建文件 / 重命名 / 新建文件夹三个入口分散在
 * 文件树、文件菜单、折叠态侧栏，各有各的挂载时机（侧栏切到「大纲」或收起时
 * 文件树根本不渲染），把对话框绑在其中一个组件上，其它入口就调不到。
 */

/** 输入框聚焦时的初始选中范围 */
export type PromptSelection =
  /** 只选主文件名（不含最后一个后缀），重命名时直接打字就能改名、后缀保留 */
  | 'stem'
  /** 全选整个内容 */
  | 'all'

export interface PromptOptions {
  title: string
  initialValue?: string
  placeholder?: string
  /** 默认 `all` */
  selection?: PromptSelection
  /** 返回 null 表示合法，否则返回可直接展示给用户的错误文案 */
  validate?: (value: string) => string | null
  /** 确认按钮文案，默认「确定」 */
  confirmLabel?: string
}

export const promptState = reactive({
  visible: false,
  title: '',
  value: '',
  placeholder: '',
  error: '',
  selection: 'all' as PromptSelection,
  confirmLabel: '确定'
})

let validateFn: ((value: string) => string | null) | null = null
let resolvePrompt: ((value: string | null) => void) | null = null

/**
 * 「主文件名」的结束位置，用作 `setSelectionRange(0, end)` 的终点。
 *
 * - `笔记.mdx` → 2（后缀留在选中区之外）
 * - `a.tar.gz` → 5（与系统重命名一致，只剥最后一个后缀）
 * - `.gitignore` → 10（点开头没有后缀可言，整名当作主文件名）
 * - `README` → 6
 */
export function stemEndIndex(name: string): number {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? dot : name.length
}

/** 请求一次单行输入。用户取消时返回 `null`。 */
export function requestPrompt(options: PromptOptions): Promise<string | null> {
  // 同一时间只允许一个输入框：后来的请求把前一个当作取消收尾，
  // 否则前一个 Promise 永远悬着，调用方就卡在 await 上。
  resolvePrompt?.(null)
  resolvePrompt = null

  promptState.title = options.title
  promptState.value = options.initialValue ?? ''
  promptState.placeholder = options.placeholder ?? ''
  promptState.selection = options.selection ?? 'all'
  promptState.confirmLabel = options.confirmLabel ?? '确定'
  promptState.error = ''
  validateFn = options.validate ?? null
  promptState.visible = true

  return new Promise<string | null>((resolve) => {
    resolvePrompt = resolve
  })
}

/** 提交当前输入：校验不通过时只显示错误、不关闭。 */
export function submitPrompt(): void {
  // 校验用未裁剪的原值：「名称以空格结尾」这类错误必须能被拦下来
  const error = validateFn ? validateFn(promptState.value) : null
  if (error) {
    promptState.error = error
    return
  }
  closePrompt(promptState.value.trim())
}

export function cancelPrompt(): void {
  closePrompt(null)
}

export function isPromptOpen(): boolean {
  return promptState.visible
}

function closePrompt(value: string | null): void {
  promptState.visible = false
  promptState.error = ''
  validateFn = null
  const resolve = resolvePrompt
  resolvePrompt = null
  resolve?.(value)
}
