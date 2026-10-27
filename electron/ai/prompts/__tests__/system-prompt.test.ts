import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT } from '../inkase'

describe('SYSTEM_PROMPT source rules', () => {
  it('numbers every principle continuously and covers the topic groups', () => {
    // 编号连续是给模型看的顺序提示，断号会让它以为有遗漏的规则
    const numbers = [...SYSTEM_PROMPT.matchAll(/^(\d+)\./gm)].map((match) => Number(match[1]))
    expect(numbers.length).toBeGreaterThan(19)
    expect(numbers).toEqual(numbers.map((_, index) => index + 1))
    expect(SYSTEM_PROMPT).toContain('create_mindmap')
    expect(SYSTEM_PROMPT).toContain('update_mindmap')
    expect(SYSTEM_PROMPT).toContain('list_workspace_root')
    expect(SYSTEM_PROMPT).toContain('read_workspace_directory')
    expect(SYSTEM_PROMPT).toContain('search_workspace')
    expect(SYSTEM_PROMPT).toContain('read_workspace_file')
    expect(SYSTEM_PROMPT).toContain('read_web_url')
    expect(SYSTEM_PROMPT).toContain('read_local_file')
    expect(SYSTEM_PROMPT).toContain('get_current_datetime')
    expect(SYSTEM_PROMPT).toContain('优先调用 search_workspace')
    expect(SYSTEM_PROMPT).toContain('scope')
    expect(SYSTEM_PROMPT).toContain('literal')
    expect(SYSTEM_PROMPT).toContain('完全一致')
    expect(SYSTEM_PROMPT).toContain('不可信数据')
    expect(SYSTEM_PROMPT).toContain('返回 completed 后')
    expect(SYSTEM_PROMPT).toContain('<!-- analysis -->')
    expect(SYSTEM_PROMPT).toContain('<!-- end-analysis -->')
    expect(SYSTEM_PROMPT).toContain('自由调用工具进行探索')
    expect(SYSTEM_PROMPT).not.toMatch(/materialId|材料 ID|列出材料|按块|chunk/i)
    expect(SYSTEM_PROMPT).not.toContain('read_current_document')
    expect(SYSTEM_PROMPT).not.toContain('search_workspace_files')
  })

  it('instructs searching the workspace in real time rather than relying on a cached summary', () => {
    expect(SYSTEM_PROMPT).toContain('实时搜索')
    expect(SYSTEM_PROMPT).toContain('搜索文件名和相对路径')
    expect(SYSTEM_PROMPT).toContain('搜索文件正文')
    expect(SYSTEM_PROMPT).not.toContain('工作区概要')
  })

  it('instructs asking the user before answering from general knowledge when nothing is found', () => {
    expect(SYSTEM_PROMPT).toMatch(/未找到.*相关.*文档|未找到.*相关的内容/)
    expect(SYSTEM_PROMPT).toMatch(/是否基于 LLM 现有知识回答/)
    expect(SYSTEM_PROMPT).toMatch(/等待用户确认|用户确认|确认继续/)
  })

  it('instructs not to search again after the user chooses general knowledge', () => {
    expect(SYSTEM_PROMPT).toMatch(/不再.*检索|不再重复.*搜索|直接回答/)
  })
})
