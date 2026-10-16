import {
  IconBrandCpp,
  IconBrandCSharp,
  IconBrandCss3,
  IconBrandDocker,
  IconBrandGit,
  IconBrandGolang,
  IconBrandHtml5,
  IconBrandJavascript,
  IconBrandKotlin,
  IconBrandNpm,
  IconBrandPhp,
  IconBrandPowershell,
  IconBrandPython,
  IconBrandReact,
  IconBrandRust,
  IconBrandSass,
  IconBrandSwift,
  IconBrandTypescript,
  IconBrandVue,
  IconCoffee,
  IconFile,
  IconFileCode,
  IconFileDescription,
  IconFileTypeCsv,
  IconFileTypeDocx,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeSql,
  IconFileTypeSvg,
  IconFileTypeTxt,
  IconFileTypeXls,
  IconFileTypeXml,
  IconFileTypeZip,
  IconFolder,
  IconJson,
  IconKey,
  IconLicense,
  IconLock,
  IconMarkdown,
  IconPhoto,
  IconSettings,
  IconTerminal2,
  type Icon
} from '@tabler/icons-vue'

/**
 * 文件图标类型。按扩展名（并补充少量特殊文件名）细分，
 * 与 VS Code 类似：只要能通过后缀识别，就用对应图标；
 * 无法识别时回退通用 `file`。图标本体来自 @tabler/icons-vue，
 * 配色由 `src/styles/file-icons.css` 的 `--file-icon-color` 提供。
 */
export type FileIconKey =
  | 'folder'
  | 'markdown'
  | 'pdf'
  | 'image'
  | 'svg'
  | 'archive'
  | 'typescript'
  | 'javascript'
  | 'react'
  | 'vue'
  | 'html'
  | 'css'
  | 'sass'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'swift'
  | 'php'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'shell'
  | 'powershell'
  | 'sql'
  | 'code'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'csv'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'text'
  | 'log'
  | 'docker'
  | 'git'
  | 'license'
  | 'env'
  | 'npm'
  | 'config'
  | 'lock'
  | 'file'

/** 键 → Tabler 图标组件（单一数据源，文件树与标签栏共用）。 */
export const FILE_ICON_COMPONENTS: Record<FileIconKey, Icon> = {
  folder: IconFolder,
  markdown: IconMarkdown,
  pdf: IconFileTypePdf,
  image: IconPhoto,
  svg: IconFileTypeSvg,
  archive: IconFileTypeZip,
  typescript: IconBrandTypescript,
  javascript: IconBrandJavascript,
  react: IconBrandReact,
  vue: IconBrandVue,
  html: IconBrandHtml5,
  css: IconBrandCss3,
  sass: IconBrandSass,
  python: IconBrandPython,
  rust: IconBrandRust,
  go: IconBrandGolang,
  java: IconCoffee,
  kotlin: IconBrandKotlin,
  swift: IconBrandSwift,
  php: IconBrandPhp,
  c: IconFileCode,
  cpp: IconBrandCpp,
  csharp: IconBrandCSharp,
  shell: IconTerminal2,
  powershell: IconBrandPowershell,
  sql: IconFileTypeSql,
  code: IconFileCode,
  json: IconJson,
  yaml: IconFileDescription,
  toml: IconFileDescription,
  xml: IconFileTypeXml,
  csv: IconFileTypeCsv,
  word: IconFileTypeDocx,
  excel: IconFileTypeXls,
  powerpoint: IconFileTypePpt,
  text: IconFileTypeTxt,
  log: IconFileDescription,
  docker: IconBrandDocker,
  git: IconBrandGit,
  license: IconLicense,
  env: IconKey,
  npm: IconBrandNpm,
  config: IconSettings,
  lock: IconLock,
  file: IconFile
}

