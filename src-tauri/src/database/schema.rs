use std::time::Duration;

use rusqlite::{Connection, Result};

pub const SCHEMA_VERSION: i64 = 6;

pub fn migrate_database(connection: &mut Connection) -> Result<()> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.busy_timeout(Duration::from_secs(5))?;

    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;

    if current_version < 1 {
        connection.execute_batch(
            r#"
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '#9a5d45',
          sort_order INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          authors TEXT NOT NULL DEFAULT '',
          year INTEGER,
          file_path TEXT,
          file_hash TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_documents (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
          sort_order INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (project_id, document_id)
        );

        CREATE TABLE IF NOT EXISTS source_excerpts (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
          raw_text TEXT NOT NULL,
          clean_text TEXT NOT NULL,
          pdf_page INTEGER,
          print_page TEXT,
          locator_json TEXT NOT NULL DEFAULT '{}',
          context_before TEXT NOT NULL DEFAULT '',
          context_after TEXT NOT NULL DEFAULT '',
          source_hash TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS synthesis_categories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (project_id, name)
        );

        CREATE TABLE IF NOT EXISTS project_cards (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          excerpt_id TEXT NOT NULL REFERENCES source_excerpts(id) ON DELETE RESTRICT,
          comment TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT 'unset'
            CHECK (role IN ('unset', 'support', 'oppose', 'qualify', 'background')),
          category_id TEXT REFERENCES synthesis_categories(id) ON DELETE SET NULL,
          synthesis_state TEXT NOT NULL DEFAULT 'active'
            CHECK (synthesis_state IN ('active', 'excluded')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (project_id, excerpt_id)
        );

        CREATE TABLE IF NOT EXISTS tags (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (project_id, name)
        );

        CREATE TABLE IF NOT EXISTS project_card_tags (
          project_card_id TEXT NOT NULL REFERENCES project_cards(id) ON DELETE CASCADE,
          tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (project_card_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS outline_nodes (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES outline_nodes(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          core_argument TEXT NOT NULL DEFAULT '',
          open_questions TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS outline_card_links (
          id TEXT PRIMARY KEY,
          outline_node_id TEXT NOT NULL REFERENCES outline_nodes(id) ON DELETE CASCADE,
          project_card_id TEXT NOT NULL REFERENCES project_cards(id) ON DELETE CASCADE,
          note TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (outline_node_id, project_card_id)
        );

        CREATE INDEX IF NOT EXISTS idx_project_documents_project
          ON project_documents(project_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_source_excerpts_document
          ON source_excerpts(document_id, pdf_page);
        CREATE INDEX IF NOT EXISTS idx_project_cards_synthesis
          ON project_cards(project_id, synthesis_state, category_id);
        CREATE INDEX IF NOT EXISTS idx_categories_project
          ON synthesis_categories(project_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_outline_nodes_tree
          ON outline_nodes(project_id, parent_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_outline_links_node
          ON outline_card_links(outline_node_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_project_card_tags_card
          ON project_card_tags(project_card_id);

        "#,
        )?;
        connection.pragma_update(None, "user_version", 1)?;
    }

    if current_version < 2 {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS pdf_annotations (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
              kind TEXT NOT NULL CHECK (kind IN ('highlight', 'underline')),
              page_number INTEGER NOT NULL CHECK (page_number >= 1),
              color TEXT NOT NULL,
              selected_text TEXT NOT NULL DEFAULT '',
              locator_json TEXT NOT NULL,
              comment TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_documents_file_hash
              ON documents(file_hash) WHERE file_hash IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_pdf_annotations_project_document
              ON pdf_annotations(project_id, document_id, page_number, created_at);
            "#,
        )?;
        connection.pragma_update(None, "user_version", 2)?;
    }

    if current_version < 3 {
        connection.execute_batch(
            r#"
            ALTER TABLE documents ADD COLUMN journal TEXT NOT NULL DEFAULT '';
            ALTER TABLE documents ADD COLUMN volume TEXT NOT NULL DEFAULT '';
            ALTER TABLE documents ADD COLUMN issue TEXT NOT NULL DEFAULT '';
            ALTER TABLE documents ADD COLUMN pages TEXT NOT NULL DEFAULT '';
            ALTER TABLE documents ADD COLUMN doi TEXT NOT NULL DEFAULT '';
            ALTER TABLE documents ADD COLUMN publisher TEXT NOT NULL DEFAULT '';
            ALTER TABLE documents ADD COLUMN metadata_raw TEXT NOT NULL DEFAULT '';

            CREATE INDEX IF NOT EXISTS idx_documents_doi
              ON documents(doi) WHERE doi != '';
            "#,
        )?;
        connection.pragma_update(None, "user_version", 3)?;
    }

    if current_version < 4 {
        connection.execute_batch(
            r#"
            ALTER TABLE project_documents ADD COLUMN removed_at TEXT;

            CREATE TABLE IF NOT EXISTS reading_notes (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
              kind TEXT NOT NULL CHECK (kind IN ('insight', 'critique')),
              content TEXT NOT NULL,
              selected_text TEXT NOT NULL DEFAULT '',
              page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
              locator_json TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_project_documents_visible
              ON project_documents(project_id, removed_at, sort_order);
            CREATE INDEX IF NOT EXISTS idx_reading_notes_project_document
              ON reading_notes(project_id, document_id, created_at);
            "#,
        )?;
        connection.pragma_update(None, "user_version", 4)?;
    }

    if current_version < 5 {
        connection.execute_batch(
            r#"
            ALTER TABLE project_cards ADD COLUMN text_override TEXT NOT NULL DEFAULT '';
            "#,
        )?;
        connection.pragma_update(None, "user_version", 5)?;
    }

    if current_version < 6 {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS app_metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            "#,
        )?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

pub fn seed_database(connection: &mut Connection) -> Result<()> {
    let initialized: i64 = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM app_metadata WHERE key = 'database_initialized')",
        [],
        |row| row.get(0),
    )?;
    if initialized == 1 {
        return Ok(());
    }

    let project_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
    if project_count > 0 {
        connection.execute(
            "INSERT INTO app_metadata (key, value) VALUES ('database_initialized', '1')",
            [],
        )?;
        return Ok(());
    }

    let transaction = connection.transaction()?;
    transaction.execute_batch(
        r#"
        INSERT INTO projects
          (id, name, description, color, sort_order, created_at, updated_at)
        VALUES
          ('seed-project-tombs', '示例项目：墓葬空间与社会关系',
           '用于验证阅读材料如何经过整理进入论文提纲。', '#a05d43', 1000,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-project-regions', '示例项目：区域互动研究',
           '展示同一工作台中的独立研究项目。', '#647b70', 2000,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z');

        INSERT INTO synthesis_categories
          (id, project_id, name, color, sort_order, is_default, created_at, updated_at)
        VALUES
          ('seed-category-inbox', 'seed-project-tombs', '待归类', '#9a9a8d', 1000, 1,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-category-claim', 'seed-project-tombs', '核心论点', '#b36647', 2000, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-category-method', 'seed-project-tombs', '方法与材料', '#688174', 3000, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-category-counter', 'seed-project-tombs', '反证与限定', '#667b8b', 4000, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-category-region-inbox', 'seed-project-regions', '待归类', '#9a9a8d', 1000, 1,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z');

        INSERT INTO documents
          (id, title, authors, year, file_path, file_hash, created_at, updated_at)
        VALUES
          ('seed-document-space', '从墓葬空间看社会关系的形成', '陈明远', 2022, NULL, NULL,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-document-ritual', '仪式、记忆与墓地的空间秩序', '林秋', 2019, NULL, NULL,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-document-region', '区域互动与物质文化传播路径', '周宁', 2021, NULL, NULL,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z');

        INSERT INTO project_documents (project_id, document_id, sort_order, created_at)
        VALUES
          ('seed-project-tombs', 'seed-document-space', 1000, '2026-08-30T00:00:00Z'),
          ('seed-project-tombs', 'seed-document-ritual', 2000, '2026-08-30T00:00:00Z'),
          ('seed-project-regions', 'seed-document-region', 1000, '2026-08-30T00:00:00Z');

        INSERT INTO source_excerpts
          (id, document_id, raw_text, clean_text, pdf_page, print_page,
           locator_json, context_before, context_after, source_hash, created_at)
        VALUES
          ('seed-excerpt-1', 'seed-document-space',
           '墓葬空间并非被动地反映社会关系，而是在仪式实践中持续参与关系的生产。',
           '墓葬空间并非被动地反映社会关系，而是在仪式实践中持续参与关系的生产。',
           17, '103', '{"page":17,"rects":[]}',
           '既有研究多将墓葬尺度作为身份等级的直接指标。',
           '因此，对空间组织的分析必须结合进入路径与仪式次序。', NULL,
           '2026-08-30T00:00:00Z'),
          ('seed-excerpt-2', 'seed-document-space',
           '随葬品数量与墓主人身份之间不存在可以脱离保存状况而成立的线性对应。',
           '随葬品数量与墓主人身份之间不存在可以脱离保存状况而成立的线性对应。',
           24, '110', '{"page":24,"rects":[]}',
           '盗扰与后期扰动会显著改变可观察到的器物组合。',
           '数量指标只有在材料可比性得到控制后才具有解释力。', NULL,
           '2026-08-30T00:00:00Z'),
          ('seed-excerpt-3', 'seed-document-space',
           '研究单元的划分本身包含解释，不能把现代统计分组直接等同于历史行动群体。',
           '研究单元的划分本身包含解释，不能把现代统计分组直接等同于历史行动群体。',
           31, '117', '{"page":31,"rects":[]}',
           '聚类分析能够描述相似性，却不能自动说明相似性的历史来源。',
           '分类结果仍需与地层、年代和空间连续性相互验证。', NULL,
           '2026-08-30T00:00:00Z'),
          ('seed-excerpt-4', 'seed-document-ritual',
           '重复举行的纪念活动使墓地空间获得了超出单次埋葬行为的社会记忆。',
           '重复举行的纪念活动使墓地空间获得了超出单次埋葬行为的社会记忆。',
           9, '57', '{"page":9,"rects":[]}',
           '墓地并非在埋葬结束后失去社会作用。',
           '路径、停留和观看共同构成了记忆被更新的方式。', NULL,
           '2026-08-30T00:00:00Z'),
          ('seed-excerpt-5', 'seed-document-ritual',
           '空间接近不必然意味着亲属接近，也可能来自不同时期对既有地标的共同利用。',
           '空间接近不必然意味着亲属接近，也可能来自不同时期对既有地标的共同利用。',
           14, '62', '{"page":14,"rects":[]}',
           '墓葬之间的距离常被直接解释为群体内部关系。',
           '年代分辨率不足时，应限制对亲属结构的推断强度。', NULL,
           '2026-08-30T00:00:00Z'),
          ('seed-excerpt-6', 'seed-document-region',
           '相似器物的出现只能说明联系的可能性，不能单独确定人口移动的方向。',
           '相似器物的出现只能说明联系的可能性，不能单独确定人口移动的方向。',
           12, '88', '{"page":12,"rects":[]}',
           '物质文化相似性可以由多种传播机制形成。',
           '需要将技术链、原料来源与时间序列共同纳入判断。', NULL,
           '2026-08-30T00:00:00Z');

        INSERT INTO project_cards
          (id, project_id, excerpt_id, comment, role, category_id,
           synthesis_state, created_at, updated_at)
        VALUES
          ('seed-card-1', 'seed-project-tombs', 'seed-excerpt-1',
           '可用于说明空间不是身份的静态镜像，而是社会实践的一部分。',
           'support', 'seed-category-claim', 'active',
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-card-2', 'seed-project-tombs', 'seed-excerpt-2',
           '需要与保存状况和盗扰程度的数据一起使用。',
           'qualify', 'seed-category-counter', 'active',
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-card-3', 'seed-project-tombs', 'seed-excerpt-3',
           '提醒统计分类不能直接替代历史解释。',
           'background', 'seed-category-method', 'active',
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-card-4', 'seed-project-tombs', 'seed-excerpt-4',
           '可以扩展墓地作为持续实践场所的讨论。',
           'support', 'seed-category-inbox', 'active',
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-card-5', 'seed-project-tombs', 'seed-excerpt-5',
           '目前与核心问题关系较弱，先从整理板剔除但保留。',
           'qualify', 'seed-category-counter', 'excluded',
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-card-6', 'seed-project-regions', 'seed-excerpt-6',
           '适合放在讨论传播机制的限定部分。',
           'qualify', 'seed-category-region-inbox', 'active',
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z');

        INSERT INTO tags (id, project_id, name, created_at)
        VALUES
          ('seed-tag-space', 'seed-project-tombs', '墓葬空间', '2026-08-30T00:00:00Z'),
          ('seed-tag-social', 'seed-project-tombs', '社会关系', '2026-08-30T00:00:00Z'),
          ('seed-tag-object', 'seed-project-tombs', '随葬品', '2026-08-30T00:00:00Z'),
          ('seed-tag-method', 'seed-project-tombs', '方法论', '2026-08-30T00:00:00Z'),
          ('seed-tag-memory', 'seed-project-tombs', '社会记忆', '2026-08-30T00:00:00Z'),
          ('seed-tag-kinship', 'seed-project-tombs', '亲属关系', '2026-08-30T00:00:00Z'),
          ('seed-tag-transfer', 'seed-project-regions', '传播机制', '2026-08-30T00:00:00Z');

        INSERT INTO project_card_tags (project_card_id, tag_id)
        VALUES
          ('seed-card-1', 'seed-tag-space'),
          ('seed-card-1', 'seed-tag-social'),
          ('seed-card-2', 'seed-tag-object'),
          ('seed-card-2', 'seed-tag-method'),
          ('seed-card-3', 'seed-tag-method'),
          ('seed-card-4', 'seed-tag-space'),
          ('seed-card-4', 'seed-tag-memory'),
          ('seed-card-5', 'seed-tag-kinship'),
          ('seed-card-6', 'seed-tag-transfer');

        INSERT INTO outline_nodes
          (id, project_id, parent_id, title, notes, core_argument,
           open_questions, sort_order, created_at, updated_at)
        VALUES
          ('seed-outline-1', 'seed-project-tombs', NULL, '第一章 研究问题与材料',
           '说明研究对象、材料范围与分析尺度。',
           '墓葬空间需要作为实践过程而非静态等级表征来分析。',
           '材料保存差异如何进入研究设计？', 1000,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-outline-2', 'seed-project-tombs', NULL, '第二章 墓葬空间的组织方式',
           '从路径、边界和可见性展开。', '空间组织参与社会关系的形成。',
           '如何区分同期规划与长期累积？', 2000,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-outline-2-1', 'seed-project-tombs', 'seed-outline-2',
           '2.1 路径与仪式次序', '', '', '', 1000,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z');

        INSERT INTO outline_card_links
          (id, outline_node_id, project_card_id, note, sort_order, created_at)
        VALUES
          ('seed-link-1', 'seed-outline-1', 'seed-card-3', '', 1000, '2026-08-30T00:00:00Z'),
          ('seed-link-2', 'seed-outline-2', 'seed-card-1', '', 1000, '2026-08-30T00:00:00Z'),
          ('seed-link-3', 'seed-outline-2-1', 'seed-card-4', '', 1000, '2026-08-30T00:00:00Z');

        INSERT INTO app_metadata (key, value)
        VALUES ('database_initialized', '1');
        "#,
    )?;
    transaction.commit()?;
    Ok(())
}
