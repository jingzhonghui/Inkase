# Inkase

一款以自包含 `.mdx` 文件格式为核心的轻量级文档工作台——将 Markdown 内容与图片、附件打包为单一 ZIP 文件。除长文之外，还能画 `.inkmind` 思维导图与 `.drawio` 图表，并支持纯文本/代码文件编辑与 PDF、图片查看。

官网：<https://jingzhonghui.github.io/Inkase/>（[English](https://jingzhonghui.github.io/Inkase/en/)）

## 特性

- 📝 自包含的 `.mdx` 文件格式（标准 ZIP 压缩包：`mdx.json` + `content.md` + `assets/`）
- 🖼️ 图片自动打包到文档内，粘贴或拖入即收入文档（可开启自动压缩）
- ✍️ 三种编辑模式：即时渲染（Markdown 标记可见的所见即所得）/ 源码编辑 / 分屏预览
- 📁 文件夹工作区：资源管理器式浏览、新建、重命名、拖拽移动，多标签页编辑
- 🗂️ 大纲视图：侧栏「文件 / 大纲」双标签，Markdown 标题与 PDF 目录都能点击跳转
- 📄 多格式支持：DOCX / Markdown / XMind / 文件夹导入，Markdown / PDF 导出（支持批量），PDF 与图片只读查看、HTML 可切浏览器式预览
- 🧠 思维导图：`.inkmind` 单文件容器，节点可带备注、标签、链接、图标、图片与附件，支持关系线、概要、画布内查找；笔记可一键转成导图，导图能导出为 Markdown 大纲、PNG/SVG 与 XMind
- 🗺️ 图表：`.drawio` 纯文本 mxfile，内置自托管的 draw.io 画布（离线、不走端口），流程图 / 架构图 / ER 图 / UML 等随画随改，可导出 SVG / PNG
- 🕸️ 知识图谱：把工作区里 `.mdx` / `.md` / `.inkmind` / `.drawio` 之间的链接画成力导向图，可看全库拓扑或某篇笔记的 1–3 跳邻居，并列出断链与孤儿笔记
- 🧩 工作台：固定标签，知识图谱与 AI 助手两段切换（`v-show` 保活），默认落在图谱
- 🔍 基于 ripgrep 的工作区全文搜索与快速打开（`Ctrl+P`）
- 🤖 内置 AI 助手：兼容 OpenAI 接口配置，文档读写与检索工具均可审批、可预览
- ⌨️ 快捷键可配置：设置面板里录制新键位、检测冲突、一键恢复默认，菜单文案同步更新
- 🔀 Git / WebDAV 同步：Git 仓库或 WebDAV 网盘任选其一，一键拉取 / 推送，冲突可视化处理
- 💾 崩溃恢复：未保存内容实时快照，异常退出后自动恢复；外部修改自动监听刷新
- 🧰 日常小工具：最近文件、文档格式化（`Shift+Alt+F`，代码 / JSON / 纯文本）、应用内检查更新、内置 PDF 使用教程
- 🌓 浅色 / 深色 / 跟随系统主题；编辑区字号、正文字体、代码字体、行高与主界面字号均可调，编辑器内 `Ctrl+滚轮` 缩放
- 💻 跨平台：Windows（NSIS / zip）与 Linux（AppImage / deb）；macOS 的 dmg 打包配置已就绪，暂未纳入发布流水线

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

## 图表

第四种文档格式，和导图刚好相反：**不做容器**。`.drawio` 就是 draw.io 自己的一整份 mxfile XML（UTF-8 纯文本），因此能和外部工具、Git diff、issue 附件直接互通；代价是没有「资源随文件走」的能力——draw.io 的图片本来就是内嵌 base64 或外链。

- **画布不是自己写的**：把自托管的 draw.io webapp 装进 iframe，双方只走官方 embed 协议（`?embed=1&proto=json`），换来完整的形状库、导出、快捷键与撤销栈，而不是一个残缺的仿制品
- **托管方式**：用 `inkase-drawio://` 自定义协议服务本地 webapp，不占端口、不监听回环，断网可用
- **开箱即用**：webapp 随安装包一起落到安装目录的 `resources/drawio`，装完即可新建图表，用户不需要联网、也不需要任何额外设置；开发与构建阶段由脚本自动准备（见「开发 › 关于 `resources/drawio`」）
- **入口**：文件 › 新建 › 图表（`Ctrl+Shift+D`）、资源管理器右键「新建 › 图表」、命令行 `inkase 流程.drawio` 直接打开（`.drawio` 没有注册 Windows 文件关联，双击不会拉起 Inkase；拖放目前只认 `.md` / `.mdx` / `.inkmind`）
- **保存**：画布改动异步回写，`Ctrl+S` 之前会先冲刷最后一次自动保存，刚拖完框就保存也不会丢；焦点在画布内时快捷键由主进程统一拦截，照样生效
- **导出**：顶栏一键导出 SVG / PNG（SVG 里 `html=1` 的标签是 `<foreignObject>`，个别外部渲染器认不出）
- **状态栏**：图表显示「图元」数而不是字数
- **多页**：一个 `.drawio` 可以有多页，不只是一张画布；状态栏的图元数按全部页累计

