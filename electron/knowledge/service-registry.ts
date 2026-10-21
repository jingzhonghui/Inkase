/**
 * 知识索引服务注册表
 *
 * 按工作区根目录缓存索引服务实例，供 IPC 处理器与文件重命名/移动流程共用
 * （两处必须看到同一份索引，否则重写引用会用到过期的链接表）。
 *
 * 服务实例与 Electron 无关，此处只负责生命周期与进度转发。
 */

import type { IndexProgress } from '../../shared/knowledge/types'
import { KnowledgeIndexService } from './index-service'
import { extractVaultText } from './vault-text'

/** 进度订阅者 */
export type KnowledgeProgressListener = (progress: IndexProgress) => void

const services = new Map<string, KnowledgeIndexService>()
const listeners = new Map<string, Set<KnowledgeProgressListener>>()

/** 取得（必要时创建）某个工作区根的索引服务 */
export function getKnowledgeService(root: string): KnowledgeIndexService {
  const existing = services.get(root)
  if (existing) return existing

  const service = new KnowledgeIndexService(root, {
    extractText: extractVaultText,
    onProgress: (progress) => {
      for (const listener of listeners.get(root) ?? []) listener(progress)
    }
  })
  services.set(root, service)
  return service
}

/** 已存在的索引服务；不会创建 */
export function peekKnowledgeService(root: string): KnowledgeIndexService | null {
  return services.get(root) ?? null
}

/** 订阅某个工作区根的构建进度；返回取消订阅函数 */
export function subscribeKnowledgeProgress(root: string, listener: KnowledgeProgressListener): () => void {
  const set = listeners.get(root) ?? new Set<KnowledgeProgressListener>()
  set.add(listener)
  listeners.set(root, set)

  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(root)
  }
}

/** 释放全部索引服务（应用退出时调用） */
export function disposeKnowledgeServices(): void {
  services.clear()
  listeners.clear()
}
