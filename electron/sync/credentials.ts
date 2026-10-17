import * as fs from 'fs'
import * as path from 'path'

/** 凭据文件所在目录（与 sync.json 同处 .inkase，本机私有） */
export const SYNC_CREDENTIALS_DIR = '.inkase'
export const SYNC_CREDENTIALS_FILE = 'credentials.json'

/**
 * Electron safeStorage 的最小抽象。真实实现为主进程的 `safeStorage`；
 * 通过注入解耦，使本模块可在 vitest（纯 Node）下测试。
 */
export interface CryptoLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** WebDAV 凭据存储 */
export interface CredentialStore {
  /** 加密保存密码；加密不可用时抛错，绝不降级为明文 */
  save(password: string): void
  /** 读取密码；无凭据、加密不可用或数据损坏时返回 null */
  load(): string | null
  /** 删除凭据文件（不存在不报错） */
  clear(): void
}

interface StoredCredentials {
  version: 1
  password: string
}

/** 凭据文件绝对路径 */
export function credentialsPath(workspacePath: string): string {
  return path.join(workspacePath, SYNC_CREDENTIALS_DIR, SYNC_CREDENTIALS_FILE)
}

/**
 * 创建基于注入 crypto 的凭据存储。
 * 密码经 `crypto.encryptString` 加密后以 base64 存入
 * `<工作区>/.inkase/credentials.json`，明文永不落盘。
 */
export function createCredentialStore(workspacePath: string, crypto: CryptoLike): CredentialStore {
  const filePath = credentialsPath(workspacePath)

  return {
    save(password: string): void {
      if (!crypto.isEncryptionAvailable()) {
        throw new Error('当前系统不支持安全存储，无法保存密码')
      }
      const stored: StoredCredentials = {
        version: 1,
        password: crypto.encryptString(password).toString('base64')
      }
      const dirPath = path.join(workspacePath, SYNC_CREDENTIALS_DIR)
      fs.mkdirSync(dirPath, { recursive: true })
      const tmpPath = `${filePath}.tmp`
      fs.writeFileSync(tmpPath, JSON.stringify(stored, null, 2), 'utf-8')
      fs.renameSync(tmpPath, filePath)
    },

    load(): string | null {
      if (!crypto.isEncryptionAvailable()) return null
      if (!fs.existsSync(filePath)) return null
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<StoredCredentials>
        if (raw.version !== 1 || typeof raw.password !== 'string') return null
        return crypto.decryptString(Buffer.from(raw.password, 'base64'))
      } catch {
        return null
      }
    },

    clear(): void {
      fs.rmSync(filePath, { force: true })
    }
  }
}
