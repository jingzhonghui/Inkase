import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'

import { resolveExistingUserGuidePath, resolveUserGuidePath, type UserGuideDependencies } from '../user-guide'

function dependencies(overrides: Partial<UserGuideDependencies> = {}): UserGuideDependencies {
  return {
    isPackaged: false,
    appPath: path.join('workspace', 'inkase'),
    resourcesPath: path.join('installed', 'resources'),
    existsSync: vi.fn(() => true),
    ...overrides
  }
}

describe('user guide', () => {
  it('resolves the development PDF from the application resources directory', () => {
    expect(resolveUserGuidePath(dependencies())).toBe(
      path.join('workspace', 'inkase', 'resources', 'Inkase 使用教程.pdf')
    )
  })

  it('resolves the packaged PDF from the extra resources directory', () => {
    expect(resolveUserGuidePath(dependencies({ isPackaged: true }))).toBe(
      path.join('installed', 'resources', 'user-guide', 'Inkase 使用教程.pdf')
    )
  })

  it('returns the path when the guide exists', () => {
    expect(resolveExistingUserGuidePath(dependencies())).toBe(
      path.join('workspace', 'inkase', 'resources', 'Inkase 使用教程.pdf')
    )
  })

  it('returns null when the guide is missing', () => {
    expect(resolveExistingUserGuidePath(dependencies({ existsSync: vi.fn(() => false) }))).toBeNull()
  })
})
