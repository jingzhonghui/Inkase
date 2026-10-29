// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore, WORKSPACE_SEGMENTS } from '../workspace'
import { useGraphStore } from '../graph'

/**
 * 工作台的段定义是导航的单一来源：概览段移除后只剩图谱与 AI，
 * 而且**图谱是默认段**——这三条都是用户能直接感觉到的行为，锁住它们。
 */
describe('工作台分段', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('只有图谱与 AI 两段，且图谱排在前面', () => {
    expect(WORKSPACE_SEGMENTS.map((segment) => segment.id)).toEqual(['graph', 'ai'])
  })

  it('未打开过工作台时，分段已经默认落在图谱', () => {
    const workspace = useWorkspaceStore()
    expect(workspace.segment).toBe('graph')
    expect(workspace.active).toBe(false)
  })

  it('open() 不传参时落在图谱段并把它标记为当前段', () => {
    const workspace = useWorkspaceStore()
    workspace.open('ai')
    expect(workspace.segment).toBe('ai')

    workspace.open()

    expect(workspace.active).toBe(true)
    expect(workspace.segment).toBe('graph')
    expect(workspace.isGraph).toBe(true)
  })

  it('从文档视图点回工作台时会补挂图谱面板，而不是留一块空白', () => {
    const workspace = useWorkspaceStore()
    const graphStore = useGraphStore()
    expect(graphStore.panelOpen).toBe(false)

    workspace.activate()

    expect(workspace.active).toBe(true)
    expect(graphStore.panelOpen).toBe(true)
  })
})
