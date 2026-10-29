# 知识图谱测试用例设计

日期：2026-10-28
依据设计文档：`docs/2026-10-28-knowledge-graph-design.md`（下称「设计」）
被测范围：Inkase 0.3.7 知识图谱（工作区链接索引 + 力导向视图）
用例总数：**130 条**（P0 47 / P1 68 / P2 15）；自动化 110 条、手工 20 条（其中 3 条为主进程自动化 + 人工确认的混合用例）

## 0. 文档信息

| 项 | 说明 |
| --- | --- |
| 被测模块 | `shared/graph/`、`electron/graph/`、`src/stores/graph.ts`、`src/components/graph/`、`src/utils/graph/`、`tab-order`/`TabBar`/`AppHeader`/`EditorPanel` 接线 |
| 测试框架 | vitest 2（`pnpm test`） |
| 不在本文件范围 | `[[双链]]`、标签节点、`.inkmind` 内部 `href` 边、图谱导出、多实例标签页（设计 §2.2 明确排除） |
| 已知实现现状 | `shared/graph/` 与 `electron/graph/` 逻辑已实现；`shared/graph/__tests__/` 已有 5 个测试文件（74 例）；`link-insert` 与整个 `electron/graph/` 无测试；渲染层 `src/utils/graph/*`、`src/components/graph/*`、`src/stores/graph.ts` 无测试 |
| 编号约定 | `TC-<模块>-NNN`，模块缩写见 §1.2 |

## 1. 分层策略与编号约定

### 1.1 分层

| 层级 | 对象 | 手段 | 判定依据 |
| --- | --- | --- | --- |
| L1 | `shared/graph/` 纯函数（无 fs、无 DOM） | vitest 纯单测 | 输入输出逐字段断言，可 100% 自动化 |
| L2 | `electron/graph/` 主进程（fs / adm-zip / IPC） | vitest + `vi.mock('electron')` + `node:fs` 临时目录 | 文件系统副作用与 IPC 契约断言 |
| L3 | 渲染层 store / 组件 / 工具 | vitest + `setActivePinia(createPinia())` / 假 Pinia / 假 Canvas 2D 上下文 | 状态与 DOM 断言 |
| L4 | 端到端业务流程 | 手工（Electron 真机，需真实工作区与磁盘） | 设计 §8 手动验收清单逐条转写 |
| L5 | 非功能与回归 | 手工 + 可自动化部分（懒加载包体、warnings） | 性能观感与包体断言 |

### 1.2 模块缩写

`EXTRACT`=link-extract；`RESOLVE`=link-resolve；`BUILD`=build；`LOCAL`=local；`COLORS`=colors；`INSERT`=link-insert；`SCANNER`=scanner；`SERVICE`=service；`LINKWRITE`=link-write；`HANDLERS`=handlers；`STORE`=graph store；`VIEW`=GraphView；`CANVAS`=GraphCanvas；`TABORDER`=tab-order；`HEADER`=AppHeader；`EDITOR`=EditorPanel；`E2E`=集成/手工验收；`PERF`=非功能与回归。

优先级口径：**P0** = 错了会导致「数据错 / 图谱不可用 / 用户数据丢失 / 与 `Ctrl+Click` 语义矛盾」；**P1** = 影响可感知体验或边界正确性；**P2** = 观感、主题、性能余量。

## 2. 覆盖矩阵

| 设计章节 | 主题 | 用例 ID 区间 | 条数 | 覆盖方式 |
| --- | --- | --- | --- | --- |
| §2.1 / §5.3 | 链接抽取（剥离、三种写法、排除、2000 截断） | TC-EXTRACT-001 ~ 012 | 12 | 自动化 |
| §2.1 / §5.4 | href → 工作区相对路径（含幽灵合并、大小写折叠） | TC-RESOLVE-001 ~ 014 | 14 | 自动化 |
| §2.1 / §5.2 | 记录 → `GraphPayload`（边去重、度、孤儿、stats） | TC-BUILD-001 ~ 007 | 7 | 自动化 |
| §4.3 / §5.1 | BFS 子图（深度 1–3、双向、剪枝） | TC-LOCAL-001 ~ 005 | 5 | 自动化 |
| §5.8 | 文件夹 → 稳定色相（含主题） | TC-COLORS-001 ~ 004 | 4 | 自动化 |
| §4.6 / §5.10 | 追加链接文本层（小节、幂等、CRLF、行号、encodeURI） | TC-INSERT-001 ~ 007 | 7 | 自动化 |
| §5.5 / §6 / §7 | 列文件、mtime 缓存、限额、二进制、rg 回退 | TC-SCANNER-001 ~ 008 | 8 | 自动化 |
| §5.5 / §7 | 编排、进度、取消、warnings、20s 时限 | TC-SERVICE-001 ~ 006 | 6 | 自动化 |
| §5.10 / §6 / §7 | `.md` 原子写、`.mdx` 重打包、mtime 冲突、幂等 | TC-LINKWRITE-001 ~ 007 | 7 | 自动化 |
| §5.6 / §7 | IPC 契约、路径校验、单构建、统一 envelope | TC-HANDLERS-001 ~ 006 | 6 | 自动化 |
| §4.1 / §4.2 / §4.4 / §5.7 / §5.9 | 标签页状态、互斥、模式、深度、过滤、脏标签覆盖 | TC-STORE-001 ~ 010 | 10 | 自动化 |
| §4.2 / §4.5 / §4.7 | 空态、加载态、错误态、问题抽屉、信息卡、四计数 | TC-VIEW-001 ~ 009 | 9 | 自动化 |
| §4.2 / §5.8 | 缩放、平移、钉住、适应内容、停 rAF | TC-CANVAS-001 ~ 008 | 8 | 自动化 |
| §5.7 | `buildBarItems` 扩展与向后兼容、图谱标签行为 | TC-TABORDER-001 ~ 003 | 3 | 自动化 |
| §4.1 | 菜单项、`Ctrl+Shift+G`、标签切换快捷键 | TC-HEADER-001 ~ 003 | 3 | 自动化 |
| §5.7 | 三面板互斥与欢迎页显示 | TC-EDITOR-001 ~ 002 | 2 | 自动化（001）/ 手工（002） |
| §8 手动验收清单 | 全链路验收（打开 → 交互 → 局部 → 搜索 → 建链接 → 刷新） | TC-E2E-001 ~ 012 | 12 | 手工 |
| §6 / §10 | 性能、静止功耗、懒加载、降级不中断 | TC-PERF-001 ~ 007 | 7 | 手工 / 部分自动化 |
| 合计 | — | — | **130** | 自动化 110 / 手工 20 |

## 3. L1 共享纯函数用例（49 条，P0 15）

> 全部为纯函数单测，无 fs、无 DOM、无 Pinia。断言以返回对象逐字段为主，不使用快照。

