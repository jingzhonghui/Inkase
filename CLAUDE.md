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

### 依赖补丁：`patches/esbuild@0.25.0.patch`

用 `pnpm patch` 打的本地补丁，`pnpm-workspace.yaml` 的 `patchedDependencies` 里登记，**改完依赖记得 `pnpm install` 才会应用**。

补掉的是一个 Windows 上会随机构建失败的上游行为：esbuild 的 JS API 对超过 1 MiB 的 `transform()` 输入不直接走 stdin，而是先写到 `%TEMP%\esbuild-<随机 hex>`，再把路径交给 Go 侧读，读完由 Go 自己 `os.Remove`。一旦这次删除被瞬时占用（杀软实时监控新写的文件），esbuild 直接抛 `remove <temp>: Access is denied.`，整个构建失败。

本项目主进程 chunk 是 1,098,335 字节 —— 刚过 1 MiB 那条线，所以每次 `vite:esbuild-transpile` 都会走临时文件，`pnpm run dev` / `pnpm run build` 随机报：

```
ERROR  [vite:esbuild-transpile] remove C:\Users\...\Temp\esbuild-<hex>: Access is denied.
```

补丁把那个分支直接关掉（`if (false)`），输入留在内存里走 pipe —— `build` API 本来就能用同一条 pipe 传任意大小的输入，所以行为不变，产物也不变（主进程仍是压缩后的 948 kB）。**升级 esbuild（含 `vite` 带的版本）后补丁可能失效**，届时会出现「`An error occurred while applying patch`」或老错误复现，需要重新 `pnpm patch` 对齐行号；也可以不改代码，改为在杀软信任区里排除 `%TEMP%` 与本仓库目录。

### 开发服务器端口：为什么不用固定的 5173

`pnpm run dev` 不写死端口。`scripts/dev.mjs` 会先**实探**一个能真正 bind 的端口，再通过 `INKASE_DEV_PORT` 传给 `electron.vite.config.ts` 的 `renderer.server`（那边是 `strictPort: true`）。

原因：Windows 上 5173 经常落在 Hyper-V / WinNAT 的保留端口段里，

```bash
netsh interface ipv4 show excludedportrange protocol=tcp
# 协议 tcp 端口排除范围
#     5159        5258      ← 5173、5174 都在里面
```

落在保留段里时 bind 返回的是 **`EACCES`（permission denied）而不是 `EADDRINUSE`**，而 Vite 只会对 `EADDRINUSE` 自动顺延端口，于是直接抛：

```
Error: listen EACCES: permission denied ::1:5173
[ELIFECYCLE] Command failed with exit code 1.
```

落到 4173/5460/6006/8080/9000 之类的备用端口时会打印一行提示。想指定端口就设 `INKASE_DEV_PORT=<port>`，或直接 `electron-vite dev --port <port>`（此时脚本不再干预）。

`strictPort` 不能关：electron-vite 拼 `ELECTRON_RENDERER_URL` 用的是 **config 里的 `port` 而不是实际监听端口**（`lib-*.mjs` 里 `const port = conf.port`），一旦顺延就会把窗口指向一个空地址。

同一处还剥掉了继承来的 `ELECTRON_RUN_AS_NODE`：从 Electron 内嵌终端（VS Code 扩展宿主等）启动时这个变量会让 `electron.exe` 退化成普通 Node 运行 `main.cjs`，`require('electron')` 拿到路径字符串而不是 `app`，崩在 `@electron-toolkit/utils` 的 `Cannot read properties of undefined (reading 'isPackaged')`。

想彻底收回被保留的端口（需要管理员，且会影响其他依赖 Hyper-V 的程序）：

