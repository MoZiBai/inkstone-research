use std::time::Duration;

use rusqlite::{Connection, Result};

pub const SCHEMA_VERSION: i64 = 12;

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

    if current_version < 7 {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS research_roles (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              color TEXT NOT NULL,
              sort_order INTEGER NOT NULL,
              is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
              is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (project_id, name)
            );

            CREATE TABLE IF NOT EXISTS project_card_roles (
              project_card_id TEXT NOT NULL REFERENCES project_cards(id) ON DELETE CASCADE,
              research_role_id TEXT NOT NULL REFERENCES research_roles(id) ON DELETE CASCADE,
              created_at TEXT NOT NULL,
              PRIMARY KEY (project_card_id, research_role_id)
            );

            ALTER TABLE project_cards ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'normal'
              CHECK (origin_kind IN ('normal', 'insight', 'critique'));

            INSERT OR IGNORE INTO research_roles
              (id, project_id, name, color, sort_order, is_default, is_archived,
               created_at, updated_at)
            SELECT 'default-role-' || id || '-support', id, '支持', '#5f7f69', 1000, 1, 0,
                   created_at, updated_at
            FROM projects
            UNION ALL
            SELECT 'default-role-' || id || '-oppose', id, '反对', '#a65e52', 2000, 1, 0,
                   created_at, updated_at
            FROM projects
            UNION ALL
            SELECT 'default-role-' || id || '-qualify', id, '限定', '#7b6d94', 3000, 1, 0,
                   created_at, updated_at
            FROM projects
            UNION ALL
            SELECT 'default-role-' || id || '-background', id, '背景', '#687d8d', 4000, 1, 0,
                   created_at, updated_at
            FROM projects;

            INSERT OR IGNORE INTO project_card_roles
              (project_card_id, research_role_id, created_at)
            SELECT pc.id, rr.id, pc.created_at
            FROM project_cards pc
            JOIN research_roles rr
              ON rr.project_id = pc.project_id
             AND rr.name = CASE pc.role
               WHEN 'support' THEN '支持'
               WHEN 'oppose' THEN '反对'
               WHEN 'qualify' THEN '限定'
               WHEN 'background' THEN '背景'
             END
            WHERE pc.role <> 'unset';

            CREATE INDEX IF NOT EXISTS idx_research_roles_project
              ON research_roles(project_id, is_archived, sort_order);
            CREATE INDEX IF NOT EXISTS idx_project_card_roles_card
              ON project_card_roles(project_card_id);
            CREATE INDEX IF NOT EXISTS idx_project_card_roles_role
              ON project_card_roles(research_role_id);
            "#,
        )?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }

    if current_version < 8 {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS backup_records (
              id TEXT PRIMARY KEY,
              path TEXT NOT NULL UNIQUE,
              kind TEXT NOT NULL CHECK (kind IN ('auto', 'full', 'project')),
              project_id TEXT,
              managed_directory TEXT,
              size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_backup_records_kind_created
              ON backup_records(kind, created_at DESC);
            "#,
        )?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }

    if current_version < 9 {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS document_groups (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              parent_id TEXT REFERENCES document_groups(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              sort_order INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            ALTER TABLE project_documents ADD COLUMN group_id TEXT
              REFERENCES document_groups(id) ON DELETE SET NULL;

            CREATE INDEX IF NOT EXISTS idx_document_groups_tree
              ON document_groups(project_id, parent_id, sort_order);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_document_groups_unique_sibling_name
              ON document_groups(project_id, IFNULL(parent_id, ''), name);
            CREATE INDEX IF NOT EXISTS idx_project_documents_group
              ON project_documents(project_id, group_id, sort_order);
            "#,
        )?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }

    if current_version < 10 {
        connection.execute_batch(
            r#"
            ALTER TABLE documents ADD COLUMN print_page_pdf_anchor INTEGER
              CHECK (print_page_pdf_anchor IS NULL OR print_page_pdf_anchor >= 1);
            ALTER TABLE documents ADD COLUMN print_page_number_anchor INTEGER
              CHECK (print_page_number_anchor IS NULL OR print_page_number_anchor >= 1);
            ALTER TABLE project_cards ADD COLUMN print_page_override TEXT;

            UPDATE project_cards
            SET print_page_override = (
              SELECT NULLIF(TRIM(se.print_page), '')
              FROM source_excerpts se
              WHERE se.id = project_cards.excerpt_id
            )
            WHERE EXISTS (
              SELECT 1 FROM source_excerpts se
              WHERE se.id = project_cards.excerpt_id
                AND NULLIF(TRIM(se.print_page), '') IS NOT NULL
            );
            "#,
        )?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }

    if current_version < 11 {
        connection.execute(
            r#"
            UPDATE app_metadata
            SET value = '24'
            WHERE key = 'backup_automatic_interval_hours'
              AND value NOT IN ('0', '6', '12', '24', '72', '168', '720')
            "#,
            [],
        )?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }

    if current_version < 12 {
        connection.execute_batch(
            r#"
            INSERT INTO app_metadata (key, value)
            SELECT 'backup_automatic_interval_minutes',
                   CASE CAST(value AS INTEGER)
                     WHEN 0 THEN '0'
                     WHEN 6 THEN '360'
                     WHEN 12 THEN '720'
                     ELSE '1440'
                   END
            FROM app_metadata
            WHERE key = 'backup_automatic_interval_hours'
            ON CONFLICT(key) DO NOTHING;

            DELETE FROM app_metadata
            WHERE key = 'backup_automatic_interval_hours';
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
          (id, title, authors, year, file_path, file_hash, created_at, updated_at,
           print_page_pdf_anchor, print_page_number_anchor)
        VALUES
          ('seed-document-space', '从墓葬空间看社会关系的形成', '陈明远', 2022, NULL, NULL,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z', 17, 103),
          ('seed-document-ritual', '仪式、记忆与墓地的空间秩序', '林秋', 2019, NULL, NULL,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z', 9, 57),
          ('seed-document-region', '区域互动与物质文化传播路径', '周宁', 2021, NULL, NULL,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z', 12, 88);

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

        INSERT INTO research_roles
          (id, project_id, name, color, sort_order, is_default, is_archived,
           created_at, updated_at)
        VALUES
          ('seed-role-tombs-support', 'seed-project-tombs', '支持', '#5f7f69', 1000, 1, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-role-tombs-oppose', 'seed-project-tombs', '反对', '#a65e52', 2000, 1, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-role-tombs-qualify', 'seed-project-tombs', '限定', '#7b6d94', 3000, 1, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-role-tombs-background', 'seed-project-tombs', '背景', '#687d8d', 4000, 1, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-role-regions-support', 'seed-project-regions', '支持', '#5f7f69', 1000, 1, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-role-regions-oppose', 'seed-project-regions', '反对', '#a65e52', 2000, 1, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-role-regions-qualify', 'seed-project-regions', '限定', '#7b6d94', 3000, 1, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z'),
          ('seed-role-regions-background', 'seed-project-regions', '背景', '#687d8d', 4000, 1, 0,
           '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z');

        INSERT INTO project_card_roles (project_card_id, research_role_id, created_at)
        VALUES
          ('seed-card-1', 'seed-role-tombs-support', '2026-08-30T00:00:00Z'),
          ('seed-card-2', 'seed-role-tombs-qualify', '2026-08-30T00:00:00Z'),
          ('seed-card-3', 'seed-role-tombs-background', '2026-08-30T00:00:00Z'),
          ('seed-card-4', 'seed-role-tombs-support', '2026-08-30T00:00:00Z'),
          ('seed-card-5', 'seed-role-tombs-qualify', '2026-08-30T00:00:00Z'),
          ('seed-card-6', 'seed-role-regions-qualify', '2026-08-30T00:00:00Z');

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_six_roles_are_migrated_to_project_scoped_relations() {
        let mut connection = Connection::open_in_memory().expect("memory database");
        connection
            .execute_batch(
                r#"
                PRAGMA foreign_keys = ON;
                CREATE TABLE projects (
                  id TEXT PRIMARY KEY,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE project_cards (
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                  excerpt_id TEXT NOT NULL,
                  role TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE documents (
                  id TEXT PRIMARY KEY
                );
                CREATE TABLE source_excerpts (
                  id TEXT PRIMARY KEY,
                  print_page TEXT
                );
                CREATE TABLE app_metadata (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );
                CREATE TABLE project_documents (
                  project_id TEXT NOT NULL,
                  document_id TEXT NOT NULL,
                  sort_order INTEGER NOT NULL,
                  created_at TEXT NOT NULL,
                  removed_at TEXT,
                  PRIMARY KEY (project_id, document_id)
                );
                INSERT INTO projects VALUES ('project-old', '2025-01-01', '2025-01-02');
                INSERT INTO project_cards VALUES ('card-support', 'project-old', 'excerpt-support', 'support', '2025-01-03');
                INSERT INTO project_cards VALUES ('card-unset', 'project-old', 'excerpt-unset', 'unset', '2025-01-04');
                PRAGMA user_version = 6;
                "#,
            )
            .expect("version six fixture");

        migrate_database(&mut connection).expect("migrate database");

        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version");
        let role_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM research_roles WHERE project_id = 'project-old'",
                [],
                |row| row.get(0),
            )
            .expect("default roles");
        let migrated_name: String = connection
            .query_row(
                r#"
                SELECT rr.name
                FROM project_card_roles pcr
                JOIN research_roles rr ON rr.id = pcr.research_role_id
                WHERE pcr.project_card_id = 'card-support'
                "#,
                [],
                |row| row.get(0),
            )
            .expect("migrated support role");
        let unset_links: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM project_card_roles WHERE project_card_id = 'card-unset'",
                [],
                |row| row.get(0),
            )
            .expect("unset links");
        let origin_kind: String = connection
            .query_row(
                "SELECT origin_kind FROM project_cards WHERE id = 'card-support'",
                [],
                |row| row.get(0),
            )
            .expect("origin kind");

        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(role_count, 4);
        assert_eq!(migrated_name, "支持");
        assert_eq!(unset_links, 0);
        assert_eq!(origin_kind, "normal");
    }

    #[test]
    fn version_seven_database_adds_backup_registry() {
        let mut connection = Connection::open_in_memory().expect("memory database");
        migrate_database(&mut connection).expect("create current schema");
        connection
            .execute_batch(
                r#"
                DROP INDEX idx_project_documents_group;
                ALTER TABLE project_documents DROP COLUMN group_id;
                DROP TABLE document_groups;
                DROP TABLE backup_records;
                ALTER TABLE documents DROP COLUMN print_page_pdf_anchor;
                ALTER TABLE documents DROP COLUMN print_page_number_anchor;
                ALTER TABLE project_cards DROP COLUMN print_page_override;
                PRAGMA user_version = 7;
                "#,
            )
            .expect("version seven fixture");

        migrate_database(&mut connection).expect("migrate version seven database");

        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version");
        let table_exists: i64 = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'backup_records')",
                [],
                |row| row.get(0),
            )
            .expect("backup registry table");
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(table_exists, 1);
    }

    #[test]
    fn version_eight_database_adds_hierarchical_document_groups() {
        let mut connection = Connection::open_in_memory().expect("memory database");
        migrate_database(&mut connection).expect("create current schema");
        connection
            .execute_batch(
                r#"
                DROP INDEX idx_project_documents_group;
                ALTER TABLE project_documents DROP COLUMN group_id;
                DROP TABLE document_groups;
                ALTER TABLE documents DROP COLUMN print_page_pdf_anchor;
                ALTER TABLE documents DROP COLUMN print_page_number_anchor;
                ALTER TABLE project_cards DROP COLUMN print_page_override;
                PRAGMA user_version = 8;
                "#,
            )
            .expect("version eight fixture");

        migrate_database(&mut connection).expect("migrate version eight database");

        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version");
        let group_table_exists: i64 = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'document_groups')",
                [],
                |row| row.get(0),
            )
            .expect("document groups table");
        let group_column_exists: i64 = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('project_documents') WHERE name = 'group_id')",
                [],
                |row| row.get(0),
            )
            .expect("project document group column");
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(group_table_exists, 1);
        assert_eq!(group_column_exists, 1);
    }

    #[test]
    fn version_nine_database_adds_print_page_mapping_and_preserves_overrides() {
        let mut connection = Connection::open_in_memory().expect("memory database");
        migrate_database(&mut connection).expect("create current schema");
        connection
            .execute_batch(
                r#"
                INSERT INTO projects
                  (id, name, description, color, sort_order, created_at, updated_at)
                VALUES ('project-print', '页码测试', '', '#9a5d45', 1000, 'now', 'now');
                INSERT INTO documents
                  (id, title, authors, year, file_path, file_hash, created_at, updated_at)
                VALUES ('document-print', '测试文献', '', NULL, NULL, NULL, 'now', 'now');
                INSERT INTO source_excerpts
                  (id, document_id, raw_text, clean_text, pdf_page, print_page, locator_json,
                   context_before, context_after, source_hash, created_at)
                VALUES ('excerpt-print', 'document-print', '原文', '原文', 7, '103', '{}', '', '', NULL, 'now');
                INSERT INTO synthesis_categories
                  (id, project_id, name, color, sort_order, is_default, created_at, updated_at)
                VALUES ('category-print', 'project-print', '待归类', '#999999', 1000, 1, 'now', 'now');
                INSERT INTO project_cards
                  (id, project_id, excerpt_id, comment, role, category_id, synthesis_state,
                   created_at, updated_at, text_override, origin_kind)
                VALUES ('card-print', 'project-print', 'excerpt-print', '', 'unset',
                        'category-print', 'active', 'now', 'now', '', 'normal');

                ALTER TABLE documents DROP COLUMN print_page_pdf_anchor;
                ALTER TABLE documents DROP COLUMN print_page_number_anchor;
                ALTER TABLE project_cards DROP COLUMN print_page_override;
                PRAGMA user_version = 9;
                "#,
            )
            .expect("version nine fixture");

        migrate_database(&mut connection).expect("migrate version nine database");

        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version");
        let override_value: Option<String> = connection
            .query_row(
                "SELECT print_page_override FROM project_cards WHERE id = 'card-print'",
                [],
                |row| row.get(0),
            )
            .expect("migrated print page override");
        let document_columns: i64 = connection
            .query_row(
                r#"
                SELECT COUNT(*) FROM pragma_table_info('documents')
                WHERE name IN ('print_page_pdf_anchor', 'print_page_number_anchor')
                "#,
                [],
                |row| row.get(0),
            )
            .expect("document print page columns");

        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(override_value.as_deref(), Some("103"));
        assert_eq!(document_columns, 2);
    }

    #[test]
    fn version_ten_database_migrates_legacy_backup_hours_to_minutes() {
        let mut connection = Connection::open_in_memory().expect("memory database");
        migrate_database(&mut connection).expect("create current schema");
        connection
            .execute_batch(
                r#"
                INSERT INTO app_metadata (key, value)
                VALUES ('backup_automatic_interval_hours', '6')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value;
                PRAGMA user_version = 10;
                "#,
            )
            .expect("version ten backup settings fixture");

        migrate_database(&mut connection).expect("migrate version ten database");

        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version");
        let interval: String = connection
            .query_row(
                "SELECT value FROM app_metadata WHERE key = 'backup_automatic_interval_minutes'",
                [],
                |row| row.get(0),
            )
            .expect("migrated backup interval");
        let old_key_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM app_metadata WHERE key = 'backup_automatic_interval_hours'",
                [],
                |row| row.get(0),
            )
            .expect("legacy key count");
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(interval, "360");
        assert_eq!(old_key_count, 0);
    }
}
