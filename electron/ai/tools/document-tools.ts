import { z } from 'zod'
import type { AiDocumentSnapshot, LocalFileReadResult } from '../../../shared/ai/types'
import { markdownToMindMapJson } from '../../../shared/mindmap/markdown'
import type { WorkspaceSearchService } from '../../workspace/workspace-search-service'
import { defineTool, type ToolDefinition } from '../tool-registry'
import type { WorkspaceSearchError } from '../../workspace/workspace-search-service'

function requireWorkspaceRoot(context: { snapshot: { workspaceRoot: string | null } }): string {
  if (!context.snapshot.workspaceRoot) {
    throw new Error('当前没有打开工作区，无法访问工作区文件')
  }
  return context.snapshot.workspaceRoot
}

function requireSignal(context: { abortSignal?: AbortSignal }): AbortSignal {
  const signal = context.abortSignal
  if (!signal) throw new Error('工作区操作缺少中止信号')
  if (signal.aborted) throw new Error('工作区操作已中止')
  return signal
}

function wrapSearchError(error: unknown): never {
  if (error instanceof Error && error.name === 'WorkspaceSearchError') {
    const code = (error as WorkspaceSearchError).code
    if (code === 'RG_UNAVAILABLE') throw new Error('搜索组件不可用，请检查应用安装完整性')
    throw error
  }
  throw error
}

export interface DocumentToolRegistry {
  searchWorkspace: ToolDefinition<unknown, unknown>
  listWorkspaceRoot: ToolDefinition<Record<string, never>, unknown>
  readWorkspaceDirectory: ToolDefinition<{ path: string }, unknown>
  readWorkspaceFile: ToolDefinition<{ path: string }, LocalFileReadResult>
  readSelectedText: ToolDefinition<Record<string, never>, unknown>
  replaceCurrentDocument: ToolDefinition<unknown, unknown>
  insertIntoCurrentDocument: ToolDefinition<unknown, unknown>
  createDocument: ToolDefinition<unknown, unknown>
  createMindmap: ToolDefinition<unknown, unknown>
  updateMindmap: ToolDefinition<unknown, unknown>
}

