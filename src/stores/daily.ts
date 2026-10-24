import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useFileStore } from './file'

const DAILY_STORAGE_KEY = 'inkase-daily-note'

export interface DailyNoteConfig {
  /** 相对库根的目录；空串表示库根 */
  directory: string
  /** 文件名格式，支持 YYYY / MM / DD / HH / mm / ss */
  filenamePattern: string
  /** Markdown 模板，支持 {{date}} / {{time}} / {{title}} */
  template: string
}

export const DEFAULT_DAILY_CONFIG: DailyNoteConfig = {
  directory: 'daily',
  filenamePattern: 'YYYY-MM-DD',
  template: '# {{date}}\n\n'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地日期分量（不经过 UTC，避免跨时区错一天） */
export function dateParts(date: Date): Record<'YYYY' | 'MM' | 'DD' | 'HH' | 'mm' | 'ss', string> {
  return {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds())
  }
}

/** 按格式串生成文件名（未补扩展名） */
export function formatDailyName(pattern: string, date: Date): string {
  const parts = dateParts(date)
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => parts[token as keyof typeof parts])
}

/** 校验并规范化每日笔记目录；拒绝绝对路径与 `..` */
export function normalizeDailyDirectory(input: string): string {
  const cleaned = input.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '')
  if (cleaned === '') return ''
  const segments = cleaned.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes(':')) {
      throw new Error('每日笔记目录必须是库内相对路径')
    }
  }
  return segments.join('/')
}

/** Windows 文件名非法字符替换为连字符 */
function sanitizeFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
}

/** 从配置生成最终文件名（总是 .md） */
export function dailyFileName(config: DailyNoteConfig, date: Date): string {
  const stem = sanitizeFileName(formatDailyName(config.filenamePattern, date).replace(/\.(md|mdx)$/i, ''))
  return `${stem === '' ? formatDailyName('YYYY-MM-DD', date) : stem}.md`
}

/** 把模板中的占位符替换为实际值 */
export function renderDailyTemplate(
  template: string,
  date: Date,
  title: string
): string {
  const parts = dateParts(date)
  return template
    .replace(/\{\{date\}\}/g, `${parts.YYYY}-${parts.MM}-${parts.DD}`)
    .replace(/\{\{time\}\}/g, `${parts.HH}:${parts.mm}`)
    .replace(/\{\{title\}\}/g, title)
}

function sanitizeConfig(input: Partial<DailyNoteConfig>): DailyNoteConfig {
  const directory = typeof input.directory === 'string'
    ? normalizeDailyDirectory(input.directory)
    : DEFAULT_DAILY_CONFIG.directory
  const filenamePattern = typeof input.filenamePattern === 'string' && input.filenamePattern.trim() !== ''
    ? input.filenamePattern.trim().slice(0, 120)
    : DEFAULT_DAILY_CONFIG.filenamePattern
  const template = typeof input.template === 'string'
    ? input.template.slice(0, 20_000)
    : DEFAULT_DAILY_CONFIG.template
  return { directory, filenamePattern, template }
}

function loadConfig(): DailyNoteConfig {
  try {
    const raw = localStorage.getItem(DAILY_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_DAILY_CONFIG }
    const parsed = JSON.parse(raw) as Partial<DailyNoteConfig>
    return sanitizeConfig(parsed)
  } catch {
    return { ...DEFAULT_DAILY_CONFIG }
  }
}

function joinPath(root: string, ...segments: string[]): string {
  const base = root.replace(/[\\/]+$/, '')
  const tail = segments
    .filter((segment) => segment !== '')
    .map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ''))
    .join('/')
  return tail === '' ? base : `${base}/${tail}`
}

/**
 * 每日笔记
 *
 * 配置存 localStorage（与外观设置一致，不写入知识库，避免同步冲突）；
 * 文件创建复用文件 store 的文件夹/标签能力，因此会正常进入文件树与最近打开。
 */
export const useDailyStore = defineStore('daily', () => {
  const config = ref<DailyNoteConfig>(loadConfig())
  const error = ref<string | null>(null)
  const opening = ref(false)

  function updateConfig(patch: Partial<DailyNoteConfig>): boolean {
    try {
      config.value = sanitizeConfig({ ...config.value, ...patch })
      error.value = null
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '每日笔记目录无效'
      return false
    }
    try {
      localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify(config.value))
    } catch {
      // 存储失败不阻断使用
    }
    return true
  }

  async function ensureDirectory(root: string, directory: string): Promise<string> {
    let current = root
    if (directory === '') return current
    for (const segment of directory.split('/')) {
      await useFileStore().createFolder(current, segment)
      current = joinPath(current, segment)
    }
    return current
  }

  /** 打开指定日期的每日笔记；不存在则按模板创建 */
  async function openFor(date: Date): Promise<boolean> {
    if (opening.value) return false
    opening.value = true
    error.value = null
    const fileStore = useFileStore()
    try {
      let root = fileStore.openedFolderPath
      if (!root) {
        await fileStore.openFolder()
        root = fileStore.openedFolderPath
        if (!root) {
          error.value = '请先打开一个文件夹'
          return false
        }
      }

      const directory = normalizeDailyDirectory(config.value.directory)
      const filename = dailyFileName(config.value, date)
      const targetDir = await ensureDirectory(root, directory)
      const targetPath = joinPath(targetDir, filename)

      const created = await fileStore.createFile(targetDir, filename)
      if (created) {
        const title = filename.replace(/\.md$/i, '')
        const content = renderDailyTemplate(config.value.template, date, title)
        if (content.trim() !== '') {
          fileStore.updateContent(content)
          const saved = await fileStore.saveFile()
          if (!saved) {
            error.value = fileStore.error ?? '每日笔记保存失败'
            return false
          }
        }
        return true
      }

      // 已存在：直接打开，不覆盖用户内容
      const opened = await fileStore.openFile(targetPath, { addToRecent: false })
      if (!opened) error.value = fileStore.error ?? '每日笔记打开失败'
      return opened
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '每日笔记打开失败'
      return false
    } finally {
      opening.value = false
    }
  }

  async function openToday(): Promise<boolean> {
    return openFor(new Date())
  }

  return {
    config,
    error,
    opening,
    updateConfig,
    openFor,
    openToday
  }
})
