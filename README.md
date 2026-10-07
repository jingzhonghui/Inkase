# Inkase

一款以自包含 `.mdx` 文件格式为核心的轻量级文档工作台——将 Markdown 内容与图片等资源打包为单一 ZIP 文件，同时支持纯文本/代码文件编辑与 PDF、图片查看。

## 特性

- 📝 自包含的 `.mdx` 文件格式（ZIP 压缩包）
- 🖼️ 图片自动打包到文档内
- 🎨 两种编辑模式：即时渲染 / 分屏预览 / 源码编辑
- 🌓 浅色/深色主题切换
- 💾 自动保存与崩溃恢复
- 📤 导出为 Markdown / HTML / PDF

## 技术栈

- Electron 34+
- Vue 3 + TypeScript
- Pinia 状态管理
- Tailwind CSS
- electron-vite

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm run dev

# 类型检查
pnpm run typecheck

# 代码检查
pnpm run lint

# 代码格式化
pnpm run format

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

## 项目结构

```
inkase/
├── electron/           # Electron 主进程
│   ├── main.ts        # 主进程入口
│   ├── preload.ts     # 预加载脚本
│   └── ...
├── src/               # Vue 渲染进程
│   ├── components/    # Vue 组件
│   ├── stores/        # Pinia 状态
│   ├── styles/        # 样式
│   └── ...
├── docs/              # 文档
└── ...
```
