# 知识图谱（链接索引 + 力导向视图）设计规格

日期：2026-10-28
状态：P1–P3 已实现，P4 收尾中
涉及版本：Inkase 0.3.7

## 1. 背景与目标

### 1.1 现状

Inkase 的文档之间已经有链接：正文里写标准 Markdown 链接 `[标题](相对路径.mdx)`，预览与即时渲染会给它加上 `class="md-link"`，`Ctrl+Click` 走 `LINK.OPEN`（`electron/ipc/file-handlers.ts`）在磁盘上解析路径并打开目标。

但这条链路是**单向且无索引**的：

- 没有反向索引——打开一篇笔记，看不到"谁引用了我"；
- 没有拓扑视图——文件树只能回答"文件在哪一层目录"，回答不了"这篇笔记处于哪个知识簇"、"哪些笔记是孤岛"、"哪些链接已经指向不存在的文件"；
- 链接解析只发生在点击的那一瞬间，失效的链接平时完全不可见。

工作区搜索（`WorkspaceSearchService`）解决的是"找关键词"，不是"看结构"。两者互补，不能互相替代。

### 1.2 目标

引入**工作区级链接索引**与**力导向图谱视图**，让"文档之间的关系"成为一等公民：

1. 一眼看到工作区的全部可索引文档及其链接拓扑；
2. 能聚焦到某篇文档的局部邻居，回答"这篇连着谁"；
3. 能把断链与孤儿笔记列出来并跳转过去，回答"哪里需要修"；
4. 能直接在图谱上新建笔记、建立链接，把发现变成动作。

### 1.3 成功标准

- 打开图谱后，工具条显示节点数、链接数、断链数、孤儿数，与实际扫描结果一致；
- 悬停节点高亮自身与一跳邻居，双击打开对应文件，单击显示信息卡（路径 / 出链数 / 入链数）；
- 局部图能只看当前文件 1–3 跳邻居，切换深度后节点集合正确变化；
- 断链与孤儿有清单，点击任一条能跳到对应文件（断链跳到来源文件）；
- 文档内容改动后重新构建图谱（含未保存的标签内容），新链接立即出现在图上；
- 图谱标签页**不进入最近文件、不写入会话恢复、关闭时不弹保存提示**；
- `pnpm typecheck` 与全量 `vitest` 通过。

## 2. 范围

### 2.1 做（本期）

- **链接来源**：只认标准 Markdown 链接（行内 `[t](href)`、尖括号 `<href>`、引用定义 `[id]: href`）。`[[双链]]` 留到二期。
- **节点集合**：工作区内 `.mdx` / `.md` / `.inkmind` / `.drawio` 四种扩展名的文件。前两种产出出链，后两种只作为链接目标（叶子节点）。
- **全局图**：整库拓扑，力导向布局。
- **局部图**：以当前文件为中心的双向 BFS 子图，深度 1–3。
- **过滤与检索**：顶层文件夹多选、扩展名多选、关键词搜索定位、断链显示开关。
- **视觉编码**：颜色按顶层文件夹、形状按文档格式、半径按入链数、虚线空心表示断链（四条编码互不重叠，见 §4.8）。
- **问题视图**：断链清单、孤儿笔记清单。
- **图上编辑**：空白处右键新建笔记；节点右键「链接到…」写入 Markdown 链接（幂等）。
- **缓存**：按 `(mtimeMs, size)` 的文件级缓存，打开图谱只重解析变动文件。

### 2.2 不做（本期明确排除）

- `[[双链]]` 语法与其输入补全、悬停预览、重命名同步；
- `#tag` 标签节点、标题级节点、块级引用（Obsidian 的 `[[note#heading]]`）；
- `.inkmind` 节点上的 `href` 作为边（导图内部链接暂不参与图谱）；
- 图谱导出 PNG / SVG；
- 多个图谱实例标签页（本期是单例：全局图与局部图共用同一标签页，用完即改模式）；
- 跨工作区 / 跨库图谱；
- 图谱上的节点拖动持久化（拖动只是临时钉住，不写盘）。

### 2.3 二期候选

`[[双链]]`、标签节点、`.inkmind` href 边、图算法视图（最短路径、社区检测）、图谱快照导出、多实例标签页。

## 3. 术语

| 术语 | 定义 |
| --- | --- |
| 节点 | 工作区内一个可索引文件；或一个**断链幽灵节点**（指向不存在文件的链接目标） |
| 边 | 从来源文档指向目标文档的关系，带 `count`（同一对文件间的链接条数） |
| 断链 | 链接的 href 无法解析到工作区内任何已索引文件 |
| 孤儿 | 度为 0 的节点（既无出链也无入链）。断链幽灵节点不算孤儿 |
| 局部图 | 以某节点为中心、按无向边 BFS 展开 N 跳得到的子图 |
| 工作区 | 当前打开的文件夹（`openedFolderPath`）。未打开文件夹则图谱不可用 |

## 4. 用户交互

### 4.1 入口

| 入口 | 行为 |
| --- | --- |
| 菜单「视图 › 知识图谱」（`Ctrl+Shift+G`） | 打开图谱标签页（已存在则激活），默认全库模式 |
| 文件树右键「显示图谱」 | 打开图谱标签页并切到局部模式，中心为所选文件 |
| 标签栏上的图谱标签 `×` | 关闭图谱标签页（不涉及任何文档，无需确认） |

