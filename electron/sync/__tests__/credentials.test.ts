import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createCredentialStore, credentialsPath, type CryptoLike } from '../credentials'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkase-credentials-'))

const fakeCrypto = (available = true): CryptoLike => ({
  isEncryptionAvailable: () => available,
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf-8')),
  decryptString: (b) => b.toString('utf-8').replace(/^enc:/, '')
})

describe('credentials', () => {
  beforeEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); fs.mkdirSync(tmpDir, { recursive: true }) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('round-trips a password without writing it in plain text', () => {
    const crypto = fakeCrypto()
    const store = createCredentialStore(tmpDir, crypto)
    store.save('s3cret')
    expect(store.load()).toBe('s3cret')
    // 安全不变量：明文必须交给加密函数，而非直接落盘
    expect(crypto.encryptString).toHaveBeenCalledTimes(1)
    expect(crypto.encryptString).toHaveBeenCalledWith('s3cret')
    const raw = fs.readFileSync(path.join(tmpDir, '.inkase', 'credentials.json'), 'utf-8')
    expect(raw).not.toContain('s3cret')
  })

  it('returns null when nothing was saved', () => {
    expect(createCredentialStore(tmpDir, fakeCrypto()).load()).toBeNull()
  })

  it('refuses to save when encryption is unavailable', () => {
    const store = createCredentialStore(tmpDir, fakeCrypto(false))
    expect(() => store.save('x')).toThrow(/安全存储/)
    expect(store.load()).toBeNull()
    // 绝不降级写入：失败后不应留下任何凭据文件
    expect(fs.existsSync(credentialsPath(tmpDir))).toBe(false)
  })

  it('clear removes the credential file', () => {
    const store = createCredentialStore(tmpDir, fakeCrypto())
    store.save('x'); store.clear()
    expect(fs.existsSync(path.join(tmpDir, '.inkase', 'credentials.json'))).toBe(false)
  })
})
