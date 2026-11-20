import { z } from 'zod'
import { join as joinPath, posix as posixPath } from 'node:path'
import type {
  AiDocumentSnapshot,
  WorkspaceFileSlice,
  WorkspaceFileStat
} from '../../../shared/ai/types'
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

/** 相对路径 → 绝对路径，仅用于把操作目标交给渲染进程执行。 */
function resolveAbsolutePath(root: string, relativePath: string): string {
  return joinPath(root, ...relativePath.split('/'))
}

/** 两个绝对路径是否指向同一个文件（分隔符与大小写都可能不同）。 */
function isSamePath(left: string | null, right: string): boolean {
  if (!left) return false
  const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
  return normalize(left) === normalize(right)
}

/** 能把整个路径（含文件名）拼成绝对路径的统一出口。 */
function absoluteFromRelative(root: string, relative: string): string {
  return resolveAbsolutePath(root, relative)
}

/**
 * 解析「移动 / 改名」的目标。
 *
 * 三个参数组合出四种行为，全部在这里收敛，避免工具实现里再分叉：
 * - 只给 path：原地不动（由调用方判定为无效，这里仍返回原路径）
 * - targetDirectory：挪进该目录，保留文件名
 * - newName：只改名，留在原目录
 * - 两者都给：挪目录 + 改名
 */
function resolveMoveDestination(
  root: string,
  searchService: WorkspaceSearchService,
  source: string,
  targetDirectory: string | undefined,
  newName: string | undefined
): { fromRelative: string; fromAbsolute: string; toRelative: string; toAbsolute: string } {
  const entry = searchService.inspectEntry(root, source)
  if (!targetDirectory && !newName) {
    throw new Error('需要提供 targetDirectory 或 newName 之一')
  }

  const name = newName ?? entry.relative.split('/').pop()!
  if (/[\\/]/.test(name)) {
    throw new Error('newName 只能是文件名，不能包含路径分隔符')
  }

  let toRelative: string
  if (targetDirectory) {
    const target = searchService.inspectDirectory(root, targetDirectory)
    toRelative = target.relative === '.' ? name : posixPath.join(target.relative, name)
  } else {
    const parent = entry.relative.includes('/')
      ? entry.relative.slice(0, entry.relative.lastIndexOf('/'))
      : '.'
    toRelative = parent === '.' ? name : posixPath.join(parent, name)
  }

  if (toRelative === entry.relative) {
    throw new Error('目标路径与源路径相同，无需移动')
  }
  return {
    fromRelative: entry.relative,
    fromAbsolute: entry.absolute,
    toRelative,
    toAbsolute: absoluteFromRelative(root, toRelative)
  }
}

/**
 * 校验「可写文本」目标。
 *
 * 容器格式与图表在这里就挡掉：`.mdx` / `.inkmind` 直接写会丢资源，
 * `.drawio` 有画布实例在跑，写盘会让两边打架。
 */
function requireWritableTextPath(
  root: string,
  searchService: WorkspaceSearchService,
  target: string
): { relative: string; absolute: string; format: 'markdown' | 'text' } {
  const resolved = searchService.resolveNewPath(root, target)
  const lower = resolved.relative.toLowerCase()
  if (lower.endsWith('.mdx') || lower.endsWith('.inkmind')) {
    throw new Error('该格式是容器文档，请用文档编辑工具修改，不能直接写正文')
  }
  if (lower.endsWith('.drawio')) {
    throw new Error('图表请用图表工具修改，不能直接写正文')
  }
  const format = lower.endsWith('.md') || lower.endsWith('.markdown') ? 'markdown' : 'text'
  return { relative: resolved.relative, absolute: resolved.absolute, format }
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
  readWorkspaceFile: ToolDefinition<{ path: string; offset?: number; length?: number }, WorkspaceFileSlice>
  getWorkspaceFileSize: ToolDefinition<{ path: string }, WorkspaceFileStat>
  createWorkspaceDirectory: ToolDefinition<unknown, unknown>
  moveWorkspaceEntry: ToolDefinition<unknown, unknown>
  writeWorkspaceFile: ToolDefinition<unknown, unknown>
  deleteWorkspaceFile: ToolDefinition<unknown, unknown>
  readSelectedText: ToolDefinition<Record<string, never>, unknown>
  replaceCurrentDocument: ToolDefinition<unknown, unknown>
  insertIntoCurrentDocument: ToolDefinition<unknown, unknown>
  createDocument: ToolDefinition<unknown, unknown>
  createMindmap: ToolDefinition<unknown, unknown>
  updateMindmap: ToolDefinition<unknown, unknown>
}

export interface DocumentToolOptions {
  /** 单次 read_workspace_file 的正文字节上限；缺省走服务内置默认值 */
  maxReadBytes?: number
}

