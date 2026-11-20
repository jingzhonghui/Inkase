import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileStore } from '../file'

/**
 * 右键菜单的「复制相对路径」/「复制路径」。
 *
 * 三条兜底注意点：
 * - 工作区根自身给 `.`（复制空串等于什么都没复制）；
 * - 库外路径、没打开文件夹时给绝对路径（相对路径无从谈起）；
 * - 输出一律正斜杠（去处是 Markdown 链接 / import 语句 / Git 命令）。
 */
describe('file store 复制路径', () => {
  let written: string[]

  beforeEach(() => {
    written = []
    setActivePinia(createPinia())
    vi.stubGlobal('window', {
      electronAPI: {
        getRecentFiles: vi.fn(async () => ({ success: true, data: [] })),
        authorizeWorkspaceRoot: vi.fn(async () => ({ success: true }))
      }
    })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    vi.stubGlobal('navigator', {
      userAgent: 'Windows',
      clipboard: {
        writeText: (text: string) => {
          written.push(text)
          return Promise.resolve()
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function lastWritten(): string | undefined {
    return written[written.length - 1]
  }

  it('库内文件给正斜杠相对路径，不带 ./ 前缀', () => {
    const store = useFileStore()
    store.openedFolderPath = 'C:/ws'

    store.copyRelativePath('C:\\ws\\docs\\b.md')

    expect(lastWritten()).toBe('docs/b.md')
  })

  it('工作区根自身给 `.`，不是空串', () => {
    const store = useFileStore()
    store.openedFolderPath = 'C:/ws'

    store.copyRelativePath('C:/ws/')

    expect(lastWritten()).toBe('.')
  })

  it('库外路径兜底给绝对路径', () => {
    const store = useFileStore()
    store.openedFolderPath = 'C:/ws'

    store.copyRelativePath('D:/other/a.md')

    expect(lastWritten()).toBe('D:/other/a.md')
  })

  it('没打开文件夹时给绝对路径', () => {
    const store = useFileStore()
    store.openedFolderPath = null

    store.copyRelativePath('C:/ws/docs/b.md')

    expect(lastWritten()).toBe('C:/ws/docs/b.md')
  })

  it('「复制路径」原样复制绝对路径', () => {
    const store = useFileStore()
    store.openedFolderPath = 'C:/ws'

    store.copyPath('C:/ws/docs/b.md')

    expect(lastWritten()).toBe('C:/ws/docs/b.md')
  })
})
