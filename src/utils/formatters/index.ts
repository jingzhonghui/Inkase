import type { Plugin } from 'prettier'

export type FormatResult =
  | { ok: true; result: string }
  | { ok: false; error: string }

interface FormatterSpec {
  /** Prettier parser 名称 */
  parser: string
  /** 该 parser 需要的插件（懒加载，保持首屏包体积不变） */
  load: () => Promise<Plugin[]>
}

type PluginModule = { default?: Plugin } & Partial<Plugin>

/**
 * 取插件模块的 default 导出（Prettier 插件的运行时默认导出），
 * 兼容 .d.ts 未声明 default 的情况。
 * 传入 loader 而非字符串，保证 Vite 能静态分析并分包。
 */
async function loadPlugin(loader: () => Promise<unknown>): Promise<Plugin> {
  const mod = (await loader()) as PluginModule
  return mod.default ?? (mod as unknown as Plugin)
}

const babelPlugins = async (): Promise<Plugin[]> => [
  await loadPlugin(() => import('prettier/plugins/babel')),
  await loadPlugin(() => import('prettier/plugins/estree'))
]

const typescriptPlugins = async (): Promise<Plugin[]> => [
  await loadPlugin(() => import('prettier/plugins/typescript')),
  await loadPlugin(() => import('prettier/plugins/estree'))
]

const postcssPlugins = async (): Promise<Plugin[]> => [
  await loadPlugin(() => import('prettier/plugins/postcss'))
]

const htmlPlugins = async (): Promise<Plugin[]> => [
  await loadPlugin(() => import('prettier/plugins/html'))
]

const yamlPlugins = async (): Promise<Plugin[]> => [
  await loadPlugin(() => import('prettier/plugins/yaml'))
]

const graphqlPlugins = async (): Promise<Plugin[]> => [
  await loadPlugin(() => import('prettier/plugins/graphql'))
]

/** 扩展名 → Prettier parser 映射（仅前端/结构化类语言，不含 Python/Shell） */
const EXTENSION_FORMATTERS: Record<string, FormatterSpec> = {
  json: { parser: 'json', load: babelPlugins },
  js: { parser: 'babel', load: babelPlugins },
  mjs: { parser: 'babel', load: babelPlugins },
  cjs: { parser: 'babel', load: babelPlugins },
  jsx: { parser: 'babel', load: babelPlugins },
  ts: { parser: 'typescript', load: typescriptPlugins },
  mts: { parser: 'typescript', load: typescriptPlugins },
  cts: { parser: 'typescript', load: typescriptPlugins },
  tsx: { parser: 'typescript', load: typescriptPlugins },
  css: { parser: 'css', load: postcssPlugins },
  scss: { parser: 'scss', load: postcssPlugins },
  less: { parser: 'less', load: postcssPlugins },
  html: { parser: 'html', load: htmlPlugins },
  htm: { parser: 'html', load: htmlPlugins },
  vue: { parser: 'vue', load: htmlPlugins },
  yaml: { parser: 'yaml', load: yamlPlugins },
  yml: { parser: 'yaml', load: yamlPlugins },
  graphql: { parser: 'graphql', load: graphqlPlugins },
  gql: { parser: 'graphql', load: graphqlPlugins }
}

/** 取文件名的扩展名（小写）；无扩展名或点文件返回 null */
export function fileExtension(fileName: string): string | null {
  const base = fileName.split(/[/\\]/).pop() ?? fileName
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return base.slice(dot + 1).toLowerCase()
}

/** 该文件是否支持格式化 */
export function isFormattable(fileName: string): boolean {
  const ext = fileExtension(fileName)
  return !!ext && ext in EXTENSION_FORMATTERS
}

/**
 * 用 Prettier 格式化代码文本。
 * 成功返回格式化后的文本，失败返回错误信息（绝不抛出）。
 */
export async function formatCode(text: string, fileName: string): Promise<FormatResult> {
  const ext = fileExtension(fileName)
  const spec = ext ? EXTENSION_FORMATTERS[ext] : undefined
  if (!spec) return { ok: false, error: '当前文件类型不支持格式化' }

  try {
    const prettier = await import('prettier/standalone')
    const plugins = await spec.load()
    const result = await prettier.format(text, { parser: spec.parser, plugins, filepath: fileName })
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