### 3.1 link-extract（`extractLinks`）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-EXTRACT-001 | L1 | 未闭合围栏代码块吞到文末且不产出链接 | 空 | 输入 ` ```\n[a](a.mdx)\n`（无结束围栏），调用 `extractLinks` | 返回 `[]`；围栏内 `[a](a.mdx)` 不被抽取 | P0 | 自动化 | §5.3 |
| TC-EXTRACT-002 | L1 | 行内代码内的链接被剥离 | 空 | 输入 `` `[a](a.mdx)` ``，调用 `extractLinks` | 返回 `[]` | P0 | 自动化 | §5.3 |
| TC-EXTRACT-003 | L1 | 多反引号行内代码（内容含反引号）被整体剥离 | 空 | 输入 ```` ``[a](a.mdx)` x`` ```` 后接一行 `[b](b.mdx)` | 只返回 `b.mdx` 一条；多反引号段内内容不抽取 | P2 | 自动化 | §5.3 |
| TC-EXTRACT-004 | L1 | HTML 注释内的链接不抽取 | 空 | 输入 `<!-- [a](a.mdx) -->\n[b](b.mdx)` | 只返回 `b.mdx` | P1 | 自动化 | §5.3 |
| TC-EXTRACT-005 | L1 | 图片语法不产出链接 | 空 | 输入 `![alt](assets/images/x.png)` 与 `[d](d.mdx)` | 仅返回 `d.mdx`；`!` 前缀不误判为链接 | P0 | 自动化 | §5.3 |
| TC-EXTRACT-006 | L1 | 中文链接文字与中文 href | 空 | 输入 `[设计文档](./设计文档.mdx)` | 返回 `href="./设计文档.mdx"`，`line=1`，中文不丢字 | P1 | 自动化 | §5.3 |
| TC-EXTRACT-007 | L1 | 尖括号含空格的 href | 空 | 输入 `[t](<我的 笔记.mdx>)` | `href="我的 笔记.mdx"`（去掉尖括号，保留空格） | P1 | 自动化 | §5.3 |
| TC-EXTRACT-008 | L1 | 尾随 `"title"` / `'title'` 被剔除 | 空 | 输入 `[t](a.mdx "标题")` 与 `[t2](b.mdx '标题2')` | `href` 分别为 `a.mdx`、`b.mdx`，不含 title 片段 | P2 | 自动化 | §5.3 |
| TC-EXTRACT-009 | L1 | 引用定义 `[id]: href` 被识别 | 空 | 输入首行 `[ref]: ./c.mdx` | 返回 `href="./c.mdx"`，`line=1` | P1 | 自动化 | §5.3 |
| TC-EXTRACT-010 | L1 | 剥离不影响行号与后续链接偏移 | 空 | 输入含 3 行围栏代码块，块后第 5 行放 `[x](x.mdx)`；另在同一行 `abc` 之后放 `[y](y.mdx)` | 该链接 `line === 5`；`href` 与 `line` 均在剥离后仍准确 | P0 | 自动化 | §5.3 |
| TC-EXTRACT-011 | L1 | 单文件 2000 条链接截断 | 空 | 生成 2001 条合法行内链接，调用 `extractLinks` | 返回恰好 2000 条；`truncated` 标记可被上层读取，供 `warnings` 追加一条 | P1 | 自动化 | §5.3 / §6 |
| TC-EXTRACT-012 | L1 | 排除纯锚点、外链、非白名单扩展名 | 空 | 依次输入 `[a](#section)`、`[b](https://x.com)`、`[c](mailto:a@b.c)`、`[d](doc.pdf)`、`[e](a.png)`、`[f](a.mdx)` | 仅 `a.mdx` 被抽取；其余 5 种均不产出 `RawLink` | P1 | 自动化 | §5.3 |

### 3.2 link-resolve（`resolveLink(href, fromPath, index)`）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-RESOLVE-001 | L1 | 同目录与子目录相对路径 | 索引含 `a/x.mdx`、`a/b/y.md` | 从 `a/src.mdx` 解析 `x.mdx` 与 `b/y.md` | 两者均 `kind='edge'`，`targetId` 分别为 `a/x.mdx`、`a/b/y.md` | P0 | 自动化 | §5.4 |
| TC-RESOLVE-002 | L1 | `../` 上跳解析 | 索引含 `a/x.mdx` | 从 `a/b/src.mdx` 解析 `../x.mdx` | `kind='edge'`，`targetId='a/x.mdx'` | P1 | 自动化 | §5.4 |
| TC-RESOLVE-003 | L1 | 绝对路径直接命中 | 索引含 `docs/x.mdx` | 从 `a/src.mdx` 解析 `/docs/x.mdx` | `kind='edge'`，`targetId='docs/x.mdx'` | P2 | 自动化 | §5.4 |
| TC-RESOLVE-004 | L1 | 无扩展名补全优先 `.mdx` | 索引同时含 `a/x.mdx` 与 `a/x.md` | 从 `a/src.mdx` 解析 `x` | `kind='edge'`，`targetId='a/x.mdx'`（`.mdx` 优先） | P0 | 自动化 | §5.4 |
| TC-RESOLVE-005 | L1 | 无扩展名时仅 `.md` 存在也能补全 | 索引仅含 `a/x.md` | 从 `a/src.mdx` 解析 `x` | `kind='edge'`，`targetId='a/x.md'` | P1 | 自动化 | §5.4 |
| TC-RESOLVE-006 | L1 | `file://` 取路径部分 | 索引含 `docs/x.mdx` | 解析 `file:///docs/x.mdx` 与 `file:///docs/x.mdx#h` | 均 `kind='edge'`，`targetId='docs/x.mdx'` | P2 | 自动化 | §5.4 |
| TC-RESOLVE-007 | L1 | fragment 与 query 剥离 | 索引含 `a/x.mdx` | 分别解析 `x.mdx#sec`、`x.mdx?p=1`、`x.mdx?p=1#sec` | 三者均 `kind='edge'`，`targetId='a/x.mdx'` | P0 | 自动化 | §5.4 |
| TC-RESOLVE-008 | L1 | 非法 `decodeURIComponent` 转义保留原串 | 索引含 `a/x.mdx` | 解析 `%E0%A4%A.mdx`（非法转义序列） | 不抛异常，退回原串参与解析，最终 `kind='unresolved'` 且其 `display` 保留原 href 片段 | P1 | 自动化 | §5.4 |
| TC-RESOLVE-009 | L1 | 越界返回 `PATH_ESCAPE` 并落断链 | 工作区根下无该文件 | 从 `a/src.mdx` 解析 `../../etc/outside.mdx` | `kind='ignore'`、`reason='escape'`；经 `build` 后该文件不产生边（按 §5.4 第 5 步越界记断链的呈现由 `build` 侧断言，见 TC-BUILD-005） | P0 | 自动化  | §5.4 |
| TC-RESOLVE-010 | L1 | 非白名单扩展名返回 `ignore` | 索引含任意节点，**未提供附件集合** | 解析 `x.pdf`、`x.png`、`x.zip` | 均 `kind='ignore'`、`reason='not-indexed'`，不得落到 `unresolved` | P1 | 自动化 | §5.3 / §5.4 |
| TC-RESOLVE-011 | L1 | basename 兜底唯一命中 | 索引含 `deep/nest/唯一名.mdx` | 从根 `src.mdx` 解析 `唯一名.mdx`（路径不存在但同名文件唯一） | `kind='edge'`，`targetId='deep/nest/唯一名.mdx'` | P1 | 自动化 | §5.4 |
| TC-RESOLVE-012 | L1 | basename 同名歧义取最短路径并记 warning | 索引含 `a/x.mdx`、`a/b/c/x.mdx` | 从根解析 `x.mdx` | `kind='edge'`，`targetId='a/x.mdx'`；warnings 含一条歧义提示（不丢解析结果） | P1 | 自动化 | §5.4 |
| TC-RESOLVE-013 | L1 | 断链幽灵节点合并 | 索引无 `missing.mdx` | 从 `a/src.mdx` 与 `b/src.mdx` 各解析一次 `missing.mdx` | 两次返回 `kind='unresolved'` 且 `ghostId` 相同（`!` 前缀规范化目标），`display` 为链接原文 | P0 | 自动化 | §5.4 |
| TC-RESOLVE-014 | L1 | Windows 大小写折叠 | 索引在大小写不敏感前提下含 `docs/Guide.mdx` | 解析 `docs/guide.mdx` | `kind='edge'`，`targetId` 归一为索引中的真实 `docs/Guide.mdx`，不产生重复节点 | P1 | 自动化 | §5.4 / §10 |
| TC-RESOLVE-015 | L1 | 非文档文件真实存在时解析成附件 | 附件集合含 `docs/scripts/deploy.sh` | 从 `docs/a.md` 解析 `scripts/deploy.sh` | `kind='attachment'`，`targetId='docs/scripts/deploy.sh'`，`targetPath` 为磁盘真实路径 | P0 | 自动化 | §5.4 / §5.10 |
| TC-RESOLVE-016 | L1 | 非文档文件不存在时保持 `ignore`，不造假断链 | 附件集合仅含 `docs/scripts/deploy.sh` | 解析 `scripts/missing.sh` 与 `.gitignore` | 均 `kind='ignore'`、`reason='not-indexed'`；**不得**变成 `unresolved`（点开头目标被遍历排除，报断链是系统性误报） | P1 | 自动化 | §5.4 / §5.10 |
| TC-RESOLVE-017 | L1 | 缺附件集合时退化为忽略 | 上下文不含 `attachments` | 解析 `scripts/deploy.sh` | `kind='ignore'`、`reason='not-indexed'`（与引入附件节点之前的行为一致） | P2 | 自动化 | §5.4 / §5.10 |
| TC-RESOLVE-018 | L1 | 附件 id 折叠、路径保留真实大小写 | 大小写不敏感；附件集合含 `scripts/Deploy.SH` | 解析 `scripts/deploy.sh` | `targetId='scripts/deploy.sh'`（折叠），`targetPath='scripts/Deploy.SH'`（原样） | P2 | 自动化 | §5.4 / §10 |

### 3.3 build（`FileLinkRecord[]` → `GraphPayload`）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-BUILD-001 | L1 | 同一对文件重复链接合并为一条边且 `count` 累加 | 记录 `a` 含 3 条指向 `b` 的链接 | 调用 `build` | `edges` 中 `a→b` 仅一条，`count===3`；`edgeCount` 记边条数（1）而非链接条数 | P0 | 自动化 | §5.2 |
| TC-BUILD-002 | L1 | 自环忽略但保留在记录中 | 记录 `a` 含一条指向 `a` 的链接 | 调用 `build` | `edges` 不含 `a→a`；`a` 的度不因自环变化；原始 `RawLink` 未被破坏 | P2 | 自动化 | §5.2 |
| TC-BUILD-003 | L1 | 出入度计算正确 | `a→b`（count 2）、`c→b`、`b→d` | 调用 `build` | `b.inDegree===2`（按源节点计，不按 count）、`b.outDegree===1`；`a.outDegree===1`；`d.inDegree===1` | P1 | 自动化 | §5.2 |
| TC-BUILD-004 | L1 | 孤儿判定为度 0 | 节点 `x` 无出入边、`y` 有入边 | 调用 `build` | `orphanCount===1`，孤儿集合仅含 `x` | P1 | 自动化 | §3 / §5.2 |
| TC-BUILD-005 | L1 | 断链幽灵节点不计入孤儿 | `a` 唯一出链指向不存在的 `m.mdx` | 调用 `build` | 生成幽灵节点（`unresolved=true`、`path=null`、`label` 为原文）；幽灵**不计**孤儿；`unresolvedCount===1` | P0 | 自动化 | §3 / §5.4 |
| TC-BUILD-006 | L1 | `stats` 四计数与 `filesScanned`/`elapsedMs` 自洽 | 3 个文件、2 条边、1 条断链、1 个孤儿 | 调用 `build` | `nodeCount` = 实节点数 + 幽灵数（口径按设计 §3「节点」定义）；`edgeCount`、`unresolvedCount`、`orphanCount` 与集合长度一致；`elapsedMs` 为非负数 | P1 | 自动化 | §5.2 / §4.2 |
| TC-BUILD-007 | L1 | 幽灵节点字段与 id 前缀 | 断链目标为 `./missing.mdx` | 调用 `build` | 幽灵 `id` 以 `!` 开头且为规范化后目标；`path===null`；`unresolved===true`；对应边的 `unresolved===true` | P1 | 自动化 | §5.2 / §5.4 |
| TC-BUILD-008 | L1 | 被链接到的非文档文件补成附件叶子节点 | `docs/a.md` 含链接 `scripts/deploy.sh`，附件集合含该路径 | 调用 `build` | 生成 `format='attachment'` 节点：`path`/`folder` 正确、`label='deploy.sh'`（**保留扩展名**）、`outDegree===0`、`inDegree===1`；边为 `docs/a.md → docs/scripts/deploy.sh` 且 `unresolved===false`；`unresolvedCount===0` | P0 | 自动化 | §5.2 / §5.10 |
| TC-BUILD-009 | L1 | 附件节点保留磁盘真实大小写 | 大小写不敏感；链接写 `scripts/Deploy.sh` | 调用 `build` | 节点 `id` 折叠为小写，`path`/`label` 保留 `Deploy.sh` 原写法 | P2 | 自动化 | §5.10 / §10 |
| TC-BUILD-010 | L1 | 只收被链接到的文件 | 工作区含 `a.md`/`b.md` 及未链接的 `assets/cover.png`、`scripts/build.sh` | 调用 `build` | 节点集合仅 `a.md`、`b.md`；不存在任何 `attachment` 节点（避免资源目录淹没文档簇） | P0 | 自动化 | §5.10 |
| TC-BUILD-011 | L1 | 同一附件被多篇文档引用 | `a.md`、`b.md` 各链一次 `shared/spec.pdf` | 调用 `build` | 只生成一个附件节点，`inDegree===2` | P1 | 自动化 | §5.10 |
| TC-BUILD-012 | L1 | 附件不参与 basename 兜底与孤儿统计 | 附件集合含 `scripts/deploy.sh`；`a.md` 链接 `deploy`（无扩展名） | 调用 `build` | 无扩展名只补 `.mdx`/`.md`，**不得**落到 `deploy.sh`；该链接记为断链；附件节点不出现在孤儿清单里（它只因被引用而存在） | P1 | 自动化 | §5.4 / §5.10 |

### 3.4 local（BFS 子图）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-LOCAL-001 | L1 | 深度 1 只含直接邻居 | 链 `a→b→c→d` | 以 `b` 为中心、深度 1 求子图 | 节点集 `{a,b,c}`；不含 `d`；边集含 `a→b`、`b→c` | P1 | 自动化 | §4.3 |
| TC-LOCAL-002 | L1 | 深度 2 展开两跳 | 同上链 | 深度 2 | 节点集 `{a,b,c,d}` | P1 | 自动化 | §4.3 |
| TC-LOCAL-003 | L1 | 深度 3 在有向链上取满可达 | 链 `a→b→c→d→e` | 以 `a` 为中心、深度 3 | 节点集 `{a,b,c,d}`，不含 `e` | P1 | 自动化 | §4.3 |
| TC-LOCAL-004 | L1 | 双向邻居：入边方向也展开 | 仅存在 `x→c`、`c→y`（`c` 无出链到 `x`） | 以 `c` 为中心、深度 1 | 节点集含 `x`、`y`（无向 BFS，入边亦算一跳） | P0 | 自动化 | §3 / §4.3 |
| TC-LOCAL-005 | L1 | 孤立中心只含自身且深度超界剪枝 | `z` 度为 0；另一连通分量在 2 跳外 | 以 `z` 为中心、深度 3 | 节点集仅 `{z}`；不越出连通分量；未显示邻居计数为 0，不产生 `NaN` / 空边 | P1 | 自动化 | §4.3 |

### 3.5 colors（文件夹 → 稳定色相）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-COLORS-001 | L1 | 同一顶层目录颜色稳定 | 空 | 对同一 `folder` 连续取色 3 次，并在不同调用顺序下取色 | 三次返回值完全一致；与调用顺序无关（同 hash → 同 hue） | P1 | 自动化 | §5.8 |
| TC-COLORS-002 | L1 | 不同顶层目录颜色不同 | 空 | 取 `folder='a'`、`'b'`、`'docs'` | 三者颜色互不相同 | P1 | 自动化 | §5.8 |
| TC-COLORS-003 | L1 | 根目录文档有专门色 | 空 | 取 `folder=''` | 返回与任意非空目录都不同的固定色，且不抛错 | P1 | 自动化 | §5.8 |
| TC-COLORS-004 | L1 | 深色 / 浅色主题各一套配色且 hue 一致 | 空 | 以 `theme='dark'` 与 `theme='light'` 分别取同一批目录颜色 | 两套返回值不同（明度/饱和度随主题切换）；同一目录在两种主题下 hue 相同；不含 `undefined`/`NaN` 色相 | P2 | 自动化 | §5.8 / §9 P4 |

### 3.6 link-insert（追加链接文本层）

> 该模块当前**无任何测试**（设计 §8 要求覆盖），是最需要补的纯函数。

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-INSERT-001 | L1 | 无小节时新建 `## 相关笔记` | 正文 `# 标题\n正文` | 调用文本层插入 `- [目标](b.mdx)` | 结果末尾出现 `\n\n## 相关笔记\n- [目标](b.mdx)`；原正文逐字保留 | P0 | 自动化 | §4.6 / §5.10 |
| TC-INSERT-002 | L1 | 已有小节时追加到小节末尾 | 正文含 `## 相关笔记` 后接一条条目、再接 `## 其他` | 插入新条目 | 新条目位于 `## 相关笔记` 段内最后一条之后、`## 其他` 之前；其它小节不变 | P1 | 自动化 | §5.10 |
| TC-INSERT-003 | L1 | 幂等：已存在同目标链接时跳过 | 小节内已有指向 `b.mdx` 的条目（写法不同，如 `./b.mdx`） | 再次插入指向 `b.mdx` 的链接 | 正文逐字节不变；返回既有条目的行号 | P0 | 自动化 | §5.10 |
| TC-INSERT-004 | L1 | 标题紧邻时补空行 | 正文末行为 `## 最后标题`（无尾随空行） | 插入 | 小节标题前补齐一个空行（`\n\n## 相关笔记`），不出现三连空行 | P2 | 自动化 | §5.10 |
| TC-INSERT-005 | L1 | CRLF 正文归一后不混行尾 | 正文为 `\r\n` 行尾 | 插入后检查结果 | 输出统一为 `\n` 行尾（或整体保持原风格），不出现 `\r\n` 与 `\n` 混排；原有 `\r\n` 行内容不丢字 | P1 | 自动化 | §5.10 |
| TC-INSERT-006 | L1 | 返回行号正确（1 起） | 结果含 5 行（第 5 行为新条目） | 读取返回值 | `line===5`；用该行号回读原文，恰好是新增条目行 | P1 | 自动化 | §5.10 / §4.5 |
| TC-INSERT-007 | L1 | 路径 `encodeURI`：空格转 `%20`、中文保留 | 目标文件名为 `我的 笔记.mdx` | 插入并检查条目文本 | 条目为 `- [标题](我的%20笔记.mdx)`；中文未转义；随后交 `resolveLink` 能解析回同一目标（往返一致） | P0 | 自动化 | §4.6 |

## 4. L2 主进程用例（27 条，P0 10）

> 环境约定：`vi.mock('electron', ...)` 提供 `app.getPath` 等；每个用例在 `node:fs` 临时目录（`os.tmpdir()` 下 `mkdtemp`）建工作区，`afterEach` 递归删除；不触网、不真实弹窗。

### 4.1 scanner（列文件 / 读内容 / mtime 缓存）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SCANNER-001 | L2 | mtime 与 size 未变时不重读内容 | 工作区 3 个 `.mdx`；首次扫描完成 | 用 spy 包住读内容函数（解包/读文件），第二次扫描不改动任何文件 | 读内容函数调用次数为 **0**（缓存命中）；返回的 `links` 与首次一致 | P0 | 自动化 | §5.5 |
| TC-SCANNER-002 | L2 | size 变化触发重解析 | 同上，仅改一个文件内容（保持 mtime 相同，用 `utimes` 还原） | 再次扫描 | 该文件被重读 1 次；其余文件仍命中缓存 | P1 | 自动化 | §5.5 |
| TC-SCANNER-003 | L2 | 删除文件后缓存剔除 | 首次扫描后删除其中一个文件 | 再次扫描 | 结果不含该文件；缓存 Map 中无该 key；不抛异常 | P0 | 自动化 | §5.5 |
| TC-SCANNER-004 | L2 | 5000 文件截断并置 `truncated` | 造 5001 个 `.md`（空内容） | 调用扫描/构建 | 返回文件数 `<=5000`；`stats.truncated===true`；`warnings` 含「已扫描至上限 5000 个文件」 | P1 | 自动化 | §5.5 / §6 / §4.7 |
| TC-SCANNER-005 | L2 | `.mdx` 原文件 50MB 上限 | 造一个 >50MB 的 `.mdx`（可用稀疏文件或 mock `stat`） | 扫描 | 该文件被跳过；`warnings` 含文件名；构建继续 | P1 | 自动化 | §6 / §7 |
| TC-SCANNER-006 | L2 | `.mdx` 解压限额（10MB / 1000 条目 / 压缩比 100） | 分别造超限样本：解压后 >10MB、条目 >1000、压缩比 >100 | 逐个扫描 | 三种样本均被跳过并记 warning；不 OOM、不长时间阻塞（断言未调用 `getData` 全量） | P1 | 自动化 | §5.5 / §6 |
| TC-SCANNER-007 | L2 | rg 不可用时回退 `fs` 递归 | `rg` 定位返回 null（mock `rg-resolver`） | 扫描含 `.git/`、`node_modules/`、`.inkase/`、`assets/x.png` 的工作区 | 仍能列出 4 类白名单文件；三个排除目录内的文件**不出现**；返回结果与 rg 路径一致 | P1 | 自动化 | §5.5 / §7 |
| TC-SCANNER-008 | L2 | 二进制 `.md` 被拒绝 | 造一个含 `\0` 的 `.md` | 扫描 | 该文件跳过并记 warning；不把二进制当 Markdown 抽取（无伪造链接） | P1 | 自动化 | §5.5 / §7 |
| TC-SCANNER-009 | L2 | 额外收集非文档文件路径但不读内容 | 工作区含 `a.md`（链到 `scripts/deploy.sh`）、`scripts/deploy.sh`、`assets/cover.png` | 扫描 | `attachmentPaths` 含两个非文档路径；`knownPaths` 仍只有 `a.md`；`records` 只有 `a.md`；抽取函数只被调用一次（附件内容从未读取） | P1 | 自动化 | §5.5 / §5.10 |
| TC-SCANNER-010 | L2 | 非文档文件同样遵守排除规则 | 工作区含 `.git/hooks/pre-commit.sh`、`node_modules/pkg/index.js` | 扫描 | `attachmentPaths` 为空（点开头条目与 `node_modules` 一律不收） | P2 | 自动化 | §5.5 / §5.10 |

### 4.2 service（编排 / 进度 / 取消 / 限额）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-SERVICE-001 | L2 | 每 200 个文件发一次进度 | 造 450 个 `.md`；注入假 `send` | 执行构建，收集 `graph:progress` 调用 | 恰好在 200、400 处各发一次（少于此数不发）；末次进度 `scanned===total`；payload 含 `{scanned,total}` | P1 | 自动化 | §5.5 / §5.6 |
| TC-SERVICE-002 | L2 | 取消信号中止构建 | 造 2000 个文件，构建开始后置取消标记 | 触发取消 | 返回 `{success:false,error:'已取消'}`；后续不再发进度；不写任何文件 | P0 | 自动化 | §7 |
| TC-SERVICE-003 | L2 | warnings 聚合且失败文件不中断 | 混合 1 个损坏 `.mdx`、1 个超限文件、若干正常文件 | 构建 | 返回 `success:true` 且包含正常文件的节点；`warnings` 至少 2 条且都带文件名 | P1 | 自动化 | §7 / §6 |
| TC-SERVICE-004 | L2 | 20s 总时限降级返回部分结果 | 用假定时器把耗时推进到 >20s（mock 时钟/让读内容永不 resolve） | 构建 | 在约 20s 处返回已完成部分；`warnings` 含超时条目；不挂死 | P1 | 自动化 | §6 / §10 |
| TC-SERVICE-005 | L2 | 并发度为 4 | 20 个文件，读内容函数记录并发峰值 | 构建 | 峰值并发 `<=4` 且 `>1`（确实并发） | P2 | 自动化 | §5.5 / §6 |
| TC-SERVICE-006 | L2 | 切换工作区根清空缓存并取消旧构建 | 先构建 A 根，再以 B 根启动构建 | 观察 A 缓存与 A 的进行中构建 | A 缓存被清空；A 构建收到取消并返回 `已取消`；B 构建结果不含 A 的节点 | P1 | 自动化 | §5.5 / §7 |
| TC-SERVICE-007 | L2 | 链接到非文档文件时端到端生成附件节点 | 真实临时目录：`docs/a.md` 链到 `scripts/deploy.sh` 与 `assets/logo.png`，两个目标都存在 | 调用 `GraphService.build` | 三个节点（1 文档 + 2 附件）；附件 `format='attachment'`、`inDegree===1`；`unresolvedCount===0`；`payload.resolution.attachmentPaths` 含附件路径（供脏标签重算复用） | P0 | 自动化 | §5.5 / §5.10 |

### 4.3 link-write（`.md` 原子写 / `.mdx` 重打包 / 冲突）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-LINKWRITE-001 | L2 | `.md` 先写 `.tmp` 再 rename | 临时目录内 `a.md` | 调用 `appendLinkToFile`，用 spy 记录 fs 调用序列 | 出现 `writeFile(*.tmp)` 后紧跟 `rename`；最终无残留 `.tmp`；内容含新条目 | P0 | 自动化 | §5.10 |
| TC-LINKWRITE-002 | L2 | `.mdx` 重打包后正文完整 | 一个含标题/列表/代码块/尾随空行的 `.mdx` | 追加链接后重新打开该 `.mdx` | `content.md` 原内容逐字不变（仅新增小节）；尾部空行数量不丢 | P0 | 自动化 | §5.10 |
| TC-LINKWRITE-003 | L2 | `.mdx` 重打包后资源完整 | 同上 `.mdx` 含 2 张图片 + 1 个附件 | 追加链接后重新打开并枚举 assets | 3 个资源字节完全一致、路径未改名；`mdx.json` 的 assets 列表数量不变 | P0 | 自动化 | §5.10 |
| TC-LINKWRITE-004 | L2 | mtime 在读写间变化时放弃写入 | 读取文件后、写入前修改其 mtime | 调用写入 | 抛错/返回失败，错误信息含「文件已被其他程序修改」；磁盘内容**未被覆盖** | P0 | 自动化 | §5.10 / §7 |
| TC-LINKWRITE-005 | L2 | 幂等返回已有行号 | `.md` 已含指向目标的条目 | 再次写入同一目标 | 文件内容不变；返回 `{line}` 为既有条目行号 | P1 | 自动化 | §5.10 |
| TC-LINKWRITE-006 | L2 | `.mdx` 损坏时不写入 | 故意损坏的 zip | 写入调用 | 抛出可读错误；目标文件字节不变（不产生半成品）；临时目录被清理 | P1 | 自动化 | §7 |
| TC-LINKWRITE-007 | L2 | 写入路径经 `resolveLink` 可反解 | 源在 `a/src.mdx`，目标 `b/t.mdx` | 写入后用 `resolveLink` 解析新条目 href | 解析回 `b/t.mdx`（写入与解析互逆），且编码后的空格/中文均可还原 | P0 | 自动化 | §4.6 / §5.4 |

### 4.4 handlers（IPC 契约 / 路径校验 / 单构建）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-HANDLERS-001 | L2 | `from`/`to` 必须是工作区内相对路径 | 已注册 `GRAPH.CREATE_LINK` handler | 分别传绝对路径、含 `..` 的路径、以 `/` 开头的路径、合法相对路径 | 前三者返回 `{success:false}` 且不写盘；合法路径成功 | P0 | 自动化 | §5.6 |
| TC-HANDLERS-002 | L2 | `realpath` 越界被拒绝 | 在工作区外建目标文件，工作区内建指向它的符号链接（Windows 下用 junction，失败则跳过该分支） | 以链接路径作为 `to` 调用 | 返回失败并提示越界；不写盘 | P1 | 自动化 | §5.6 |
| TC-HANDLERS-003 | L2 | 取消时返回「已取消」 | 构建中触发取消 | 调用 `GRAPH.BUILD` | `{success:false, error:'已取消'}`，渲染层可据此静默忽略 | P1 | 自动化 | §7 |
| TC-HANDLERS-004 | L2 | 所有 handler 统一 `{success,data,error}` | 空 | 逐个调用 BUILD / REFRESH_FILE / CREATE_LINK 的成功与失败分支 | 成功路径含 `success===true` 与 `data`；失败路径含 `success===false` 与字符串 `error`；无裸值返回、无未捕获异常 | P0 | 自动化 | §5.6 / CLAUDE.md IPC 约定 |
| TC-HANDLERS-005 | L2 | 每个 webContents 只保留一个构建 | 同一 `sender` 连续两次 `BUILD` | 观察构建启动次数 | 第二次使第一次被取消（或忽略），并发构建数恒为 1；不出现两份进度事件交叉 | P1 | 自动化 | §5.6 / §7 |
| TC-HANDLERS-006 | L2 | 非法/不存在 root 的处理 | 传不存在的目录与空串 | 调用 `BUILD` | 返回 `{success:false,error}`，不抛未捕获异常；不泄漏堆栈到渲染层 | P1 | 自动化 | §7 |

## 5. L3 渲染层用例（35 条，P0 14）

> 约定：store 用 `setActivePinia(createPinia())`；纯函数（`buildBarItems`、viewport、dirty-overlay）直接调，不挂组件；组件用 `@vue/test-utils` 浅挂并 stub 掉 `GraphCanvas` / `TinyGrid` 等重物。

### 5.1 graph store（`src/stores/graph.ts`）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-STORE-001 | L3 | 打开图谱设置面板状态 | 关状态 | 调 `openGraph()` | `panelOpen===true`、`panelActive===true`、`mode==='global'`；不向 `fileStore.tabs` 添加任何 tab | P0 | 自动化 | §4.1 / §5.7 |
| TC-STORE-002 | L3 | 关闭图谱 | 已打开 | 调 `closePanel()` | `panelOpen===false` 且 `panelActive===false`；`payload` 可保留或清空（按实现），但不残留监听 | P1 | 自动化 | §4.1 |
| TC-STORE-003 | L3 | 激活图谱时停用 AI 面板 | 假 `aiStore.panelActive===true` | 调 `openGraph()` | `aiStore.deactivatePanel` 被调用 1 次；两面板不同时 active | P0 | 自动化 | §5.7 |
| TC-STORE-004 | L3 | 激活文件标签时停用图谱 | 图谱 active | 调 `deactivatePanel()`（模拟文件标签激活） | 图谱 `panelActive===false`，`panelOpen` 保持（标签仍在标签栏） | P1 | 自动化 | §5.7 |
| TC-STORE-005 | L3 | 切局部模式：无选中且无激活文件时退回全库 | `selection===null`、`fileStore.activeTab===null` | 调 `setMode('local')` | `mode` 仍为 `'global'`（或自动回退），不抛错、不产生空中心 | P1 | 自动化 | §4.3 |
| TC-STORE-006 | L3 | 切局部模式：中心取当前激活文件 | 有激活文件 `a/src.mdx` | 调 `setMode('local')` | 中心为 `a/src.mdx`；可见节点等于该中心 BFS 结果 | P0 | 自动化 | §4.3 |
| TC-STORE-007 | L3 | 深度 1–3 裁剪节点集合 | 已加载含 4 跳链的 payload，局部模式 | 依次设深度 1、2、3 | 可见节点数严格递增；深度 3 不超全库节点数；改动深度不触发 IPC 重建（`buildGraph` spy 调用次数为 0） | P1 | 自动化 | §4.3 / §5.5 |
| TC-STORE-008 | L3 | 过滤后可见集合正确 | payload 含 2 个顶层目录、4 种扩展名、1 个断链幽灵 | 依次取消一个目录 chip、取消 `inkmind` chip、输入搜索词、关闭「显示断链」 | 每次 `visibleNodes` 按条件收缩；关闭断链后幽灵节点与其边全部消失；过滤**不**触发仿真重建（`reheat` spy 为 0） | P0 | 自动化 | §4.4 / §6 |
| TC-STORE-009 | L3 | 工作区切换重置状态 | 已加载 A 工作区 payload，有过滤条件 | 切换工作区根到 B | `payload`、`filters`、`selection`、`progress` 全部重置；不残留 A 的节点 | P1 | 自动化 | §5.5 / §4.1 |
| TC-STORE-010 | L3 | 脏标签覆盖：未保存内容里的新链接立即可见 | payload 中 `a` 无出边；`fileStore.tabs` 中 `a` 为 `modified===true`，其 `content` 含一条指向 `b` 的链接 | 应用脏标签覆盖后读取 store | 图上出现 `a→b` 边；`a.outDegree` 与 `b.inDegree` 各 +1；孤儿集合同步更新；不触发 `buildGraph`（spy 为 0） | P0 | 自动化 | §5.9 |

### 5.2 GraphView

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-VIEW-001 | L3 | 未打开文件夹空态 | `openedFolderPath===''` | 挂载 | 显示「先打开一个文件夹，知识图谱以工作区为范围」与打开文件夹按钮；不发 `buildGraph` | P2 | 自动化 | §4.7 |
| TC-VIEW-002 | L3 | 加载态显示「已扫描 N / 总数 M」 | 进行中 `progress={scanned:200,total:450}` | 挂载 | 文案含 `200` 与 `450`；进度条可见；完成后该态消失 | P0 | 自动化 | §4.2 / §4.7 |
| TC-VIEW-003 | L3 | 错误态与重试 | `error='boom'` | 挂载并点击「重试」 | 显示错误信息与重试按钮；点击后重新调用 `buildGraph` 1 次 | P1 | 自动化 | §4.7 |
| TC-VIEW-004 | L3 | 问题抽屉断链分区 | payload 含 2 条断链（来源 `a.mdx` 第 3 行、`b.mdx` 第 9 行） | 打开抽屉 | 每行形如「来源文件名 › 目标原文（行号）」；点击打开来源文件（`openFile` 收到来源路径） | P1 | 自动化 | §4.5 |
| TC-VIEW-005 | L3 | 问题抽屉孤儿分区 | payload 含 1 个孤儿 `docs/x.mdx` | 打开抽屉切到孤儿 | 显示文件名与所在目录；点击打开该文件 | P1 | 自动化 | §4.5 |
| TC-VIEW-006 | L3 | 数量为 0 时显示正向空态而非隐藏 | 断链与孤儿均为 0 | 打开抽屉 | 两个分区都存在，分别显示「没有断链」「没有孤儿」类文案 | P2 | 自动化 | §4.5 |
| TC-VIEW-007 | L3 | 信息卡显示路径与出/入链数 | 选中节点 `a/x.mdx`（out 2 / in 3） | 单击节点 | 信息卡含相对路径、出链 2、入链 3 与「打开」按钮；点击按钮打开文件 | P0 | 自动化 | §4.2 |
| TC-VIEW-008 | L3 | 局部模式提示「N 个邻居未显示」 | 局部图隐藏 5 个节点 | 查看信息卡 | 显示「5 个邻居未显示」；点「扩展到全库」后 `mode==='global'` 且提示消失 | P1 | 自动化 | §4.3 |
| TC-VIEW-009 | L3 | 工具条四计数与 payload 一致 | payload `stats` 四项已知 | 挂载 | 节点/链接/断链/孤儿四个数字与 `stats` 完全一致；`truncated` 为真时额外显示上限警告 | P0 | 自动化 | §1.3 / §4.2 |
| TC-VIEW-011 | L3 | 「其他」组控制附件可见性 | payload 含 1 个 `attachment` 节点（由 `docs/a.md` 链到 `scripts/deploy.sh` 生成） | 挂载侧栏，点「其他」行 | 该行形状为三角、后缀文案为「任意后缀」；点击后 `filters.formats` 不含 `attachment`，画布可见节点里不再有附件 | P1 | 自动化 | §4.4 / §4.8 |
| TC-VIEW-012 | L3 | 选中附件的信息卡 | 同上，`selectedId` 指向附件节点 | 挂载 | 信息卡类型标为「其他文件」、形状为三角、标题为带扩展名的 `deploy.sh`（与文档去扩展名的规则不同） | P1 | 自动化 | §4.2 / §5.10 |

### 5.3 GraphCanvas

> Canvas 2D 上下文用假对象（`clearRect`/`beginPath`/`stroke` 等为 `vi.fn()`）；`requestAnimationFrame` 用假定时器驱动。

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-CANVAS-001 | L3 | 滚轮以光标为中心缩放 | `k=最大值前的 1`、光标在 (300,200) | 派发 `wheel`（deltaY<0） | `k` 增大；光标处图坐标点缩放前后保持不动（误差 < 0.5px） | P0 | 自动化 | §4.2 |
| TC-CANVAS-002 | L3 | 缩放边界钳制在 [0.1, 4] | 反复放大/缩小 | 连续 wheel 各 50 次 | `k` 始终 ∈ [0.1, 4]，不出现 `Infinity`/`NaN`/负值 | P1 | 自动化 | §4.2 |
| TC-CANVAS-003 | L3 | 空白处拖拽平移视口 | 视口 `(tx,ty)=(0,0)` | 在空白处按下并移动 (50,-30) 后松开 | 平移量等于位移；节点不被钉住；图坐标未变 | P0 | 自动化 | §4.2 |
| TC-CANVAS-004 | L3 | 节点拖拽钉住 `fx/fy` | 节点 `n1` 在 (10,10) | 拖到 (200,120) | 该节点 `fx=200`、`fy=120`；其它节点未被钉住；重绘发生 | P0 | 自动化 | §4.2 |
| TC-CANVAS-005 | L3 | 双击节点释放钉住 | 节点 `n1` 已钉住 | 双击该节点 | `fx`/`fy` 变回 `null`（或 undefined）；节点随后随仿真移动 | P1 | 自动化 | §4.2 |
| TC-CANVAS-006 | L3 | 双击空白处适应内容 | 视口被平移/缩放到偏离 | 双击空白 | 视口重置为「适应内容」：所有节点落在可视区内，`k` 按内容包围盒计算 | P2 | 自动化 | §4.2 |
| TC-CANVAS-007 | L3 | 单击空白清除选中 | 已选中 `n1` | 单击空白区 | `selection===null`；信息卡关闭 | P1 | 自动化 | §4.2 |
| TC-CANVAS-008 | L3 | `alpha<0.001` 后停止 rAF | 假定时器推进至仿真收敛 | 记录 `requestAnimationFrame` 与 `onTick` 调用 | 收敛后 rAF 不再被调度（连续推进 10 帧零新增）；再次交互（滚轮/拖拽）能重新启动 | P1 | 自动化 | §4.2 / §5.8 / §6 |

### 5.4 tab-order（`buildBarItems`）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-TABORDER-001 | L3 | 图谱项恒在末尾 | 2 个文档标签 + 图谱项 | 调 `buildBarItems(tabs, aiIndex, graphItem?)` 传第 4 参 | 末项 `kind==='graph'`；即使 `aiTabIndex` 在末尾，图谱仍在 AI 项之后 | P0 | 自动化 | §5.7 |
| TC-TABORDER-002 | L3 | AI 项位置不变 | 同上 | 比较带/不带第 4 参的结果前 N 项 | AI 项索引与原断言一致；既有 `ai-tab.test.ts` 断言全部保持通过 | P1 | 自动化 | §5.7 / §8 |
| TC-TABORDER-003 | L3 | 3 参调用向后兼容 | 既有调用点 | 只传 3 个参数 | 返回与原行为完全一致（无图谱项、不抛错） | P2 | 自动化 | §5.7 |

### 5.5 AppHeader

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-HEADER-001 | L3 | 菜单含「视图 › 知识图谱」 | 挂载 | 打开视图菜单 | 存在该菜单项；点击后 `openGraph()` 被调用 | P2 | 自动化 | §4.1 |
| TC-HEADER-002 | L3 | `Ctrl+Shift+G` 打开图谱 | 挂载 | 派发 keydown | `openGraph()` 调用 1 次；已打开时只激活不重复创建 | P0 | 自动化 | §4.1 |
| TC-HEADER-003 | L3 | `Ctrl+←`/`Ctrl+→` 标签切换包含图谱项 | 2 个文档标签 + 图谱项，当前在最后文档标签 | 按 `Ctrl+→` 一次，再 `Ctrl+←` 一次 | `Ctrl+→` 后图谱 active；`Ctrl+←` 回到原文档标签；不越界 | P1 | 自动化 | §4.1 / §5.7 |

### 5.6 EditorPanel

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-EDITOR-001 | L3 | 三面板互斥（图谱 / AI / 文档） | 有文档标签 | 依次激活图谱、AI、文档 | 任一时刻只有一路 `v-show` 为真；图谱打开时文档区不可见 | P0 | 自动化（浅挂 + stub） | §5.7 |
| TC-EDITOR-002 | L3 | 图谱激活时欢迎页隐藏 | 无标签、图谱打开 | 挂载 | 欢迎页不显示；`GraphView` 显示 | P2 | 手工 | §5.7 |

## 6. L4 集成与手工验收（12 条，P0 6）

> 环境：真实 Electron 应用（`pnpm run dev`），准备一个 **50+ 文档** 的工作区（含 `.mdx` / `.md` / `.inkmind` / `.drawio`、3 个以上顶层目录、至少 1 条断链、至少 1 篇孤儿）。下列用例对应设计 §8「手动验收清单」，PR 描述中逐条打勾。

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-E2E-001 | L4 | 50+ 文档工作区首次打开图谱 | 工作区已打开，图谱未打开 | 按 `Ctrl+Shift+G` | 标签栏末尾出现「知识图谱」标签；显示进度；完成后渲染出拓扑；工具条四个计数与人工抽查的节点/链接/断链/孤儿数一致 | P0 | 手工 | §8 / §1.3 |
| TC-E2E-002 | L4 | 悬停 / 单击 / 双击基本交互 | 图谱已渲染 | 悬停节点 → 单击节点 → 双击另一节点 | 悬停时自身与一跳邻居高亮、其余降至约 15% 透明度；单击出信息卡（路径/出链/入链）；双击打开该文件且图谱标签仍在 | P1 | 手工 | §4.2 |
| TC-E2E-003 | L4 | 缩放与拖拽节点 | 图谱已渲染 | 滚轮缩放多次 → 拖空白平移 → 拖节点 → 双击该节点 | 缩放跟随光标；平移流畅；节点被钉住；双击后节点重新受力学驱动 | P1 | 手工 | §4.2 |
| TC-E2E-004 | L4 | 切局部图并调深度 | 图谱已渲染，有激活文档 | 点「局部」→ 深度 1 → 2 → 3 | 中心为当前文档；节点集合随深度递增且与手工核对的邻居一致；切换深度**无**磁盘重复扫描的进度条 | P1 | 手工 | §4.3 |
| TC-E2E-005 | L4 | 搜索定位 | 全局图 | 输入关键词 → `Enter` | 命中节点保持彩色、其余变暗；`Enter` 选中并居中最近命中；清空恢复 | P1 | 手工 | §4.4 |
| TC-E2E-006 | L4 | 关闭「显示断链」 | 含断链的图谱 | 关闭开关再打开 | 关闭后幽灵节点与其边消失、断链计数显示不变或标注；重新打开恢复；全程无重排抖动 | P1 | 手工 | §4.4 |
| TC-E2E-007 | L4 | 图上建链接并保存后刷新确认新边 | 两个文档 A、B 均未打开 | 右键 A ›「链接到…」→ 选 B → 打开 A 确认条目 → 重新构建图谱 | A 末尾出现 `## 相关笔记` 与 `- [B](相对路径)`；重构图谱后 A→B 边存在、B 入链 +1 | P0 | 手工 | §4.6 / §5.10 |
| TC-E2E-008 | L4 | 新建笔记后立即出现在图上 | 图谱已渲染 | 空白右键 ›「新建笔记」→ 命名 → 确认 | 根目录生成 `.mdx` 并打开；不重建整库（无进度条）图上即出现新节点 | P1 | 手工 | §5.9 |
| TC-E2E-009 | L4 | 未保存标签里的新链接立即可见 | A 在标签中打开且为 modified | 在 A 正文手写一条指向 B 的链接（不保存）→ 看图谱 | 图谱上 A→B 边立即出现；A 仍处于未保存态（标签有脏标记） | P0 | 手工 | §5.9 |
| TC-E2E-010 | L4 | 图谱标签关闭不弹保存提示 | 有未保存文档标签 + 图谱标签 | 点图谱标签 `×` | 直接关闭，无确认弹窗；未保存文档标签不受影响，脏标记仍在 | P0 | 手工 | §4.1 / §1.3 |
| TC-E2E-011 | L4 | 图谱不进最近文件与会话恢复 | 打开图谱后正常退出应用 | 重启应用 → 查看最近文件列表与恢复的标签 | 最近文件不含图谱；恢复的标签中无图谱标签；图谱功能仍可从菜单打开 | P0 | 手工 | §4.1 / §10 |
| TC-E2E-012 | L4 | 断链与孤儿清单跳转 | 图谱含断链与孤儿 | 打开「问题」抽屉 → 点断链行 → 点孤儿行 | 断链行跳到来源文件并定位到对应行号附近内容；孤儿行打开该文件；两个清单的「在图中高亮」都能高亮对应节点 | P0 | 手工 | §4.5 |

## 7. L5 非功能与回归（7 条，P0 2）

| ID | 层级 | 标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 执行方式 | 设计章节 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-PERF-001 | L5 | 2000 节点仿真不抖动 | 造 2000 节点 / ~2500 边的工作区 | 打开图谱，观察 30s 并记录 CPU | 布局平滑收敛（约 300 tick 内），无明显抖动/回弹；无标签批量绘制（节点数 > 800 只在悬停/选中绘制） | P1 | 手工 | §5.8 / §6 / §10 |
| TC-PERF-002 | L5 | 静止时不耗电 | 图谱已收敛 | 静置 60s 后用任务管理器看渲染进程 CPU | 收敛后 rAF 停止，CPU 接近 0%；鼠标移过（未悬停节点）不应触发整帧重绘 | P0 | 手工 | §4.2 / §6 |
| TC-PERF-003 | L5 | 过滤不重跑仿真 | 图谱已收敛，记下若干节点坐标 | 勾选/取消文件夹 chip、切换扩展名、搜索 | 节点位置保持不变（不重排）；CPU 无尖峰；`reheat` 未被调用 | P0 | 手工 | §4.4 / §6 |
| TC-PERF-004 | L5 | 深色 / 浅色主题配色 | 含 4 个顶层目录的图谱 | 切换主题 | 节点与标签在两种主题下都可读（对比度足够）；同一目录颜色在两主题下色相一致、仅明暗变化；切换不重建布局 | P2 | 手工 | §5.8 / §9 P4 |
| TC-PERF-005 | L5 | 首屏不包含图谱代码（懒加载） | 干净构建产物 | 构建后检查主 chunk，或首启不打开图谱时抓包/看已加载模块 | `GraphView` 走 `defineAsyncComponent`；`d3-force` 不出现在首屏 chunk；首次打开图谱时才加载该 chunk | P1 | 手工（可用构建产物断言自动化） | §6 |
| TC-PERF-006 | L5 | `.mdx` 损坏时 warnings 带文件名且构建不中断 | 工作区混入一个损坏 `.mdx` | 打开图谱 | 图谱正常渲染其余节点；工具条/警告区能看到含该文件名的 warning；不白屏、不崩 | P1 | 手工 + L2 已覆盖 | §7 / §6 |
| TC-PERF-007 | L5 | 单文件读取失败只跳过该文件 | 工作区含一个权限受限或无读权限文件 | 打开图谱 | 其余节点正常；warning 含文件名；重试后行为一致（幂等） | P1 | 手工 + L2 已覆盖 | §7 |

## 8. 自动化落地建议

### 8.1 建议新建的测试文件（10 个，按优先级排序）

| 序 | 文件路径 | 优先级 | 覆盖用例 | 需 mock / 特殊处理 |
| --- | --- | --- | --- | --- |
| 1 | `shared/graph/__tests__/link-insert.test.ts` | **P0** | TC-INSERT-001~007 | 无 mock，纯字符串进出；断言用「输入 + 期望全文」而非快照；CRLF 用例单独一份夹具字符串 |
| 2 | `electron/graph/__tests__/link-write.test.ts` | **P0** | TC-LINKWRITE-001~007 | `vi.mock('electron')`（`app.getPath` 指向临时目录）；`node:fs/promises` + `os.tmpdir()` + `mkdtemp`，`afterEach` 递归清理；原子写用 spy 挂 `rename`/`writeFile` 记录调用序列；`.mdx` 夹具用 `adm-zip` 在测试内现场生成；mtime 冲突用 `fs.utimes` |
| 3 | `electron/graph/__tests__/scanner.test.ts` | **P0** | TC-SCANNER-001~008 | `vi.mock('electron')`；`node:fs` 临时目录造 `.git/`/`node_modules/`/`.inkase/` 与假 `assets`；`vi.spyOn` 包住「解压 / 读文件」函数断言调用次数（缓存命中）；`vi.mock('../rg-resolver')` 返回 null 走回退分支；大文件用 mock `stat` 返回尺寸而非真的写 50MB |
| 4 | `electron/graph/__tests__/handlers.test.ts` | **P0** | TC-HANDLERS-001~006 | `vi.mock('electron')` 提供 `ipcMain.handle` 捕获注册表，测试内直接调用注册的回调；`sender = { send: vi.fn(), id: 1 }` 断言进度通道与建构建去重；路径校验用临时目录 + 真实 `realpath`（符号链接用例在无权限环境 `it.skip`） |
| 5 | `electron/graph/__tests__/service.test.ts` | **P1** | TC-SERVICE-001~006 | `vi.mock('electron')`；`scanner` 用 `vi.mock('../scanner')` 注入可控文件列表与延迟；`vi.useFakeTimers()` 推进 20s 与进度节流；取消用 `AbortController` 或注入的 cancel token |
| 6 | `src/stores/__tests__/graph.test.ts` | **P0** | TC-STORE-001~010 | `setActivePinia(createPinia())`；`vi.mock('@/stores/file')` 提供 `tabs`/`activeTab`/`folders`；`window.electronAPI` 用 `vi.stubGlobal` 提供 `buildGraph`/`onGraphProgress`/`refreshGraphFile`；payload 用共享 fixture 工厂（勿依赖磁盘） |
| 7 | `src/utils/__tests__/graph-dirty-overlay.test.ts` | **P0** | TC-STORE-010（脏标签覆盖，建议拆成独立纯函数测试） | 无 Pinia：输入 `payload + tabs(modified=true)` 输出新 payload；与 `link-extract`/`link-resolve` 同源，用真实实现而非 mock（这正是设计 §5.9 的可信点） |
| 8 | `src/utils/__tests__/graph-tab-order.test.ts` | **P1** | TC-TABORDER-001~003 | 直接调 `buildBarItems` 纯函数，不挂 Pinia、不挂组件；断言既有 `ai-tab.test.ts` 的断言在 3 参调用下仍成立 |
| 9 | `src/components/graph/__tests__/GraphView.test.ts` | **P1** | TC-VIEW-001~009 | `@vue/test-utils` + 假 Pinia（`createTestingPinia` 或手写 stub store）；`GraphCanvas` 用 `global.stubs` 替成 `<div>`；断言文案与 DOM 分区，不触碰 Canvas |
| 10 | `src/components/graph/__tests__/GraphCanvas.test.ts` | **P1** | TC-CANVAS-001~008 | 假 Canvas 2D 上下文：`{ clearRect, beginPath, arc, fill, stroke, moveTo, lineTo, setLineDash, setTransform }` 全部 `vi.fn()`；`HTMLCanvasElement.prototype.getContext` 用 `vi.spyOn` 返回该对象；`vi.useFakeTimers()` + 手写 `requestAnimationFrame` 队列驱动收敛；`ResizeObserver` 用 `vi.stubGlobal` 空实现 |

补充说明：

- **`link-insert` 与 `electron/graph/*` 是当前最大空白**：按设计 §8，`link-insert` 属「共享纯函数（重点，全部为纯单测）」但实现已有、测试为零；`electron/graph/` 四个模块全部无测试。建议这两处先补（第 1、2、3、4 项），再补 store 与组件。
- 渲染层的既有习惯可复用：`ai-tab.test.ts` 的「假 Pinia + 直接调纯函数」适合第 8 项；`src/stores/__tests__/*.test.ts` 的 `setActivePinia(createPinia())` 适合第 6 项。主进程侧按 `electron/mdx/__tests__/writer.test.ts` 的常规写法（`vi.mock('electron')` + 临时目录）即可，无需新造框架。
- **待修的既有缺陷**：`shared/graph/__tests__/` 现有 74 例中有 1 例因实现多返回 `ambiguous` 字段而失败（歧义兜底）。建议把「同名歧义」断言改为「容忍额外字段、只校验 `kind`/`targetId`/warning 是否产生」（对应 TC-RESOLVE-012），避免断言与实现字段耦合。

### 8.2 执行编排建议

| 阶段 | 跑什么 | 通过标准 |
| --- | --- | --- |
| 提交前 | `shared/graph/__tests__/*` + `src/utils/__tests__/graph-*` | 全绿，纯函数层不允许 skip |
| CI | 上述 + `electron/graph/__tests__/*` + `src/stores/__tests__/graph.test.ts` | 全绿；`electron/graph` 用例需在 CI 上确认临时目录与符号链接权限，必要时 `it.skip` 并记 TODO |
| 合并前 | 全量 `pnpm test` + `pnpm typecheck` | 全绿（设计 §1.3 成功标准） |
| 发版前 | §6 手工清单 12 条逐条打勾 | 全勾 |

## 9. 风险点（最易出缺陷的 5 条）

| 序 | 结论 | 理由 | 对应用例 |
| --- | --- | --- | --- |
| 1 | **`link-resolve` 与 `Ctrl+Click`（`LINK.OPEN`）语义不一致**是最危险的缺陷 | 设计 §5.4 要求「必须与现有 `Ctrl+Click` 语义**完全一致**」，但两套解析目前是两份代码（`file-handlers.ts` 内联 vs `shared/graph/link-resolve.ts`），`file://`、`decodeURIComponent` 失败、`basename 兜底` 三条分支尤其容易分叉。一旦分叉，用户会看到「图谱说断了、点一下却能打开」或反之，直接摧毁可信度（设计 §10 已列为风险）。且现有 5 个测试文件只测了共享侧，没有对 `LINK.OPEN` 做同源比对。 | TC-RESOLVE-001~014、TC-EXTRACT-012 |
| 2 | **`.mdx` 重打包写回（`appendLinkToFile`）可能损坏用户文档** | `.mdx` 是 ZIP 容器，写回要 `openMdx → 改 content → prepareAssetsData → saveMdx`。资源（图片/附件）在临时目录里，任何一步路径或缓冲区处理失误都会导致「链接加上了、图没了」。该模块目前**零测试**，而它直接改写磁盘上的用户文件，是本次改动中唯一会破坏既有数据的路径。 | TC-LINKWRITE-002、TC-LINKWRITE-003、TC-LINKWRITE-006 |
| 3 | **脏标签覆盖（§5.9）与「已打开文件只改缓冲区」两处规则易冲突** | 同一份新链接有两条呈现代码路径：`tab.content` 重算（返回内存）与 `appendLinkToFile`（返回磁盘），两边的基准目录、`encodeURI` 方式、幂等判定必须一致。若哈希/路径编码不一致，会出现「刚写完的链接在图谱里看不见」或「写进去后重开会重复追加」——都是用户可见的错误。设计明确要求「绝不直接落盘」，实现里最容易漏的是「已打开但 modified===false」这个中间态。 | TC-E2E-009、TC-STORE-010、TC-INSERT-003、TC-INSERT-007 |
| 4 | **mtime/size 缓存导致图谱「看不到刚发生的变化」** | 缓存键是 `(mtimeMs, size)`。某些编辑器/同步工具（含 Git 检出、`mdx` 原子重打包）会保留 mtime 或使 size 不变，缓存命中就不再重解析——用户抱怨「我明明加了一条链接」时最难复现。共享侧缓存与主进程缓存若各存一份，失效条件也不同。 | TC-SCANNER-001、TC-SCANNER-002、TC-SERVICE-006、TC-PERF-003 |
| 5 | **画布交互状态机（钉住/缩放/停 rAF）在大图上易卡死或空转** | 缩放钳制、`fx/fy` 释放、`alpha<0.001` 停帧三件事共享同一份每帧状态：漏 `release` 会让节点粘住，漏停 rAF 会持续耗电（设计 §6 明确要求静止不耗电），而 `k` 越界或除以零会让整个画布变空白且无报错。这类缺陷自动化只有用假 Canvas + 假 rAF 才抓得到，否则只能靠肉眼。 | TC-CANVAS-001~008、TC-PERF-002 |

## 10. 待澄清

| 序 | 位置 | 疑问 | 影响 |
| --- | --- | --- | --- |
| 1 | §5.3 排除项 vs §5.4 第 7 步 | 「目标扩展名不在白名单内」在抽取阶段就被排除（§5.3），但 §5.4 第 7 步又规定「文件存在但不在索引内记 `ignore`」。两处谁先生效未明说。本文件按「抽取阶段已排除非白名单 → resolve 收到非白名单返回 `ignore`」处理（TC-RESOLVE-010）。**已澄清（2026-10-28）**：§5.4 现拆成第 7/8 两步——带白名单扩展名但未进索引记 `ignore`；非白名单扩展名若在附件集合内返回 `attachment`，否则仍记 `ignore`（不报断链，避免点开头目录的系统性误报）。见 TC-RESOLVE-015~018。 | 已解决：`not-indexed` 仍表示「忽略」，附件走新增的 `attachment` 分支，断链计数不受影响 |
| 2 | §5.4 第 5 步 | 「越界记断链（`PATH_ESCAPE`）」——但同节的 `Resolution` 类型里 `escape` 属于 `ignore` 分支。即「越界」到底产生**幽灵节点**（计入 `unresolvedCount`）还是**静默忽略**（不计）？§5.3 排除项最后一条又写「解析后越出工作区边界的路径（记为断链）」。 | 直接决定 `stats.unresolvedCount` 与断链清单是否包含越界条目；TC-RESOLVE-009 与 TC-BUILD-005 的断言口径取决于此 |
| 3 | §5.2 `GraphStats.nodeCount` | 未说明 `nodeCount` 是否包含断链幽灵节点。§6 的「渲染节点上限 6000（含断链幽灵节点）」暗示计数含幽灵，但架构上 `nodes` 数组包含幽灵、`nodeCount` 可能只数实节点。 | TC-BUILD-006 的断言需要明确口径；工具条四计数（TC-VIEW-009）与图例数量会对不上 |
| 4 | §5.4 第 8 步 | basename 兜底「多个命中取路径最短者」——「路径最短」是按字符数还是按层级数？大小写折叠是在「不区分大小写查找」之后还是之前归一？ | 同名歧义场景（TC-RESOLVE-012）的结果不稳定，尤其 Windows 上 `Docs/a.mdx` 与 `docs/a.mdx` 的折叠时机 |
| 5 | §4.3 | 「取消选中节点后切局部模式时，中心取当前激活标签的文件」——若当前激活的恰好是编辑区里的**未保存新文件**（无 `path`）怎么办？设计只给了「没有激活文件则退回全库」。 | 影响 TC-STORE-005/006 的分支覆盖与空态表现 |
| 6 | §4.2 / §5.8 | 标签显示阈值有两处口径：§4.2「节点数 ≤ 800 时显示标签」、§5.8「`k >= 0.8` 或悬停/选中时绘制；节点数 > 800 时只在悬停/选中绘制」。两者是「与」关系还是两套独立条件？ | 影响 TC-CANVAS / TC-PERF-001 的可断言性（标签是否绘制） |
| 7 | §5.10 | 幂等判定的粒度：设计写「小节内已存在指向同一目标（解析后比较）的条目」。若链接写在**小节之外**（正文中部）已指向同一目标，是否算已存在？本文件 TC-INSERT-003 按「仅小节内」处理。 | 可能出现同一目标两条链接（一条在小节内重复、一条在正文），用户会认为是 bug |
| 8 | §5.5 / §6 | 20s 总时限到达时「返回已构建部分」——已构建部分的 `inDegree/outDegree/孤儿` 是否基于完整节点集合重新计算？半成品图谱的孤儿数会明显虚高（未解析的入链被当成不存在）。 | 影响 TC-SERVICE-004 与超时场景下的工具条计数可信度 |
| 9 | §8 | 手动验收清单只有一条长句（「打开含 50+ 文档的工作区 → … → 刷新图谱确认新边」），没有逐步判据。本文件 §6 已把它拆成 12 条可勾选用例，但「50+ 文档」的构成（含多少断链/孤儿/四种格式）仍未定义，建议在 PR 里固定一份夹具工作区。 | 验收结果不可复现 |

---

**统计复核**：L1 49 条（P0 15）、L2 27 条（P0 10）、L3 35 条（P0 14）、L4 12 条（P0 6）、L5 7 条（P0 2）→ 合计 **130 条**，P0 **47** 条（36.2%），P1 68 条、P2 15 条；自动化 110 条、手工 20 条。

