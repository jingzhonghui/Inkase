import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MindElixirData } from 'mind-elixir'
import { createMindMapAutosave } from '../mindmap/autosave'
import { serializeMindMap } from '../mindmap/schema'
import { MINDMAP_FILE_SCHEMA } from '../../types/mindmap'

/**
 * 同步器的关键性质：
 * - 连续编辑只在窗口结束后写一次（避免每个按键都 JSON.stringify）；
 * - 卸载/切标签时 flush 必须把最后一次编辑写出去（否则丢数据）；
 * - 内容没变时不产生无意义的写入（否则标签一直显示未保存）。
 */

function makeData(text: string): MindElixirData {
  return {
    nodeData: { id: 'n_root', topic: text, children: [] }
  }
}

describe('createMindMapAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('合并窗口内的多次变更只提交一次', () => {
    let text = 'A'
    const commit = vi.fn()
    const autosave = createMindMapAutosave({
      getData: () => makeData(text),
      commit,
      delay: 250
    })

    autosave.schedule()
    text = 'B'
    autosave.schedule()
    text = 'C'
    autosave.schedule()

    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0]).toContain('"text": "C"')
  })

  it('flush 把未提交的改动立即写出（切标签场景）', () => {
    let text = 'A'
    const commit = vi.fn()
    const autosave = createMindMapAutosave({
      getData: () => makeData(text),
      commit,
      delay: 250
    })

    autosave.schedule()
    text = '最后一次编辑'
    autosave.flush()

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0]).toContain('最后一次编辑')
    expect(autosave.hasPending()).toBe(false)
  })

  it('没有待提交变更时 flush 不写入', () => {
    const commit = vi.fn()
    const autosave = createMindMapAutosave({
      getData: () => makeData('A'),
      commit
    })

    autosave.flush()
    expect(commit).not.toHaveBeenCalled()
  })

  it('内容与已同步文本一致时不重复写入', () => {
    const commit = vi.fn()
    const autosave = createMindMapAutosave({
      getData: () => makeData('A'),
      commit,
      delay: 100
    })

    autosave.schedule()
    vi.advanceTimersByTime(100)
    expect(commit).toHaveBeenCalledTimes(1)

    // 同样的内容再触发一次：不应产生第二次写盘/置脏
    autosave.schedule()
    vi.advanceTimersByTime(100)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('markSynced 记录的文本同样不会重复写入', () => {
    const commit = vi.fn()
    const autosave = createMindMapAutosave({
      getData: () => makeData('已保存'),
      commit,
      delay: 100
    })

    // 模拟初次挂载：store 里的文本与渲染层一致，无需回写
    autosave.markSynced(
      serializeMindMap({
        schema: MINDMAP_FILE_SCHEMA,
        version: 1,
        root: { id: 'n_root', text: '已保存', children: [] }
      })
    )
    autosave.schedule()
    vi.advanceTimersByTime(100)

    expect(commit).not.toHaveBeenCalled()
  })

  it('cancel 丢弃待提交变更', () => {
    const commit = vi.fn()
    const autosave = createMindMapAutosave({
      getData: () => makeData('A'),
      commit,
      delay: 100
    })

    autosave.schedule()
    autosave.cancel()
    vi.advanceTimersByTime(500)

    expect(commit).not.toHaveBeenCalled()
    expect(autosave.hasPending()).toBe(false)
  })

  it('渲染层不可读时（getData 返回 null）安全跳过', () => {
    const commit = vi.fn()
    const autosave = createMindMapAutosave({
      getData: () => null,
      commit,
      delay: 100
    })

    autosave.schedule()
    vi.advanceTimersByTime(100)

    expect(commit).not.toHaveBeenCalled()
  })

  it('提交的文本可被重新解析为合法文档', () => {
    const commit = vi.fn()
    const autosave = createMindMapAutosave({
      getData: () => makeData('往返'),
      commit,
      delay: 10
    })

    autosave.schedule()
    vi.advanceTimersByTime(10)

    const text = String(commit.mock.calls[0][0])
    const parsed = JSON.parse(text) as { schema: string; root: { text: string } }
    expect(parsed.schema).toBe(MINDMAP_FILE_SCHEMA)
    expect(parsed.root.text).toBe('往返')
  })
})
