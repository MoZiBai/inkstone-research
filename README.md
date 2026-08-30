# 砚台（Inkstone Research Desk）

砚台是面向历史学、考古学研究者的 Windows 本地研究卡片工作台。它以项目组织文献和摘录，把卡片经过二次整理后关联到研究者自己创建的多级论文提纲。

这是一套 Tauri + React + Rust + SQLite 的真实桌面应用工程，不是一次性 HTML Demo。核心数据默认只保存在本机，PDF 原件不会被修改。

## 当前阶段

第一阶段的本地研究工作台已经具备：

- 创建和切换同级研究项目；
- 登记文献书目信息；
- 按来源文献查看项目全部卡片；
- 编辑项目内评论、标签和卡片作用；
- 创建、改名、着色、排序与安全删除整理分类；
- 拖拽分类，剔除和恢复卡片；
- 创建、编辑、删除与拖拽多级提纲；
- 将同一卡片关联到多个章节，并独立调整或移除关联；
- 使用真实 SQLite 事务持久化，关闭数据库后重新打开仍能恢复状态。

第二阶段（PDF 阅读与可追溯摘录）已部分实现：

- 通过系统文件选择器导入 PDF；按 SHA-256 在应用数据目录保存只读副本，重复文件复用；
- 使用 PDF.js 连续滚动阅读，支持页码跳转、上一页/下一页、缩放和适合宽度；
- 文字型 PDF 支持文字层选择；选区可创建研究卡片，保存页码、印刷页码、坐标、前后文和文件哈希；
- 选区可保存高亮或下划线，批注在应用重启后恢复，并可从右侧列表定位或移除；
- 卡片库、二次整理和论文提纲中的“查看原文”可以回到对应 PDF 页和选区附近。

空数据库会写入带“示例项目”标识的种子数据，用于验证状态流。新建项目不会自动生成固定章节。

尚未实现的能力会在界面中明确标注：扫描件 OCR、PDF 全文索引与跨页/模糊反向定位、确定性复制格式清理、NoteExpress 等外部导入，以及 Markdown/Word 导出。项目不包含 WPS 剪贴板入口或自由画布。

## 技术栈

- Tauri 2 / Windows WebView2
- React 19 / TypeScript / Vite
- Rust stable / `rusqlite` bundled SQLite
- Vitest、Rust tests、rustfmt、Clippy

详细说明见 [产品说明](docs/PRODUCT.md)、[数据模型](docs/DATA_MODEL.md)、[技术架构](docs/ARCHITECTURE.md) 与 [阶段计划](docs/ROADMAP.md)。

## 开发环境

需要 Node.js 22+、pnpm、rustup，以及带 C++ x64 工具的 Visual Studio 2022 Build Tools。Rust 工具链安装在仓库内的 `.toolchains`，项目脚本不会修改系统 PATH。

```powershell
pnpm install
pnpm setup:rust
```

本机已经存在项目内 Rust 工具链时，不需要重复执行 `pnpm setup:rust`。

## 常用命令

```powershell
pnpm dev          # 启动 Tauri 开发窗口
pnpm typecheck    # TypeScript 类型检查
pnpm test         # 前端纯逻辑测试
pnpm test:rust    # SQLite 与业务不变量测试
pnpm lint:rust    # Clippy，警告视为错误
pnpm format:rust  # Rust 格式化
pnpm build:web    # 构建 WebView 前端
pnpm build        # 生成 Windows release 可执行文件
```

发布构建输出到 `src-tauri/target/release/inkstone-research.exe`。

## 本地数据

正式运行时数据库位于 Tauri 的应用数据目录，文件名为 `inkstone.db`；导入的 PDF 副本位于同目录下的 `pdf-library/<sha256>.pdf`。Windows 通常对应当前用户 Roaming AppData 下的 `com.inkstone.research` 目录。SQLite 启用外键、WAL 与事务保护。

当前备份/恢复界面尚未实现。在进入真实资料录入前，应先完成路线图第四阶段中的 JSON/Markdown 备份能力。
