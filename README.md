# Inkase

一款以自包含 `.mdx` 文件格式为核心的轻量级文档工作台——将 Markdown 内容与图片、附件打包为单一 ZIP 文件，同时支持纯文本/代码文件编辑与 PDF、图片查看。

官网：<https://jingzhonghui.github.io/Inkase/>（[English](https://jingzhonghui.github.io/Inkase/en/)）

## 特性

- 📝 自包含的 `.mdx` 文件格式（标准 ZIP 压缩包：`mdx.json` + `content.md` + `assets/`）
- 🖼️ 图片自动打包到文档内，粘贴或拖入即收入文档
- ✍️ 三种编辑模式：即时渲染（Markdown 标记可见的所见即所得）/ 源码编辑 / 分屏预览
- 📁 文件夹工作区：资源管理器式浏览、新建、重命名、拖拽移动，多标签页编辑
- 📄 多格式支持：DOCX / Markdown / 文件夹导入，Markdown / PDF 导出（支持批量），PDF 与图片只读查看
- 🧠 思维导图：`.inkmind` 单文件容器，节点可带备注、标签、链接、图标、图片与附件，支持关系线、概要、画布内查找；笔记可一键转成导图，导图能导出为 Markdown 大纲、PNG/SVG 与 XMind
- 🔍 基于 ripgrep 的工作区全文搜索与快速打开（`Ctrl+P`）
- 🤖 内置 AI 助手：兼容 OpenAI 接口配置，文档读写与检索工具均可审批、可预览
- 🔀 Git 同步：绑定仓库后一键拉取 / 推送，冲突可视化处理
- 💾 自动保存与崩溃恢复，外部修改自动监听刷新
- 🌓 浅色 / 深色 / 跟随系统主题；编辑器正文字体、代码字体、行高可调，`Ctrl+滚轮` 缩放编辑区字号
- 💻 跨平台：Windows（NSIS / zip）与 Linux（AppImage / deb）

## 思维导图

除了 `.mdx` / 纯文本，Inkase 还能直接打开 `.inkmind` 思维导图。它和 `.mdx` 一样是**单文件 ZIP 容器**：

```
图纸.inkmind
├── map.json          # 导图结构（UTF-8 JSON，schema: "inkase.mindmap"）
└── assets/
    ├── images/       # 节点图片
    └── files/        # 节点附件
```

节点的图片与附件跟着文件一起走，不会出现「文件在、图没了」；保存时重新打包，另存为会写出一份完整容器（图片与附件一并带走）。包内的 `map.json` 仍是可读 JSON，需要放进 Git 比对时解包即可。

- **入口**：文件 › 新建 › 思维导图（`Ctrl+Shift+N`）、资源管理器右键「新建 › 思维导图」、拖放 `.inkmind` 文件、命令行 `inkase 图纸.inkmind` 直接打开；Windows 安装时可勾选关联 `.inkmind`
- **编辑**：`Tab` 新建子主题、`Enter` 新建同级主题、`Ctrl+Enter` 新建父主题、`F2` 重命名、`Delete` 删除；拖拽主题调整父子关系
- **右键菜单**：备注、标签（`P1`/`P2`/`P3` 自动套优先级配色）、链接、图标（星标 / 旗帜 / 疑问 / 重点 / 已完成，可叠加）、图片、附件、关系线（先按住 `Ctrl` 选中两个主题）、概要、分支颜色、折叠分支
- **富内容**：图片按节点尺寸参与布局；附件在主题下方显示为卡片，左键打开、右键另存为或移除（单节点最多 10 个，单个上限 50MB；图片单张上限 12MB）
- **查看**：画布自适应当前窗口，`Ctrl+滚轮` 缩放、滚轮平移、按住根主题拖动可整体挪动画布；`Ctrl+F` 在画布内查找并高亮命中（自动展开折叠分支）；撤销/重做走应用「编辑」菜单（`Ctrl+Z` / `Ctrl+Y`）
- **导入导出**：`XMind` 互转（`.xmind` 的标记与标签会映射成节点标签），导出 PNG / SVG 图片与 Markdown 大纲
- **与笔记互通**：文件 › 新建 › 「由当前笔记生成」按标题层级与列表缩进生成导图（原文档不动）
- **AI 与搜索**：AI 助手与工作区搜索读到的 `.inkmind` 是「主题 + 缩进」的大纲文本，而不是裸露的 JSON 括号

## 下载

前往[官网](https://jingzhonghui.github.io/Inkase/)或 [GitHub Releases](https://github.com/jingzhonghui/Inkase/releases/latest) 获取最新版本安装包。

## 技术栈

- Electron 34+
- Vue 3 + TypeScript + Pinia
- Tailwind CSS
- CodeMirror 6（源码模式）+ ProseMirror（即时渲染）
- markdown-it + Shiki + KaTeX（预览渲染与高亮）
- electron-vite

## 开发

```bash
# 安装依赖（使用 pnpm）
pnpm install

# 开发模式
pnpm run dev

# 类型检查（Node 与 Web 双端）
pnpm run typecheck

# 代码检查
pnpm run lint

# 代码格式化
pnpm run format

# 运行测试（vitest）
pnpm test

# 构建
pnpm run build

# 打包
pnpm run build:win    # Windows
pnpm run build:mac    # macOS
pnpm run build:linux  # Linux
```

## 发布

推送 `vX.Y.Z` 格式的标签会自动触发 GitHub Actions 发布流程。

```bash
git tag v1.0.1
git push origin v1.0.1
```

流水线会使用 `dist/` 目录下的安装包自动创建 GitHub Release 并上传资产。

官网主页（`website/` 目录）在推送到 `main` 且内容变更时自动部署到 GitHub Pages。

## 项目结构

```
inkase/
├── electron/            # Electron 主进程
│   ├── main.ts          # 主进程入口
│   ├── preload.ts       # 预加载脚本（contextBridge API）
│   ├── ipc/             # IPC handlers（文件/MDX/PDF/同步/AI）
│   ├── mdx/             # .mdx 读写、导入导出
│   ├── ai/              # AI 运行时、工具、审批
│   ├── sync/            # Git 同步引擎
│   └── workspace/       # 工作区搜索（ripgrep）
├── src/                 # Vue 3 渲染进程
│   ├── components/      # 组件（编辑器/布局/侧栏/AI/导出）
│   ├── stores/          # Pinia 状态（file/ai/sync/appearance/theme 等）
│   ├── utils/           # 工具集（markdown/ProseMirror/mindmap 等）
│   └── styles/          # 主题样式（CSS 变量）
├── website/             # 官网主页（GitHub Pages）
├── shared/              # 主进程与渲染进程共享类型（含 mindmap 格式与大纲转换）
├── docs/                # 设计文档
└── scripts/             # 构建/开发辅助脚本
```

## 许可证

[Apache-2.0](LICENSE)