```bash
net stop winnat
netsh int ipv4 set dynamicport tcp start=49152 num=16384
netsh int ipv6 set dynamicport tcp start=49152 num=16384
net start winnat
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
│   ├── workspace-search-service.ts # ripgrep 全文搜索 + 文件范围读取（readFileSlice / statFile）
│   ├── rg-resolver.ts # rg 二进制定位
│   └── mdx-content-search.ts # MDX 内容搜索
├── clipboard/
│   └── file-clipboard.ts # 系统文件剪切板集成
└── diagram/          # 图表：自托管 draw.io webapp（inkase-drawio:// 协议托管 + 能力探测）

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
│   │   ├── DiagramEditor.vue # 图表（.drawio）：iframe 套自托管 draw.io，走 embed 协议
│   │   ├── PdfViewer.vue / ImageViewer.vue / HtmlPreview.vue # 附件查看器
│   │   └── ai/        # AI 面板组件（AiPanel、会话侧栏、消息列表、审批对话框、工具调用卡片等）
│   ├── settings/     # 设置中心（左栏分组 + 右栏分节；sections/ 下每个分组一个组件，AI 配置也在其中）
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
│   ├── mindmap/                       # 思维导图（schema 解析/序列化、viewport 画布尺寸、context-menu 菜单项）
│   ├── diagram/                       # 图表（embed 协议桥接、保存前冲刷登记表）
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
- **Markdown 工具栏只发命令，状态靠编辑器回声**: `src/components/editor/MarkdownToolbar.vue` 挂在 `EditorPanel` 的 `.document-view` 第一行（分屏时横跨两栏），只对 `format` 为 `mdx`/`markdown` 的标签显示——用它判显示条件顺带排除了 `.txt`/`.sh`/`.html`，不必再单独判纯文本。三条约束：① **不碰编辑器内部**：按钮一律往 `window` 派发既有的 `editor:format` / `editor:heading` / `editor:codeBlock` / `editor:image` 事件，`editor:link` 走 `editor:showLinkDialog` 复用顶栏那个对话框；真正干活的是当前挂载的那个编辑器（即时渲染 / 源码 / 分屏左栏是三个 `v-if` 分支，工具栏不需要知道是哪个）。② **高亮是回声，不是本地状态**：编辑器把光标处格式经 `editor:format-state` 发上来（`src/types/editor-format-state.ts` 是两边唯一的约定），工具栏自己不记「按下了什么」，否则点完按钮立刻与正文脱节。即时渲染侧每次事务（rAF 合并）与**所有 `applyAndSync` / `toggleMarkInView` 调用**都要发一次——后两者用 `view.updateState` 直接换 state，绕开了 `dispatchTransaction`，只在 dispatch 里挂会表现为「点完加粗按钮不亮」；源码侧走 `updateListener`，**`viewportChanged` 也要发**，因为 Markdown 语法树是随视口增量解析的，漏了这条会「明明在标题里标题按钮却不亮」。③ **不抢焦点**：按钮全部 `@mousedown.prevent`，丢掉选区等于点了没用。源码模式的格式状态读 `syntaxTree`（`src/utils/editor-format-state.ts`）而不是正则数 `**` 奇偶——`***粗斜体***`、行内代码里的星号、跨行标记都会误判，而「是否在围栏代码块内」用正则得从文档开头数围栏。图片按钮直接开系统文件选择器并走 `fileStore.addImage`，**不要**沿用旧 `ToolBar.vue` 那种「读成 data URL 塞进正文」的做法（图片进不了 `.mdx` 资源包）。开关在设置中心「编辑器」节，默认开。④ **空选区必须看得见符号**：光标处没有字符时，即时渲染的行内标记只能挂在 `state.storedMarks` 上（ProseMirror 的 mark 必须附着在文本节点上），`**` 无处可画，用户看到的只是「点了没反应」。所以 `ir-plugin.ts` 的 `collectPendingMarkDecorations` 在光标两侧各画一个 widget，把 `**`/`*`/`~~`/`` ` `` 摆出来，形态与 Typora 一致：`**|**`，直接打字就落在符号中间（`insertText` 走 `replaceSelectionWith(…, true)`，会继承 `storedMarks`，所以打出来的字真的带格式）。三个约束：**打第一个字后 widget 自动消失**，改由 `collectMarkDecorations` 展开的真标记接管，别去手工清理；**光标处已有同类标记时必须跳过**，否则在 `**加粗**` 里再点加粗会叠成 `******`；widget 的 `toDOM` 传**函数**而不是现成 DOM（与任务勾选框一致），收集装饰阶段不碰 `document`，否则无 DOM 环境（单测、序列化路径）直接抛错。源码模式本来就把 `****` 当字符插进文档、光标落中间，无需改动。回归用例：`src/components/editor/__tests__/ir-pending-mark.test.ts`（含「打的字要真的带上加粗」这条，只断言符号消失会漏掉 mark 不生效的情况）、`src/components/editor/__tests__/markdown-toolbar.test.ts`
- **PDF 阅读位置寄存在标签上**: `PdfViewer` 与图片/导图/图表一样在 `EditorPanel` 里按 `:key="activeTabId"` 挂载，切标签时**整体卸载重建**（pdfjs 的文档与画布占内存，刻意不用 keep-alive），所以页码不能留在组件内——否则「读到第 30 页，切走再切回」会回到第一页。位置写进 `TabInfo.pdfPosition`，与 `savedEditorPosition` 同一套生命周期（关闭标签即丢弃，不需要额外清理）：滚动时在 `onScroll` 写回，`loadPdf` 末尾用 `restoreScroll` 恢复（页面高度随缩放变化，刚重建时布局可能还没就绪，一次性赋 `scrollTop` 会滚不到或滚过头）。恢复期间用 `restoringPage` 抑制写回，否则重试途中的中间位置会被记成新的阅读位置；`pages` 还没量出来时 `pageAtScroll` 恒为 1，同样不能写回。回归用例：`src/components/editor/__tests__/PdfViewer.position.test.ts`
- **工作台双段**: 标签栏只有「文件 + 一个固定的家」。工作台内部是 `graph` / `ai` 两段，靠 `v-show` 保活（图谱的仿真坐标活在组件实例里，销毁重建会重新播种跳位），**默认落在图谱**——工作台的意义是「看你的库」，AI 是按需打开的第二段。AI 收起或关掉最后一个文档时都退回图谱段。曾经的「概览」段已移除。注意首屏跟着落在图谱时，会话恢复是异步的，`GraphView` 里有一个 `openedFolderPath` watcher 负责在 root 到位后补建索引（否则会停在「先打开一个文件夹」且不再自试）。
- **`.mdx` 文件格式**: ZIP 压缩包，内含 `mdx.json`（元数据）+ `content.md` + `assets/images/`。打开时解压到系统临时目录，保存时重新打包
- **图片处理**: 通过 `sharp` 库可选压缩，使用 `adm-zip` 打包进 MDX，读取时通过 IPC 获取 Buffer 转为 Data URL
- **会话持久化**: localStorage 保存打开的文件路径、编辑器模式、侧边栏状态，启动时自动恢复
- **主题系统**: CSS 变量方案，支持 light/dark/system 三种模式
- **外观设置**: `appearance` store 将编辑区字号/字体族/行高以 CSS 变量注入根节点（`--editor-font-size` / `--editor-font-family` / `--editor-mono-font-family` / `--editor-line-height`），消费端带默认回退；编辑器内 Ctrl+滚轮 步进缩放字号（`useEditorFontZoom`）
- **Git 同步自愈**: `.inkase/`（本机私有配置）自动写入工作区 `.gitignore`；若已被跟踪则 `git rm --cached` 并提交移除，commit 暂存时排除 `.inkase`；旧用户的 `.markdownPlus` 目录在 attach/授权时自动迁移
- **IR 尾部空行往返**: `serializeMarkdown` 按尾部连续空段落数补足尾随换行（k 段 ↔ 2k 个 `\n`），`parseMarkdown` 逆向补偿，保证 IR 模式末尾空行保存/重开不丢失
- **图谱索引跟着磁盘走**: 图谱是对磁盘的一次性快照，文档一存盘它就可能过期（新增/删除的链接、另存为多出来的文件）。`fileStore.libraryRevision` 是唯一的「磁盘库版本」——保存、另存为、外部改动重载、`readFolder`（文件树刷新与新建/删除/改名都经过它）各推一格，**编辑器打字不推**（否则图谱会被每次按键拖垮）。`GraphView` 监听它：防抖 500 ms、走 `refresh(true)` 静默重建（画布上有图时不要换成转圈），图谱没在眼前时只记 `pendingRebuild`，等 `isShowing` 变真再补建。画布一侧用 `graphStore.builtRoot` 区分「换工作区」与「后台重建」：用户自己掌过视口就不再自动适配，否则存一次盘就把人正在看的地方甩走
- **`isFiltered` 跟格式清单比，不写死数字**: 格式一共五种（mdx / markdown / mindmap / diagram / attachment），`ALL_GRAPH_FORMATS` 同时充当默认值与判定依据。早先按 `formats.length < 4` 判断，关掉一种后仍然报「没过滤」，侧栏那枚「重置筛选」的入口就不出现
- **AI 文件读取与删除**: 文档正文一律由工具按路径读取，模型不靠快照内容猜。`read_workspace_file` 支持 `offset`/`length`（字节，默认 0 与 -1=读到末尾），单次上限 `maxReadBytes`（默认 256 KiB，可配置），超了返回 `truncated` + `nextOffset`；`.mdx`/`.inkmind` 先解包再对正文切片，因此 `offset` 与 `get_workspace_file_size` 的 `totalSize` 是同一把尺子（普通文本 `totalSize`=磁盘字节，容器=解包后正文长度）。二进制文件不报错，`statFile` 返回 `readable:false` 让模型换路子
- **AI 整理工作区（写类工具）**: 四个写操作全部 `approval: always` 且**在渲染进程执行**（文件树、标签、图谱索引都在那边），都带冲突检测：
  - `delete_workspace_file`：只删文件不删目录，`riskLevel: critical`；有未保存修改的标签直接拒绝
  - `create_workspace_directory`：一次只建一层（`resolveNewPath` 要求父目录真实存在且在根内）
  - `move_workspace_entry`：`targetDirectory`（须已存在）+ 可选 `newName`，同目录时走 `renameItem`、跨目录先 `moveItem` 再改名；源或目标内有未保存修改即冲突
  - `write_workspace_file`：**只允许 Markdown / 纯文本**——`.mdx`/`.inkmind` 直写会丢 resources、`.drawio` 有画布实例，都在造操作时挡掉并要求改用文档工具。目标在编辑器里打开时用 revision+哈希判冲突，写完同步标签内容并清脏标记；未打开时写盘后 `readFolder` 刷新