图谱标签页固定在标签栏**末尾**，不可拖动排序、不可中键关闭。它是视图不是文档，因此不参与「最近文件」、不写入会话恢复的 `openFilePaths`、不触发外部文件监听。

### 4.2 全库图

| 场景 | 行为 |
| --- | --- |
| 首次打开 | 显示进度（`已扫描 N / 总数 M`），完成后自动仿真并渲染 |
| 悬停节点 | 自身与一跳邻居高亮，其余节点与边降到 18% 透明度；与焦点相连的边加粗并带方向箭头；节点数 ≤ 800 时显示标签 |
| 单击节点 | 选中，画布左下浮层信息卡显示格式、路径、出链数、入链数、「打开」按钮 |
| 双击节点 | 用 `fileStore.openFile` 打开该文件（不关闭图谱标签页） |
| 滚轮 | 以光标位置为中心缩放（`k ∈ [0.1, 4]`） |
| 空白处拖拽 | 平移视口 |
| 拖拽节点 | 临时钉住位置（`fx/fy`），双击节点释放 |
| 双击空白处 | 重置视口到「适应内容」 |
| 单击空白处 | 清除选中 |
| 仿真静止 | `alpha < 0.001` 后停止 rAF，不再重绘，直到有交互 |

### 4.3 局部图

- 侧栏「视图」分段的模式切换：`全库 ⇄ 局部`；
- 取消选中节点后切局部模式时，中心取当前激活标签的文件；没有激活文件则退回全库；
- 深度滑块 1–3 跳，改动后立即重算子图（不重新扫描磁盘）；
- 局部模式下，图外节点在信息卡里以「N 个邻居未显示」提示，可点「扩展到全库」一键切换。

### 4.4 过滤与检索

全部集中在左侧栏，**不做静默截断**（目录再多也在这栏里滚动看全）：

- **目录**：取所有节点的顶层目录（根目录文档记为「根目录」），每行带该目录的色条与节点数，多选，默认全选，「全部目录」一键还原；
- **类型**：按**形状**分三组——文档（`.mdx` `.md`）、导图（`.inkmind`）、图表（`.drawio`）——一次开关一组格式；每行都写出该组的全部后缀，并带该组的节点数；
- **断链目标**：一行开关，控制幽灵节点是否进图，行尾给出当前幽灵节点数；
- **搜索框**：在页头，输入即过滤，命中节点保持彩色、其余变暗；`Enter` 选中并居中最靠前的命中；
- 页脚在筛选生效时出现「重置筛选」；被筛空时画布给空态与重置入口，而不是留一块白板；
- 过滤只影响**渲染集合**，不重跑仿真——保留节点位置，避免每次筛选都重排（这是体验上最关键的一条）。

### 4.5 问题清单

侧栏「质量」分组的「断链」「孤儿」两行打开抽屉，并直接停在对应分区：

- **断链**：每行显示「来源文件名 › 目标原文（行号）」，点击打开来源文件；
- **孤儿**：每行显示文件名与所在目录，点击打开；
- 两个清单都可一键「在图中高亮」；
- 数量为 0 时显示正向空态（「没有断链」），不隐藏该分区。

### 4.6 图上编辑

| 操作 | 行为 |
| --- | --- |
| 空白处右键 ›「新建笔记」 | 输入文件名 → 在工作区根创建 `.mdx` → 打开该文件 |
| 节点右键 ›「链接到…」 | 弹出目标选择器（模糊搜索文件名）→ 在源文档末尾追加链接 → 就地更新图谱 |
| 节点右键 ›「打开」 | 同双击 |
| 节点右键 ›「复制路径」 | 复制工作区相对路径 |

写入规则：

- 目标位置为文档末尾的 `## 相关笔记` 小节；小节不存在则先创建（前置一个空行）；
- 条目格式 `- [目标标题](相对路径)`，**该相对路径以源文档所在目录为基准**（与 §5.4 第 4 步的解析规则互为逆运算，保证写进去的链接一定解析得回来）；
- 路径**只转义会破坏语法的字符**，其余保持原文：空格 → `%20`、`%` → `%25`、`#` → `%23`、`?` → `%3F`、`<` → `%3C`、`>` → `%3E`。**中文与 `()` 等常规字符不转码**——`encodeURI` 会把整个路径变成 `%E7%AC%94%E8%AE%B0/...`，源码模式与 diff 里几乎不可读；markdown-it 认非 ASCII，只不认裸空格。写进去的链接仍能被 §5.4 的 `decodeURIComponent` 原样解回（两者互为逆运算，`shared/graph/link-resolve.ts` 的 `encodeLinkTarget` 一处实现，缓冲区与写盘两条路径共用）；
- 已存在同目标链接则**跳过**，保证幂等；
- **源文件若已在标签页打开，只修改 `tab.content` 并标记为已修改**，由用户正常保存；绝不直接落盘，避免与编辑器缓冲区打架；
- 源文件未打开时才走 IPC 读改写：`.md` 直写；`.mdx` 用 `openMdx` → 改 `document.content` → `prepareAssetsData` → `saveMdx` 原子重打包。

### 4.7 空态与异常态

| 状态 | 展示 |
| --- | --- |
| 未打开文件夹 | 「先打开一个文件夹，知识图谱以工作区为范围」+ 打开文件夹按钮 |
| 索引中 | 进度条 + 已扫描/总数 |
| 工作区无可索引文档 | 「这个工作区里还没有 .mdx / .md 文档」+ 新建笔记按钮 |
| 索引超限 | 图谱正常显示，页头挂一个「已截断」标记，悬停给出「已扫描至上限 5000 个文件，结果不完整」 |
| 构建失败 | 错误信息 + 重试按钮 |
| 筛选后为空 | 「当前筛选下没有可显示的节点」+ 重置筛选按钮 |

