import { fuzzyMatch } from './fuzzy'

/**
 * 代码块语言清单（IR 编辑器的语言下拉、以及围栏 info 的归一）。
 *
 * 三个字段各管一件事，别混用：
 * - `value` 写进围栏 info，必须是 Shiki 认识的语言 id（`txt` 是纯文本）；
 * - `label` 是下拉里给人看的文字；
 * - `keywords` **只参与搜索**，不上屏——`cmakelists` 在 Shiki 里没有对应语言，
 *   只能当 `cmake` 的搜索词，否则写进围栏就是一段没有高亮的死字。
 */
export interface CodeLanguage {
  /** 写进围栏 info 的语言标识 */
  value: string
  /** 下拉框里显示的文字 */
  label: string
  /** 额外的搜索词（别名、常见文件名） */
  keywords?: readonly string[]
}

/**
 * 语言清单。
 *
 * 纯文本只留一条：早先同时存在 `''` 与 `text` 两条「纯文本」，选项面板里出现
 * 两个一模一样的条目，选哪个都无法区分。现在统一成 `txt`——它是 Shiki 的纯文本
 * 别名，写进围栏也读得懂。
 */
export const CODE_BLOCK_LANGUAGES: readonly CodeLanguage[] = [
  { value: 'txt', label: 'txt', keywords: ['text', 'plaintext', '纯文本'] },
  { value: 'javascript', label: 'JavaScript', keywords: ['js'] },
  { value: 'typescript', label: 'TypeScript', keywords: ['ts'] },
  { value: 'python', label: 'Python', keywords: ['py'] },
  { value: 'java', label: 'Java' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++', keywords: ['c++', 'cxx'] },
  { value: 'csharp', label: 'C#', keywords: ['c#', 'cs'] },
  { value: 'go', label: 'Go', keywords: ['golang'] },
  { value: 'rust', label: 'Rust', keywords: ['rs'] },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'scss', label: 'SCSS' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML', keywords: ['yml'] },
  { value: 'xml', label: 'XML' },
  { value: 'sql', label: 'SQL' },
  { value: 'bash', label: 'Bash', keywords: ['sh', 'shell', 'zsh'] },
  { value: 'powershell', label: 'PowerShell', keywords: ['ps1', 'pwsh'] },
  { value: 'markdown', label: 'Markdown', keywords: ['md'] },
  { value: 'vue', label: 'Vue' },
  { value: 'svelte', label: 'Svelte' },
  { value: 'lua', label: 'Lua' },
  { value: 'ruby', label: 'Ruby', keywords: ['rb'] },
  { value: 'php', label: 'PHP' },
  { value: 'swift', label: 'Swift' },
  { value: 'kotlin', label: 'Kotlin', keywords: ['kt'] },
  { value: 'dockerfile', label: 'Dockerfile', keywords: ['docker'] },
  { value: 'cmake', label: 'CMake', keywords: ['cmakelists', 'cmakelists.txt'] }
]

/** 围栏里常见的写法 → 清单里的规范 id */
const LANGUAGE_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  text: 'txt',
  plaintext: 'txt',
  plain: 'txt',
  cmakelists: 'cmake',
  'cmakelists.txt': 'cmake'
}

/** 纯文本的规范标识：空围栏、`text`、`plaintext` 都归到它 */
export const PLAIN_TEXT_LANGUAGE = 'txt'

/**
 * 归一围栏/节点上的语言标识：去空白、转小写、套用别名。
 * 空串归到 `txt`（纯文本），与下拉里的「txt」是同一个东西。
 */
export function normalizeCodeLanguage(language: string): string {
  const lower = language.trim().toLowerCase()
  if (!lower) return PLAIN_TEXT_LANGUAGE
  return LANGUAGE_ALIASES[lower] ?? lower
}

/**
 * 下拉框触发器上显示的文字。
 * 清单里没有的语言（手写围栏里的 `scheme`、`zig`…）原样显示，不要吞成「txt」。
 */
export function codeLanguageLabel(language: string): string {
  const normalized = normalizeCodeLanguage(language)
  const known = CODE_BLOCK_LANGUAGES.find((item) => item.value === normalized)
  return known ? known.label : normalized
}

export interface CodeLanguageMatch {
  language: CodeLanguage
  score: number
  /** 命中字符在 `label` 中的下标；命中的是搜索词时为空 */
  positions: number[]
}

/** 标签命中的权重：同一个查询既能命中标签又能命中搜索词时，标签优先 */
const LABEL_WEIGHT = 2

/**
 * 按查询词过滤语言清单：标签走模糊匹配并打分排序，标签没命中再试
 * `value` 与 `keywords`（这两个只决定「留不留」，不产生高亮位置）。
 * 空查询按清单原顺序返回全部。
 */
export function matchCodeLanguages(
  query: string,
  languages: readonly CodeLanguage[] = CODE_BLOCK_LANGUAGES
): CodeLanguageMatch[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return languages.map((language) => ({ language, score: 0, positions: [] }))
  }

  const matches: CodeLanguageMatch[] = []
  for (const language of languages) {
    const onLabel = fuzzyMatch(trimmed, language.label)
    if (onLabel) {
      matches.push({
        language,
        score: onLabel.score * LABEL_WEIGHT + 1,
        positions: onLabel.positions
      })
      continue
    }

    const haystacks = [language.value, ...(language.keywords ?? [])]
    if (haystacks.some((text) => fuzzyMatch(trimmed, text) !== null)) {
      matches.push({ language, score: 1, positions: [] })
    }
  }

  // Array.prototype.sort 是稳定排序，同分项保持清单里的原始顺序
  matches.sort((a, b) => b.score - a.score)
  return matches
}