- **权限模式（只读 / 标准 / 完全控制）**: 三档在 **AI 面板输入框内部左下角**的胶囊里切换（`AiPermissionSelect`，状态与落盘在 `AiPanel` → `AI.PERMISSION.SET`），不放设置中心——它属于「这一次怎么干」，是发送前的运行期许可，不是 Provider 参数。**它是输入框的一部分**：与 textarea 同在一张带边框的卡里（底栏左侧是权限胶囊、右侧是发送/停止），不是输入框下方另起的一条控件栏；外面不写「权限」标签、也不常驻说明句，三档靠图标（锁 / 盾 / 闪电）与配色区分，**完整解释只在 tooltip 里**（`模式名：会发生什么`，菜单打开时主动收起），完全控制态用警示色（浅色 `#b45309`、深色 `#fbbf24`）。**选项列表是自绘 listbox，不是 `<select>`**：原生下拉的选项面板由系统绘制，CSS 够不着，深色面板里会冒出一块系统白列表；自绘画在 `AiPermissionSelect.vue`，`Teleport` 到 body（躲开祖先裁剪与层叠上下文）、**贴着胶囊上沿**向上弹（下沿距胶囊上沿 8px、左沿与胶囊左沿对齐），上方放不下才翻到下方并夹进视口，打开后用真实尺寸再校准一帧。交互契约：点击/`Enter`/`Space`/`↑`/`↓` 打开，`↑`/`↓` 移动高亮，`Enter`/`Space` 选中，`Escape`/`Tab`/点击外部/滚动/缩放关闭；`role="listbox"` + `role="option"` + `aria-selected`，触发器带 `aria-haspopup`/`aria-expanded`。取值与文案只维护在 `shared/ai/permission.ts`（`readonly | standard | auto`，默认 `standard`，旧配置的 `approvalMode: 'ask'` 读入时迁移成 `standard`）。`evaluateToolPolicy` 返回三态：`readonly` 下 `effect` 为 `write` / `dangerous` 的工具**在进审批通道之前就 deny**（不能退化成「先弹窗再允许」），读类与 `network`（网页/本地文件读取）仍按各自策略走审批；`standard` 逐次审批；`auto` 全放行，但**渲染进程类操作仍走同一条审批通道**——请求带 `auto: true`，store 收到后立即 `resolveApproval(approved)`，执行路径、冲突检测与 `approvalHistory` 审计记录都不变，省掉的只是那一次点击。运行期切换走 `runtime.setPermissionMode`（下一次工具调用即生效，不重建 runtime，避免打断会话），同时写进 `ai-config.json`；模式**不参与** `configsEqual` 与能力探测指纹（它不影响模型能力）。只读模式下修改类工具不会递给模型，另有一道执行期 deny 兜底，系统提示里也会追加当前模式段落；切换失败时错误提示留在输入框外（胶囊太小塞不下），并回滚到原来的档位。**完全控制下审批卡片默认折叠**：`AiApprovalCard` 与 `AiApprovalGroup` 的 `open` 初值都要判 `record.auto`，只判 `decision === undefined` 会永久展开——自动放行的记录是**先插入、随后被 store 立即 resolve** 的，卡片创建那一瞬 `decision` 还没写，正好落进「等待批准所以要摊开」那条分支；而 `open` 是只取一次初值的 ref，之后 decision 落地也不会自动收起。折叠不丢信息，结论（`完全控制 · 已允许 · 已应用`）留在摘要行上，点开仍能回看整段 diff
- **AI 可用性的判定**: `AiConfigView.ready` 只看「地址 + 模型 + API Key 齐备」，不再要求先跑通能力探测——探测是验证，不是使用的前置条件（探测结果仍通过 `capabilities` 展示，模型不支持工具调用由运行期报 `TOOLS_NOT_SUPPORTED`）。设置对话框里的「能力已验证」只在探针结果与已保存配置指纹一致时显示
- **AI 超时按「空闲」算，不按墙钟**: `VercelAiSdkProvider` 用空闲看门狗（`idleTimeoutMs`，默认 10 分钟）替代原来的 5 分钟墙钟总超时：只要模型还在吐事件就算有活动，`toolsInFlight > 0` 期间（工具执行 + 等待用户审批）直接跳过计时。这是「整理一个目录」这类任务能跑完的前提——按墙钟计时时，用户读一份 diff 的时间就能把整轮判成超时。另有首事件超时 30s（每次请求）与工具超时 180s（`withTimeout`）、审批超时 300s（`ApprovalManager` 的默认值，发布时重置）。`maxSteps` 默认 50，设置里可调，上限 200。单次读取上限 `maxReadBytes` 由设置页配置（KB），经 `createDocumentTools({ maxReadBytes })` → `readFileSlice(range.maxBytes)` 传入，服务端用 `resolveMaxReadBytes` 夹到 4 KiB–4 MiB
- **每个工具调用都必须有终态**: 渲染层的工具卡片只有收到 `tool-call-completed` 才会离开「运行中」(`AiToolCallCard` 的 `displayStatus` 取 `result.status`，没有结果就一直是 `running`)。主进程这一侧必须在**两种**流事件上收尾：`fullStream` 的 `tool-result`（正常执行结果）与 **`tool-error`**。后者覆盖的是「模型给的参数不满足 Zod schema」和「模型调用了不存在的工具名」这两个高频小事故——AI SDK 6.x 在 `tool()` 层就把它们拦掉了，`AiRuntime.execute` 根本不会跑，SDK 只发一条 `tool-error`；早先 `provider.ts` 只认 `tool-result`，这条分片被直接丢弃，于是运行明明正常 `run-completed`，界面上那张卡片却永久停在「运行中」，看着像卡死。渲染层另有一道兜底 `settleRunningToolCalls`（`src/stores/ai.ts`）：`run-completed` / `run-failed` / `run-cancelled` 三个终止分支都把剩余 `running` 改成终态并随会话存盘，否则重开会话还是「运行中」。`cancelRun()` 里**必须单独再调一次**——它先把 `activeRunId` 置空，随后到达的 `run-cancelled` 会被 `event.runId !== activeRunId` 挡掉，指望那条事件收尾是收不到的。收尾状态决定徽标颜色：取消给 `cancelled`（灰「已取消」），中断给 `failed`（红「失败」）。回归用例：`electron/ai/__tests__/e2e.test.ts` 的 E10 / E10b（主进程侧）与 `src/components/ai/__tests__/ai-panel.test.ts` 的三条收尾用例（渲染层侧）
- **IR 回写必须「读当前文档」**: `IrEditor` 用 `requestAnimationFrame` 把文档序列化回 store（避免每次按键都全文档序列化）。两个铁律：① rAF 回调里序列化 `viewRef.value.state`，**不要**序列化调度时刻传进来的快照——同一帧内连打几个字符（快速键入、按键重复、输入法一次提交多个字符）时快照已经落后，回写会让 store 落后于编辑器；② store 的同步 watcher 见到「store 内容 ≠ 当前序列化」时**不能无条件整篇重建**（`EditorState.create` 的选区默认落在文档开头，表现为「光标莫名跳回开头」且吞掉刚打的字），先用 `lastPushedMarkdown` 判定这是不是自己上一帧写出去的回声，是就补一次回写、以编辑器为准。回写前还要校验 `editorTabId === activeTabId`，否则切标签时旧实例会把上一篇的内容写进新标签。回归用例：`src/components/editor/__tests__/ir-fast-typing-cursor.test.ts`
- **删除 = 移入回收站，绝不静默降级成永久删除**: `FILE.DELETE` 走 `shell.trashItem`（Windows 回收站 / macOS 废纸篓 / Linux XDG trash，目录同样支持），不再用 `fs.rmSync` / `fs.unlinkSync`。**失败时不回退到 `fs.rm`**——用户按「删除」的预期是「还能捞回来」，静默升级成永久删除是最坏的失败方式，宁可报错让用户自己决定；这反过来要求失败必须**说出来**：`folder.ts` 的 `deleteItem` 把 `result.error` 写进 `deps.error`，`FileExplorer` 的 `promptDelete` / `promptDeleteSelection` 在 `false` 时弹「删除失败」（多选时列名，并允许其余项继续删）。`file-handlers.ts` 里另有一个 `removeTarget()` 用 `fs.rmSync`，那是「粘贴时覆盖同名目标」的内部清理，不是用户的删除动作，保持永久删除是对的。三处文案随之统一为「将移入回收站」：文件树确认框、AI 审批的 `DeleteFilePreview`、`delete_workspace_file` 的工具描述与系统提示（否则模型会跟用户说「删了就找不回来」）。回归用例：`electron/ipc/__tests__/file-handlers.test.ts` 的 `file:delete` 三条（走 trashItem / 路径不存在 / 失败后文件仍在）
- **文件名的输入框只有一处实现，且挂载在 `App.vue` 上**: 「新建文件 / 重命名 / 新建文件夹」三处输入框共用 `src/utils/prompt.ts`（模块级单例状态 + `requestPrompt(): Promise<string | null>`）与 `src/components/common/PromptDialog.vue`，由 `App.vue` 与 `ConfirmDialog` 并排挂一次。**不能把它留在 `FileExplorer.vue` 里**：三个入口的挂载时机各不相同——文件树在侧栏切到「大纲」或收起时是 `v-if` 掉的真不渲染，文件菜单的「新建 ▸ 文件」走的却是 store 的 `newFile`，绑在组件上就有一半入口调不到。同一时间只允许一个输入框（后来的请求把前一个当作取消收尾，否则前一个 Promise 永远悬着）；`selection: 'stem'` 让重命名默认只选中主文件名（`stemEndIndex`：`a.md`→1、`a.tar.gz`→5、`.gitignore`→9，目录名一律 `'all'`），直接打字即改名、后缀不丢。**「文件 ▸ 新建 ▸ 文件 / 思维导图 / 图表」在工作区内与文件树右键新建是同一件事**：三个入口共用 store 的 `createDocument()`（先 `requestPrompt` 起名、再 `folder.createFile` 落盘并打开，`.inkmind` / `.drawio` 的空白内容由主进程按后缀写入），没有工作区时才退回「空白标签 + 首次保存再选路径」；`isLoading` 要等名字敲完才置位（状态栏拿它显示「加载中...」）。文件树的三个键盘动作都**只在列表本体持有焦点时**响应：`F2` 重命名、`Delete` 删除选中项（多选先 `dedupeTopLevelPaths` 剔掉被包含的子项，再逐个删，确认框按钮是 `取消` / `删除`），`Escape` 清空选中。`AppHeader.isAnyDialogOpen()` 把这套输入框与 `dialogState` 都算进去——重命名时按 `Ctrl+W` 想关的是输入框，不该顺手把背后的文档关掉
- **相对路径只有一种算法，输出一律正斜杠**: `src/utils/workspace-path.ts` 的 `toWorkspaceRelativePath(root, target)` 是唯一实现（反斜杠与尾斜杠归一、Windows 盘符路径大小写不敏感、`C:/ws` 不会误判 `C:/ws2/a` 是子路径），三种结果——`'a/b.md'` 在库内、`''` 是根自身、`null` 在库外。图谱用的 `toWorkspaceRelative`（`utils/graph/dirty-overlay.ts`）只是它的薄包装：把 `''` 也归成 `null`，因为图谱没有「根自己」这一号节点；**改归一规则只改这一处**。右键「复制相对路径」（`folder.ts` 的 `copyRelativePath`）排在「复制路径」**上方**，输出不带 `./` 前缀、工作区根自身给 `.`（复制空串等于什么都没复制，用户会以为没生效），库外兜底给绝对路径而不是空串。用正斜杠不是洁癖：这条路径的去处是 Markdown 链接、import 语句和 Git 命令，三处都只认 `/`，而反斜杠在 Markdown 里还会被当转义符。**图谱的节点右键菜单也是这一对**（`GraphView.vue`），但那边有个坑：`GraphNode.path` 本身就是工作区相对的 POSIX 路径，所以「复制路径」必须先 `graphStore.joinRoot()` 拼上根再复制——早先它直接复制 `node.path`，等于两个菜单项复制同一个东西。剪贴板写入统一走 `src/utils/clipboard.ts` 的 `writeClipboardText()`，顺带补了 `.catch()`——原来 `navigator.clipboard.writeText()` 的 reject 没人接，是个 unhandled rejection
- **快捷键的单一真相是 `src/shortcuts/registry.ts`**: 改键、菜单右侧文案、速查表/设置面板、实际派发全部从这一份命令注册表读，不要再往 `handleKeydown` 里加 `if (key === 'x')` 分支，也不要给菜单项写 `shortcut: 'Ctrl+S'` 字面量（用 `shortcutId`）。绑定一律用 `Mod`（Win/Linux = Ctrl，macOS = ⌘），存储与匹配只认 `Mod`，显示时才展开成 `Ctrl+…` / `⌘…`。**读键位一律走 `bindingOf(id)`**（= 用户覆盖值 ?? 默认值），不要在派发路径里读 `command.binding`——那是默认值，用户改过键就会出现「文案变了、行为没变」。用户覆盖值只存改过的条目（localStorage `inkase-shortcuts`，`{version:1, overrides}`），`null` 表示显式解绑，坏值只让那一条回落默认。`owner` 决定谁来执行：`app` 走 `AppHeader` 的派发器（`matchCommand` → `runCommand`），`editor` 由 ProseMirror/CodeMirror 的 keymap 执行（注册表只登记键位用于显示，派发器不抢），`native` 交给系统默认。标签切换（`Ctrl+←/→`）标了 `priority: 'capture'`：它与编辑器内「按词移动光标」冲突，必须在捕获阶段先于编辑器处理。解析/匹配/录制/保留键判定等纯函数在 `shared/shortcuts/binding.ts`（主进程也要用）；平台判定渲染层走 UA（`detectPlatform`，必须同步）、主进程走 `process.platform`——`app:getPlatform` 通道存在但别在同步路径上用（`detectPlatform` 被注册表格式化、菜单渲染直接调用，改成 await 会染成异步）
- **AI 配置住在设置中心，不在 AI 面板里**: Provider 参数（API 地址/模型/Key/温度/上下文窗口/工具步骤）是 `src/components/settings/sections/AiSection.vue`，归设置中心的「AI 助手」节。AI 面板标题栏只剩一个「设置」按钮，点它发 `inkase:open-settings` 窗口事件（`detail.section = 'ai'`），由唯一持有设置面板开关的 `AppHeader` 打开并落到该节——不要在 App 层再养一个 `aiSettingsOpen`，那正是这次合并掉的旧结构（原先是独立对话框 `AiSettingsDialog`）。三条搬过来必须守住的契约：① **Key 默认不回显**，主进程只回 `hasApiKey`；输入框显示固定十点的掩码（`KEY_MASK`，固定长度本身就是为了不泄露真实长度），**聚焦即清空**、失焦且没输入过任何东西就回填掩码，所以「留空＝保留原 Key」的语义不变；唯一例外是用户点小眼睛时经独立通道 `AI.CONFIG.REVEAL_KEY` 取一次明文，存在 `revealedApiKey` 里**只用于显示**、不并回 `form.apiKey`，提交时 `form.apiKey` 为空就不带 `apiKey` 字段（后端据此保留已存的 Key）；② **探测要防竞态**，用配置指纹比对，回来时表单已变就丢弃结果；③ **测通 ≠ 就绪**，只有「探测通过 + 表单与已存配置一致」才把「配置已就绪」点亮。与其余分节的差别是落盘走主进程异步 IPC、可能失败，所以 `AiSection.save()` 返回 `boolean`：失败时 `SettingsDialog` **不关面板**并切回 AI 节，否则错误留在看不见的那一节里，用户只看到「点了保存没反应」。AI 节首次进入才创建、之后 `v-show` 保活（切节不能丢已填的表单）；就绪状态经 `ai:readiness` 窗口事件回给 `App.vue`，不要改成保存后重新 `getAiConfig`——那既多一次往返，也会抹掉「探测通过但未保存」的中间态
- **接口格式只做两种，模型目录只是「候选」不是「选中」**: 接口格式（`shared/ai/api-format.ts`）只有 `openai-compatible`（默认）与 `openai-responses` 两档，对应 SDK 里 `createOpenAICompatible(...)(model)` 与 `openai(...).responses(model)` 两条构造路径，选哪种只决定「用哪套协议说话」，**不会自动给地址补 `/v1` 之类的后缀**——补了反而会让本来正确的地址多出一层路径。之所以停在两种：`ai@6.0.256` + provider 3.x 这一条 3.x 线是主进程 CJS 打包能用的最后一代，npm 上 `latest` 的 provider 是纯 ESM / `node>=22` / provider@4，直接换会把 `out/main/main.cjs` 打崩；加第三种格式就得再拉一个同代 provider 包，收益不抵风险。`apiFormat` **参与** `configsEqual` 与能力探测指纹（换协议后同一地址/模型/Key 的能力结论不能复用），`models`（勾选清单）则**两者都不参与**——它只是给下拉框用的候选表，增删候选不该让已通过的能力探测失效、也不该触发 runtime 重建。模型目录走 `GET {baseUrl}/models`（`electron/ai/model-catalog.ts`），有 Key 就带 `Authorization: Bearer`，401/403/404/429/5xx、非 JSON、15s 超时都给中文话术，结果按去重 + 排序 + 上限 500 收口。**模型区是「一行一个」的清单，不是单个输入框**：`AiModelPicker` 渲染 N 行输入（`rows` 由 `props.models` 推导，为空时用当前模型兜住，两边都空给一行空白），每行末尾是删除（`rows.length > 1` 时才出现，防止把清单删空），最后一行的「+」追加一个空行——两个按钮都只有图标（`IconPlus`/`IconMinus`），文字会把行挤窄，解释交给 `aria-label` + `title`；删除是破坏性动作，常驻淡红底 + 红图标、悬停才实心红并转白（纯实心红挂在每一行末尾会把注意力从模型名上拽走）；**网格必须建在「列表」上，不能建在每一行上**：三列 `minmax(0,1fr) auto auto`（输入框 / 删除位 / 添加位）写在 `.model-list` 上，`.model-row` 用 `display: contents` 透明化让子元素直接成为网格项。每行各自一个 grid 时列宽是**各算各的**——末行多一个「+」，它那一行的输入框就被挤窄 36px、删除按钮整体左移，摞起来正是「第一行宽、第二行窄」的锯齿；`display: contents` 的代价是 `.model-list__error` 这类非行子元素要显式 `grid-column: 1 / -1` 横跨，否则被塞进第一列。**单行时「+」上移顶到删除位**（`.model-row--single .model-row__add { grid-column: 2 }`，紧跟输入框，不留白——中间空一格看着像漏了个按钮），空出来的添加位由等宽隐形占位 `.model-row__ghost` 顶住，这样 1 行 ↔ N 行之间输入框宽度分毫不差、删除按钮始终同列（实测 1/2/3 行输入框均为 348px、删除按钮 left 均为 378）；改的正是当前模型那一行时把 `model` 一起改名、删掉的正是它时顺位到剩下第一个——否则保存后会出现「当前模型不在清单里」。**获取结果先弹窗、确认才落地**：点「获取模型」→ 主进程拉 `GET {baseUrl}/models` → 结果进 `AiModelCatalogDialog`（独立模态，勾选 + 搜索 + 全选，一个都不选时「确认」禁用），用户确认后才整体替换清单。候选里**预勾上当前模型**（`dialogSelection` = 清单 ∪ 当前模型），它通常不在服务商返回的列表里（手填的），不预勾的话用户一确认就把正在用的模型删了。**获取动作的按钮不在 picker 里**：按布局它要跟「模型」标题同一行，所以由 `SettingsRow` 的 `#actions` 插槽渲染，调用 picker `defineExpose` 出来的 `fetchModels` 与 `fetching`（`computed(() => picker.value?.fetching)` 能跟踪，因为 expose 走的是 proxyRefs）。**不要**把行内输入框设为 `disabled`：`loading`（保存/探测）期间禁用会让「探测时改表单→结果作废」这条竞态防护失去意义，测试里也根本触发不了 `input` 事件。落盘语义：`models: undefined` 表示不动，`models: []` 归一成 `[model]`，空白项由 `normalizeModelList` 丢掉，主进程再用 `withActiveModel` 把当前模型补进列表首位，所以渲染层提交时漏掉 `model` 也是合法的。`AI.MODEL.SET` 会拒绝「不在非空 `models` 里」的模型（挡旧渲染层的过期写入），因此设置保存成功后 `SettingsDialog` 要 `dispatchEvent(new CustomEvent('ai:config-changed'))` 让 AI 面板换掉手里那份旧清单，不能只靠关闭面板时重读
- **下拉菜单统一走 `useListboxMenu`，不用原生 `<select>`**: 原生下拉的选项面板由系统绘制，CSS 够不着，深色主题下会冒出一块系统白列表；所以设置中心与 AI 面板里的下拉都是自绘 `role="listbox"` + `Teleport` 到 body（躲开祖先裁剪与层叠上下文），定位、翻边、键盘交互、点击外部/滚动/缩放关闭这些共性抽在 `src/composables/useListboxMenu.ts`（`AiPermissionSelect`、`AiModelSelect`、`SettingsSelect` 共用，改交互只改这一处）。**层级必须显式声明**：`Teleport` 出去的元素拿不到 DOM 顺序，而设置中心整个面板就是一个 `position: fixed` 的全屏遮罩（`--z-settings-overlay` = 10010），菜单若还写着 10000 就会被压在面板下面 —— 表现是「点了没反应」或「弹窗被设置界面挡住」。所以 `src/styles/index.css` 里定了一套：`--z-popover`（常驻浮层，菜单用 10020）> `--z-settings-overlay`（设置面板 10010）；要用户确认的二级弹窗（`AiModelCatalogDialog`）再高一层 `--z-dialog`（10100）。新增浮层时**挑一个变量用，不要再写死数字**。**只有一个选项时也要能展开**：早先 `AiModelSelect` 在 `models.length <= 1` 时禁用，点下去毫无反应，用户只会认为按钮坏了；正确做法是照常弹出、把唯一那项勾在它自己身上，只有「一个候选都没有」（`length === 0`）才点不开。而「一个候选都没有」在模型下拉里根本不该发生：候选 = 清单 ∪ 当前模型，主进程 `toView()` 用 `withActiveModel` 归一、`AiModelSelect` 自己再兜一层（触发器上写着用的是哪个模型，点开却一项都没有是纯 bug——老配置从没写过 `models` 字段，读出来就是空数组）。两个使用约束：① **菜单的 `disabled` / 候选项数量来自刚 emit 出去的 props 时，必须 `await nextTick()` 再开**——同一 tick 里读到的还是旧值，表现是「点了获取没反应」；② 使用方要给 `props.options` 之类接 `as const` 常量表的参数标 `readonly T[]`，否则 `readonly` 的选项表赋不进可变数组（`TS4104`）
- **代码块语言下拉：清单只有一份，并且必须能搜**: 「语言」这一列在 `src/utils/code-languages.ts`（`CODE_BLOCK_LANGUAGES`），`value` 是写进围栏 info 的 Shiki 语言 id，`label` 是给人看的文字，`keywords` **只参与搜索不上屏**——`cmakelists` 在 Shiki 里没有对应语言，只能当 `cmake` 的搜索词，否则写进围栏就是一段没有高亮的死字。**纯文本只有一条，叫 `txt`**：早先 `''` 与 `text` 两条都叫「纯文本」，选项面板里出现两个一模一样的条目、选哪个都分不出来；现在统一成 `txt`（Shiki 的纯文本别名，`text`/`plaintext`/空串都由 `normalizeCodeLanguage` 归到它），因此新写的纯文本围栏是 ```txt。**原生 `<select>` 换成了自绘浮层**（`src/components/editor/CodeLanguageMenu.vue`）有两个硬理由：原生选项面板由系统绘制，深色主题下会冒出系统白列表；而且它只认首字母跳转，`cmakelists` 根本找不到 CMake。还有一个排版原因——`.ir-code-block` 是 `overflow-x: auto` 的 `<pre>`，浮层留在里面会被裁掉，所以 `Teleport` 到 body 用 fixed 坐标。交互：输入即过滤（复用 `utils/fuzzy`，标签命中带高亮、命中的是搜索词则不画高亮）、`↑`/`↓` 移动、`Enter` 提交、`Escape` 收起并把焦点还给编辑器、点击别处/滚动/缩放收起。两处容易踩的坑：① 浮层状态用 **`shallowRef`** 而不是 `reactive`——里面装着 `EditorView`，深代理会把它整个包一层；② 「点击外部关闭」必须**跳过触发按钮**，否则 pointerdown 先关、click 再开，表现为点了没反应，所以 `triggerEl` 要传给浮层。选语言时先校验 `pos` 上仍是 `code_block` 再派发（浮层开着时撤销/外部改动/AI 写回都可能把节点挪走）；NodeView 的 `destroy()` 顺手把指向自己的浮层收掉。新语言要在三处同时登记才真的能用：清单、`src/utils/shiki.ts` 的 `SHARED_LANGS`（没加载的语言 Shiki 会直接抛错，两处调用点都是 `catch` 掉静默不变色，很容易以为「加了没效果」）、以及 `src/utils/markdown.ts` 的 `CODE_LANGUAGES` 别名表。`CMakeLists.txt` 另在 `src/utils/editor-language.ts` 按**整份文件名**认语言（后缀是 `.txt`，按后缀匹配拿不到任何语言）
- **快捷键设置面板只对 `owner: 'app'` 开放编辑**: 编辑器命令（加粗、查找、插入链接…）的键位写在 ProseMirror/CodeMirror 的 keymap 里，在这里让人改是**假的**（改完列表显示新键，按下去还是旧键），所以那些行只读并标注「编辑器」。`owner: 'native'` 的三条（剪切/复制/粘贴）**整行不列**——它们是 Chromium 原生行为，键位由操作系统定死，摆在应用设置里只会让人误以为 Ctrl+C 是本应用的可配置项；但注册表里必须保留这三条，编辑菜单右侧的 Ctrl+C 文案还要从它们读。冲突检测仍按**全量**算（撞到 Ctrl+C 要提醒），只是逐条列举时跳过键为系统原生命令的那一侧，否则会指向列表里根本不存在的行。将来做 Phase 4（从注册表生成 ProseMirror keymap）时才把编辑器行放开。`allowInInput`（默认 true）只对四条「新建/打开」置 false：它们会把用户眼前的输入框换成新标签或系统对话框；保存/另存为/关标签必须保持生效，否则「在搜索框里按 Ctrl+S」会没反应。改这个名单前先想清楚：`before-input-event` 是全窗口的，主进程转发那条路拿不到焦点信息

### MDX 文件结构

```
document.mdx
├── mdx.json          # { version, title, content_file, assets: { images: [...] }, settings }
├── content.md        # Markdown 正文
└── assets/
    └── images/       # 嵌入的图片文件