export function createDocumentTools(
  searchService: WorkspaceSearchService,
  options: DocumentToolOptions = {}
): DocumentToolRegistry {
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

  const readWorkspaceFile = defineTool<
    { path: string; offset?: number; length?: number },
    WorkspaceFileSlice
  >({
    name: 'read_workspace_file',
    description:
      '读取工作区中指定相对路径的文件正文（Markdown、MDX、思维导图、图表与 UTF-8 文本）。路径需来自 search_workspace、list_workspace_root 或 read_workspace_directory 的结果。支持分段读取：offset 为起始字节（默认 0），length 为读取字节数（默认 -1 表示读到末尾）。返回 totalSize / eof / nextOffset；被单次上限截断时 truncated 为 true，用 nextOffset 继续读。大文件建议先调用 get_workspace_file_size 判断要读几次。',
    inputSchema: z
      .object({
        path: z.string().trim().min(1),
        offset: z.number().int().min(0).optional(),
        length: z.number().int().min(-1).optional()
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
        return await searchService.readFileSlice(
          root,
          input.path,
          { offset: input.offset, length: input.length, maxBytes: options.maxReadBytes },
          signal
        )
      } catch (error) {
        wrapSearchError(error)
      }
    }
  })

  const getWorkspaceFileSize = defineTool<{ path: string }, WorkspaceFileStat>({
    name: 'get_workspace_file_size',
    description:
      '获取工作区内文件的字节大小与可读性，用于判断一次读完还是分多次读。返回 fileSize（磁盘字节）、totalSize（可读正文字节，容器格式为解包后的长度）、readable（二进制文件为 false）与 format。配合 read_workspace_file 的 offset/length 使用。',
    inputSchema: z.object({ path: z.string().trim().min(1) }).strict(),
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
        return await searchService.statFile(root, input.path, signal)
      } catch (error) {
        wrapSearchError(error)
      }
    }
  })

  /**
   * 新建目录。
   *
   * 一次只建一层（父目录必须已存在）：递归建目录等于允许模型一次命令
   * 造出整棵目录树，审批预览里还看不清楚，收益不值得这个风险。
   */
  const createWorkspaceDirectory = defineTool({
    name: 'create_workspace_directory',
    description:
      '在工作区内新建一个目录。path 为工作区内相对路径，父目录必须已存在（一次只建一层，需要多层就连续调用）。执行前需要用户批准。',
    inputSchema: z.object({ path: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict(),
    policy: {
      effect: 'write',
      approval: 'always',
      riskLevel: 'medium',
      supportsRememberDecision: false
    },
    execution: 'renderer',
    createRendererOperation: async (input, context) => {
      const { path: target, reason } = input as { path: string; reason: string }
      const root = requireWorkspaceRoot(context)
      const resolved = searchService.resolveNewPath(root, target)
      return {
        type: 'create-workspace-directory' as const,
        relativePath: resolved.relative,
        absolutePath: resolved.absolute,
        reason
      }
    },
    createApprovalPreview: async (input, context) => {
      const { path: target } = input as { path: string }
      const root = requireWorkspaceRoot(context)
      const resolved = searchService.resolveNewPath(root, target)
      return {
        type: 'file-operation' as const,
        operation: 'create-directory' as const,
        title: resolved.relative,
        to: resolved.relative
      }
    }
  })

  /**
   * 移动 / 改名。
   *
   * 目标是「目录 + 文件名」而不是单一字符串：模型常常只知道要挪到哪个分类目录，
   * 由工具补上文件名，比让它拼完整路径稳。
   */
  const moveWorkspaceEntry = defineTool({
    name: 'move_workspace_entry',
    description:
      '移动或重命名工作区内的文件/目录。path 为源相对路径；targetDirectory 为目标目录（工作区内相对路径，必须已存在，缺省表示原地改名）；newName 为新文件名（可选）。执行前需要用户批准。',
    inputSchema: z
      .object({
        path: z.string().trim().min(1),
        targetDirectory: z.string().trim().min(1).optional(),
        newName: z.string().trim().min(1).optional(),
        reason: z.string().trim().min(1)
      })
      .strict(),
    policy: {
      effect: 'write',
      approval: 'always',
      riskLevel: 'high',
      supportsRememberDecision: false
    },
    execution: 'renderer',
    createRendererOperation: async (input, context) => {
      const { path: source, targetDirectory, newName, reason } = input as {
        path: string
        targetDirectory?: string
        newName?: string
        reason: string
      }
      const root = requireWorkspaceRoot(context)
      const destination = resolveMoveDestination(root, searchService, source, targetDirectory, newName)
      return {
        type: 'move-workspace-entry' as const,
        fromRelative: destination.fromRelative,
        fromAbsolute: destination.fromAbsolute,
        toRelative: destination.toRelative,
        toAbsolute: destination.toAbsolute,
        reason
      }
    },
    createApprovalPreview: async (input, context) => {
      const { path: source, targetDirectory, newName } = input as {
        path: string
        targetDirectory?: string
        newName?: string
      }
      const root = requireWorkspaceRoot(context)
      const destination = resolveMoveDestination(root, searchService, source, targetDirectory, newName)
      return {
        type: 'file-operation' as const,
        operation: 'move' as const,
        title: destination.toRelative,
        from: destination.fromRelative,
        to: destination.toRelative
      }
    }
  })

  /**
   * 按路径写文本。
   *
   * 容器格式（.mdx / .inkmind）与图表（.drawio）在这里就拒掉：直接写会让
   * `.mdx` 丢资源、`.drawio` 与画布实例打架。这类文档仍由「打开后改」的
   * 文档工具负责。
   */
  const writeWorkspaceFile = defineTool({
    name: 'write_workspace_file',
    description:
      '把文本内容写入工作区内的指定文件（Markdown 与纯文本；不支持 .mdx / .inkmind / .drawio，这些请用文档编辑工具）。文件不存在则新建，存在则整体覆盖。执行前需要用户批准；目标在编辑器中有未保存修改时会被拒绝。',
    inputSchema: z
      .object({
        path: z.string().trim().min(1),
        content: z.string(),
        reason: z.string().trim().min(1)
      })
      .strict(),
    policy: {
      effect: 'write',
      approval: 'always',
      riskLevel: 'high',
      supportsRememberDecision: false
    },
    execution: 'renderer',
    createRendererOperation: async (input, context) => {
      const { path: target, content, reason } = input as {
        path: string
        content: string
        reason: string
      }
      const root = requireWorkspaceRoot(context)
      const resolved = requireWritableTextPath(root, searchService, target)
      // 目标恰好是当前活动文档时带上冲突基线（revision + 内容哈希），
      // 渲染层据此判断「批准期间用户是否改过它」；写别的文件不需要活动文档
      const active = context.snapshot.activeDocument
      return {
        type: 'write-workspace-file' as const,
        relativePath: resolved.relative,
        absolutePath: resolved.absolute,
        content,
        format: resolved.format,
        target: active && isSamePath(active.path, resolved.absolute) ? active : null,
        reason
      }
    },
    createApprovalPreview: async (input, context) => {
      const { path: target, content } = input as { path: string; content: string }
      const root = requireWorkspaceRoot(context)
      const resolved = requireWritableTextPath(root, searchService, target)
      let before = ''
      try {
        const slice = await searchService.readFileSlice(
          root,
          resolved.relative,
          { offset: 0, length: -1 },
          requireSignal(context)
        )
        before = slice.content
      } catch {
        // 文件还不存在：按「新建文档」预览
        return { type: 'document' as const, title: resolved.relative, content }
      }
      return {
        type: 'markdown-diff' as const,
        title: resolved.relative,
        before,
        after: content
      }
    }
  })

  /**
   * 删除文件。
   *
   * 只删文件、不删目录：递归删除的破坏面太大，用户要清理目录可以自己在文件树里做。
   * 执行放在渲染进程，因为删完之后文件树、已打开的标签与图谱索引都要一起更新。
   */
  const deleteWorkspaceFile = defineTool({
    name: 'delete_workspace_file',
    description:
      '删除工作区内的一个文件（移入系统回收站，不是永久删除；不能删除目录）。执行前需要用户批准。若该文件还在编辑器中且有未保存的修改，删除会被拒绝。',
    inputSchema: z
      .object({
        path: z.string().trim().min(1),
        reason: z.string().trim().min(1)
      })
      .strict(),
    policy: {
      effect: 'dangerous',
      approval: 'always',
      riskLevel: 'critical',
      supportsRememberDecision: false
    },
    execution: 'renderer',
    createRendererOperation: async (input, context) => {
      const { path: target, reason } = input as { path: string; reason: string }
      const root = requireWorkspaceRoot(context)
      const targetStat = await searchService.statFile(root, target, requireSignal(context))
      return {
        type: 'delete-workspace-file' as const,
        relativePath: targetStat.path,
        absolutePath: resolveAbsolutePath(root, targetStat.path),
        fileSize: targetStat.fileSize,
        reason
      }
    },
    createApprovalPreview: async (input, context) => {
      const { path: target } = input as { path: string }
      const root = requireWorkspaceRoot(context)
      const targetStat = await searchService.statFile(root, target, requireSignal(context))
      return {
        type: 'file-delete' as const,
        title: targetStat.path,
        relativePath: targetStat.path,
        fileSize: targetStat.fileSize,
        format: targetStat.format
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
        target: describeEditableTarget(context.snapshot.activeDocument),
        content,
        reason
      }
    },
    createApprovalPreview: async (input, context) => {
      const { content } = input as { content: string }
      const doc = describeEditableTarget(context.snapshot.activeDocument)
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
        target: describeEditableTarget(context.snapshot.activeDocument),
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
      const doc = describeEditableTarget(context.snapshot.activeDocument)
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
    getWorkspaceFileSize,
    createWorkspaceDirectory,
    moveWorkspaceEntry,
    writeWorkspaceFile,
    deleteWorkspaceFile,
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

/**
 * 写工具的目标校验：图片与 PDF 在编辑器里是只读二进制，正文是 Data URL / base64，
 * 让模型去「替换正文」只会产出一个打不开的文件，这里直接拒绝。
 */
function describeEditableTarget(doc: AiDocumentSnapshot | null): AiDocumentSnapshot {
  const target = describeTarget(doc)
  if (target.format === 'image' || target.format === 'pdf') {
    throw new Error('当前文档是只读的图片或 PDF，无法修改正文')
  }
  return target
}