### 4.8 界面结构

界面分三层，各管一件事，**同一份信息只出现一次**：

```
┌──────────────────────────────────────────────────────┐
│ ▤ 知识图谱   [搜索…]            节点 42 · 链接 57   ⟳ │  页头：做事
├────────────────┬─────────────────────────────────────┤
│ 视图  全库|局部 │                                     │
│ 目录       15  │                                     │
│  ▎全部目录     │              ●──────◆               │
│  ▎根目录   12  │             ╱        ╲              │  侧栏：看什么
│  ▎notes    34  │            ●          ■            │  画布：只看画面
│ 类型           │             ╲        ╱              │
│  ● 文档    28  │              ●──────●               │
│  ◆ 导图     3  │                                     │
│ 质量  断链 2 › │   ┌────────────────┐                │
│       孤儿 5 › │   │ b   docs/b.md  │  选中信息卡     │
└────────────────┴───└────────────────┘────────────────┘
```

**四条视觉编码**（`render.ts` / `colors.ts` / `shape.ts`）：

| 通道 | 含义 | 备注 |
| --- | --- | --- |
| 颜色 | 顶层目录 | 饱和度压在 45% 上下；描边低明度、填充中高明度，小圆点也有边界 |
| 形状 | 文档格式 | 圆点＝正文（`.mdx`/`.md`）、菱形＝导图、方形＝图表；断链幽灵固定圆点虚线 |
| 半径 | 入链数 | `3 + 2 * sqrt(inDegree)`，上限 14 |
| 虚线空心 | 断链 | 与形状正交，因此幽灵节点不参与格式编码 |

**为什么形状是必需的那一条**：颜色与半径都被占满之后，四种格式原本在画布上没有任何视觉表达——一篇导图和一篇笔记长得完全一样。形状是唯一还剩的通道，且在小尺寸下就可辨。`.mdx` 与 `.md` 刻意合并成同一形状：二者都是正文文档，差别只在容器，多造一个符号只会增加学习成本。

**上一版的两处具体问题**（已随本节重设计修掉）：

1. 顶部工具条把 12 组控件平铺在同一行（模式、中心名、深度、4 个统计、搜索、4 个格式 chip、目录 chip、断链开关、问题、刷新），全都是同一款细边框按钮，换行后成了两排碎片——没有层级就没有焦点；
2. 目录名在工具条 chip（`slice(0, 8)`，**无任何提示**）与底部图例（`slice(0, 12)`，带 `+N`）各出现一次，两处截断长度还不一致，看起来像没做完。

## 5. 技术设计

### 5.1 分层

```
主进程 electron/graph/
  scanner.ts     列文件、读内容、mtime 缓存
  service.ts     编排 + 进度 + 限额
  link-write.ts  追加链接（.md 直写 / .mdx 重打包）
  handlers.ts    IPC 注册

共享纯函数 shared/graph/   ← 主进程与渲染层共用，无 fs、无 DOM
  types.ts       数据模型
  link-extract.ts  从 Markdown 抽链接
  link-resolve.ts  href → 工作区相对路径
  build.ts        FileLinkRecord[] → GraphPayload
  local.ts        BFS 子图
  colors.ts       文件夹 → 稳定色相

渲染层
  src/stores/graph.ts                标签页状态 + 索引数据 + 过滤/选中
  src/components/graph/GraphView.vue 容器（工具条 + 画布 + 抽屉）
  src/components/graph/GraphCanvas.vue 画布与交互
  src/utils/graph/simulation.ts      自研力导向（网格近似，非 d3-force）
  src/utils/graph/render.ts          Canvas 2D 绘制
  src/utils/graph/viewport.ts        平移缩放变换
```

**为什么抽取/解析/构建放 `shared/`**：渲染层必须对「已打开且未保存」的标签用**同一套规则**重算出链（见 §5.9），否则刚写完的链接在图谱里看不见。放共享层还顺带把 `LINK.OPEN` 的路径解析逻辑收敛成单一来源——目前它内联在 `file-handlers.ts` 的 handler 里，是重复实现的隐患。

**为什么索引在主进程**：需要 fs 访问、`adm-zip` 解包（`.mdx` 不能当文本读）、并发与超时控制；渲染层只拿结构化结果。

### 5.2 数据模型

