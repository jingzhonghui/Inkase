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
│   └── mdx-handlers.ts   # MDX 打开/保存/导入/导出/资源管理
└── mdx/
    ├── schema.ts     # MDX 文档类型定义、验证
    ├── reader.ts     # MDX 解压、解析、临时目录管理
    ├── writer.ts     # MDX 打包、写入、资源添加
    ├── import.ts     # Markdown → MDX 导入
    └── export.ts     # MDX → Markdown 导出

src/
├── main.ts           # Vue 入口，挂载 Pinia
├── App.vue           # 根组件，初始化主题和文件状态
├── stores/           # Pinia 状态管理
│   ├── file.ts       # 文件状态（多标签、打开/保存/导入/导出、文件夹浏览）
│   ├── session.ts    # 会话持久化（localStorage）
│   └── theme.ts      # 主题管理（浅色/深色/跟随系统）
├── components/
│   ├── layout/       # AppHeader（菜单栏+窗口控制）、ToolBar（格式化工具栏）、SideBar、StatusBar
│   ├── sidebar/      # FileExplorer、FileTreeItem（文件树浏览器）
│   └── editor/       # 编辑器核心组件
│       ├── EditorPanel.vue   # 编辑器容器（模式切换、欢迎页、分屏布局）
│       ├── SourceEditor.vue  # CodeMirror 源码编辑器
│       ├── IrEditor.vue      # ProseMirror 即时渲染编辑器（显示 Markdown 标记）
│       ├── PreviewPanel.vue  # 预览面板（markdown-it + Shiki 高亮 + KaTeX）
│       └── TabBar.vue        # 多标签页栏
├── utils/
│   ├── markdown.ts                    # markdown-it 实例、数学公式插件、代码语言映射
│   └── prosemirror/                   # ProseMirror 工具集
│       ├── index.ts                   # 统一导出
│       ├── schema.ts                  # Schema 定义（节点 + 标记，含 math_inline/block）
│       ├── markdown.ts                # Markdown ↔ ProseMirror DOM 互转
│       ├── keymap.ts                  # 快捷键与命令
│       ├── inputrules.ts              # 输入规则（自动补全 Markdown 语法）
│       ├── plugins.ts                 # 插件集（历史、选中、拖放、占位符等）
│       └── ir-plugin.ts              # IR 模式插件（控制标记显示）
├── styles/
│   └── index.css      # Tailwind + CSS 变量（浅色/深色主题）
└── types/
    └── mdx.ts          # MDX 类型定义（与 electron/mdx/schema.ts 同步）
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