export function createDocumentTools(searchService: WorkspaceSearchService): DocumentToolRegistry {
  const searchWorkspace = defineTool({
    name: 'search_workspace',
    description:
      '在当前工作区中实时搜索。文件名模式匹配文件名和相对路径；内容模式匹配文件正文（普通文本与 MDX）。遵循 .gitignore 并固定排除 .git、node_modules、.inkase。搜索结果返回相对路径，可配合 read_workspace_file 读取正文。',
    inputSchema: z
      .object({
        query: z.string().trim().min(1).max(500),
        mode: z.enum(['filename', 'content']),
        match: z.enum(['literal', 'regex']).optional(),
        scope: z.string().trim().optional(),
        extensions: z
          .array(z.string().regex(/^[a-zA-Z0-9]+$/))
          .max(20)
          .optional(),
        caseSensitive: z.boolean().optional(),
        contextLines: z.number().int().min(0).max(3).optional(),
        maxResults: z.number().int().min(1).max(100).optional()
      })
      .strict(),
    policy: {
      effect: 'read',
      approval: 'never',
      riskLevel: 'low',
      supportsRememberDecision: false
    },
    execution: 'main',
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      const signal = requireSignal(context)
      try {
        return await searchService.search(
          input as {
            query: string
            mode: 'filename' | 'content'
            match?: 'literal' | 'regex'
            scope?: string
            extensions?: string[]
            caseSensitive?: boolean
            contextLines?: number
            maxResults?: number
          },
          root,
          signal
        )
      } catch (error) {
        wrapSearchError(error)
      }
    }
  })

  const listWorkspaceRoot = defineTool({
    name: 'list_workspace_root',
    description:
      '实时列出当前工作区根目录下的直接文件和文件夹。用于了解工作区顶层结构，然后可调用 read_workspace_directory 深入浏览目录、调用 read_workspace_file 读取文件。',
    inputSchema: z.object({}),
    policy: {
      effect: 'read',
      approval: 'never',
      riskLevel: 'low',
      supportsRememberDecision: false
    },
    execution: 'main',
    execute: async (_input, context) => {
      const root = requireWorkspaceRoot(context)
      const signal = requireSignal(context)
      try {
        return await searchService.listRoot(root, signal)
      } catch (error) {
        wrapSearchError(error)
      }
    }
  })

  const readWorkspaceFile = defineTool<{ path: string }, LocalFileReadResult>({
    name: 'read_workspace_file',
    description:
      '读取工作区中指定相对路径的文件内容（支持 Markdown、MDX、TXT 及 UTF-8 文本文件），路径需来自 search_workspace、list_workspace_root 或 read_workspace_directory 的结果。',
    inputSchema: z.object({ path: z.string().trim().min(1) }),
    policy: {
      effect: 'read',
      approval: 'never',
      riskLevel: 'low',
      supportsRememberDecision: false
    },
    execution: 'main',
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      const signal = requireSignal(context)
      try {
        const content = await searchService.readFile(root, input.path, signal)
        const type: LocalFileReadResult['fileType'] = input.path.toLowerCase().endsWith('.mdx')
          ? 'mdx'
          : input.path.toLowerCase().endsWith('.md')
            ? 'markdown'
            : 'text'
        return {
          requestedPath: input.path,
          normalizedPath: input.path,
          fileType: type,
          content,
          chunks: [],
          truncated: false
        } as LocalFileReadResult
      } catch (error) {
        wrapSearchError(error)
      }
    }
  })

  const readWorkspaceDirectory = defineTool<{ path: string }, unknown>({
    name: 'read_workspace_directory',
    description:
      '实时列出工作区中指定目录下的直接子文件和子文件夹。path 参数为工作区内的相对目录路径（可用 "." 表示根目录）。用于逐层展开目录结构。',
    inputSchema: z.object({ path: z.string().trim().min(1) }),
    policy: {
      effect: 'read',
      approval: 'never',
      riskLevel: 'low',
      supportsRememberDecision: false
    },
    execution: 'main',
    execute: async (input, context) => {
      const root = requireWorkspaceRoot(context)
      const signal = requireSignal(context)
      try {
        return await searchService.readDirectory(root, input.path, signal)
      } catch (error) {
        wrapSearchError(error)
      }
    }
  })

  const readSelectedText = defineTool({
    name: 'read_selected_text',
    description: '读取发送消息时的当前选区（选中文本和偏移）。',
    inputSchema: z.object({}),
    policy: {
      effect: 'read',
      approval: 'never',
      riskLevel: 'low',
      supportsRememberDecision: false
    },
    execution: 'main',
    execute: async (_input, context) => {
      const doc = context.snapshot.activeDocument
      const selection = context.snapshot.selection
      if (!doc || !selection) {
        return { available: false as const }
      }
      return {
        available: true as const,
        documentId: doc.id,
        text: selection.text,
        from: selection.from,
        to: selection.to
      }
    }
  })

  const replaceCurrentDocument = defineTool({
    name: 'replace_current_document',
    description: '替换当前文档的完整内容。执行前需要用户批准。',
    inputSchema: z.object({ content: z.string(), reason: z.string() }),
    policy: {
      effect: 'write',
      approval: 'always',
      riskLevel: 'high',
      supportsRememberDecision: false
    },
    execution: 'renderer',
    createRendererOperation: async (input, context) => {
      const { content, reason } = input as { content: string; reason: string }
      return {
        type: 'replace-document' as const,
        target: describeTarget(context.snapshot.activeDocument),
        content,
        reason
      }
    },
    createApprovalPreview: async (input, context) => {
      const { content } = input as { content: string }
      const doc = describeTarget(context.snapshot.activeDocument)
      return {
        type: 'markdown-diff' as const,
        title: doc.title,
        before: doc.content,
        after: content
      }
    }
  })

  const insertIntoCurrentDocument = defineTool({
    name: 'insert_into_current_document',
    description: '在指定位置（选区/光标/开头/结尾）插入内容。执行前需要用户批准。',
    inputSchema: z.object({
      content: z.string(),
      position: z.enum(['selection', 'cursor', 'start', 'end']),
      reason: z.string()
    }),
    policy: {
      effect: 'write',
      approval: 'always',
      riskLevel: 'high',
      supportsRememberDecision: false
    },
    execution: 'renderer',
    createRendererOperation: async (input, context) => {
      const { content, position, reason } = input as {
        content: string
        position: 'selection' | 'cursor' | 'start' | 'end'
        reason: string
      }
      return {
        type: 'insert-document' as const,
        target: describeTarget(context.snapshot.activeDocument),
        content,
        position,
        selection: context.snapshot.selection,
        cursor: context.snapshot.cursor,
        reason
      }
    },
    createApprovalPreview: async (input, context) => {
      const { content, position } = input as {
        content: string
        position: 'selection' | 'cursor' | 'start' | 'end'
      }
      const doc = describeTarget(context.snapshot.activeDocument)
      const after = applyInsert(
        doc.content,
        content,
        position,
        context.snapshot.selection,
        context.snapshot.cursor
      )
      return {
        type: 'markdown-diff' as const,
        title: doc.title,
        before: doc.content,
        after
      }
    }
  })

  const createDocument = defineTool({
    name: 'create_document',
    description: '创建一篇新的 Markdown/MDX 文档。执行前需要用户批准。',
    inputSchema: z.object({
      title: z.string(),
      content: z.string(),
      format: z.enum(['markdown', 'mdx']),
      reason: z.string()
    }),
    policy: {
      effect: 'write',
      approval: 'always',
      riskLevel: 'medium',
      supportsRememberDecision: false
    },
    execution: 'renderer',
    createRendererOperation: async (input) => {
      const { title, content, format, reason } = input as {
        title: string
        content: string
        format: 'markdown' | 'mdx'
        reason: string
      }
      return {
        type: 'create-document' as const,
        title,
        content,
        format,
        reason
      }
    },
    createApprovalPreview: async (input) => {
      const { title, content } = input as { title: string; content: string }
      return { type: 'document' as const, title, content }
    }
  })

  /**
   * 大纲 → 导图 JSON。
   *
   * 模型只写 Markdown 大纲，结构与 id 交给 `markdownToMindMapJson` 生成：
   * 让模型逐字产出 JSON 极易出现漏括号、错 id、悬空引用，
   * 而这些问题一旦写进文件，用户看到的就是一张打不开的图。
   */
  const outlineToMindmap = (outline: string, title: string): string => {
    const normalized = stripDuplicateTitle(outline, title)
    if (normalized.trim() === '') {
      throw new Error('大纲为空，无法生成导图')
    }
    const json = markdownToMindMapJson(normalized, { title })
    // 兜底自检：转换结果必须是能解析的 JSON 对象，否则宁可报错也不落盘
    try {
      const parsed = JSON.parse(json) as { root?: unknown }
      if (!parsed || typeof parsed !== 'object' || !parsed.root) {
        throw new Error('empty')
      }
    } catch {
      throw new Error('大纲没有可用的层级结构，无法生成导图')
    }
    return json
  }

  const createMindmap = defineTool({
    name: 'create_mindmap',
    description:
      '根据 Markdown 大纲创建一张新的思维导图。用标题（#、##）与列表（-）表达层级。执行前需要用户批准。',
    inputSchema: z.object({
      title: z.string(),
      outline: z.string(),
      reason: z.string()
    }),
    policy: {
      effect: 'write',
      approval: 'always',
      riskLevel: 'medium',
      supportsRememberDecision: false
    },
    execution: 'renderer',
    createRendererOperation: async (input) => {
      const { title, outline, reason } = input as {
        title: string
        outline: string
        reason: string
      }
      return {
        type: 'create-document' as const,
        title,
        content: outlineToMindmap(outline, title),
        format: 'mindmap' as const,
        reason
      }
    },
    // 预览给人看的是大纲，不是 JSON：JSON 又长又难读，审批时反而看不出结构对不对
    createApprovalPreview: async (input) => {
      const { title, outline } = input as { title: string; outline: string }
      return { type: 'document' as const, title, content: outline }
    }
  })

  const updateMindmap = defineTool({
    name: 'update_mindmap',
    description:
      '用新的 Markdown 大纲整体重写当前思维导图。会覆盖原有内容（包括标签、图片等富内容），仅在用户明确要求重写整张图时使用。执行前需要用户批准。',
    inputSchema: z.object({
      outline: z.string(),
      reason: z.string()
    }),
    policy: {
      effect: 'write',
      approval: 'always',
      riskLevel: 'high',
      supportsRememberDecision: false
    },
    execution: 'renderer',
    createRendererOperation: async (input, context) => {
      const { outline, reason } = input as { outline: string; reason: string }
      const doc = describeTarget(context.snapshot.activeDocument)
      if (doc.format !== 'mindmap') {
        throw new Error('当前文档不是思维导图，请改用 replace_current_document')
      }
      const title = doc.title.replace(/\.[^.]+$/, '') || '思维导图'
      // 复用替换操作：自带 revision/内容哈希冲突检测，避免覆盖用户在此期间的手动修改
      return {
        type: 'replace-document' as const,
        target: doc,
        content: outlineToMindmap(outline, title),
        reason
      }
    },
    createApprovalPreview: async (input, context) => {
      const { outline } = input as { outline: string }
      const doc = describeTarget(context.snapshot.activeDocument)
      return {
        type: 'document' as const,
        title: doc.title,
        content: outline
      }
    }
  })

  return {
    searchWorkspace,
    listWorkspaceRoot,
    readWorkspaceDirectory,
    readWorkspaceFile,
    readSelectedText,
    replaceCurrentDocument,
    insertIntoCurrentDocument,
    createDocument,
    createMindmap,
    updateMindmap
  }
}

