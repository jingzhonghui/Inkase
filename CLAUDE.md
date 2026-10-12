# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Inkase 是一款 Electron + Vue 3 桌面端轻量文档工作台，核心创新是自包含的 `.mdx` 文件格式 —— 将 Markdown 内容与图片、附件等资源打包为单一 ZIP 文件。

## Build/Dev Commands

```bash
# 安装依赖（使用 pnpm）
pnpm install

# 开发模式
pnpm run dev

# 类型检查（分别检查 Node 和 Web 端）
pnpm run typecheck:node
pnpm run typecheck:web
pnpm run typecheck

# 代码检查
pnpm run lint

# 格式化
pnpm run format

# 构建
pnpm run build

# 打包
pnpm run build:win    # Windows
pnpm run build:mac    # macOS  
pnpm run build:linux  # Linux

# 测试
pnpm test             # vitest
```

## Architecture

### 进程模型（Electron 双进程）

- **主进程** (`electron/`) — Electron main process，负责窗口管理、文件 I/O、MDX 打包解包、IPC handlers
- **渲染进程** (`src/`) — Vue 3 前端，负责编辑器 UI、用户交互、Markdown 渲染

通信方式：通过 `contextBridge` 暴露安全的 `window.electronAPI` 接口（在 `electron/preload.ts` 中定义），使用 `ipcMain.handle` / `ipcRenderer.invoke` 模式。

### 目录结构

```
electron/
├── main.ts           # Electron 入口：窗口创建、生命周期
├── preload.ts        # contextBridge API 定义与暴露
├── ipc/
│   ├── channels.ts   # IPC 通道常量（单一来源）
│   ├── file-handlers.ts  # 文件对话框、最近文件、文件夹 CRUD
│   ├── mdx-handlers.ts   # MDX 打开/保存/导入/导出/资源管理
│   ├── pdf-handlers.ts   # PDF 导出（单文件/批量）
│   ├── sync-handlers.ts  # Git 同步 IPC
│   ├── watch-handlers.ts # 外部文件修改监听
│   └── preview-protocol.ts # mdx-preview 协议（图片/附件 Data URL）
├── mdx/
│   ├── schema.ts     # MDX 文档类型定义、验证
│   ├── reader.ts     # MDX 解压、解析、临时目录管理
│   ├── writer.ts     # MDX 打包、写入、资源添加
│   ├── import.ts     # Markdown → MDX 导入
│   ├── export.ts     # MDX → Markdown 导出
│   ├── html-to-md.ts # HTML → Markdown 转换
│   ├── docx-import.ts # DOCX → MDX 导入
│   └── mime.ts       # 资源 MIME 类型
├── sync/             # Git 同步子系统
│   ├── config.ts     # .inkase/sync.json 配置读写、.gitignore 自愈
│   ├── engine.ts     # 同步状态机（attach/enable/pull/push）
│   ├── git-provider.ts # git 命令封装（commit 时排除 .inkase）
│   ├── legacy-migration.ts # 旧 .markdownPlus 目录自动迁移
│   ├── watcher.ts    # 远程变更监听
│   └── types.ts      # 共享类型（与 shared/sync 同步）
├── ai/               # AI 助手子系统
│   ├── runtime.ts / provider.ts # 会话运行时与 LLM 调用
│   ├── tool-registry.ts / tools/ # 工具调用注册与实现
│   ├── approval-manager.ts / policy-engine.ts # 审批流与权限策略
│   ├── conversation-store.ts # 会话持久化（.inkase/conversations/）
│   ├── source-access-service.ts / source-authorization.ts # 工作区文件访问授权
│   └── ipc-handlers.ts # AI IPC
├── workspace/        # 工作区搜索
│   ├── workspace-search-service.ts # ripgrep 全文搜索
│   ├── rg-resolver.ts # rg 二进制定位
│   └── mdx-content-search.ts # MDX 内容搜索
└── clipboard/
    └── file-clipboard.ts # 系统文件剪切板集成

src/
├── main.ts           # Vue 入口，挂载 Pinia
├── App.vue           # 根组件，初始化主题和文件状态
├── stores/           # Pinia 状态管理
│   ├── file/         # 文件状态（多标签、打开/保存/导入/导出、文件夹浏览）
│   │   ├── index.ts  # store 入口，聚合各子模块
│   │   └── tabs.ts / folder.ts / assets.ts / pdf.ts / clipboard.ts / external-watch.ts / types.ts
│   ├── session.ts    # 会话持久化（localStorage）
│   ├── theme.ts      # 主题管理（浅色/深色/跟随系统）
│   ├── appearance.ts # 外观设置：编辑区字号/字体族/行高，CSS 变量注入 + Ctrl+滚轮缩放
│   ├── ai.ts         # AI 助手面板状态
│   ├── sync.ts       # Git 同步面板状态
│   └── update.ts     # 应用更新检查
├── components/
│   ├── layout/       # AppHeader（菜单栏+窗口控制+设置对话框）、ToolBar、SideBar、StatusBar、SyncPanel（同步面板）
│   ├── sidebar/      # FileExplorer、FileTreeItem（文件树浏览器）
│   ├── editor/       # 编辑器核心组件
│   │   ├── EditorPanel.vue   # 编辑器容器（模式切换、欢迎页、分屏布局）
│   │   ├── SourceEditor.vue  # CodeMirror 源码编辑器
│   │   ├── IrEditor.vue      # ProseMirror 即时渲染编辑器（显示 Markdown 标记）
│   │   ├── PreviewPanel.vue  # 预览面板（markdown-it + Shiki 高亮 + KaTeX）
│   │   ├── TabBar.vue        # 多标签页栏
│   │   ├── FindReplacePanel.vue # 查找替换面板
│   │   ├── PdfViewer.vue / ImageViewer.vue / HtmlPreview.vue # 附件查看器
│   │   └── ai/        # AI 面板组件（AiPanel、AiSettingsDialog、会话侧栏、消息列表、审批对话框、工具调用卡片等）
│   ├── common/       # 通用组件（QuickOpenPalette、Tooltip、ConfirmDialog、EditorContextMenu、FileDropOverlay）
│   ├── export/       # PDF 导出视图（PdfExportView、批量进度对话框）
│   └── update/       # UpdateDialog（应用内更新）
├── composables/      # 组合式函数（useFileDrop 拖放打开、useEditorFontZoom Ctrl+滚轮缩放、useMdx）
├── utils/
│   ├── markdown.ts                    # markdown-it 实例、数学公式插件、代码语言映射
│   ├── shiki.ts                       # 代码高亮 highlighter 单例
│   ├── fuzzy.ts / dialog.ts / editor-language.ts / windows-filename.ts 等通用工具
│   ├── formatters/                    # 代码格式化（Prettier standalone，按扩展名懒加载 parser；供纯文本源码右键菜单「格式化文档」/ Shift+Alt+F）
│   ├── ai/                            # AI 消息解析等工具
│   └── prosemirror/                   # ProseMirror 工具集
│       ├── index.ts                   # 统一导出
│       ├── schema.ts                  # Schema 定义（节点 + 标记，含 math_inline/block）
│       ├── markdown.ts                # Markdown ↔ ProseMirror 互转（尾部空行往返保持）
│       ├── keymap.ts                  # 快捷键与命令
│       ├── inputrules.ts              # 输入规则（自动补全 Markdown 语法）
│       ├── plugins.ts                 # 插件集（历史、选中、拖放、占位符等）
│       ├── ir-plugin.ts               # IR 模式插件（控制标记显示）
│       ├── search.ts                  # 查找替换
│       ├── list-clipboard.ts          # 列表复制粘贴
│       └── anchors.ts                 # 标题锚点
├── styles/
│   └── index.css      # Tailwind + CSS 变量（浅色/深色主题 + 编辑区字体/行高变量）
└── types/
    ├── mdx.ts          # MDX 类型定义（与 electron/mdx/schema.ts 同步）
    ├── pdf.ts / update.ts / editor-context-menu.ts # 各域类型
    └── electron.d.ts   # electronAPI 类型声明
```