/** 扩展名（小写，不含点）→ 图标键。 */
const EXTENSION_TO_KEY: Record<string, FileIconKey> = {
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  tif: 'image',
  tiff: 'image',
  svg: 'svg',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  tgz: 'archive',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'react',
  jsx: 'react',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  vue: 'vue',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  less: 'sass',
  styl: 'sass',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  bat: 'shell',
  cmd: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  sql: 'sql',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  csv: 'csv',
  tsv: 'csv',
  doc: 'word',
  docx: 'word',
  odt: 'word',
  rtf: 'word',
  xls: 'excel',
  xlsx: 'excel',
  ods: 'excel',
  ppt: 'powerpoint',
  pptx: 'powerpoint',
  odp: 'powerpoint',
  txt: 'text',
  log: 'log',
  ini: 'config',
  conf: 'config',
  cfg: 'config',
  properties: 'config',
  env: 'env',
  lock: 'lock',
  lua: 'code',
  r: 'code',
  rb: 'code',
  pl: 'code',
  pm: 'code',
  scala: 'code',
  dart: 'code',
  clj: 'code',
  ex: 'code',
  exs: 'code',
  hs: 'code',
  erl: 'code',
  groovy: 'code',
  m: 'code',
  mm: 'code'
}

/** 特殊文件名（小写）→ 图标键，优先于扩展名。 */
const FILENAME_TO_KEY: Record<string, FileIconKey> = {
  'package.json': 'npm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  '.npmrc': 'npm',
  'tsconfig.json': 'config',
  '.editorconfig': 'config',
  '.prettierrc': 'config',
  '.prettierrc.json': 'config',
  '.prettierrc.yaml': 'config',
  '.prettierrc.yml': 'config',
  '.eslintrc': 'config',
  '.eslintrc.json': 'config',
  '.eslintrc.js': 'config',
  '.babelrc': 'config',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitconfig': 'git',
  '.gitkeep': 'git',
  '.dockerignore': 'docker',
  'dockerfile': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  'compose.yaml': 'docker',
  '.env': 'env',
  'license': 'license',
  'license.md': 'license',
  'license.txt': 'license',
  'licence': 'license',
  'licence.md': 'license',
  'licence.txt': 'license',
  'makefile': 'shell',
  'gnumakefile': 'shell',
  'cmakelists.txt': 'shell',
  'readme': 'markdown',
  'readme.md': 'markdown',
  'readme.markdown': 'markdown',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell'
}

/** 文件名前缀/模式特例，优先级介于精确文件名与扩展名之间。 */
function matchFilenamePattern(lowerName: string): FileIconKey | null {
  if (lowerName.startsWith('dockerfile')) return 'docker'
  if (lowerName.startsWith('docker-compose') || lowerName.startsWith('compose.')) return 'docker'
  if (lowerName.startsWith('.env')) return 'env'
  if (lowerName.startsWith('readme')) return 'markdown'
  if (lowerName.startsWith('license') || lowerName.startsWith('licence')) return 'license'
  if (lowerName.startsWith('tsconfig')) return 'config'
  if (/\.config\.(js|jsx|ts|tsx|mjs|cjs|json)$/.test(lowerName)) return 'config'
  if (/^\.(eslintrc|prettierrc|stylelintrc|babelrc|swcrc)/.test(lowerName)) return 'config'
  return null
}

/** 由文件名（含目录判定）得出图标键。 */
export function getFileIconKey(name: string, isDirectory: boolean): FileIconKey {
  if (isDirectory) return 'folder'

  const lowerName = name.toLowerCase()

  const filenameKey = FILENAME_TO_KEY[lowerName]
  if (filenameKey) return filenameKey

  const patternKey = matchFilenamePattern(lowerName)
  if (patternKey) return patternKey

  const extension = name.split('.').pop()?.toLowerCase()
  if (!extension || extension === lowerName) return 'file'

  return EXTENSION_TO_KEY[extension] ?? 'file'
}

/** 由文件名得出对应的 Tabler 图标组件。 */
export function getFileIconComponent(name: string, isDirectory: boolean): Icon {
  return FILE_ICON_COMPONENTS[getFileIconKey(name, isDirectory)]
}