## 知识图谱

笔记之间的链接（正文里的 `[标题](相对路径.mdx)`）会被索引成一张图，用来回答「这篇笔记连着谁」「哪里断了」这类结构问题——文件树与全文搜索都不回答这些。

- **入口**：工作台标签的图谱段，或 视图 › 知识图谱（`Ctrl+Shift+G`）；资源管理器右键文件 ›「显示图谱」直接进局部模式，中心为该文件
- **全库图**：滚轮以光标为中心缩放、空白处拖拽平移、拖拽节点临时钉住（双击释放并重新舒展）、双击节点打开文件、单击显示路径与出入链数
- **局部图**：以当前文件（或选中节点）为中心按双向 BFS 展开 1–3 跳，侧栏切换「全库 ⇄ 局部」、滑块调深度；图外还有邻居时信息卡会提示并支持一键扩展到全库
- **左侧栏**：视图（全库 / 局部 + 深度）、目录（色标 + 该目录节点数）、类型（文档 / 导图 / 图表 / 其他，按形状分组整组开关）、质量（断链 / 孤儿条数，点击展开清单）。目录不截断，多了在栏内滚动
- **过滤与检索**：侧栏任意一行点一下即过滤，顶部搜索框高亮命中（`Enter` 选中并居中）；过滤只改渲染集合，不重排布局
- **视觉编码**：颜色＝顶层目录、形状＝格式（圆点文档 / 菱形导图 / 方形图表 / 三角其他文件）、半径＝入链数、虚线空心＝断链目标
- **问题清单**：侧栏「质量」两行分别打开「断链 / 孤儿」抽屉，点击任一条跳到对应文件（断链跳到来源文件）
- **图上编辑**：空白处右键「新建笔记」直接在工作区根建 `.mdx`；节点右键「链接到…」在源文档的「## 相关笔记」小节追加链接（已存在则跳过，打开的标签只改缓冲区不落盘）
- **非文档目标**：链到脚本、PDF、图片时，只要文件真实存在就以三角节点入图（只收被链接到的，不会把 `assets/` 灌进来）；无法解析出链
- **计数**：工具条显示节点 / 链接 / 断链 / 孤儿四个数字，扫到文件上限时会挂出「结果不完整」的警告
- **不污染文档状态**：图谱是视图不是文档，不进入最近文件、不写入会话恢复、关闭时不弹保存提示

## 设置与快捷键

`Ctrl+,` 打开设置面板，大部分改动即时生效；主题会先预览，点「取消」则回滚到打开时的样子。

- **外观**：浅色 / 深色 / 跟随系统，主界面字号
- **编辑器**：编辑区字号、正文字体、代码字体、行高；编辑器内 `Ctrl+滚轮` 也能缩放字号
- **文件**：插入图片时自动压缩，压缩质量可调
- **通用**：最大同时打开的标签数
- **快捷键**：按「文件 / 编辑 / 视图 / 导航」分组列出应用级命令，点键位进入录制态重新绑定；`Backspace` 清除绑定，`Esc` 只退出录制；改过的行会标出来并提供「恢复」；撞键会提示（同一优先级层只有排在前面的命令生效）

键位是单一来源：菜单右侧文案、设置面板、实际派发都读同一份命令注册表（`src/shortcuts/registry.ts`），改键不会出现「文案变了、行为没变」。编辑器内部命令（加粗、查找、插入链接等）的键位写在 ProseMirror / CodeMirror 里，在设置面板中只读展示；剪切 / 复制 / 粘贴是系统原生行为，不列入可配置项。绑定统一用 `Mod`（Windows / Linux 为 `Ctrl`，macOS 为 `⌘`）。

## 下载

