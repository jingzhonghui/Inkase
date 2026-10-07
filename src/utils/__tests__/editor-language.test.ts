import { describe, expect, it } from 'vitest'
import { findCodeLanguage, languageDisplayName } from '../editor-language'

describe('findCodeLanguage', () => {
  it('matches common code/config extensions', () => {
    expect(findCodeLanguage('deploy.sh')?.name).toBe('Shell')
    expect(findCodeLanguage('app.json')?.name).toBe('JSON')
    expect(findCodeLanguage('ci.yml')?.name).toBe('YAML')
    expect(findCodeLanguage('main.py')?.name).toBe('Python')
  })

  it('maps fallback extensions like .conf to the properties/ini language', () => {
    const conf = findCodeLanguage('app.conf')
    expect(conf).not.toBeNull()
    expect(languageDisplayName(conf!)).toBe('INI')
    expect(findCodeLanguage('settings.cfg')).not.toBeNull()
    expect(findCodeLanguage('app.ini')?.name).toBe('Properties files')
  })

  it('is case-insensitive on extensions', () => {
    expect(findCodeLanguage('BUILD.SH')?.name).toBe('Shell')
    expect(findCodeLanguage('Data.JSON')?.name).toBe('JSON')
  })

  it('returns null for plain text / extensionless / dotfiles', () => {
    expect(findCodeLanguage('notes.txt')).toBeNull()
    expect(findCodeLanguage('Makefile')).toBeNull()
    expect(findCodeLanguage('LICENSE')).toBeNull()
    expect(findCodeLanguage('.gitignore')).toBeNull()
  })
})

describe('language load (runtime resolution)', () => {
  it('loads Shell support via dynamic import', async () => {
    const desc = findCodeLanguage('deploy.sh')!
    const support = await desc.load()
    expect(support).toBeTruthy()
  })

  it('loads properties support via dynamic import', async () => {
    const desc = findCodeLanguage('app.conf')!
    const support = await desc.load()
    expect(support).toBeTruthy()
  })
})