```ts
// shared/graph/types.ts
export type GraphNodeFormat = 'mdx' | 'markdown' | 'mindmap' | 'diagram' | 'attachment'

export interface GraphNode {
  /** 节点标识：工作区相对 POSIX 路径；Windows 下大小写折叠。断链节点为 `!<规范化目标>` */
  id: string
  /** 真实相对路径（POSIX）；断链节点为 null */
  path: string | null
  /** 展示名：文档去扩展名；附件保留扩展名；断链节点为链接原文 */
  label: string
  format: GraphNodeFormat
  /** 顶层目录名；根目录文档为 '' */
  folder: string
  inDegree: number
  outDegree: number
  /** 是否为断链幽灵节点 */
  unresolved: boolean
}

export interface GraphEdge {
  source: string
  target: string
  /** 同一对文件之间的链接条数（>= 1），用于边权重与视觉区分 */
  count: number
  /** 目标未解析（指向幽灵节点） */
  unresolved: boolean
}

export interface GraphStats {
  /**
   * 节点总数，**包含断链幽灵节点**（恒等于 `nodes.length`）。
   * 工具条上「节点」与「断链」因此会有视觉重叠：断链节点既是 `nodes` 里的一员，
   * 也被 `unresolvedCount` 单独计数。这是刻意的——图上的圆点数必须与节点数一致。
   */
  nodeCount: number
  edgeCount: number
  unresolvedCount: number
  orphanCount: number
  filesScanned: number
  elapsedMs: number
  /**
   * 是否因限额（5000 文件）或 20s 总时限截断。
   *
   * 截断时**孤儿数可能虚高**：未扫描到的文件不入图，指向它们的入边全部缺失，
   * 被截掉的文件本该连着的节点就会退化成「度为 0」。这是已知降级，靠
   * `warnings` 与工具条的「已截断」标记提示，不追求数字精确。
   */
  truncated: boolean
}

export interface GraphPayload {
  root: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
  warnings: string[]
}

/** 单文件出链记录的中间态 */
export interface FileLinkRecord {
  path: string
  format: GraphNodeFormat
  links: RawLink[]
}

export interface RawLink {
  /** 原始 href（未解码） */
  href: string
  /** 正文行号（1 起），供问题清单跳转 */
  line: number
}
```

自环（文件链接到自己）不计入边，但保留在 `RawLink` 里以便统计。

### 5.3 链接抽取规则

`extractLinks(markdown: string): RawLink[]`，纯函数，逐条对齐以下规则：

**扫描前必须剥离**（否则代码示例会被误判成链接）：

1. 围栏代码块：以三个反引号或三个波浪线开启的围栏，到「同字符、长度不少于开启串」的围栏结束；未闭合则吞到文末；
2. 行内代码：单反引号包裹，以及用更多反引号包裹、内容本身含反引号的形式；
3. HTML 注释：`<!-- ... -->`；
4. 图片语法：`![alt](src)` —— 图片是资源不是文档，且它的 `src` 常是 `assets/images/...`。

剥离采用「同长度空白替换」而不是删除，保证**行号与列偏移不变**，问题清单里的行号才准确。

**识别三种写法**：

- 行内链接：`[text](href)` 与 `[text](<href with space>)`，可选尾随 `"title"` 或 `'title'`；
- 尖括号自动链接：`<href>`（`linkify` 产出的 http 链接也走这里，靠后续解析排除）；
- 引用定义：行首 `[id]: href`。

**排除**：

- 纯锚点 `#section`（同文件内跳转，不是边）；
- 外链（`http://`、`https://`、`mailto:`、`tel:` 等非文件协议）；
- 目标扩展名不在 `{.mdx,.md,.inkmind,.drawio}` 内（图片、PDF 附件、`.inkmind` 资源等）；
- 解析后越出工作区边界的路径（记为 `ignore: escape`，**不算断链**，见 §5.4）。

**限额**：单文件最多抽取 2000 条链接，超出截断并在 `warnings` 记一条（防止自动生成的巨型索引页拖垮图谱）。

### 5.4 链接解析规则

`resolveLink(href, fromPath, index): Resolution`，必须与现有 `Ctrl+Click` 语义**完全一致**，否则会出现「图谱说断了、点一下却能打开」的矛盾。

解析顺序：

1. 去掉 fragment（`#...`）与 query（`?...`）；
2. `decodeURIComponent`（失败则用原串）；
3. `file://` → 取路径部分；
4. 相对 `fromPath` 所在目录解析；绝对路径直接用；
5. 解析后必须在工作区根内，越界记 `ignore`（`reason: 'escape'`）：越界不等于「文件不存在」，库外那个路径可能真的存在，把它报成断链会误伤；因此**不生成幽灵节点、不计入 `unresolvedCount`、不进断链清单**；
6. 无扩展名时依次尝试 `+.mdx`、`+.md`；
7. 精确命中 → 若目标在索引内则成边；文件存在但不在索引内（因 §6 限额被跳过）记 `ignore`，**不算断链**——断链只描述"文件真的不存在"；
8. 目标扩展名不在白名单（图片、PDF、脚本…）→ 若该文件在工作区里真实存在，返回 `attachment`，由构建期补一个叶子节点（见 §5.10）；不存在则记 `ignore`，**也不报断链**（点开头目录、`.gitignore` 这类被遍历排除的目标会变成误报，不拿准确性换覆盖率）；
9. 未命中 → **basename 兜底**：在工作区文件名索引里按不区分大小写查找同名文件（对齐 `LINK.OPEN` 的 `searchFileInDir` 行为）；唯一命中则成边，多个命中取路径最短者在 `warnings` 记一条歧义提示，仍无命中才记为断链。

结果类型：

```ts
export type Resolution =
  | { kind: 'edge'; targetId: string }
  | { kind: 'attachment'; targetId: string; targetPath: string }
  | { kind: 'unresolved'; ghostId: string; display: string }
  | { kind: 'ignore'; reason: 'external' | 'anchor' | 'not-indexed' | 'escape' }
```

断链幽灵节点的 `id` 为 `!${normalizedTarget}`，`label` 取链接原文——同一个失效目标被多处引用时合并成一个节点，这对「哪些断链最该修」的观感很重要。

### 5.5 索引构建与缓存

