# 数据模型

## 1. 模型原则

- 文献和项目通过关系表关联，不复制 PDF。
- 来源摘录与研究者解释分离。
- 卡片库、二次整理和论文提纲引用同一条 `ProjectCard`，不复制卡片内容。
- 二次整理“剔除”和永久删除是不同状态转换。
- 排序使用稀疏整数 `sort_order`；批量移动在单个事务内完成。
- 所有时间均以 UTC ISO-8601 字符串保存。

## 2. 关系概览

```text
Project ──< ProjectDocument >── Document ──< SourceExcerpt
   │                                  ├──< PdfAnnotation
   │                                  │
   ├──< SynthesisCategory             └──< ProjectCard >── Tag
   │                                             │
   └──< OutlineNode ──< OutlineCardLink >───────┘
```

## 3. 实体与字段

### Project

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| name | TEXT | 项目名称 |
| description | TEXT | 可选说明 |
| color | TEXT | 导航标识色 |
| sort_order | INTEGER | 同级项目顺序 |
| created_at / updated_at | TEXT | 时间戳 |

### Document

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| title | TEXT | 标题 |
| authors | TEXT | 当前阶段保存显示文本 |
| year | INTEGER NULL | 年份 |
| file_path | TEXT NULL | 应用数据目录中的 PDF 只读副本路径 |
| file_hash | TEXT NULL | 导入时计算的 SHA-256；相同文件复用副本 |
| created_at / updated_at | TEXT | 时间戳 |

### ProjectDocument

`project_id + document_id` 为复合主键，另含 `sort_order` 与 `created_at`。从项目移除文献只删除此关系，不删除全局文献或 PDF。

### SourceExcerpt

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| document_id | TEXT FK | 来源文献 |
| raw_text | TEXT | 不可静默修改的原始文字 |
| clean_text | TEXT | 确定性规则处理后的文字 |
| pdf_page | INTEGER NULL | 从 1 开始的 PDF 页码 |
| print_page | TEXT NULL | 支持罗马数字等印刷页标签 |
| locator_json | TEXT | 页面坐标与定位信息 |
| context_before / context_after | TEXT | 前后文 |
| source_hash | TEXT NULL | 摘录时文件标识 |
| created_at | TEXT | 创建时间 |

### ProjectCard

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| project_id | TEXT FK | 所属项目 |
| excerpt_id | TEXT FK | 不可变来源摘录 |
| comment | TEXT | 项目内研究评论 |
| role | TEXT | `unset/support/oppose/qualify/background` |
| category_id | TEXT FK NULL | 当前或剔除前分类 |
| synthesis_state | TEXT | `active/excluded` |
| created_at / updated_at | TEXT | 时间戳 |

同一来源摘录可在不同项目生成不同 `ProjectCard`。`UNIQUE(project_id, excerpt_id)` 防止同一项目误建重复项目卡片。

### PdfAnnotation

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| project_id | TEXT FK | 批注所属项目 |
| document_id | TEXT FK | 被批注的文献 |
| kind | TEXT | `highlight` 或 `underline` |
| page_number | INTEGER | 从 1 开始的 PDF 页码 |
| color | TEXT | `#RRGGBB` 颜色 |
| selected_text | TEXT | 创建批注时选中的文字，可为空 |
| locator_json | TEXT | 归一化页面坐标矩形集合 |
| comment | TEXT | 批注说明（当前界面主要用于后续扩展） |
| created_at / updated_at | TEXT | 时间戳 |

批注是项目内的独立记录，不修改 PDF 文件，也不等同于 `ProjectCard`。删除批注不会删除摘录或卡片。

### Tag / ProjectCardTag

`Tag` 在项目内唯一；`ProjectCardTag` 建立多对多关系。标签不与二次整理分类混用。

### SynthesisCategory

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| project_id | TEXT FK | 所属项目 |
| name | TEXT | 分类名称 |
| color | TEXT | 分类颜色 |
| sort_order | INTEGER | 分类顺序 |
| created_at / updated_at | TEXT | 时间戳 |

每个项目初始化一个不可删除但可改名的默认分类，初始名称为“待归类”。删除其他分类时，其中卡片回到当前默认分类。

### OutlineNode

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| project_id | TEXT FK | 所属项目 |
| parent_id | TEXT FK NULL | 父章节 |
| title | TEXT | 章节标题 |
| notes | TEXT | 写作说明 |
| core_argument | TEXT | 核心论点 |
| open_questions | TEXT | 待解决问题 |
| sort_order | INTEGER | 同级排序 |
| created_at / updated_at | TEXT | 时间戳 |

### OutlineCardLink

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| outline_node_id | TEXT FK | 章节节点 |
| project_card_id | TEXT FK | 项目卡片 |
| note | TEXT | 章节内备注 |
| sort_order | INTEGER | 章节内卡片顺序 |
| created_at | TEXT | 时间戳 |

`UNIQUE(outline_node_id, project_card_id)` 防止同一章节重复关联；不同章节可关联同一卡片。

## 4. 删除与级联

- 永久删除 `ProjectCard`：级联删除标签关系和提纲关联，不删除 `SourceExcerpt` 或 PDF。
- 删除提纲节点：必须确认；删除该节点及子树和其关联，卡片保留。
- 删除分类：卡片在事务内移动到默认分类后再删除分类。
- 删除项目：需要明确确认；项目专属的卡片、批注、阅读笔记、分类和提纲会一并删除，仍被其他项目引用的文献和 PDF 保留。建议删除前先导出项目备份。
- `SourceExcerpt` 和 `Document` 的孤立记录暂不自动清理，避免误删其他项目仍可能复用的来源。

## 5. 必要索引

- `project_documents(project_id, sort_order)`
- `source_excerpts(document_id, pdf_page)`
- `project_cards(project_id, synthesis_state, category_id)`
- `synthesis_categories(project_id, sort_order)`
- `outline_nodes(project_id, parent_id, sort_order)`
- `outline_card_links(outline_node_id, sort_order)`
- `project_card_tags(project_card_id)`
- `documents(file_hash)`（部分索引）
- `pdf_annotations(project_id, document_id, page_number, created_at)`
