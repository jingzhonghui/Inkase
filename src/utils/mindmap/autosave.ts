/**
 * 思维导图的「渲染层 → store」同步器
 *
 * 单独抽出来有两个原因：
 * 1. 这是 P1 里最容易造成**数据丢失**的一环（连续编辑合并、切标签前必须冲刷），
 *    独立成纯函数后可以用假定时器精确验证，不必碰组件内部状态；
 * 2. 组件只负责「什么时候通知」，这里负责「什么时候真正写」。
 */

import type { MindElixirData } from 'mind-elixir'
import { fromElixirData } from './adapter'
import { serializeMindMap } from './schema'

export interface MindMapAutosaveOptions {
  /** 读取渲染层当前数据；返回 null 表示尚不可读（未初始化/已销毁） */
  getData: () => MindElixirData | null
  /** 提交序列化后的文本 */
  commit: (text: string) => void
  /** 合并窗口（毫秒） */
  delay?: number
  /**
   * 自定义序列化。
   * 渲染层数据里不含画布级视图设置（例如彩虹分支开关），
   * 由组件在这里把它们合并回文档，缺省行为等价于 `serializeMindMap(fromElixirData(data))`。
   */
  serialize?: (data: MindElixirData) => string
}

export interface MindMapAutosave {
  /** 通知有变更，合并窗口结束后提交 */
  schedule: () => void
  /** 立即提交未提交的变更（切标签/卸载前必须调用） */
  flush: () => void
  /** 取消待提交的变更（不应丢弃已发生的编辑，仅在确知无需写入时使用） */
  cancel: () => void
  /** 记录一份已经与渲染层一致的文本，避免重复回写 */
  markSynced: (text: string) => void
  /** 是否有待提交的变更 */
  hasPending: () => boolean
}

const DEFAULT_DELAY = 250

export function createMindMapAutosave(options: MindMapAutosaveOptions): MindMapAutosave {
  const delay = options.delay ?? DEFAULT_DELAY
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 上一次与渲染层同步过的文本，用于跳过无意义的回写 */
  let lastSynced = ''

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function commitNow(): void {
    clearTimer()
    const data = options.getData()
    if (!data) return
    const text = options.serialize
      ? options.serialize(data)
      : serializeMindMap(fromElixirData(data))
    if (text === lastSynced) return
    lastSynced = text
    options.commit(text)
  }

  function schedule(): void {
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      commitNow()
    }, delay)
  }

  function flush(): void {
    if (timer === null) return
    commitNow()
  }

  return {
    schedule,
    flush,
    cancel: clearTimer,
    markSynced: (text: string) => {
      lastSynced = text
    },
    hasPending: () => timer !== null
  }
}