```

### 思维导图（`.inkmind`）

第三种文档格式：**ZIP 容器**，与 `.mdx` 同构——导图结构与图片、附件一起打包，单文件即可带走，不会出现「文件在、图没了」。

```
map.inkmind (ZIP)
├── map.json          # 导图结构
└── assets/
    ├── images/       # 节点图片
    └── files/        # 节点附件
```

```json
{ "schema": "inkase.mindmap", "version": 2,
  "root": { "id": "n_root", "text": "中心主题", "note": "可选备注",
            "collapsed": false, "direction": "right", "color": "#4c8dff",
            "image": { "src": "assets/images/hero_9f2a1c.png", "width": 200, "height": 140 },
            "attachments": [ { "id": "att_1", "name": "方案.pdf",
                               "src": "assets/files/方案_a41d90.pdf",
                               "mime": "application/pdf", "size": 10240 } ],
            "children": [ ... ] } }
```

- **共享定义**：`shared/mindmap/document.ts`（schema/version/扩展名/空白文档），主进程新建文件与渲染层共用同一份常量
- **容器读写**：`electron/mindmap/inkmind-archive.ts` 用 `adm-zip` 解包到临时目录 / 原子打包回去，卡包体积、条目数、解压总量，并按 `assets/<images|files>/<文件名>` 逐段校验路径（挡 `..` 穿越）。打开时把 `map.json` 的文本交给编辑器，资源留在临时目录，另给一张「包内路径 → 绝对路径」的 `assetMap`；保存时才重打包。临时目录随标签关闭清理
- **资源登记与另存为**：`assetMap` 只覆盖「打开时包里已有」的条目，新插入的图片/附件必须由 store 的 `registerMindMapAsset` 把包内路径补进当前标签的表——否则 `resolveMindMapImageSrc` 查到空串，节点的 `<img>` 拿不到 url 就画不出来（附件同理，点了打不开）。`SAVE_AS` 对 `.inkmind` 必须**真的打包成容器**（写裸 JSON 会产出打不开的文件）；已打开的导图顺着源临时目录打包并沿用它，新建导图则写新容器再解包，两条路径都要 `registerTempDir(targetPath, …)`，否则另存为之后插入图片/附件会报「导图尚未打开」。新容器的 `assetMap` 随返回值带回渲染层替换标签的资源表。注意导图临时目录里只有 `map.json`，按 MDX 文档（`mdx.json`）去读会 ENOENT
- **渲染层**：`src/types/mindmap.ts` 模型 + `src/utils/mindmap/schema.ts` 容错解析（`{ ok, document, repaired[] }`）与序列化（2 空格缩进 + 末尾换行）
- **编辑器**：`src/components/editor/MindMapEditor.vue`（基于 mind-elixir）。刻意关掉了渲染库自带的右键菜单与平移，改用面板内自有菜单和原生滚动容器；画布尺寸由 `src/utils/mindmap/viewport.ts` 自适应内容；图片 URL 由 `src/utils/mindmap/image-src.ts` 查 `assetMap` 得到
- **AI 与搜索**：`shared/mindmap/outline.ts` 把导图转成「主题 + 缩进 + （备注：…）」大纲；`source-access-service` 与 `workspace-search-service` 读 `.inkmind` 时**先解包**再返回该大纲，不会把压缩字节当文本
- **互通**：`shared/mindmap/markdown.ts` 把 Markdown 标题/列表层级转成导图（store 的 `convertActiveToMindMap`，原文档不动）；`exportMindMapOutline` 反向导出大纲，走 `SAVE_AS` 的 `format: 'markdown'` 分支直接写文本
- **XMind 互转**：`shared/mindmap/xmind.ts` 做 `.inkmind` ↔ `.xmind` 的纯文本转换（只支持新版 `content.json`；遇到 XMind 8 的 `content.xml` 给「用新版另存」的提示），`electron/mindmap/xmind-archive.ts` 用 `adm-zip` 读写压缩包并卡体积/条目/解压总量上限；导入落盘 `.inkmind`（重名加 `_1`）后走正常打开流程。标记（`markers`）与标签（`labels`）映射到节点 `tags`、超链接映射到 `href`，能原样带回；关系线/概要/边界/图片/游离主题/多余画布无法表达，按类别计数汇总提示一次
- **富内容**：节点支持 `image`（包内 `assets/images/…`）、`attachments`（包内 `assets/files/…`，单节点上限 10 个、单个 50MB）、`icons`、`tags`、`href`，文档支持 `arrows`（关系线）与 `summaries`（概要），schema 版本 2。渲染层映射集中在 `src/utils/mindmap/adapter.ts`，校验与限额在 `src/utils/mindmap/rich-content.ts`；图标以字形（⭐🚩❓❗✅）交给渲染库、文件里仍存名字，因为 mind-elixir 把 `icons` 当纯文本输出——两边进出必须走 `iconsFromElixir` / `writeIconsToElixir`，直接往 `icons` 里塞名字会让画布显示「star」这个单词；附件不在渲染库的数据结构里，借节点 `metadata` 带一圈再回读
- **右键菜单与附件卡片**：图标是一级入口 + 二级菜单，点一下就地切换**并关闭菜单**（图标可叠加：重新右键再选，二级菜单里已选项带勾选态；`refresh()` 会清掉选中态，所以关菜单前记住 id、切完用 `restoreSelection` 选回来），不弹输入面板；只有标签/链接需要面板校验。附件在画布上渲染成节点下方的卡片（字形 + 文件名 + 大小），卡片是**注入进 `me-tpc` 的 DOM**，渲染库每轮重绘都会重建节点元素，所以挂在 `scheduleMeasure()` 里重画（与分支配色、查找标记同一处）；卡片参与节点高度，整图由渲染库自己的 flex 布局重排。卡片左键打开、右键出「打开 / 另存为 / 移除」。`P1`/`P2`/`P3` 自动套用优先级配色（预设定义在 `shared/mindmap/document.ts`，供 XMind 互转共用）
- **AI 生成导图**：`create_mindmap` / `update_mindmap`（`electron/ai/tools/document-tools.ts`）只收 Markdown 大纲，由 `markdownToMindMapJson` 转成 JSON——不让模型手写 `.inkmind`，避免 id/括号出错产出打不开的文件。`update_mindmap` 复用 `replace-document` 操作，自带 revision/哈希冲突检测；会整体覆盖，因此丢失节点富内容，工具描述里限定了使用场景。与标题同名的一级标题会被剥掉，避免中心主题下多挂一个同名节点

### 图表（`.drawio`）

第四种文档格式，与导图相反：**不做容器**，文件就是 draw.io 自己的一整份 mxfile XML（UTF-8 文本），`format: 'diagram'`。这样 `.drawio` 能和外部工具、Git diff、issue 附件直接互通，代价是没有「资源随文件走」的能力（draw.io 的图片本来就是内嵌 base64 或外链）。

- **编辑器不是自己写的**：`src/components/editor/DiagramEditor.vue` 用一个 iframe 套住**自托管的 draw.io webapp**，双方只走官方的 embed 协议（`?embed=1&proto=json`）。draw.io 是强耦合单体，拆到最后只剩 mxGraph 内核，重造轮子的工作量在 spike 里量到 53–72 人日，且形状库、导出、撤销栈全都要自己补。iframe 换来的是完整功能，代价是 +45MB 磁盘 / +7.6MB 安装包
- **协议托管**：`electron/diagram/protocol.ts` 用自定义协议 `inkase-drawio://app/...` 服务 `resources/drawio`（dev 走仓库目录，prod 走 `process.resourcesPath/drawio`），不占端口、不监听回环；响应头里注入严格 CSP（**不需要 `unsafe-eval`**，已实测）。注册分两步：`registerDiagramSchemePrivileges()` 在 app ready **之前**声明 standard/secure 特权，`registerDiagramProtocol()` 在 ready 之后挂文件服务——顺序错了协议直接不工作
- **webapp 不入库，但必须自动到位**：`resources/drawio` 是 45MB / 780 文件，`.gitignore` 忽略；`electron-builder.yml` 用 `extraResources` 把它放到安装包的 `resources/drawio`，同时 `files` 里用 `!resources/**` 排除——不排除的话它会被再打一份进 `app.asar`，安装包白胖 45MB。拉取由 `scripts/fetch-drawio.mjs` 负责：源包钉死 `@guowenzhang/dsh-drawioedit@1.2.1`，`registry.npmmirror.com` 优先、官方源兜底，tarball 缓存在 `node_modules/.cache/inkase-drawio/`，解包后校验文件数与体积再原子替换。它被三处自动调用——`pnpm install` 的 postinstall（`--optional`，网络抖动不阻断安装）、`pnpm run dev`、`pnpm run build`——**不要**再把「先跑 fetch:drawio」写回任何用户可见的流程。打包结束时 `build/after-pack.cjs` 的 `ensureDiagramWebapp` 会校验产物里确实有 `index.html` + `js/app.min.js` 且 ≥20MB，缺了直接让构建失败：electron-builder 对缺失的 `extraResources.from` 是**静默跳过**的，曾经就这样产出了「新建图表提示组件缺失」的安装包
- **缺失态文案分环境**：`diagram:info` 返回 `packaged`，渲染层据此区分——开发环境提示 `pnpm run fetch:drawio`（并说明 install/dev 会自动做），打包环境只说「安装不完整，覆盖安装最新版即可」，**绝不**把构建命令暴露给普通用户
- **切主题不重建 iframe**：画布用 `dark=auto` 打开，配色由 `prefers-color-scheme` 决定；应用主题经 `theme:setSource` 落到主进程的 `nativeTheme.themeSource`，draw.io 收到 media change 自己翻色（实测 **~35–40ms**）。**不要**再把主题写进 embed URL——URL 一变 `iframe` 的 `:key` 就变，等于每次切主题都把 17–33MB 的 webapp 重新加载一遍（实测 765–1260ms），还得靠 `flushXml` + `load` 把内容搬回去，snapshot 与 store 有偏差就丢改动。两条相关约束：① `themeSource` 是应用级的，覆盖成 light/dark 后 `matchMedia` 读到的是覆盖值而非真实系统偏好，所以 `theme.ts` 只在「跟随系统」时更新 `systemPreference`；② `iframe` 用 `v-if` 而不是 `v-show` 提前挂在 DOM 里——`display:none` 的 iframe 照样会加载 src，早先「检查通过后 `frameKey += 1` 再重建」导致首次打开图表白加载两遍
- **宿主样式注入**：`protocol.ts` 的 `injectDiagramHostStyle()` 在 `index.html` 的 `</head>` 前插一段内联 `<style>`，目前只做一件事——藏掉 draw.io 页签栏右侧自带的 GitHub 图标（`updateTabContainer` 里无条件创建的 `a[href^="https://github.com/jgraph/drawio"]`，webapp 没有开关配置）。放在协议层而不是改 `resources/drawio` 里的文件：那份资源是 `scripts/fetch-drawio.mjs` 解出来的，重跑即覆盖；协议层注入对上游不可见、重新拉取依然生效。CSP 的 `style-src` 本来就放开了 `'unsafe-inline'`（draw.io 自己的内联样式必需），所以无需放宽策略
- **桥接**：`src/utils/diagram/bridge.ts` 只管收发消息与请求配对，不碰 Pinia。三个实测得来的约束写在代码里：`format:'xml'` 的导出结果在 `payload.xml` 而非 `data`；一次编辑会连发**两条** autosave（第一条是中间态），所以按去抖合并、取最后一条；`EditorUi` 是闭包变量挂不到 `window`，任何程序化操作只能走用户输入或协议
- **真相在 store**：`tab.content` 是唯一真相，画布是它的视图。改动经 autosave 回写；只有**不是自己写**的变更（重新打开、外部改文件、AI 改正文）才回灌给 iframe，否则「写回 → 监听到变化 → 再加载」会活锁。回灌会记在 `loadChain` 上，保存前冲刷要等它，否则会把装载前的旧模型写进文件
- **保存前冲刷**：draw.io 的 autosave 是异步且去抖的，`Ctrl+S` 读的是 `tab.content`，刚拖完框就保存会丢最后一次改动。`src/utils/diagram/flush.ts` 是一张「标签 id → 冲刷函数」的登记表，`saveFile`/`saveAsFile` 写盘前按需冲一次；图表编辑器挂载时登记、卸载时先 `flushPendingAutosave()` 再注销
- **快捷键跨域问题**：画布在跨域 iframe 里，那里的 keydown 不会冒泡到页面，`Ctrl+S` 会「按了没反应」。`electron/main.ts` 用 `webContents.on('before-input-event')` 统一拦截保存/另存为/关闭标签页，`preventDefault()` 之后转 `app:shortcut` 给渲染层——`preventDefault` 保证这次按键只被处理一次，不会重复保存、更不会一次关掉两个标签。`Ctrl+W` 必须走这条通道：Chromium 对它没有任何默认行为，不拦就完全没反应；有对话框开着时渲染层不响应，免得用户想关对话框却关掉了文档。**键位由渲染层推送**：拦截名单是 `registry.ts` 的 `MAIN_INTERCEPTED_COMMANDS`，`AppHeader` 用 `watchEffect(pushShortcutsToMain)` 在启动时与每次改键后把「命令 id → 当前绑定」通过 `app:sync-shortcuts` 推过去，主进程只做 `matchesBinding` 匹配并回传**命令 id**。主进程里**不要**再写 `key === 's'` 之类的判断——用户一改键就两头对不上（新键在画布里没反应、旧键反而还在存盘）。匹配逻辑放在 `shared/shortcuts/binding.ts`，主进程与渲染层共用同一份
- **导出**：工具栏的 SVG/PNG 走协议 `export`，拿回 data URL 后解码，复用 `exportMindMapImage`（`FILE.EXPORT_IMAGE`）写盘。注意 SVG 里 `html=1` 的标签是 `<foreignObject>`，部分外部渲染器不认
- **计数**：状态栏对图表显示「图元」而不是「字数」（`countDiagramCells` 数 `<mxCell>` 再减掉每页两个根 cell）
- **组件缺失时**：`diagram:info` 告诉渲染层 webapp 是否就位；缺了就显示空状态而不是白屏，并按 `packaged` 分文案（开发环境给命令，打包环境只提示重装）。安装包层面这条路径本不该出现——`after-pack` 已经拦住漏打 drawio 的构建

### IPC 通信模式

所有 IPC handler 统一返回 `{ success: boolean, data?: any, error?: string }` 格式。通道常量集中定义在 `electron/ipc/channels.ts` 中作为单一来源，preload 和主进程共享。