**列文件**：`rg --files --null --no-config`，固定 `--glob '!.git/**'`、`'!node_modules/**'`、`'!.inkase/**'`，在进程内按扩展名白名单过滤。rg 不可用时回退 `fs.readdir` 递归（同样的排除规则）。复用 `rg-resolver.ts` 的定位逻辑。

遍历时**同时**记一份非文档文件的路径（任意扩展名，只记路径不读内容，上限 5 万条）。它不是索引的一部分，只用来回答「这条链接的目标是不是一个真实文件」，见 §5.10。

**读内容**：

- `.mdx`：`adm-zip` 只解 `content.md`，沿用 `mdx-content-search.ts` 的限额（原文件 50MB / 解压后 10MB / 条目数 1000 / 压缩比 100），防解压炸弹；
- `.md`：直读 UTF-8，`rejectBinary` 拒绝二进制；
- `.inkmind` / `.drawio`：只登记为节点，不读内容。

**缓存**：主进程内按工作区根维护

```ts
type FileCache = Map<string, { mtimeMs: number; size: number; links: RawLink[] }>
```

重建时对每个文件 `stat`，`(mtimeMs, size)` 未变则复用 `links`，只重解析变动文件；删除的文件从缓存剔除；切换工作区根时整体清空。

**并发与限额**：`concurrency = 4`；单次构建总时限 20s；文件上限 5000；超限置 `stats.truncated = true` 并给 warning。

**进度**：每处理 200 个文件向渲染层发一次 `graph:progress { scanned, total }`。

### 5.6 IPC 契约

`electron/ipc/channels.ts` 新增：

```ts
GRAPH: {
  BUILD: 'graph:build',                // invoke(root) → { success, data: GraphPayload, error? }
  PROGRESS: 'graph:progress',          // webContents.send → { scanned, total }
  REFRESH_FILE: 'graph:refreshFile',   // invoke(root, relPath) → 单文件重算出链
  CREATE_LINK: 'graph:createLink'      // invoke({ root, from, to }) → { success, data: { line }, error? }
}
```

沿用既有约定：handler 统一返回 `{ success, data?, error? }`；通道常量集中在 `channels.ts`；`preload.ts` 暴露 `buildGraph / onGraphProgress / refreshGraphFile / createGraphLink`。

`CREATE_LINK` 必须做路径校验：`from` / `to` 都必须是工作区内的相对路径，`realpath` 不得越界（复用 `isPathWithinRoot`）。

### 5.7 渲染层：虚拟标签页

**不碰 `TabInfo`**。图谱是视图，不是文档。照抄 AI 面板的「合成标签」模式：

1. `src/stores/graph.ts` 维护 `panelOpen` / `panelActive` / `mode` / `payload` / `loading` / `progress` / `error` / `filters` / `selection`；
2. `src/utils/tab-order.ts` 的 `buildBarItems` 增加可选的第 4 个参数 `extra: BarItem[]`，把图谱项**追加在末尾**（AI 项仍在 `aiTabIndex` 位置）。既有调用（`TabBar.vue`、`AppHeader.vue`）各加一个实参即可，`ai-tab.test.ts` 的断言不受影响；
3. `TabBar.vue` 渲染 `kind === 'graph'` 的项：图标 + 「知识图谱」标题 + 关闭按钮；拖拽排序时忽略该类项（固定末尾）；
4. `EditorPanel.vue` 增加分支：`<GraphView v-if="graphStore.panelOpen" v-show="graphStore.panelActive" />`，并把欢迎页与 `document-view` 的 `v-show` 条件补上 `&& !graphStore.panelActive`；
5. 激活图谱时调 `aiStore.deactivatePanel()`，激活文件标签时调 `graphStore.deactivatePanel()`，保证三个面板互斥。

**为什么不做成真实 document tab**：`fileStore.tabs` 里放一个没有 `fileInfo.path` 的项，会连带污染 `persistSession`（`openFilePaths` 会 filter 掉，看似安全）、恢复快照、`findTabByPath`、外部监听、AI 的文档上下文等一系列假设"tab 即文件"的路径。合成标签把这些风险全部绕开。

### 5.8 渲染层：画布与仿真

依赖**零新增**：仿真用自研实现（`src/utils/graph/simulation.ts`），只做数值计算、不碰 DOM。
原因与图算法无关——这个项目没有网络安装窗口，少一个依赖就少一个「装完才能跑」的门槛。
斥力走**网格近似**（远格按质心、近格逐个算），2000 节点也不会退化成 O(n²)；初位置由节点 `id` 哈希决定，
同一份数据每次打开都是同一个形状。对外接口（`reheat` / `pin` / `release` / `stop` / `positions` / `onTick` 等）
刻意对齐 d3 的用法：将来若要换回 `d3-force`（+ `@types/d3-force`），只改这一个文件即可，其余代码无需改动。

```ts
// src/utils/graph/simulation.ts
export interface GraphSimulation {
  positions: Map<string, { x: number; y: number; vx: number; vy: number; fx?: number | null; fy?: number | null }>
  reheat(alpha?: number): void
  pin(id: string, x: number, y: number): void
  release(id: string): void
  stop(): void
  onTick(cb: () => void): void
  onSettle(cb: () => void): void
}
export function createSimulation(nodes: GraphNode[], edges: GraphEdge[]): GraphSimulation
```

力学参数：

