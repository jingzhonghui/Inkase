import { describe, expect, it } from 'vitest'
import { toAbsolutePath, toVaultRelativePath } from '../knowledge-path'

describe('toVaultRelativePath', () => {
  it('converts a path inside the vault', () => {
    expect(toVaultRelativePath('E:\\vault', 'E:\\vault\\dir\\a.md')).toBe('dir/a.md')
    expect(toVaultRelativePath('/home/me/vault', '/home/me/vault/a.md')).toBe('a.md')
  })

  it('returns an empty string for the vault root itself', () => {
    expect(toVaultRelativePath('E:\\vault', 'E:\\vault')).toBe('')
    expect(toVaultRelativePath('E:\\vault', 'E:\\vault\\')).toBe('')
  })

  it('is case-insensitive for Windows drive paths', () => {
    expect(toVaultRelativePath('E:\\Vault', 'e:\\vault\\a.md')).toBe('a.md')
  })

  it('returns null for paths outside the vault', () => {
    expect(toVaultRelativePath('E:\\vault', 'E:\\other\\a.md')).toBeNull()
    expect(toVaultRelativePath('E:\\vault', 'E:\\vault-other\\a.md')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(toVaultRelativePath('', 'E:\\vault\\a.md')).toBeNull()
    expect(toVaultRelativePath('E:\\vault', '')).toBeNull()
  })
})

describe('toAbsolutePath', () => {
  it('joins with the root separator style', () => {
    expect(toAbsolutePath('E:\\vault', 'dir/a.md')).toBe('E:\\vault\\dir\\a.md')
    expect(toAbsolutePath('/home/me/vault', 'dir/a.md')).toBe('/home/me/vault/dir/a.md')
  })

  it('tolerates trailing separators and leading slashes', () => {
    expect(toAbsolutePath('E:\\vault\\', '/a.md')).toBe('E:\\vault\\a.md')
  })

  it('round-trips with toVaultRelativePath', () => {
    const abs = toAbsolutePath('E:\\vault', 'dir/sub/a.md')
    expect(toVaultRelativePath('E:\\vault', abs)).toBe('dir/sub/a.md')
  })
})