/**
 * 去掉与标题重复的一级标题。
 *
 * 模型几乎总是把主题写成大纲的第一行 `# 产品规划`，而导图的中心主题也就是这个标题；
 * 照搬会让中心主题下面多挂一个同名节点，看起来像「根 → 同一个词 → 内容」。
 * 只在「恰好一个 h1 且与标题同名」时剥掉，其它结构一律保持原样。
 */
function stripDuplicateTitle(outline: string, title: string): string {
  const lines = outline.split(/\r?\n/)
  const h1Indexes = lines
    .map((line, index) => (/^#\s+\S/.test(line) ? index : -1))
    .filter((index) => index >= 0)
  if (h1Indexes.length !== 1) return outline
  const heading = lines[h1Indexes[0]].replace(/^#\s+/, '').trim()
  const expected = title.trim()
  if (heading === '' || heading !== expected) return outline
  return lines.filter((_, index) => index !== h1Indexes[0]).join('\n')
}

function applyInsert(
  base: string,
  text: string,
  position: 'selection' | 'cursor' | 'start' | 'end',
  selection: { from: number; to: number } | null,
  cursor: number | null
): string {
  switch (position) {
    case 'start':
      return text + base
    case 'end':
      return base + text
    case 'selection':
      if (!selection) return base + text
      return base.slice(0, selection.from) + text + base.slice(selection.to)
    case 'cursor': {
      const at = cursor ?? base.length
      return base.slice(0, at) + text + base.slice(at)
    }
  }
}

function describeTarget(doc: AiDocumentSnapshot | null): AiDocumentSnapshot {
  if (!doc) {
    throw new Error('当前没有活动文档')
  }
  return doc
}
