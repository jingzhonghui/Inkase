// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  DEFAULT_DAILY_CONFIG,
  dailyFileName,
  formatDailyName,
  normalizeDailyDirectory,
  renderDailyTemplate,
  useDailyStore
} from '../daily'
import { useFileStore } from '../file'

const DAY = new Date(2026, 9, 24, 9, 5, 0)

function setupVault(path: string | null = 'C:/vault') {
  const fileStore = useFileStore()
  fileStore.openedFolderPath = path
  const createFolder = vi.spyOn(fileStore, 'createFolder').mockResolvedValue(true)
  const createFile = vi.spyOn(fileStore, 'createFile').mockResolvedValue(true)
  const openFile = vi.spyOn(fileStore, 'openFile').mockResolvedValue(true)
  const updateContent = vi.spyOn(fileStore, 'updateContent').mockImplementation(() => {})
  const saveFile = vi.spyOn(fileStore, 'saveFile').mockResolvedValue(true)
  return { fileStore, createFolder, createFile, openFile, updateContent, saveFile }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('daily note formatting', () => {
  it('formats local date tokens and renders the template', () => {
    expect(formatDailyName('YYYY-MM-DD', DAY)).toBe('2026-10-24')
    expect(dailyFileName({ ...DEFAULT_DAILY_CONFIG, filenamePattern: '日记/YYYY' }, DAY)).toBe('日记-2026.md')
    expect(renderDailyTemplate('# {{date}} {{time}}\n\n{{title}}', DAY, '2026-10-24')).toBe(
      '# 2026-10-24 09:05\n\n2026-10-24'
    )
  })

  it('accepts nested relative directories and rejects traversal', () => {
    expect(normalizeDailyDirectory('journal/2026')).toBe('journal/2026')
    expect(normalizeDailyDirectory('')).toBe('')
    expect(() => normalizeDailyDirectory('../outside')).toThrow(/相对路径/)
    expect(() => normalizeDailyDirectory('C:/absolute')).toThrow(/相对路径/)
  })
})

describe('daily note store', () => {
  it('creates a missing note with the rendered template and saves it', async () => {
    const { createFolder, createFile, updateContent, saveFile } = setupVault()
    const store = useDailyStore()

    const ok = await store.openFor(DAY)

    expect(ok).toBe(true)
    expect(createFolder).toHaveBeenCalledWith('C:/vault', 'daily')
    expect(createFile).toHaveBeenCalledWith('C:/vault/daily', '2026-10-24.md')
    expect(updateContent).toHaveBeenCalledWith('# 2026-10-24\n\n')
    expect(saveFile).toHaveBeenCalled()
  })

  it('opens an existing note without overwriting it', async () => {
    const { createFile, openFile, updateContent } = setupVault()
    createFile.mockResolvedValue(false)
    const store = useDailyStore()

    const ok = await store.openFor(DAY)

    expect(ok).toBe(true)
    expect(openFile).toHaveBeenCalledWith('C:/vault/daily/2026-10-24.md', { addToRecent: false })
    expect(updateContent).not.toHaveBeenCalled()
  })

  it('creates nested directories in order', async () => {
    const { createFolder, createFile } = setupVault()
    const store = useDailyStore()
    store.updateConfig({ directory: 'journal/2026', filenamePattern: 'DD', template: '' })

    await store.openFor(DAY)

    expect(createFolder.mock.calls).toEqual([
      ['C:/vault', 'journal'],
      ['C:/vault/journal', '2026']
    ])
    expect(createFile).toHaveBeenCalledWith('C:/vault/journal/2026', '24.md')
  })

  it('asks for a folder when none is open and fails cleanly', async () => {
    const { fileStore } = setupVault(null)
    vi.spyOn(fileStore, 'openFolder').mockResolvedValue(undefined)
    const store = useDailyStore()

    const ok = await store.openFor(DAY)

    expect(ok).toBe(false)
    expect(store.error).toBe('请先打开一个文件夹')
  })

  it('persists config changes', () => {
    const store = useDailyStore()
    expect(store.updateConfig({ directory: 'notes', filenamePattern: 'YYYYMMDD', template: '# {{date}}' })).toBe(true)

    expect(store.config).toMatchObject({
      directory: 'notes',
      filenamePattern: 'YYYYMMDD',
      template: '# {{date}}'
    })
    expect(localStorage.getItem('inkase-daily-note')).toContain('notes')
  })

  it('rejects an unsafe directory without overwriting the current config', () => {
    const store = useDailyStore()
    const before = { ...store.config }

    expect(store.updateConfig({ directory: '../outside' })).toBe(false)
    expect(store.config).toEqual(before)
    expect(store.error).toContain('相对路径')
  })
})
