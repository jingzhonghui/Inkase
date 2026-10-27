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
- **webapp 不入库**：`resources/drawio` 是 45MB / 767 文件，`pnpm run fetch:drawio`（`scripts/fetch-drawio.mjs`）从 npm 拉 `@guowenzhang/dsh-drawioedit` 解包得到，`.gitignore` 忽略、`electron-builder.yml` 用 `extraResources` 打包。`eslint.config.mjs` 也把它排除，否则 lint 会被这堆压缩产物淹掉
- **桥接**：`src/utils/diagram/bridge.ts` 只管收发消息与请求配对，不碰 Pinia。三个实测得来的约束写在代码里：`format:'xml'` 的导出结果在 `payload.xml` 而非 `data`；一次编辑会连发**两条** autosave（第一条是中间态），所以按去抖合并、取最后一条；`EditorUi` 是闭包变量挂不到 `window`，任何程序化操作只能走用户输入或协议
- **真相在 store**：`tab.content` 是唯一真相，画布是它的视图。改动经 autosave 回写；只有**不是自己写**的变更（重新打开、外部改文件、AI 改正文）才回灌给 iframe，否则「写回 → 监听到变化 → 再加载」会活锁。回灌会记在 `loadChain` 上，保存前冲刷要等它，否则会把装载前的旧模型写进文件
- **保存前冲刷**：draw.io 的 autosave 是异步且去抖的，`Ctrl+S` 读的是 `tab.content`，刚拖完框就保存会丢最后一次改动。`src/utils/diagram/flush.ts` 是一张「标签 id → 冲刷函数」的登记表，`saveFile`/`saveAsFile` 写盘前按需冲一次；图表编辑器挂载时登记、卸载时先 `flushPendingAutosave()` 再注销
- **快捷键跨域问题**：画布在跨域 iframe 里，那里的 keydown 不会冒泡到页面，`Ctrl+S` 会「按了没反应」。`electron/main.ts` 用 `webContents.on('before-input-event')` 统一拦截保存快捷键，`preventDefault()` 之后转 `app:shortcut` 给渲染层——`preventDefault` 保证这次按键只被处理一次，不会重复保存
- **导出**：工具栏的 SVG/PNG 走协议 `export`，拿回 data URL 后解码，复用 `exportMindMapImage`（`FILE.EXPORT_IMAGE`）写盘。注意 SVG 里 `html=1` 的标签是 `<foreignObject>`，部分外部渲染器不认
- **计数**：状态栏对图表显示「图元」而不是「字数」（`countDiagramCells` 数 `<mxCell>` 再减掉每页两个根 cell）
- **组件缺失时**：`diagram:info` 告诉渲染层 webapp 是否就位；缺了就显示「运行 `pnpm run fetch:drawio`」的空状态，而不是白屏

### IPC 通信模式

所有 IPC handler 统一返回 `{ success: boolean, data?: any, error?: string }` 格式。通道常量集中定义在 `electron/ipc/channels.ts` 中作为单一来源，preload 和主进程共享。