- `forceLink(distance = 60, strength = 0.1)`，按 `count` 提升强度上限到 0.5；
- `forceManyBody(strength = -120, theta = 0.9, distanceMax = 600)`（自研网格近似替代 Barnes-Hut）；
- `forceCenter` 视口中心；`forceCollide(radius + 2)`，节点数 > 1500 时**不注册**碰撞力；
- `alphaMin = 0.001`，`alphaDecay = 0.0228`（约 300 tick 收敛）。

初始位置由节点 `id` 哈希决定（角度 + 半径），保证同一份数据每次打开布局稳定、不会"每次都换个形状"；已存在节点在重建后保留旧坐标，只对新增节点播种。

渲染（`render.ts`）每帧只做一次 `clearRect` + 一次点阵底 + 一次边批处理 + 一次节点批处理：

- 背景：世界坐标 28px 点阵，随平移取模平铺；屏幕间距不足 15px 时把间距翻倍（否则点会连成灰雾）。没有空间参照的画布看起来像一块白板；
- 边：`count === 1` 用 1px、`>= 2` 用 1.5px；断链边虚线；与焦点（hover 优先于选中）相连的边加粗到 0.92 不透明度，并在目标端画一个 chevron 箭头。方向只在焦点那一簇出现——2000 条边全挂箭头会糊成一片；
- 节点：半径 `3 + 2 * Math.sqrt(inDegree)`，上限 14；颜色由 `colors.ts` 按顶层文件夹稳定映射（hash → hue，饱和度/明度随主题切换）；形状由 `shape.ts` 按格式决定（圆 / 菱形 / 方 / 三角，见 §4.8）；
- 断链节点：红色空心 + 虚线描边，固定圆点形状，`label` 显示原文；
- 标签：焦点（hover/命中/选中）与断链节点永远画；其余在 `k >= 0.9 && 屏幕半径 >= 5` 或 `k >= 1.7` 时画——原来的「`k >= 0.8` 就全铺」在几百节点的图上会糊满；
- 标签避让：按 72px 空间哈希分桶判重叠，焦点标签优先且不可被挤掉，重叠的次要标签直接放弃；底衬用圆角矩形而非硬边白块；
- 字体层级不靠换字体（离线 Electron 不引入网络字体），靠字号与字重：焦点标签 `600 12px`，其余 `500 11px`；
- 节点数 > 800 时不画标签；
- DPR：`canvas.width = cssWidth * devicePixelRatio`，绘制前 `setTransform`；
- 尺寸变化用 `ResizeObserver`，不监听 window resize。

命中测试用线性扫描（2000 个节点每次 `mousemove` 遍历一次，开销可忽略），不引入四叉树。

### 5.9 脏标签覆盖

索引读的是磁盘，但用户可能刚在编辑器里写完一条链接还没保存。处理方式：

1. 渲染层拿到 `GraphPayload` 后，遍历 `fileStore.tabs`，挑出 `fileInfo.modified === true` 且 `format` 为 `mdx` / `markdown` 的标签；
2. 用 `shared/graph/link-extract.ts` 对 `tab.content` 重算出链；
3. 用 `shared/graph/link-resolve.ts` 解析（目标集合来自 payload 的节点索引）；
4. 在内存里替换该节点的出边，重算 `inDegree/outDegree` 与孤儿集合。

这套覆盖也用在「新建笔记」与「建立链接」之后——无需整库重建，也不必等用户保存。

### 5.10 非文档文件：只收被链接到的

图谱的主体是文档（`.mdx` / `.md` / `.inkmind` / `.drawio`），但现实里链接目标经常是一个脚本、一份 PDF、一张图：

```markdown
[部署说明](scripts/deploy.sh)
```

如果这些一律丢弃，链接在图上会凭空消失，用户看不出「这篇文档引用了一个脚本」。如果把工作区里所有文件都收进来，`assets/` 里成百上千张图立刻会把文档簇淹没——而且它们之间没有任何引用关系。

**规则：只有被链接到、且在磁盘上真实存在的非文档文件才成为叶子节点。**

- 遍历阶段只记路径，**不读内容**，所以附件节点永远没有出链（`outDegree` 恒为 0），也不参与脏标签覆盖；
- 白名单不变（`GRAPH_EXTENSION_FORMATS` 仍然只有四种）。附件不是"第五种被索引的格式"，它由 `kind: 'attachment'` 的解析结果在构建期按需补出来；
- `label` 保留扩展名（`deploy.sh` 而不是 `deploy`）：文档去扩展名是因为「同名不同类型的文档」很少见，而 `deploy.sh` 与 `deploy.txt` 必须能区分；
- 视觉上给**三角**（§4.8），与圆点（正文）、菱形（导图）、方形（图表）并列——点开前就能看出这不是一篇能被编辑的文档；
- 链接目标**不存在**时仍按 `ignore` 处理，不报断链：`.gitignore`、`.github/**` 这类点开头的目标本来就被遍历排除，把它们报成断链是系统性误报。

`GraphResolutionContext.attachmentPaths` 随 payload 回到渲染层，因此脏标签重算（§5.9）能得出与主进程完全一致的结论。

### 5.11 链接写入

```ts
// electron/graph/link-write.ts
export async function appendLinkToFile(
  absPath: string,
  targetAbsPath: string,
  targetTitle: string
): Promise<{ line: number }>
```

