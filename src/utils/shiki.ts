import { createHighlighter, type Highlighter } from 'shiki'

export type { Highlighter }

let highlighterPromise: Promise<Highlighter> | null = null

const SHARED_LANGS = [
  'javascript', 'typescript', 'python', 'go', 'rust', 'java',
  'c', 'cpp', 'csharp', 'php', 'ruby', 'swift', 'kotlin',
  'html', 'css', 'scss', 'json', 'yaml', 'xml', 'sql',
  'bash', 'powershell', 'dockerfile', 'markdown', 'vue',
  'svelte', 'astro', 'lua', 'perl', 'haskell', 'r', 'dart',
  'cmake'
]

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: [...SHARED_LANGS]
    })
  }
  return highlighterPromise
}