### 三种编辑模式

1. **即时渲染（IR）** — ProseMirror，在段落首显示 `#`、`>`、`-` 等 Markdown 标记符号，选中文本附近展开内联标记（`**`、`*` 等）
2. **源码模式** — CodeMirror，传统源码编辑，带语法高亮、自动补全、查找替换
3. **分屏模式** — 左侧 CodeMirror 源码 + 右侧预览

这三种模式在 `EditorPanel.vue` 中通过 `fileStore.editorMode` 切换。

### 核心数据流

```
编辑器组件 (SourceEditor/IrEditor)
  → fileStore.updateContent(content)    # 写入 Pinia
  → fileStore.fileContent (computed)    # 读取当前 tab 内容
  → PreviewPanel 监听变化重新渲染 HTML
    
用户操作 (AppHeader/ToolBar)
  → fileStore.newFile/openFile/saveFile
  → window.electronAPI.saveFile(content)
  → ipcMain.handle('file:save')
  → mdx-handlers.ts → writer.ts → ZIP 打包
```

### 关键设计决策

- **多标签页**: `fileStore.tabs` 数组 + `activeTabId`，向后兼容通过 computed 代理到 `activeTab`
- **`.mdx` 文件格式**: ZIP 压缩包，内含 `mdx.json`（元数据）+ `content.md` + `assets/images/`。打开时解压到系统临时目录，保存时重新打包
- **图片处理**: 通过 `sharp` 库可选压缩，使用 `adm-zip` 打包进 MDX，读取时通过 IPC 获取 Buffer 转为 Data URL
- **会话持久化**: localStorage 保存打开的文件路径、编辑器模式、侧边栏状态，启动时自动恢复
- **主题系统**: CSS 变量方案，支持 light/dark/system 三种模式
- **外观设置**: `appearance` store 将编辑区字号/字体族/行高以 CSS 变量注入根节点（`--editor-font-size` / `--editor-font-family` / `--editor-mono-font-family` / `--editor-line-height`），消费端带默认回退；编辑器内 Ctrl+滚轮 步进缩放字号（`useEditorFontZoom`）
- **Git 同步自愈**: `.inkase/`（本机私有配置）自动写入工作区 `.gitignore`；若已被跟踪则 `git rm --cached` 并提交移除，commit 暂存时排除 `.inkase`；旧用户的 `.markdownPlus` 目录在 attach/授权时自动迁移
- **IR 尾部空行往返**: `serializeMarkdown` 按尾部连续空段落数补足尾随换行（k 段 ↔ 2k 个 `\n`），`parseMarkdown` 逆向补偿，保证 IR 模式末尾空行保存/重开不丢失

### MDX 文件结构

```
document.mdx
├── mdx.json          # { version, title, content_file, assets: { images: [...] }, settings }
├── content.md        # Markdown 正文
└── assets/
    └── images/       # 嵌入的图片文件
```

### IPC 通信模式

所有 IPC handler 统一返回 `{ success: boolean, data?: any, error?: string }` 格式。通道常量集中定义在 `electron/ipc/channels.ts` 中作为单一来源，preload 和主进程共享。