- 归一化：把正文按 `\n` 切分，找到最后一个 `## 相关笔记` 标题；不存在则追加 `\n\n## 相关笔记\n`；
- 在该小节末尾（下一个同级或更高级标题之前）插入 `- [title](encoded)`；
- 幂等：小节内已存在指向同一目标（解析后比较）的条目则直接返回其行号；
- `.md`：`atomicWrite`（先写 `.tmp` 再 rename）；
- `.mdx`：`openMdx` → 改 `document.content` → `prepareAssetsData(tempDir, document)` → `saveMdx(abs, document, assets)` → `cleanupTempDir(tempDir)`。

**并发保护**：写入前若该文件正处于打开状态（由渲染层判断并转成「只改缓冲区」分支），绝不进入此函数；主进程再兜底检查一次文件 `mtime` 是否在读取后变化，变化则放弃并报错，避免覆盖用户同时进行的保存。

## 6. 限额、性能与降级

| 项 | 值 | 超限行为 |
| --- | --- | --- |
| 索引文件数 | 5000 | 截断 + warning，`stats.truncated = true` |
| 单文件大小（原） | 50 MB | 跳过该文件 + warning |
| `.mdx` 解压后正文 | 10 MB | 跳过该文件 + warning |
| 单文件链接数 | 2000 | 截断 + warning |
| 构建总时长 | 20 s | 返回已构建部分 + warning |
| 并发解析 | 4 | — |
| 渲染节点上限 | 6000（含断链幽灵节点） | 超出部分不绘制，按度数降序保留高连接节点，并给 warning |

其他：

- 画布在 `alpha < 0.001` 后停止 rAF，静止时不耗电；
- 过滤不重跑仿真，只改渲染集合；
- `GraphView` 用 `defineAsyncComponent` 懒加载，仿真与绘制代码不进首屏包（与 `MindMapEditor` / `DiagramEditor` 一致）。

## 7. 错误处理

| 场景 | 行为 |
| --- | --- |
| rg 不可用 | 回退 `fs` 递归；仍失败则报「搜索组件不可用」 |
| 单个文件读取失败 | 记入 `warnings`，跳过该文件，不中断整体构建 |
| `.mdx` 损坏 | 同上，`warnings` 里带文件名 |
| 构建被取消（切换文件夹） | 返回 `{ success: false, error: '已取消' }`，渲染层静默忽略 |
| 写入链接失败 | 对话框提示具体错误，图谱数据不做乐观更新 |
| 写入时文件已被外部修改 | 放弃写入，提示「文件已被其他程序修改，请重新加载后再试」 |

## 8. 测试策略

**共享纯函数（重点，全部为纯单测）**

- `link-extract`：围栏代码块（含未闭合）、行内代码、多反引号、HTML 注释、图片、中文链接文字、尖括号带空格、`"title"`、引用定义、行号准确性、单文件 2000 条截断；
- `link-resolve`：相对路径、`../` 上跳、绝对路径、无扩展名补全、`file://`、fragment/query 剥离、`decodeURIComponent`、越界、非白名单扩展名、basename 兜底、同名歧义、断链幽灵合并；
- `build`：边去重与 `count` 累加、自环忽略、`inDegree/outDegree` 正确、孤儿判定、断链不计入孤儿；
- `local`：深度 1/2/3、双向邻居、孤立中心节点、深度超界剪枝；
- `colors`：同一顶层目录颜色稳定、不同目录不同、根目录有专门色。

**主进程**

- `scanner`：mtime 命中不重读（用 spy 断言解压次数）、文件删除后缓存剔除、超限降级、`.mdx` 解包限额；
- `service`：进度事件次数、取消信号、warnings 聚合；
- `link-write`：新建小节、已有小节追加、幂等跳过、`.md` 原子写、`.mdx` 重打包后正文与资源都完整、mtime 冲突放弃。

**渲染层**

- `graph store`：打开/关闭/激活互斥、模式切换、过滤后可见集合；
- `GraphView`：空态（未打开文件夹）、加载态、错误态、页头计数、侧栏筛选（目录/类型/断链）、问题清单入口；
- `render`（渲染契约）：用记录型 2D 上下文断言指令序列——点阵画了且最密不低于 15px、三种形状各自走对路径、标签按渐进披露与避让规则出现、焦点边多画一个箭头。像素级差异在 code review 里看不出来，只能靠指令序列兜住；
- `tab-order`：图谱项固定在末尾，`ai-tab.test.ts` 既有断言全部保持通过。

**手动验收清单**（PR 描述里逐条打勾）：打开含 50+ 文档的工作区 → 打开图谱 → 悬停/双击/缩放/拖拽 → 切局部图 → 搜索 → 关断链显示 → 建链接 → 保存 → 刷新图谱确认新边。

## 9. 实施计划

### P1 索引 + 全局图（约 2 天）

`shared/graph/{types,link-extract,link-resolve,build,colors}.ts` + 单测 →
`electron/graph/{scanner,service,handlers}.ts` + `channels/preload` 接线 →
`src/stores/graph.ts` + `GraphView/GraphCanvas` + `simulation/render/viewport` →
`TabBar/EditorPanel/AppHeader` 接线（菜单项、快捷键、`buildBarItems` 扩展）。

### P2 局部图 + 问题清单 + 新建笔记（约 1.5 天）

`shared/graph/local.ts` + 单测 → 模式切换与深度滑块 → 断链/孤儿抽屉 → 右键新建笔记 → 脏标签覆盖（§5.9）。

### P3 图上建链接（约 1 天）

目标选择器 → `electron/graph/link-write.ts` + `CREATE_LINK` handler + 单测 → 幂等与冲突分支 → 写入后就地刷新该节点出边。

### P4 打磨（约 1 天）

