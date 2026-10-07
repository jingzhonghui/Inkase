import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  loadWindowState,
  resolveWindowState,
  saveWindowState,
  type DisplayWorkArea,
  type WindowState
} from '../window-state'

const tempDirs: string[] = []

function makeTempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-window-state-'))
  tempDirs.push(dir)
  return path.join(dir, 'window-state.json')
}

const display: DisplayWorkArea = { x: 0, y: 0, width: 1920, height: 1080 }

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('window state persistence', () => {
  it('saves and loads bounds plus maximized state', () => {
    const statePath = makeTempStatePath()
    const state: WindowState = {
      bounds: { x: 120, y: 80, width: 1280, height: 800 },
      isMaximized: true
    }

    saveWindowState(statePath, state)

    expect(loadWindowState(statePath)).toEqual(state)
  })

  it('returns null for invalid or missing state', () => {
    const statePath = makeTempStatePath()

    expect(loadWindowState(statePath)).toBeNull()
    fs.writeFileSync(statePath, '{bad json', 'utf8')
    expect(loadWindowState(statePath)).toBeNull()
  })

  it('keeps a restored window visible and clamps oversized bounds', () => {
    const saved: WindowState = {
      bounds: { x: -2400, y: -900, width: 4000, height: 3000 },
      isMaximized: false
    }

    expect(resolveWindowState(saved, [display])).toEqual({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      isMaximized: false
    })
  })

  it('falls back to defaults when the saved window is off-screen', () => {
    const saved: WindowState = {
      bounds: { x: 4000, y: 3000, width: 1200, height: 800 },
      isMaximized: true
    }
    const defaults = { x: 100, y: 100, width: 1400, height: 900 }

    expect(resolveWindowState(saved, [display], defaults)).toEqual({
      bounds: defaults,
      isMaximized: true
    })
  })
})
