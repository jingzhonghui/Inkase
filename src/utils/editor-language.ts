import { languages } from '@codemirror/language-data'

type CodeLanguageDescription = (typeof languages)[number]

/**
 * language-data 未覆盖的常用后缀 → 语言名/别名 fallback 映射
 * 例如 .conf 与 .ini 格式几乎一致，借用 properties/ini 高亮规则
 */
const EXTENSION_FALLBACK: Record<string, string> = {
  conf: 'ini',
  cfg: 'ini',
  cnf: 'ini',
  env: 'properties',
  bashrc: 'shell',
  zshrc: 'shell',
  bash_profile: 'shell'
}

/** 按文件名匹配 CodeMirror 语法高亮语言；纯文本/无后缀/未知后缀返回 null */
export function findCodeLanguage(fileName: string): CodeLanguageDescription | null {
  if (!fileName.includes('.')) return null
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (!ext) return null

  const direct = languages.find((d) => d.extensions?.includes(ext))
  if (direct) return direct

  const fallbackName = EXTENSION_FALLBACK[ext]
  if (!fallbackName) return null
  return (
    languages.find((d) => d.alias?.includes(fallbackName)) ??
    languages.find((d) => d.name.toLowerCase() === fallbackName) ??
    null
  )
}

/** 语言展示名：修正 legacy 模式的冗长名称（Properties files → INI） */
export function languageDisplayName(desc: CodeLanguageDescription): string {
  if (desc.name === 'Properties files') return 'INI'
  return desc.name
}
