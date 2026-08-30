# 技术架构

## 1. 技术选型

| 层 | 选择 | 原因 |
|---|---|---|
| 桌面壳 | Tauri 2 | 使用系统 WebView2，安装包和常驻内存明显小于 Electron，适合长期打开的研究工具 |
| UI | React + TypeScript + Vite | 适合复杂多视图状态、类型安全 IPC 和长期维护 |
| 本地数据 | SQLite + Rust `rusqlite` | 单文件、事务可靠、写入和复杂查询不阻塞界面线程 |
| 测试 | Rust 单元/持久化测试 + Vitest | 数据不变量、数据库重启恢复和纯前端逻辑可自动回归 |
| PDF | PDF.js 6 | 成熟开源；文本层、页面坐标和按需渲染满足第一版摘录定位需求 |

Rust stable 工具链固定安装在项目内的 `.toolchains`，不修改系统 PATH。Windows 构建使用已安装的 MSVC Build Tools。项目脚本会自动初始化编译环境，保证开发命令可重复执行。

## 2. 进程边界

```text
WebView（React）
  只负责展示、局部交互和乐观反馈
        │ typed Tauri commands
Rust Core（Tauri）
  业务服务、事务、SQLite、文件能力
        │
SQLite / PDF 文件
```

- WebView 不直接访问文件系统和数据库。
- Tauri capability 只开放应用窗口所需的最小权限。
- 所有写操作由 Rust 层验证项目归属，并在事务中执行。
- Command 返回可序列化 DTO，不传递数据库连接或文件句柄。

## 3. 模块划分

```text
src-tauri/src/
  database/        连接、初始迁移、种子、查询
  pdf_files.rs     PDF 导入复制、哈希和受限读取
  commands.rs      项目、文献、卡片、PDF、整理、提纲命令
  models.rs        序列化 DTO 与输入模型

src/renderer/src/
  features/
    reading/
    library/
    synthesis/
    outline/
  components/      通用对话框与空状态

src/shared/         Rust IPC 对应的 TypeScript 类型
```

## 4. 数据加载策略

- 启动加载项目导航和当前项目工作集，但不会加载其他项目的卡片正文。
- 切换项目时按项目查询文献、分类和提纲，不加载其他项目卡片。
- 第一阶段在已加载的当前项目内延迟执行搜索与筛选；接入全文索引后改由 SQLite 查询。
- 二次整理只查询当前项目；卡片节点使用 `content-visibility`，避免不可见列参与完整布局。
- 第一阶段写入后重载当前项目快照以优先保证一致性，不会重载其他项目；性能基线通过后再改为命令返回增量补丁。
- 排序和批量移动使用单事务。
- PDF 文件在 Rust 层按哈希保存到应用目录，WebView 通过受限的 `read_pdf` 命令读取，不允许任意路径访问。
- PDF.js 文档和页面对象按需加载；先显示第一页和估算页面尺寸，再以小批次后台校正其余页面，避免大型文献打开时阻塞界面。
- 文字层只在可视区域附近渲染；高亮/下划线使用归一化坐标覆盖层，缩放时无需改写数据。

## 5. 性能目标

- 常用按钮按下后 100 ms 内出现状态反馈。
- 2,000 张项目卡片下，分类移动和剔除不触发整库刷新。
- 数据库单条常用查询目标低于 50 ms；测试中记录慢查询。
- 不在 React render 阶段解析 PDF、计算哈希或执行全文搜索。
- 拖拽期间不写数据库；放下后进行一次持久化。
- 关闭装饰性重动画，尊重系统“减少动态效果”设置。

## 6. 数据位置与迁移

- 正式数据库：Tauri `app_data_dir()/inkstone.db`（Windows 通常位于当前用户的 Roaming AppData）。
- 当前建立 schema v2；后续结构变化必须追加版本化迁移，禁止运行期随意修改已有迁移。v2 新增 `pdf_annotations` 和 PDF 哈希索引。
- 开发种子只在空数据库中创建，并带有明确的“示例数据”标识。
- 后续备份使用一致性事务导出 JSON/Markdown；PDF 原件不进入默认备份。

## 7. 当前阶段边界

当前实现真实桌面壳、SQLite、项目/文献/卡片/分类/提纲状态闭环，并已部分完成第二阶段的 PDF 导入、渲染、同页选区摘录、批注和定位。扫描件 OCR、全文索引和跨页定位仍明确留在后续阶段。