空态/加载态/错误态、主题适配（浅色/深色配色各一套）、大工作区性能验证（造 3000 节点）、`electron/user-guide.ts` 与快捷键速查表补条目、类型检查与全量测试。

合计约 **5.5 人日**。

### 文件清单

| 路径 | 新增/修改 | 说明 |
| --- | --- | --- |
| `shared/graph/types.ts` | 新增 | 数据模型 |
| `shared/graph/link-extract.ts` | 新增 | Markdown 抽链接 |
| `shared/graph/link-resolve.ts` | 新增 | 路径解析（与 `LINK.OPEN` 同语义） |
| `shared/graph/build.ts` | 新增 | 记录 → `GraphPayload` |
| `shared/graph/local.ts` | 新增 | BFS 子图 |
| `shared/graph/colors.ts` | 新增 | 文件夹配色 |
| `shared/graph/__tests__/*.test.ts` | 新增 | 纯函数单测 |
| `electron/graph/scanner.ts` | 新增 | 列文件 + 读内容 + 缓存 |
| `electron/graph/service.ts` | 新增 | 编排与进度 |
| `electron/graph/link-write.ts` | 新增 | 追加链接 |
| `electron/graph/handlers.ts` | 新增 | IPC 注册 |
| `electron/graph/__tests__/*.test.ts` | 新增 | 扫描/写入测试 |
| `electron/ipc/channels.ts` | 修改 | 新增 `GRAPH` 段 |
| `electron/preload.ts` | 修改 | 暴露 4 个 API 与类型 |
| `electron/main.ts` | 修改 | 注册图谱 handler |
| `src/stores/graph.ts` | 新增 | 视图状态 |
| `src/components/graph/GraphView.vue` | 新增 | 容器：页头 + 侧栏 + 画布 + 抽屉（§4.8 重设计） |
| `src/components/graph/GraphSidebar.vue` | 新增 | 左侧栏：视图/目录/类型/质量，图例与过滤器合一 |
| `src/components/graph/GraphCanvas.vue` | 新增 | 画布交互 |
| `src/components/graph/GraphIssues.vue` | 新增 | 断链/孤儿清单（`section` 受控，侧栏可直接开对应分区） |
| `src/utils/graph/shape.ts` | 新增 | 格式 → 形状编码 + 侧栏类型分组 |
| `src/utils/graph/simulation.ts` | 新增 | 自研力导向（网格近似，接口对齐 d3 用法） |
| `src/utils/graph/render.ts` | 新增 | Canvas 绘制（点阵底 / 形状 / 渐进披露标签 / 焦点箭头） |
| `src/utils/graph/viewport.ts` | 新增 | 变换与命中测试 |
| `src/utils/tab-order.ts` | 修改 | `buildBarItems` 增加 `extra` 参数 |
| `src/components/editor/TabBar.vue` | 修改 | 渲染图谱标签项 |
| `src/components/editor/EditorPanel.vue` | 修改 | 挂载 `GraphView`、互斥 `v-show` |
| `src/components/layout/AppHeader.vue` | 修改 | 视图菜单项、快捷键、`buildBarItems` 实参 |
| `src/types/electron.d.ts` | 未修改 | 它只从 `electron/preload.ts` 再导出 `ElectronAPI`，新增 API 的类型随 preload 自动生效 |
| `scripts/build-guide.py` | 修改 | 内置教程「知识图谱」章节与快捷键表条目（该脚本与截图本地保留、不入库） |
| `resources/Inkase 使用教程.pdf` | **待重建** | 教程正文补了章节，但重建需要本地截图 `scripts/guide-images/`（未入库），当前仓库内 PDF 仍是旧版 |
| `README.md` | 修改 | 能力列表与「知识图谱」使用段落 |
| `package.json` | 未修改 | 自研仿真实现，**没有**引入 `d3-force` |

## 10. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 大工作区首次建索引慢 | 打开图谱要等 | mtime 缓存 + 进度条 + 20s 时限降级；首次结果可接受即可 |
| `.mdx` 逐包解压开销 | 1000 个文档约 1–3 s | 只解 `content.md`；缓存命中后不再解压；并发 4 |
| 力导向在 2000+ 节点抖动 | 观感差、占 CPU | 关碰撞力、关标签、`alphaMin` 收敛后停 rAF |
| 链接解析与 `Ctrl+Click` 不一致 | 用户信任崩塌 | 解析逻辑抽到 `shared/`，两边同源；单测覆盖 `LINK.OPEN` 现有分支 |
| 写回链接覆盖用户并发保存 | 数据丢失 | 已打开文件只改缓冲区；未打开文件做 mtime 冲突检测后放弃 |
| 图谱标签页污染会话恢复 | 重启后出现幽灵标签 | 合成标签不进 `fileStore.tabs`，从根上避免 |
| Windows 路径大小写导致节点重复 | 同一文件两个节点 | 节点 `id` 在 Windows 下大小写折叠，`path` 保留原写法 |

## 11. 二期

1. `[[双链]]`：语法 + CodeMirror/ProseMirror 补全 + 未创建笔记的虚节点点击即建；
2. 标签 `#tag` 作为节点与筛选维度；
3. `.inkmind` 节点 `href` 参与边（导图内部引用也能进图谱）；
4. 图算法：最短路径、社区检测着色、PageRank 缩放；
5. 图谱快照导出 PNG/SVG；
6. 多实例图谱标签页（全局图与局部图并排）。