前往[官网](https://jingzhonghui.github.io/Inkase/)或 [GitHub Releases](https://github.com/jingzhonghui/Inkase/releases/latest) 获取最新版本安装包。

## 技术栈

- Electron 34+
- Vue 3 + TypeScript + Pinia
- Tailwind CSS
- CodeMirror 6（源码模式）+ ProseMirror（即时渲染）
- mind-elixir（思维导图画布）
- 自托管的 [draw.io](https://www.drawio.com/) webapp（图表画布，走官方 embed 协议）
- markdown-it + Shiki + KaTeX（预览渲染与高亮）
- AI SDK（`ai` + `@ai-sdk/openai-compatible`，接任意 OpenAI 兼容接口）
- pdf.js（PDF 阅读）、mammoth（DOCX 导入）、sharp（图片压缩）、adm-zip（容器读写）、webdav（WebDAV 同步）、Prettier standalone（文档格式化）
- electron-vite

## 开发

```bash
# 安装依赖（使用 pnpm）
# 依赖装完后会自动把图表画布所需的 draw.io webapp 取到 resources/drawio
pnpm install

# 开发模式（启动前会再确认一次 draw.io webapp 是否就位）
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
pnpm run build:mac    # macOS（dmg 配置已就绪，发布流水线暂未启用）
pnpm run build:linux  # Linux
```

### 关于 `resources/drawio`

图表画布是自托管的 draw.io webapp（约 45 MB / 780 个文件），**不进 git**，但它不是「可选组件」：

- `pnpm install`（postinstall）、`pnpm run dev`、`pnpm run build` 都会自动调用 `scripts/fetch-drawio.mjs` 把它取到 `resources/drawio`，已有就跳过；
- 打包时 `electron-builder.yml` 用 `extraResources` 把它放进安装包的 `resources/drawio`，用户装完即可直接新建图表，不需要任何额外操作；
- `build/after-pack.cjs` 会在打包完成时校验产物里确实有它，缺失直接让构建失败——不会再产出一个「新建图表提示组件缺失」的安装包；
- 需要重取时：`pnpm run fetch:drawio --force`；只想确认就位情况：`pnpm run fetch:drawio --check`。版本钉在脚本常量里（当前 `1.2.1`），换版本改常量即可。

## 发布

推送 `vX.Y.Z` 格式的标签会自动触发 GitHub Actions 发布流程。

```bash
git tag v1.0.1
git push origin v1.0.1
```

流水线从构建产物里收集安装包（`dist/` 下的 exe / zip / AppImage / deb），自动创建 GitHub Release 并上传资产。macOS 打包任务目前仍被注释掉（等签名与公证就绪），因此发布包只有 Windows 与 Linux。

官网主页（`website/` 目录）在推送到 `master`、且改动命中 `website/**`（或版本号印章脚本、部署工作流本身）时自动部署到 GitHub Pages；每次 Release 成功跑完后也会经 `workflow_run` 再部署一次，用最新版本号刷新页面。

## 项目结构

```
inkase/
├── electron/            # Electron 主进程
│   ├── main.ts          # 主进程入口
│   ├── preload.ts       # 预加载脚本（contextBridge API）
│   ├── ipc/             # IPC handlers（文件/MDX/导图/PDF/同步/AI/外部改动）
│   ├── mdx/             # .mdx 读写、导入导出
│   ├── mindmap/         # .inkmind 容器读写、XMind 互转
│   ├── diagram/         # 图表协议（inkase-drawio:// 托管自托管 draw.io webapp）
│   ├── graph/           # 知识图谱扫描、断链解析与链接写入
│   ├── ai/              # AI 运行时、工具、审批
│   ├── sync/            # 同步引擎（Git / WebDAV 两个提供者）
│   ├── workspace/       # 工作区搜索（ripgrep）
│   ├── clipboard/       # 系统文件剪切板集成
│   ├── recovery.ts      # 崩溃恢复快照
│   ├── updater.ts       # 应用内更新
│   ├── window-state.ts  # 窗口尺寸/位置记忆
│   ├── instance-broker.ts # 单实例与文件关联拉起
│   └── user-guide.ts / launch-target.ts # 内置教程、命令行目标解析
├── src/                 # Vue 3 渲染进程
│   ├── components/      # 组件（编辑器/布局/侧栏/AI/导出/图谱/设置）
│   ├── stores/          # Pinia 状态（file/ai/sync/appearance/theme/graph/workspace 等）
│   ├── shortcuts/       # 快捷键注册表、覆盖值存储、派发匹配
│   ├── composables/     # 组合式函数（文件拖放、字号缩放等）
│   ├── utils/           # 工具集（markdown/ProseMirror/mindmap/diagram/graph/格式化 等）
│   └── styles/          # 主题样式（CSS 变量）
├── website/             # 官网主页（GitHub Pages）
├── shared/              # 主进程与渲染进程共享（mindmap / diagram / graph / shortcuts / sync / ai / fs）
├── resources/drawio/    # draw.io webapp（`pnpm run fetch:drawio` 生成，不入库）
├── docs/prototype/      # 界面原型（HTML）
└── scripts/             # 构建/开发辅助脚本
```

## 许可证

[Apache-2.0](LICENSE)
