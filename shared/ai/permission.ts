/**
 * AI 权限模式。
 *
 * 三档描述的是「AI 能对工作区做什么」，不是「要不要弹窗」：
 * - `readonly`：只读——只能读取、检索与分析，修改类工具直接拒绝；
 * - `standard`：标准——修改前逐次请求用户批准（默认）；
 * - `auto`：完全控制——写入、移动、删除直接执行，会话里仍留审计记录。
 *
 * 这是「运行期许可」而不是 Provider 参数：切换要立即生效、要能持久化，
 * 但不能参与能力探测的指纹（模式不影响模型能力）。
 *
 * 取值与文案只在这里维护一份：主进程校验、渲染层下拉、配置迁移都读它。
 */
export const AI_PERMISSION_MODES = ['readonly', 'standard', 'auto'] as const

export type AiPermissionMode = (typeof AI_PERMISSION_MODES)[number]

export const DEFAULT_AI_PERMISSION_MODE: AiPermissionMode = 'standard'

export interface AiPermissionModeOption {
  value: AiPermissionMode
  label: string
  /** 下拉旁边的一句话说明；写「会发生什么」，不写「推荐」。 */
  hint: string
}

export const AI_PERMISSION_MODE_OPTIONS: readonly AiPermissionModeOption[] = [
  {
    value: 'readonly',
    label: '只读',
    hint: '只能读取与分析，修改请求会被直接拒绝'
  },
  {
    value: 'standard',
    label: '标准',
    hint: '修改前逐次请求你的批准'
  },
  {
    value: 'auto',
    label: '完全控制',
    hint: '自动执行写入、移动与删除，操作仍记录在会话里'
  }
]

/**
 * 旧配置里存的是 `ask`，语义就是现在的标准模式。
 * 只做单向迁移：新配置不再写 `ask`。
 */
const LEGACY_MODE_ALIASES: Readonly<Record<string, AiPermissionMode>> = {
  ask: 'standard'
}

/** 把配置、IPC、旧数据里的任意值收敛成合法模式；不认识的一律回落默认值。 */
export function normalizeAiPermissionMode(value: unknown): AiPermissionMode {
  if (typeof value !== 'string') return DEFAULT_AI_PERMISSION_MODE
  const candidate = value.trim().toLowerCase()
  if ((AI_PERMISSION_MODES as readonly string[]).includes(candidate)) {
    return candidate as AiPermissionMode
  }
  return LEGACY_MODE_ALIASES[candidate] ?? DEFAULT_AI_PERMISSION_MODE
}

/** 取某个模式的展示信息；非法值走默认值，调用方不用写兜底分支。 */
export function permissionModeOption(mode: AiPermissionMode): AiPermissionModeOption {
  return (
    AI_PERMISSION_MODE_OPTIONS.find((option) => option.value === mode) ??
    AI_PERMISSION_MODE_OPTIONS[1]
  )
}
