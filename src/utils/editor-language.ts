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

/**
 * 按**整份文件名**认语言的固定名文件：后缀一样、语言不一样，只能靠名字区分。
 * `CMakeLists.txt` 的后缀是 `.txt`，按后缀匹配拿不到任何语言，但它该按 CMake 高亮。
 */
const FILE_NAME_LANGUAGES: Record<string, string> = {
  'cmakelists.txt': 'cmake'
}

function findByNameOrAlias(name: string): CodeLanguageDescription | null {
  return (
    languages.find((d) => d.alias?.includes(name)) ??
    languages.find((d) => d.name.toLowerCase() === name) ??
    null
  )
}

/** 按文件名匹配 CodeMirror 语法高亮语言；纯文本/无后缀/未知后缀返回 null */
export function findCodeLanguage(fileName: string): CodeLanguageDescription | null {
  const lowerName = fileName.toLowerCase()

  const byName = FILE_NAME_LANGUAGES[lowerName]
  if (byName) {
    const found = findByNameOrAlias(byName)
    if (found) return found
  }

  if (!fileName.includes('.')) return null
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (!ext) return null

  const direct = languages.find((d) => d.extensions?.includes(ext))
  if (direct) return direct

  const fallbackName = EXTENSION_FALLBACK[ext]
  if (!fallbackName) return null
  return findByNameOrAlias(fallbackName)
}

/** 语言展示名：修正 legacy 模式的冗长名称（Properties files → INI） */
export function languageDisplayName(desc: CodeLanguageDescription): string {
  if (desc.name === 'Properties files') return 'INI'
  return desc.name
}
