use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    CreateCardFromSelectionInput, CreateCategoryInput, CreateDocumentInput, CreateOutlineNodeInput,
    CreatePdfAnnotationInput, CreateProjectInput, CreateReadingNoteInput, DocumentSummary,
    ImportPdfInput, ImportPdfResult, MoveOutlineNodeInput, OutlineCardLink, OutlineNode,
    OutlinePlacement, PdfAnnotation, ProjectCardView, ProjectSummary, ReadingNote,
    RemoveDocumentInput, SynthesisCategory, UpdateCardInput, UpdateCategoryInput,
    UpdateDocumentInput, UpdateOutlineNodeInput, WorkspaceSnapshot,
};

use super::schema::{migrate_database, seed_database};

pub struct Repository {
    connection: Connection,
}

impl Repository {
    pub fn open(path: &Path) -> AppResult<Self> {
        let mut connection = Connection::open(path)?;
        migrate_database(&mut connection)?;
        seed_database(&mut connection)?;
        Ok(Self { connection })
    }

    #[cfg(test)]
    fn memory() -> AppResult<Self> {
        let mut connection = Connection::open_in_memory()?;
        migrate_database(&mut connection)?;
        seed_database(&mut connection)?;
        Ok(Self { connection })
    }

    pub fn get_workspace(
        &self,
        requested_project_id: Option<&str>,
    ) -> AppResult<WorkspaceSnapshot> {
        let projects = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT p.id, p.name, p.description, p.color, p.sort_order,
                       (SELECT COUNT(*) FROM project_documents pd
                        WHERE pd.project_id = p.id AND pd.removed_at IS NULL),
                       (SELECT COUNT(*) FROM project_cards pc WHERE pc.project_id = p.id),
                       p.created_at, p.updated_at
                FROM projects p
                ORDER BY p.sort_order, p.created_at
                "#,
            )?;
            let rows = statement.query_map([], |row| {
                Ok(ProjectSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    color: row.get(3)?,
                    sort_order: row.get(4)?,
                    document_count: row.get(5)?,
                    card_count: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let current_project_id = requested_project_id
            .filter(|requested| projects.iter().any(|project| project.id == *requested))
            .map(str::to_owned)
            .or_else(|| projects.first().map(|project| project.id.clone()));

        let Some(project_id) = current_project_id.as_deref() else {
            return Ok(WorkspaceSnapshot {
                projects,
                current_project_id: None,
                documents: Vec::new(),
                categories: Vec::new(),
                cards: Vec::new(),
                pdf_annotations: Vec::new(),
                reading_notes: Vec::new(),
                outline_nodes: Vec::new(),
                outline_links: Vec::new(),
            });
        };

        let documents = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT d.id, d.title, d.authors, d.year,
                       d.journal, d.volume, d.issue, d.pages, d.doi, d.publisher, d.metadata_raw,
                       pd.removed_at IS NOT NULL, d.file_path, d.file_hash, pd.sort_order,
                       COUNT(pc.id) AS card_count,
                       d.created_at, d.updated_at
                FROM project_documents pd
                JOIN documents d ON d.id = pd.document_id
                LEFT JOIN source_excerpts se ON se.document_id = d.id
                LEFT JOIN project_cards pc
                  ON pc.excerpt_id = se.id AND pc.project_id = pd.project_id
                WHERE pd.project_id = ?1
                GROUP BY d.id, pd.sort_order
                ORDER BY (pd.removed_at IS NOT NULL), pd.sort_order, d.title
                "#,
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok(DocumentSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    authors: row.get(2)?,
                    year: row.get(3)?,
                    journal: row.get(4)?,
                    volume: row.get(5)?,
                    issue: row.get(6)?,
                    pages: row.get(7)?,
                    doi: row.get(8)?,
                    publisher: row.get(9)?,
                    metadata_raw: row.get(10)?,
                    is_removed: row.get::<_, i64>(11)? == 1,
                    file_path: row.get(12)?,
                    file_hash: row.get(13)?,
                    sort_order: row.get(14)?,
                    card_count: row.get(15)?,
                    created_at: row.get(16)?,
                    updated_at: row.get(17)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let categories = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT id, project_id, name, color, sort_order, is_default,
                       created_at, updated_at
                FROM synthesis_categories
                WHERE project_id = ?1
                ORDER BY sort_order, created_at
                "#,
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok(SynthesisCategory {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    name: row.get(2)?,
                    color: row.get(3)?,
                    sort_order: row.get(4)?,
                    is_default: row.get::<_, i64>(5)? == 1,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let cards = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT pc.id, pc.project_id, pc.excerpt_id,
                       d.id, d.title, d.authors, d.year,
                       se.raw_text, se.clean_text, se.pdf_page, se.print_page,
                       se.locator_json, se.context_before, se.context_after, se.source_hash,
                       pc.comment, pc.role, pc.category_id, pc.synthesis_state,
                       COALESCE(GROUP_CONCAT(t.name, char(31)), ''),
                       pc.created_at, pc.updated_at
                FROM project_cards pc
                JOIN source_excerpts se ON se.id = pc.excerpt_id
                JOIN documents d ON d.id = se.document_id
                LEFT JOIN project_card_tags pct ON pct.project_card_id = pc.id
                LEFT JOIN tags t ON t.id = pct.tag_id
                WHERE pc.project_id = ?1
                GROUP BY pc.id
                ORDER BY d.title, pc.created_at
                "#,
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                let tags_value: String = row.get(19)?;
                let tags = if tags_value.is_empty() {
                    Vec::new()
                } else {
                    tags_value.split('\u{1f}').map(str::to_owned).collect()
                };
                Ok(ProjectCardView {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    excerpt_id: row.get(2)?,
                    document_id: row.get(3)?,
                    document_title: row.get(4)?,
                    document_authors: row.get(5)?,
                    document_year: row.get(6)?,
                    raw_text: row.get(7)?,
                    clean_text: row.get(8)?,
                    pdf_page: row.get(9)?,
                    print_page: row.get(10)?,
                    locator_json: row.get(11)?,
                    context_before: row.get(12)?,
                    context_after: row.get(13)?,
                    source_hash: row.get(14)?,
                    comment: row.get(15)?,
                    role: row.get(16)?,
                    category_id: row.get(17)?,
                    synthesis_state: row.get(18)?,
                    tags,
                    created_at: row.get(20)?,
                    updated_at: row.get(21)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let pdf_annotations = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT id, project_id, document_id, kind, page_number, color,
                       selected_text, locator_json, comment, created_at, updated_at
                FROM pdf_annotations
                WHERE project_id = ?1
                ORDER BY document_id, page_number, created_at
                "#,
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok(PdfAnnotation {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    document_id: row.get(2)?,
                    kind: row.get(3)?,
                    page_number: row.get(4)?,
                    color: row.get(5)?,
                    selected_text: row.get(6)?,
                    locator_json: row.get(7)?,
                    comment: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let reading_notes = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT id, project_id, document_id, kind, content, selected_text,
                       page_number, locator_json, created_at, updated_at
                FROM reading_notes
                WHERE project_id = ?1
                ORDER BY document_id, created_at DESC
                "#,
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok(ReadingNote {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    document_id: row.get(2)?,
                    kind: row.get(3)?,
                    content: row.get(4)?,
                    selected_text: row.get(5)?,
                    page_number: row.get(6)?,
                    locator_json: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let outline_nodes = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT id, project_id, parent_id, title, notes, core_argument,
                       open_questions, sort_order, created_at, updated_at
                FROM outline_nodes
                WHERE project_id = ?1
                ORDER BY parent_id, sort_order, created_at
                "#,
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok(OutlineNode {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    parent_id: row.get(2)?,
                    title: row.get(3)?,
                    notes: row.get(4)?,
                    core_argument: row.get(5)?,
                    open_questions: row.get(6)?,
                    sort_order: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let outline_links = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT ocl.id, ocl.outline_node_id, ocl.project_card_id,
                       ocl.note, ocl.sort_order, ocl.created_at
                FROM outline_card_links ocl
                JOIN outline_nodes node ON node.id = ocl.outline_node_id
                WHERE node.project_id = ?1
                ORDER BY ocl.outline_node_id, ocl.sort_order, ocl.created_at
                "#,
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok(OutlineCardLink {
                    id: row.get(0)?,
                    outline_node_id: row.get(1)?,
                    project_card_id: row.get(2)?,
                    note: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        Ok(WorkspaceSnapshot {
            projects,
            current_project_id,
            documents,
            categories,
            cards,
            pdf_annotations,
            reading_notes,
            outline_nodes,
            outline_links,
        })
    }

    pub fn create_project(&mut self, input: CreateProjectInput) -> AppResult<String> {
        let name = required_text(&input.name, "项目名称")?;
        let color = validated_color(input.color.as_deref().unwrap_or("#9a5d45"))?;
        let now = timestamp();
        let project_id = Uuid::new_v4().to_string();
        let category_id = Uuid::new_v4().to_string();
        let transaction = self.connection.transaction()?;
        let sort_order: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM projects",
            [],
            |row| row.get(0),
        )?;
        transaction.execute(
            r#"
            INSERT INTO projects
              (id, name, description, color, sort_order, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
            "#,
            params![
                project_id,
                name,
                input.description.trim(),
                color,
                sort_order,
                now
            ],
        )?;
        transaction.execute(
            r#"
            INSERT INTO synthesis_categories
              (id, project_id, name, color, sort_order, is_default, created_at, updated_at)
            VALUES (?1, ?2, '待归类', '#9a9a8d', 1000, 1, ?3, ?3)
            "#,
            params![category_id, project_id, now],
        )?;
        transaction.commit()?;
        Ok(project_id)
    }

    pub fn create_document(&mut self, input: CreateDocumentInput) -> AppResult<String> {
        let metadata = normalize_document_metadata(
            &input.title,
            &input.authors,
            input.year,
            &input.journal,
            &input.volume,
            &input.issue,
            &input.pages,
            &input.doi,
            &input.publisher,
            &input.metadata_raw,
        )?;
        ensure_project_exists(&self.connection, &input.project_id)?;

        let document_id = Uuid::new_v4().to_string();
        let now = timestamp();
        let transaction = self.connection.transaction()?;
        let sort_order: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM project_documents WHERE project_id = ?1",
            params![input.project_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            r#"
            INSERT INTO documents
              (id, title, authors, year, journal, volume, issue, pages, doi,
               publisher, metadata_raw, file_path, file_hash, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, ?12, ?12)
            "#,
            params![
                document_id,
                metadata.title,
                metadata.authors,
                metadata.year,
                metadata.journal,
                metadata.volume,
                metadata.issue,
                metadata.pages,
                metadata.doi,
                metadata.publisher,
                metadata.metadata_raw,
                now
            ],
        )?;
        transaction.execute(
            r#"
            INSERT INTO project_documents (project_id, document_id, sort_order, created_at)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![input.project_id, document_id, sort_order, now],
        )?;
        transaction.commit()?;
        Ok(document_id)
    }

    pub fn update_document(&mut self, input: UpdateDocumentInput) -> AppResult<()> {
        let metadata = normalize_document_metadata(
            &input.title,
            &input.authors,
            input.year,
            &input.journal,
            &input.volume,
            &input.issue,
            &input.pages,
            &input.doi,
            &input.publisher,
            &input.metadata_raw,
        )?;
        let changed = self.connection.execute(
            r#"
            UPDATE documents
            SET title = ?1, authors = ?2, year = ?3, journal = ?4, volume = ?5,
                issue = ?6, pages = ?7, doi = ?8, publisher = ?9, metadata_raw = ?10,
                updated_at = ?11
            WHERE id = ?12
            "#,
            params![
                metadata.title,
                metadata.authors,
                metadata.year,
                metadata.journal,
                metadata.volume,
                metadata.issue,
                metadata.pages,
                metadata.doi,
                metadata.publisher,
                metadata.metadata_raw,
                timestamp(),
                input.document_id
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("文献".into()));
        }
        Ok(())
    }

    pub fn remove_document(&mut self, input: RemoveDocumentInput) -> AppResult<Option<PathBuf>> {
        let relation_exists: i64 = self.connection.query_row(
            r#"
            SELECT EXISTS(
              SELECT 1 FROM project_documents
              WHERE project_id = ?1 AND document_id = ?2
            )
            "#,
            params![input.project_id, input.document_id],
            |row| row.get(0),
        )?;
        if relation_exists == 0 {
            return Err(AppError::NotFound("当前项目中的文献".into()));
        }

        if input.keep_cards {
            self.connection.execute(
                r#"
                UPDATE project_documents
                SET removed_at = ?1
                WHERE project_id = ?2 AND document_id = ?3
                "#,
                params![timestamp(), input.project_id, input.document_id],
            )?;
            return Ok(None);
        }

        let transaction = self.connection.transaction()?;
        transaction.execute(
            r#"
            DELETE FROM project_cards
            WHERE project_id = ?1 AND excerpt_id IN (
              SELECT id FROM source_excerpts WHERE document_id = ?2
            )
            "#,
            params![input.project_id, input.document_id],
        )?;
        transaction.execute(
            "DELETE FROM pdf_annotations WHERE project_id = ?1 AND document_id = ?2",
            params![input.project_id, input.document_id],
        )?;
        transaction.execute(
            "DELETE FROM reading_notes WHERE project_id = ?1 AND document_id = ?2",
            params![input.project_id, input.document_id],
        )?;
        transaction.execute(
            "DELETE FROM project_documents WHERE project_id = ?1 AND document_id = ?2",
            params![input.project_id, input.document_id],
        )?;

        let remaining_relations: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM project_documents WHERE document_id = ?1",
            params![input.document_id],
            |row| row.get(0),
        )?;
        let remaining_cards: i64 = transaction.query_row(
            r#"
            SELECT COUNT(*)
            FROM project_cards pc
            JOIN source_excerpts se ON se.id = pc.excerpt_id
            WHERE se.document_id = ?1
            "#,
            params![input.document_id],
            |row| row.get(0),
        )?;

        let mut discarded_path = None;
        if remaining_relations == 0 && remaining_cards == 0 {
            let file_path: Option<String> = transaction
                .query_row(
                    "SELECT file_path FROM documents WHERE id = ?1",
                    params![input.document_id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            transaction.execute(
                "DELETE FROM source_excerpts WHERE document_id = ?1",
                params![input.document_id],
            )?;
            transaction.execute(
                "DELETE FROM documents WHERE id = ?1",
                params![input.document_id],
            )?;
            if let Some(path) = file_path {
                let path_references: i64 = transaction.query_row(
                    "SELECT COUNT(*) FROM documents WHERE file_path = ?1",
                    params![path],
                    |row| row.get(0),
                )?;
                if path_references == 0 {
                    discarded_path = Some(PathBuf::from(path));
                }
            }
        }

        transaction.commit()?;
        Ok(discarded_path)
    }

    pub fn restore_document(&mut self, project_id: &str, document_id: &str) -> AppResult<()> {
        let changed = self.connection.execute(
            r#"
            UPDATE project_documents
            SET removed_at = NULL
            WHERE project_id = ?1 AND document_id = ?2 AND removed_at IS NOT NULL
            "#,
            params![project_id, document_id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("已移除的文献".into()));
        }
        Ok(())
    }

    pub fn register_imported_pdf(
        &mut self,
        input: &ImportPdfInput,
        managed_path: &Path,
        file_hash: &str,
        reused_managed_file: bool,
    ) -> AppResult<ImportPdfResult> {
        let metadata = normalize_document_metadata(
            &input.title,
            &input.authors,
            input.year,
            &input.journal,
            &input.volume,
            &input.issue,
            &input.pages,
            &input.doi,
            &input.publisher,
            &input.metadata_raw,
        )?;
        ensure_project_exists(&self.connection, &input.project_id)?;

        let now = timestamp();
        let managed_path = managed_path.to_string_lossy().into_owned();
        let transaction = self.connection.transaction()?;
        let (document_id, reused_document) = if let Some(target_document_id) =
            input.target_document_id.as_deref()
        {
            let current_file_path = transaction
                .query_row(
                    r#"
                        SELECT d.file_path
                        FROM documents d
                        JOIN project_documents pd ON pd.document_id = d.id
                        WHERE d.id = ?1 AND pd.project_id = ?2
                        "#,
                    params![target_document_id, input.project_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .ok_or_else(|| AppError::NotFound("当前项目中的文献".into()))?;
            if current_file_path.is_some() {
                return Err(AppError::Validation(
                    "这篇文献已经连接 PDF；为避免改变已有摘录的来源，本阶段不允许直接替换。".into(),
                ));
            }
            transaction.execute(
                r#"
                    UPDATE documents
                    SET title = ?1, authors = ?2, year = ?3, journal = ?4,
                        volume = ?5, issue = ?6, pages = ?7, doi = ?8,
                        publisher = ?9, metadata_raw = ?10, file_path = ?11,
                        file_hash = ?12, updated_at = ?13
                    WHERE id = ?14
                    "#,
                params![
                    metadata.title,
                    metadata.authors,
                    metadata.year,
                    metadata.journal,
                    metadata.volume,
                    metadata.issue,
                    metadata.pages,
                    metadata.doi,
                    metadata.publisher,
                    metadata.metadata_raw,
                    managed_path,
                    file_hash,
                    now,
                    target_document_id
                ],
            )?;
            (target_document_id.to_owned(), false)
        } else if let Some(existing_id) = transaction
            .query_row(
                "SELECT id FROM documents WHERE file_hash = ?1 ORDER BY created_at LIMIT 1",
                params![file_hash],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            (existing_id, true)
        } else {
            let document_id = Uuid::new_v4().to_string();
            transaction.execute(
                r#"
                    INSERT INTO documents
                      (id, title, authors, year, journal, volume, issue, pages, doi,
                       publisher, metadata_raw, file_path, file_hash, created_at, updated_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
                    "#,
                params![
                    document_id,
                    metadata.title,
                    metadata.authors,
                    metadata.year,
                    metadata.journal,
                    metadata.volume,
                    metadata.issue,
                    metadata.pages,
                    metadata.doi,
                    metadata.publisher,
                    metadata.metadata_raw,
                    managed_path,
                    file_hash,
                    now
                ],
            )?;
            (document_id, false)
        };

        let already_linked: i64 = transaction.query_row(
            r#"
            SELECT EXISTS(
              SELECT 1 FROM project_documents WHERE project_id = ?1 AND document_id = ?2
            )
            "#,
            params![input.project_id, document_id],
            |row| row.get(0),
        )?;
        if already_linked == 0 {
            let sort_order: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM project_documents WHERE project_id = ?1",
                params![input.project_id],
                |row| row.get(0),
            )?;
            transaction.execute(
                r#"
                INSERT INTO project_documents (project_id, document_id, sort_order, created_at)
                VALUES (?1, ?2, ?3, ?4)
                "#,
                params![input.project_id, document_id, sort_order, now],
            )?;
        }
        transaction.commit()?;

        Ok(ImportPdfResult {
            document_id,
            reused_managed_file,
            reused_document,
        })
    }

    pub fn pdf_path(&self, document_id: &str) -> AppResult<PathBuf> {
        let file_path = self
            .connection
            .query_row(
                "SELECT file_path FROM documents WHERE id = ?1",
                params![document_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("文献".into()))?
            .ok_or_else(|| AppError::Validation("这篇文献尚未连接 PDF 文件。".into()))?;
        Ok(PathBuf::from(file_path))
    }

    pub fn create_card_from_selection(
        &mut self,
        input: CreateCardFromSelectionInput,
    ) -> AppResult<String> {
        validate_role(&input.role)?;
        validate_selection_text(&input.raw_text)?;
        validate_locator(&input.locator_json, input.pdf_page)?;
        let normalized_tags = normalize_tags(&input.tags)?;
        ensure_project_document(&self.connection, &input.project_id, &input.document_id)?;

        let source_hash: Option<String> = self.connection.query_row(
            "SELECT file_hash FROM documents WHERE id = ?1",
            params![input.document_id],
            |row| row.get(0),
        )?;
        let now = timestamp();
        let transaction = self.connection.transaction()?;
        let excerpt_id = transaction
            .query_row(
                r#"
                SELECT id
                FROM source_excerpts
                WHERE document_id = ?1 AND raw_text = ?2 AND pdf_page = ?3
                  AND locator_json = ?4
                LIMIT 1
                "#,
                params![
                    input.document_id,
                    input.raw_text,
                    input.pdf_page,
                    input.locator_json
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let excerpt_exists: i64 = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM source_excerpts WHERE id = ?1)",
            params![excerpt_id],
            |row| row.get(0),
        )?;
        if excerpt_exists == 0 {
            transaction.execute(
                r#"
                INSERT INTO source_excerpts
                  (id, document_id, raw_text, clean_text, pdf_page, print_page,
                   locator_json, context_before, context_after, source_hash, created_at)
                VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
                params![
                    excerpt_id,
                    input.document_id,
                    input.raw_text,
                    input.pdf_page,
                    input.print_page.as_deref().map(str::trim),
                    input.locator_json,
                    input.context_before.trim(),
                    input.context_after.trim(),
                    source_hash,
                    now
                ],
            )?;
        }

        ensure_selection_highlight(
            &transaction,
            &input.project_id,
            &input.document_id,
            input.pdf_page,
            &input.raw_text,
            &input.locator_json,
            &now,
        )?;

        if let Some(existing_card_id) = transaction
            .query_row(
                "SELECT id FROM project_cards WHERE project_id = ?1 AND excerpt_id = ?2",
                params![input.project_id, excerpt_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            transaction.commit()?;
            return Ok(existing_card_id);
        }

        let category_id: String = transaction
            .query_row(
                r#"
                SELECT id FROM synthesis_categories
                WHERE project_id = ?1 AND is_default = 1 LIMIT 1
                "#,
                params![input.project_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::Validation("当前项目缺少默认整理分类。".into()))?;
        let card_id = Uuid::new_v4().to_string();
        transaction.execute(
            r#"
            INSERT INTO project_cards
              (id, project_id, excerpt_id, comment, role, category_id,
               synthesis_state, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)
            "#,
            params![
                card_id,
                input.project_id,
                excerpt_id,
                input.comment.trim(),
                input.role,
                category_id,
                now
            ],
        )?;
        write_card_tags(
            &transaction,
            &input.project_id,
            &card_id,
            normalized_tags,
            &now,
        )?;
        transaction.commit()?;
        Ok(card_id)
    }

    pub fn create_pdf_annotation(&mut self, input: CreatePdfAnnotationInput) -> AppResult<String> {
        if !["highlight", "underline"].contains(&input.kind.as_str()) {
            return Err(AppError::Validation("PDF 批注类型无效。".into()));
        }
        let color = validated_color(&input.color)?;
        validate_selection_text(&input.selected_text)?;
        validate_locator(&input.locator_json, input.page_number)?;
        ensure_project_document(&self.connection, &input.project_id, &input.document_id)?;

        let id = Uuid::new_v4().to_string();
        let now = timestamp();
        self.connection.execute(
            r#"
            INSERT INTO pdf_annotations
              (id, project_id, document_id, kind, page_number, color,
               selected_text, locator_json, comment, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
            "#,
            params![
                id,
                input.project_id,
                input.document_id,
                input.kind,
                input.page_number,
                color,
                input.selected_text,
                input.locator_json,
                input.comment.trim(),
                now
            ],
        )?;
        Ok(id)
    }

    pub fn delete_pdf_annotation(&mut self, annotation_id: &str) -> AppResult<()> {
        let changed = self.connection.execute(
            "DELETE FROM pdf_annotations WHERE id = ?1",
            params![annotation_id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("PDF 批注".into()));
        }
        Ok(())
    }

    pub fn create_reading_note(&mut self, input: CreateReadingNoteInput) -> AppResult<String> {
        if !["insight", "critique"].contains(&input.kind.as_str()) {
            return Err(AppError::Validation("阅读笔记类型无效。".into()));
        }
        let content = required_long_text(&input.content, "阅读笔记", 20_000)?;
        let selected_text = limited_text(&input.selected_text, "关联原文", 50_000)?;
        match input.page_number {
            Some(page_number) => {
                if input.locator_json.trim().is_empty() {
                    return Err(AppError::Validation(
                        "带页码的阅读笔记缺少原文位置。".into(),
                    ));
                }
                validate_locator(&input.locator_json, page_number)?;
                ensure_project_document(
                    &self.connection,
                    &input.project_id,
                    &input.document_id,
                )?;
            }
            None if !input.locator_json.trim().is_empty() || !selected_text.is_empty() => {
                return Err(AppError::Validation(
                    "关联原文的阅读笔记缺少 PDF 页码。".into(),
                ));
            }
            None => ensure_project_document_relation(
                &self.connection,
                &input.project_id,
                &input.document_id,
            )?,
        }

        let note_id = Uuid::new_v4().to_string();
        let now = timestamp();
        self.connection.execute(
            r#"
            INSERT INTO reading_notes
              (id, project_id, document_id, kind, content, selected_text,
               page_number, locator_json, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
            "#,
            params![
                note_id,
                input.project_id,
                input.document_id,
                input.kind,
                content,
                selected_text,
                input.page_number,
                input.locator_json.trim(),
                now
            ],
        )?;
        Ok(note_id)
    }

    pub fn delete_reading_note(&mut self, note_id: &str) -> AppResult<()> {
        let changed = self
            .connection
            .execute("DELETE FROM reading_notes WHERE id = ?1", params![note_id])?;
        if changed == 0 {
            return Err(AppError::NotFound("阅读笔记".into()));
        }
        Ok(())
    }

    pub fn update_card(&mut self, input: UpdateCardInput) -> AppResult<()> {
        validate_role(&input.role)?;
        let normalized_tags = input
            .tags
            .iter()
            .map(|tag| tag.trim())
            .filter(|tag| !tag.is_empty())
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        if normalized_tags.len() > 24 {
            return Err(AppError::Validation("单张卡片最多使用 24 个标签。".into()));
        }

        let now = timestamp();
        let transaction = self.connection.transaction()?;
        let project_id: String = transaction
            .query_row(
                "SELECT project_id FROM project_cards WHERE id = ?1",
                params![input.card_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("卡片".into()))?;
        transaction.execute(
            "UPDATE project_cards SET comment = ?1, role = ?2, updated_at = ?3 WHERE id = ?4",
            params![input.comment.trim(), input.role, now, input.card_id],
        )?;
        transaction.execute(
            "DELETE FROM project_card_tags WHERE project_card_id = ?1",
            params![input.card_id],
        )?;
        for tag_name in normalized_tags {
            transaction.execute(
                r#"
                INSERT INTO tags (id, project_id, name, created_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(project_id, name) DO NOTHING
                "#,
                params![Uuid::new_v4().to_string(), project_id, tag_name, now],
            )?;
            let tag_id: String = transaction.query_row(
                "SELECT id FROM tags WHERE project_id = ?1 AND name = ?2",
                params![project_id, tag_name],
                |row| row.get(0),
            )?;
            transaction.execute(
                "INSERT INTO project_card_tags (project_card_id, tag_id) VALUES (?1, ?2)",
                params![input.card_id, tag_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn move_card(&mut self, card_id: &str, category_id: &str) -> AppResult<()> {
        let valid: i64 = self.connection.query_row(
            r#"
            SELECT EXISTS(
              SELECT 1
              FROM project_cards pc
              JOIN synthesis_categories sc ON sc.id = ?2 AND sc.project_id = pc.project_id
              WHERE pc.id = ?1
            )
            "#,
            params![card_id, category_id],
            |row| row.get(0),
        )?;
        if valid != 1 {
            return Err(AppError::Validation(
                "卡片和整理分类不属于同一项目。".into(),
            ));
        }
        self.connection.execute(
            r#"
            UPDATE project_cards
            SET category_id = ?1, synthesis_state = 'active', updated_at = ?2
            WHERE id = ?3
            "#,
            params![category_id, timestamp(), card_id],
        )?;
        Ok(())
    }

    pub fn set_card_excluded(&mut self, card_id: &str, excluded: bool) -> AppResult<()> {
        let changed = self.connection.execute(
            "UPDATE project_cards SET synthesis_state = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                if excluded { "excluded" } else { "active" },
                timestamp(),
                card_id
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("卡片".into()));
        }
        Ok(())
    }

    pub fn delete_card(&mut self, card_id: &str) -> AppResult<()> {
        let changed = self
            .connection
            .execute("DELETE FROM project_cards WHERE id = ?1", params![card_id])?;
        if changed == 0 {
            return Err(AppError::NotFound("卡片".into()));
        }
        Ok(())
    }

    pub fn create_category(&mut self, input: CreateCategoryInput) -> AppResult<String> {
        let name = required_text(&input.name, "分类名称")?;
        let color = validated_color(&input.color)?;
        ensure_project_exists(&self.connection, &input.project_id)?;
        let sort_order: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM synthesis_categories WHERE project_id = ?1",
            params![input.project_id],
            |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let now = timestamp();
        self.connection.execute(
            r#"
            INSERT INTO synthesis_categories
              (id, project_id, name, color, sort_order, is_default, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)
            "#,
            params![id, input.project_id, name, color, sort_order, now],
        )?;
        Ok(id)
    }

    pub fn update_category(&mut self, input: UpdateCategoryInput) -> AppResult<()> {
        let name = required_text(&input.name, "分类名称")?;
        let color = validated_color(&input.color)?;
        let changed = self.connection.execute(
            "UPDATE synthesis_categories SET name = ?1, color = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, color, timestamp(), input.category_id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("整理分类".into()));
        }
        Ok(())
    }

    pub fn delete_category(&mut self, category_id: &str) -> AppResult<()> {
        let transaction = self.connection.transaction()?;
        let category: (String, bool) = transaction
            .query_row(
                "SELECT project_id, is_default FROM synthesis_categories WHERE id = ?1",
                params![category_id],
                |row| Ok((row.get(0)?, row.get::<_, i64>(1)? == 1)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("整理分类".into()))?;
        if category.1 {
            return Err(AppError::Validation("项目的默认整理分类不能删除。".into()));
        }

        let default_category_id: String = transaction
            .query_row(
                r#"
                SELECT id
                FROM synthesis_categories
                WHERE project_id = ?1 AND is_default = 1
                LIMIT 1
                "#,
                params![category.0],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::Validation("当前项目缺少默认整理分类。".into()))?;
        transaction.execute(
            r#"
            UPDATE project_cards
            SET category_id = ?1, updated_at = ?2
            WHERE category_id = ?3
            "#,
            params![default_category_id, timestamp(), category_id],
        )?;
        transaction.execute(
            "DELETE FROM synthesis_categories WHERE id = ?1",
            params![category_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn reorder_categories(
        &mut self,
        project_id: &str,
        ordered_ids: &[String],
    ) -> AppResult<()> {
        let existing = {
            let mut statement = self.connection.prepare(
                "SELECT id FROM synthesis_categories WHERE project_id = ?1 ORDER BY sort_order",
            )?;
            let rows = statement.query_map(params![project_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<BTreeSet<_>, _>>()?
        };
        let requested = ordered_ids.iter().cloned().collect::<BTreeSet<_>>();
        if existing != requested || existing.len() != ordered_ids.len() {
            return Err(AppError::Validation(
                "分类排序必须包含当前项目的全部分类且不能重复。".into(),
            ));
        }
        let transaction = self.connection.transaction()?;
        for (index, category_id) in ordered_ids.iter().enumerate() {
            transaction.execute(
                "UPDATE synthesis_categories SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
                params![(index as i64 + 1) * 1000, timestamp(), category_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn create_outline_node(&mut self, input: CreateOutlineNodeInput) -> AppResult<String> {
        let title = required_text(&input.title, "章节标题")?;
        ensure_project_exists(&self.connection, &input.project_id)?;
        if let Some(parent_id) = input.parent_id.as_deref() {
            let parent_project: Option<String> = self
                .connection
                .query_row(
                    "SELECT project_id FROM outline_nodes WHERE id = ?1",
                    params![parent_id],
                    |row| row.get(0),
                )
                .optional()?;
            if parent_project.as_deref() != Some(input.project_id.as_str()) {
                return Err(AppError::Validation("父章节不属于当前项目。".into()));
            }
        }
        let sort_order: i64 = self.connection.query_row(
            r#"
            SELECT COALESCE(MAX(sort_order), 0) + 1000
            FROM outline_nodes
            WHERE project_id = ?1 AND parent_id IS ?2
            "#,
            params![input.project_id, input.parent_id],
            |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let now = timestamp();
        self.connection.execute(
            r#"
            INSERT INTO outline_nodes
              (id, project_id, parent_id, title, notes, core_argument,
               open_questions, sort_order, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, '', '', '', ?5, ?6, ?6)
            "#,
            params![
                id,
                input.project_id,
                input.parent_id,
                title,
                sort_order,
                now
            ],
        )?;
        Ok(id)
    }

    pub fn update_outline_node(&mut self, input: UpdateOutlineNodeInput) -> AppResult<()> {
        let title = required_text(&input.title, "章节标题")?;
        let changed = self.connection.execute(
            r#"
            UPDATE outline_nodes
            SET title = ?1, notes = ?2, core_argument = ?3,
                open_questions = ?4, updated_at = ?5
            WHERE id = ?6
            "#,
            params![
                title,
                input.notes.trim(),
                input.core_argument.trim(),
                input.open_questions.trim(),
                timestamp(),
                input.node_id
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("提纲章节".into()));
        }
        Ok(())
    }

    pub fn move_outline_node(&mut self, input: MoveOutlineNodeInput) -> AppResult<()> {
        if input.node_id == input.target_node_id {
            return Err(AppError::Validation("章节不能移动到自身。".into()));
        }
        let transaction = self.connection.transaction()?;
        let moving: (String, Option<String>) = transaction
            .query_row(
                "SELECT project_id, parent_id FROM outline_nodes WHERE id = ?1",
                params![input.node_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("待移动章节".into()))?;
        let target: (String, Option<String>) = transaction
            .query_row(
                "SELECT project_id, parent_id FROM outline_nodes WHERE id = ?1",
                params![input.target_node_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("目标章节".into()))?;
        if moving.0 != target.0 {
            return Err(AppError::Validation("不能跨项目移动章节。".into()));
        }

        let target_is_descendant: i64 = transaction.query_row(
            r#"
            WITH RECURSIVE descendants(id) AS (
              SELECT id FROM outline_nodes WHERE parent_id = ?1
              UNION ALL
              SELECT node.id
              FROM outline_nodes node
              JOIN descendants child ON node.parent_id = child.id
            )
            SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)
            "#,
            params![input.node_id, input.target_node_id],
            |row| row.get(0),
        )?;
        if target_is_descendant == 1 {
            return Err(AppError::Validation(
                "不能把章节移动到其子章节内部。".into(),
            ));
        }

        let new_parent = match input.placement {
            OutlinePlacement::Inside => Some(input.target_node_id.clone()),
            OutlinePlacement::Before | OutlinePlacement::After => target.1.clone(),
        };
        let mut new_sibling_ids = sibling_ids(
            &transaction,
            &moving.0,
            new_parent.as_deref(),
            Some(&input.node_id),
        )?;
        match input.placement {
            OutlinePlacement::Inside => new_sibling_ids.push(input.node_id.clone()),
            OutlinePlacement::Before | OutlinePlacement::After => {
                let target_index = new_sibling_ids
                    .iter()
                    .position(|id| id == &input.target_node_id)
                    .ok_or_else(|| AppError::Validation("目标章节顺序无效。".into()))?;
                let insert_index = if matches!(input.placement, OutlinePlacement::After) {
                    target_index + 1
                } else {
                    target_index
                };
                new_sibling_ids.insert(insert_index, input.node_id.clone());
            }
        }

        transaction.execute(
            "UPDATE outline_nodes SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_parent, timestamp(), input.node_id],
        )?;
        write_outline_node_order(&transaction, &new_sibling_ids)?;
        if moving.1 != new_parent {
            let old_siblings = sibling_ids(
                &transaction,
                &moving.0,
                moving.1.as_deref(),
                Some(&input.node_id),
            )?;
            write_outline_node_order(&transaction, &old_siblings)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn delete_outline_node(&mut self, node_id: &str) -> AppResult<()> {
        let changed = self
            .connection
            .execute("DELETE FROM outline_nodes WHERE id = ?1", params![node_id])?;
        if changed == 0 {
            return Err(AppError::NotFound("提纲章节".into()));
        }
        Ok(())
    }

    pub fn link_card_to_outline(&mut self, node_id: &str, card_id: &str) -> AppResult<String> {
        let valid: i64 = self.connection.query_row(
            r#"
            SELECT EXISTS(
              SELECT 1
              FROM outline_nodes node
              JOIN project_cards card ON card.id = ?2 AND card.project_id = node.project_id
              WHERE node.id = ?1
            )
            "#,
            params![node_id, card_id],
            |row| row.get(0),
        )?;
        if valid != 1 {
            return Err(AppError::Validation(
                "卡片和提纲章节不属于同一项目。".into(),
            ));
        }
        if let Some(existing_id) = self
            .connection
            .query_row(
                "SELECT id FROM outline_card_links WHERE outline_node_id = ?1 AND project_card_id = ?2",
                params![node_id, card_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(existing_id);
        }

        let sort_order: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM outline_card_links WHERE outline_node_id = ?1",
            params![node_id],
            |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        self.connection.execute(
            r#"
            INSERT INTO outline_card_links
              (id, outline_node_id, project_card_id, note, sort_order, created_at)
            VALUES (?1, ?2, ?3, '', ?4, ?5)
            "#,
            params![id, node_id, card_id, sort_order, timestamp()],
        )?;
        Ok(id)
    }

    pub fn remove_outline_link(&mut self, link_id: &str) -> AppResult<()> {
        let changed = self.connection.execute(
            "DELETE FROM outline_card_links WHERE id = ?1",
            params![link_id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("章节卡片关联".into()));
        }
        Ok(())
    }

    pub fn move_outline_card(&mut self, link_id: &str, direction: i64) -> AppResult<()> {
        if ![-1, 1].contains(&direction) {
            return Err(AppError::Validation("卡片排序方向无效。".into()));
        }
        let transaction = self.connection.transaction()?;
        let node_id: String = transaction
            .query_row(
                "SELECT outline_node_id FROM outline_card_links WHERE id = ?1",
                params![link_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("章节卡片关联".into()))?;
        let mut links = {
            let mut statement = transaction.prepare(
                "SELECT id FROM outline_card_links WHERE outline_node_id = ?1 ORDER BY sort_order, created_at",
            )?;
            let rows = statement.query_map(params![node_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let current = links
            .iter()
            .position(|id| id == link_id)
            .ok_or_else(|| AppError::NotFound("章节卡片关联".into()))?;
        let next = current as i64 + direction;
        if next < 0 || next >= links.len() as i64 {
            return Ok(());
        }
        links.swap(current, next as usize);
        write_outline_link_order(&transaction, &links)?;
        transaction.commit()?;
        Ok(())
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339()
}

struct NormalizedDocumentMetadata {
    title: String,
    authors: String,
    year: Option<i64>,
    journal: String,
    volume: String,
    issue: String,
    pages: String,
    doi: String,
    publisher: String,
    metadata_raw: String,
}

#[allow(clippy::too_many_arguments)]
fn normalize_document_metadata(
    title: &str,
    authors: &str,
    year: Option<i64>,
    journal: &str,
    volume: &str,
    issue: &str,
    pages: &str,
    doi: &str,
    publisher: &str,
    metadata_raw: &str,
) -> AppResult<NormalizedDocumentMetadata> {
    if year.is_some_and(|value| !(1..=3000).contains(&value)) {
        return Err(AppError::Validation("文献年份超出合理范围。".into()));
    }
    Ok(NormalizedDocumentMetadata {
        title: required_text(title, "文献标题")?,
        authors: limited_text(authors, "作者", 1_000)?,
        year,
        journal: limited_text(journal, "期刊或来源", 500)?,
        volume: limited_text(volume, "卷号", 120)?,
        issue: limited_text(issue, "期号", 120)?,
        pages: limited_text(pages, "页码范围", 120)?,
        doi: normalize_doi(doi)?,
        publisher: limited_text(publisher, "出版社", 500)?,
        metadata_raw: limited_text(metadata_raw, "原始书目信息", 100_000)?,
    })
}

fn limited_text(value: &str, label: &str, max_length: usize) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.chars().count() > max_length {
        return Err(AppError::Validation(format!(
            "{label}不能超过 {max_length} 个字符。"
        )));
    }
    Ok(trimmed.to_owned())
}

fn normalize_doi(value: &str) -> AppResult<String> {
    let mut normalized = value.trim();
    let lowercase = normalized.to_ascii_lowercase();
    for prefix in ["https://doi.org/", "http://doi.org/", "doi:"] {
        if lowercase.starts_with(prefix) {
            normalized = normalized[prefix.len()..].trim();
            break;
        }
    }
    normalized = normalized.trim_end_matches(['.', '。', ',', '，', ';', '；']);
    if normalized.is_empty() {
        return Ok(String::new());
    }
    if normalized.chars().count() > 300
        || !normalized.starts_with("10.")
        || !normalized.contains('/')
    {
        return Err(AppError::Validation(
            "DOI 格式无效，应类似 10.1234/example.2024.01。".into(),
        ));
    }
    Ok(normalized.to_owned())
}

fn required_text(value: &str, label: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(format!("{label}不能为空。")));
    }
    if trimmed.chars().count() > 160 {
        return Err(AppError::Validation(format!(
            "{label}不能超过 160 个字符。"
        )));
    }
    Ok(trimmed.to_owned())
}

fn required_long_text(value: &str, label: &str, max_length: usize) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(format!("{label}不能为空。")));
    }
    if trimmed.chars().count() > max_length {
        return Err(AppError::Validation(format!(
            "{label}不能超过 {max_length} 个字符。"
        )));
    }
    Ok(trimmed.to_owned())
}

fn validated_color(value: &str) -> AppResult<String> {
    let valid = value.len() == 7
        && value.starts_with('#')
        && value
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_hexdigit());
    if !valid {
        return Err(AppError::Validation("颜色必须是 #RRGGBB 格式。".into()));
    }
    Ok(value.to_ascii_lowercase())
}

fn validate_role(value: &str) -> AppResult<()> {
    if ["unset", "support", "oppose", "qualify", "background"].contains(&value) {
        Ok(())
    } else {
        Err(AppError::Validation("卡片作用无效。".into()))
    }
}

fn validate_selection_text(value: &str) -> AppResult<()> {
    let length = value.chars().count();
    if value.trim().is_empty() {
        return Err(AppError::Validation("所选 PDF 文字不能为空。".into()));
    }
    if length > 50_000 {
        return Err(AppError::Validation(
            "单次摘录或批注不能超过 50,000 个字符。".into(),
        ));
    }
    Ok(())
}

fn validate_locator(locator_json: &str, expected_page: i64) -> AppResult<()> {
    if locator_json.len() > 100_000 {
        return Err(AppError::Validation("PDF 定位信息过大。".into()));
    }
    let value: serde_json::Value = serde_json::from_str(locator_json)
        .map_err(|_| AppError::Validation("PDF 定位信息格式无效。".into()))?;
    let page = value
        .get("page")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| AppError::Validation("PDF 定位信息缺少页码。".into()))?;
    if page != expected_page || page < 1 {
        return Err(AppError::Validation("PDF 定位页码不一致。".into()));
    }
    let rects = value
        .get("rects")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| AppError::Validation("PDF 定位信息缺少选区坐标。".into()))?;
    if rects.is_empty() || rects.len() > 256 {
        return Err(AppError::Validation(
            "PDF 选区必须包含 1 到 256 个坐标矩形。".into(),
        ));
    }
    for rect in rects {
        let number = |name: &str| {
            rect.get(name)
                .and_then(serde_json::Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or_else(|| AppError::Validation("PDF 选区坐标无效。".into()))
        };
        let x = number("x")?;
        let y = number("y")?;
        let width = number("width")?;
        let height = number("height")?;
        if x < 0.0
            || y < 0.0
            || width <= 0.0
            || height <= 0.0
            || x + width > 1.001
            || y + height > 1.001
        {
            return Err(AppError::Validation("PDF 选区坐标超出页面范围。".into()));
        }
    }
    Ok(())
}

fn normalize_tags(tags: &[String]) -> AppResult<BTreeSet<String>> {
    let normalized = tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    if normalized.len() > 24 {
        return Err(AppError::Validation("单张卡片最多使用 24 个标签。".into()));
    }
    if normalized.iter().any(|tag| tag.chars().count() > 80) {
        return Err(AppError::Validation("单个标签不能超过 80 个字符。".into()));
    }
    Ok(normalized)
}

fn write_card_tags(
    transaction: &Transaction<'_>,
    project_id: &str,
    card_id: &str,
    tags: BTreeSet<String>,
    now: &str,
) -> AppResult<()> {
    for tag_name in tags {
        transaction.execute(
            r#"
            INSERT INTO tags (id, project_id, name, created_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(project_id, name) DO NOTHING
            "#,
            params![Uuid::new_v4().to_string(), project_id, tag_name, now],
        )?;
        let tag_id: String = transaction.query_row(
            "SELECT id FROM tags WHERE project_id = ?1 AND name = ?2",
            params![project_id, tag_name],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO project_card_tags (project_card_id, tag_id) VALUES (?1, ?2)",
            params![card_id, tag_id],
        )?;
    }
    Ok(())
}

fn ensure_selection_highlight(
    transaction: &Transaction<'_>,
    project_id: &str,
    document_id: &str,
    page_number: i64,
    selected_text: &str,
    locator_json: &str,
    now: &str,
) -> AppResult<String> {
    if let Some(existing_id) = transaction
        .query_row(
            r#"
            SELECT id
            FROM pdf_annotations
            WHERE project_id = ?1 AND document_id = ?2 AND kind = 'highlight'
              AND page_number = ?3 AND locator_json = ?4
            LIMIT 1
            "#,
            params![project_id, document_id, page_number, locator_json],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(existing_id);
    }

    let annotation_id = Uuid::new_v4().to_string();
    transaction.execute(
        r#"
        INSERT INTO pdf_annotations
          (id, project_id, document_id, kind, page_number, color,
           selected_text, locator_json, comment, created_at, updated_at)
        VALUES (?1, ?2, ?3, 'highlight', ?4, '#e8bd55', ?5, ?6, '', ?7, ?7)
        "#,
        params![
            annotation_id,
            project_id,
            document_id,
            page_number,
            selected_text,
            locator_json,
            now
        ],
    )?;
    Ok(annotation_id)
}

fn ensure_project_exists(connection: &Connection, project_id: &str) -> AppResult<()> {
    let exists: i64 = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        params![project_id],
        |row| row.get(0),
    )?;
    if exists == 1 {
        Ok(())
    } else {
        Err(AppError::NotFound("项目".into()))
    }
}

fn ensure_project_document(
    connection: &Connection,
    project_id: &str,
    document_id: &str,
) -> AppResult<()> {
    let exists: i64 = connection.query_row(
        r#"
        SELECT EXISTS(
          SELECT 1
          FROM project_documents pd
          JOIN documents d ON d.id = pd.document_id
          WHERE pd.project_id = ?1 AND pd.document_id = ?2
            AND d.file_path IS NOT NULL AND d.file_hash IS NOT NULL
        )
        "#,
        params![project_id, document_id],
        |row| row.get(0),
    )?;
    if exists == 1 {
        Ok(())
    } else {
        Err(AppError::Validation(
            "当前项目中的文献尚未连接可用的 PDF。".into(),
        ))
    }
}

fn ensure_project_document_relation(
    connection: &Connection,
    project_id: &str,
    document_id: &str,
) -> AppResult<()> {
    let exists: i64 = connection.query_row(
        r#"
        SELECT EXISTS(
          SELECT 1 FROM project_documents
          WHERE project_id = ?1 AND document_id = ?2
        )
        "#,
        params![project_id, document_id],
        |row| row.get(0),
    )?;
    if exists == 1 {
        Ok(())
    } else {
        Err(AppError::NotFound("当前项目中的文献".into()))
    }
}

fn sibling_ids(
    transaction: &Transaction<'_>,
    project_id: &str,
    parent_id: Option<&str>,
    excluded_id: Option<&str>,
) -> AppResult<Vec<String>> {
    let mut statement = transaction.prepare(
        r#"
        SELECT id
        FROM outline_nodes
        WHERE project_id = ?1 AND parent_id IS ?2 AND id != COALESCE(?3, '')
        ORDER BY sort_order, created_at
        "#,
    )?;
    let rows = statement.query_map(params![project_id, parent_id, excluded_id], |row| {
        row.get::<_, String>(0)
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn write_outline_node_order(transaction: &Transaction<'_>, ids: &[String]) -> AppResult<()> {
    for (index, id) in ids.iter().enumerate() {
        transaction.execute(
            "UPDATE outline_nodes SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
            params![(index as i64 + 1) * 1000, timestamp(), id],
        )?;
    }
    Ok(())
}

fn write_outline_link_order(transaction: &Transaction<'_>, ids: &[String]) -> AppResult<()> {
    for (index, id) in ids.iter().enumerate() {
        transaction.execute(
            "UPDATE outline_card_links SET sort_order = ?1 WHERE id = ?2",
            params![(index as i64 + 1) * 1000, id],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusion_preserves_card_and_outline_links() {
        let mut repository = Repository::memory().expect("memory database");
        repository
            .set_card_excluded("seed-card-1", true)
            .expect("exclude card");
        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace");
        let card = snapshot
            .cards
            .iter()
            .find(|card| card.id == "seed-card-1")
            .expect("card still exists");
        assert_eq!(card.synthesis_state, "excluded");
        assert!(snapshot
            .outline_links
            .iter()
            .any(|link| link.project_card_id == "seed-card-1"));
    }

    #[test]
    fn removing_document_with_cards_keeps_traceability_and_can_be_restored() {
        let mut repository = Repository::memory().expect("memory database");
        repository
            .remove_document(RemoveDocumentInput {
                project_id: "seed-project-tombs".into(),
                document_id: "seed-document-space".into(),
                keep_cards: true,
            })
            .expect("soft-remove document");

        let removed_snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after removal");
        let document = removed_snapshot
            .documents
            .iter()
            .find(|document| document.id == "seed-document-space")
            .expect("removed source remains addressable");
        assert!(document.is_removed);
        assert_eq!(document.card_count, 3);
        assert!(removed_snapshot
            .cards
            .iter()
            .any(|card| card.document_id == "seed-document-space"));
        assert!(removed_snapshot
            .outline_links
            .iter()
            .any(|link| link.project_card_id == "seed-card-1"));

        repository
            .restore_document("seed-project-tombs", "seed-document-space")
            .expect("restore document");
        let restored_snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after restore");
        assert!(
            !restored_snapshot
                .documents
                .iter()
                .find(|document| document.id == "seed-document-space")
                .expect("restored document")
                .is_removed
        );
    }

    #[test]
    fn deleting_document_with_project_cards_removes_dependent_project_data() {
        let mut repository = Repository::memory().expect("memory database");
        repository
            .remove_document(RemoveDocumentInput {
                project_id: "seed-project-tombs".into(),
                document_id: "seed-document-space".into(),
                keep_cards: false,
            })
            .expect("delete document with cards");

        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after deletion");
        assert!(!snapshot
            .documents
            .iter()
            .any(|document| document.id == "seed-document-space"));
        assert!(!snapshot
            .cards
            .iter()
            .any(|card| card.document_id == "seed-document-space"));
        assert!(!snapshot.outline_links.iter().any(|link| [
            "seed-card-1",
            "seed-card-2",
            "seed-card-3"
        ]
        .contains(&link.project_card_id.as_str())));
    }

    #[test]
    fn insight_and_critique_notes_are_independent_from_project_cards() {
        let mut repository = Repository::memory().expect("memory database");
        repository
            .connection
            .execute(
                "UPDATE documents SET file_path = 'managed.pdf', file_hash = 'hash' WHERE id = 'seed-document-space'",
                [],
            )
            .expect("attach test PDF metadata");
        let note_id = repository
            .create_reading_note(CreateReadingNoteInput {
                project_id: "seed-project-tombs".into(),
                document_id: "seed-document-space".into(),
                kind: "critique".into(),
                content: "作者没有说明样本缺失如何影响结论。".into(),
                selected_text: String::new(),
                page_number: None,
                locator_json: String::new(),
            })
            .expect("create critique note");

        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace with note");
        assert_eq!(snapshot.cards.len(), 5);
        let note = snapshot
            .reading_notes
            .iter()
            .find(|note| note.id == note_id)
            .expect("critique note in snapshot");
        assert_eq!(note.kind, "critique");

        repository
            .delete_reading_note(&note_id)
            .expect("delete only note");
        assert_eq!(
            repository
                .get_workspace(Some("seed-project-tombs"))
                .expect("workspace after note deletion")
                .cards
                .len(),
            5
        );
    }

    #[test]
    fn removing_one_outline_link_keeps_other_links_and_card() {
        let mut repository = Repository::memory().expect("memory database");
        let second_link = repository
            .link_card_to_outline("seed-outline-1", "seed-card-1")
            .expect("create second link");
        repository
            .remove_outline_link(&second_link)
            .expect("remove second link");
        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace");
        assert!(snapshot.cards.iter().any(|card| card.id == "seed-card-1"));
        assert!(snapshot
            .outline_links
            .iter()
            .any(|link| link.project_card_id == "seed-card-1"));
    }

    #[test]
    fn permanent_card_delete_keeps_source_excerpt() {
        let mut repository = Repository::memory().expect("memory database");
        repository.delete_card("seed-card-1").expect("delete card");
        let excerpt_count: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM source_excerpts WHERE id = 'seed-excerpt-1'",
                [],
                |row| row.get(0),
            )
            .expect("count excerpt");
        let link_count: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM outline_card_links WHERE project_card_id = 'seed-card-1'",
                [],
                |row| row.get(0),
            )
            .expect("count links");
        assert_eq!(excerpt_count, 1);
        assert_eq!(link_count, 0);
    }

    #[test]
    fn outline_cannot_be_moved_inside_its_descendant() {
        let mut repository = Repository::memory().expect("memory database");
        let result = repository.move_outline_node(MoveOutlineNodeInput {
            node_id: "seed-outline-2".into(),
            target_node_id: "seed-outline-2-1".into(),
            placement: OutlinePlacement::Inside,
        });
        assert!(result.is_err());
    }

    #[test]
    fn projects_keep_independent_cards() {
        let repository = Repository::memory().expect("memory database");
        let first = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("first workspace");
        let second = repository
            .get_workspace(Some("seed-project-regions"))
            .expect("second workspace");
        assert_eq!(first.cards.len(), 5);
        assert_eq!(second.cards.len(), 1);
        assert!(first
            .cards
            .iter()
            .all(|card| card.project_id == "seed-project-tombs"));
        assert!(second
            .cards
            .iter()
            .all(|card| card.project_id == "seed-project-regions"));
    }

    #[test]
    fn deleting_category_reassigns_cards_without_restoring_excluded_cards() {
        let mut repository = Repository::memory().expect("memory database");
        repository
            .delete_category("seed-category-counter")
            .expect("delete category");

        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace");
        assert!(!snapshot
            .categories
            .iter()
            .any(|category| category.id == "seed-category-counter"));
        let default_category = snapshot
            .categories
            .iter()
            .find(|category| category.is_default)
            .expect("default category");
        let moved_card = snapshot
            .cards
            .iter()
            .find(|card| card.id == "seed-card-2")
            .expect("active card");
        let excluded_card = snapshot
            .cards
            .iter()
            .find(|card| card.id == "seed-card-5")
            .expect("excluded card");
        assert_eq!(
            moved_card.category_id.as_deref(),
            Some(default_category.id.as_str())
        );
        assert_eq!(
            excluded_card.category_id.as_deref(),
            Some(default_category.id.as_str())
        );
        assert_eq!(excluded_card.synthesis_state, "excluded");
    }

    #[test]
    fn default_category_cannot_be_deleted() {
        let mut repository = Repository::memory().expect("memory database");
        let result = repository.delete_category("seed-category-inbox");
        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    #[test]
    fn synthesis_and_outline_flow_keeps_one_shared_project_card() {
        let mut repository = Repository::memory().expect("memory database");
        let category_id = repository
            .create_category(CreateCategoryInput {
                project_id: "seed-project-tombs".into(),
                name: "新论证线索".into(),
                color: "#8a6757".into(),
            })
            .expect("create category");
        repository
            .move_card("seed-card-4", &category_id)
            .expect("move card");
        repository
            .set_card_excluded("seed-card-4", true)
            .expect("exclude card");
        repository
            .set_card_excluded("seed-card-4", false)
            .expect("restore card");
        repository
            .update_card(UpdateCardInput {
                card_id: "seed-card-4".into(),
                comment: "更新后的项目评论".into(),
                role: "oppose".into(),
                tags: vec!["仪式".into(), "空间".into()],
            })
            .expect("update card");

        let first_node = repository
            .create_outline_node(CreateOutlineNodeInput {
                project_id: "seed-project-tombs".into(),
                parent_id: None,
                title: "自建章节甲".into(),
            })
            .expect("create first outline node");
        let second_node = repository
            .create_outline_node(CreateOutlineNodeInput {
                project_id: "seed-project-tombs".into(),
                parent_id: Some(first_node.clone()),
                title: "自建章节甲之一".into(),
            })
            .expect("create nested outline node");
        let first_link = repository
            .link_card_to_outline(&first_node, "seed-card-4")
            .expect("link first chapter");
        repository
            .link_card_to_outline(&second_node, "seed-card-4")
            .expect("link second chapter");
        repository
            .remove_outline_link(&first_link)
            .expect("remove only first link");

        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace");
        let card = snapshot
            .cards
            .iter()
            .find(|card| card.id == "seed-card-4")
            .expect("shared card");
        assert_eq!(card.category_id.as_deref(), Some(category_id.as_str()));
        assert_eq!(card.synthesis_state, "active");
        assert_eq!(card.comment, "更新后的项目评论");
        assert_eq!(card.role, "oppose");
        assert_eq!(
            card.tags.iter().cloned().collect::<BTreeSet<_>>(),
            BTreeSet::from(["仪式".to_owned(), "空间".to_owned(),])
        );
        assert_eq!(
            snapshot
                .outline_links
                .iter()
                .filter(|link| link.project_card_id == "seed-card-4")
                .count(),
            2
        );
        assert!(snapshot.outline_links.iter().any(|link| {
            link.project_card_id == "seed-card-4" && link.outline_node_id == second_node
        }));
    }

    #[test]
    fn project_survives_database_reopen() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-databases");
        std::fs::create_dir_all(&directory).expect("create test database directory");
        let database_path = directory.join(format!("persistence-{}.db", Uuid::new_v4()));

        let project_id = {
            let mut repository = Repository::open(&database_path).expect("open database");
            repository
                .create_project(CreateProjectInput {
                    name: "重启持久化验收".into(),
                    description: "用于验证关闭数据库后重新载入。".into(),
                    color: Some("#a05d43".into()),
                })
                .expect("create project")
        };

        {
            let repository = Repository::open(&database_path).expect("reopen database");
            let snapshot = repository
                .get_workspace(Some(&project_id))
                .expect("load persisted project");
            assert_eq!(
                snapshot.current_project_id.as_deref(),
                Some(project_id.as_str())
            );
            assert!(snapshot
                .projects
                .iter()
                .any(|project| project.id == project_id));
            assert_eq!(snapshot.categories.len(), 1);
            assert!(snapshot.categories[0].is_default);
            assert!(snapshot.outline_nodes.is_empty());
        }

        for suffix in ["", "-wal", "-shm"] {
            let path = format!("{}{}", database_path.display(), suffix);
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn imported_pdf_is_deduplicated_and_annotations_survive_reopen() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-pdf-imports")
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).expect("create test import directory");
        let source_path = root.join("source.pdf");
        std::fs::write(&source_path, b"%PDF-1.4\ninkstone test fixture\n").expect("write test PDF");
        let managed_directory = root.join("pdf-library");
        let database_path = root.join("inkstone.db");
        let locator_json = r#"{"version":1,"page":1,"coordinateSpace":"page-normalized","rects":[{"x":0.12,"y":0.24,"width":0.38,"height":0.04}]}"#;

        let (project_id, second_project_id, document_id, card_id, annotation_id, file_hash) = {
            let mut repository = Repository::open(&database_path).expect("open database");
            let project_id = repository
                .create_project(CreateProjectInput {
                    name: "PDF 导入测试项目".into(),
                    description: String::new(),
                    color: Some("#a05d43".into()),
                })
                .expect("create first project");
            let second_project_id = repository
                .create_project(CreateProjectInput {
                    name: "PDF 复用测试项目".into(),
                    description: String::new(),
                    color: Some("#637b6d".into()),
                })
                .expect("create second project");

            let prepared = crate::pdf_files::prepare_pdf_copy(&source_path, &managed_directory)
                .expect("copy PDF into managed library");
            assert_eq!(
                std::fs::read(&prepared.managed_path).expect("read managed copy"),
                std::fs::read(&source_path).expect("read source copy")
            );
            let first_import = repository
                .register_imported_pdf(
                    &ImportPdfInput {
                        project_id: project_id.clone(),
                        source_path: source_path.to_string_lossy().into_owned(),
                        target_document_id: None,
                        title: "一篇用于测试的 PDF".into(),
                        authors: "测试作者".into(),
                        year: Some(2024),
                        journal: "测试学刊".into(),
                        volume: "12".into(),
                        issue: "3".into(),
                        pages: "7-19".into(),
                        doi: "10.1234/inkstone.test".into(),
                        publisher: String::new(),
                        metadata_raw: "测试作者. 一篇用于测试的 PDF[J]. 测试学刊, 2024.".into(),
                    },
                    &prepared.managed_path,
                    &prepared.file_hash,
                    prepared.reused_managed_file,
                )
                .expect("register first PDF import");
            assert!(!first_import.reused_document);
            assert!(!first_import.reused_managed_file);

            let card_id = repository
                .create_card_from_selection(CreateCardFromSelectionInput {
                    project_id: project_id.clone(),
                    document_id: first_import.document_id.clone(),
                    raw_text: "一段来自测试 PDF 的原文".into(),
                    pdf_page: 1,
                    print_page: Some("7".into()),
                    locator_json: locator_json.into(),
                    context_before: "前文".into(),
                    context_after: "后文".into(),
                    comment: "用于验证重启后仍可回到原文。".into(),
                    role: "support".into(),
                    tags: vec!["PDF".into(), "定位".into()],
                })
                .expect("create card from selection");
            let annotation_id: String = repository
                .connection
                .query_row(
                    r#"
                    SELECT id FROM pdf_annotations
                    WHERE project_id = ?1 AND document_id = ?2 AND kind = 'highlight'
                      AND locator_json = ?3
                    "#,
                    params![project_id, first_import.document_id, locator_json],
                    |row| row.get(0),
                )
                .expect("card creates a matching highlight atomically");

            let prepared_again =
                crate::pdf_files::prepare_pdf_copy(&source_path, &managed_directory)
                    .expect("reuse managed PDF copy");
            assert!(prepared_again.reused_managed_file);
            let second_import = repository
                .register_imported_pdf(
                    &ImportPdfInput {
                        project_id: second_project_id.clone(),
                        source_path: source_path.to_string_lossy().into_owned(),
                        target_document_id: None,
                        title: "同一篇 PDF".into(),
                        authors: "另一处显示".into(),
                        year: Some(2024),
                        journal: String::new(),
                        volume: String::new(),
                        issue: String::new(),
                        pages: String::new(),
                        doi: String::new(),
                        publisher: String::new(),
                        metadata_raw: String::new(),
                    },
                    &prepared_again.managed_path,
                    &prepared_again.file_hash,
                    prepared_again.reused_managed_file,
                )
                .expect("register second PDF import");
            assert!(second_import.reused_document);
            assert_eq!(second_import.document_id, first_import.document_id);

            (
                project_id,
                second_project_id,
                first_import.document_id,
                card_id,
                annotation_id,
                prepared.file_hash,
            )
        };

        {
            let repository = Repository::open(&database_path).expect("reopen database");
            let snapshot = repository
                .get_workspace(Some(&project_id))
                .expect("load first project after reopen");
            let document = snapshot
                .documents
                .iter()
                .find(|document| document.id == document_id)
                .expect("imported document survives reopen");
            assert_eq!(document.file_hash.as_deref(), Some(file_hash.as_str()));
            assert_eq!(document.journal, "测试学刊");
            assert_eq!(document.doi, "10.1234/inkstone.test");
            assert_eq!(document.card_count, 1);
            let card = snapshot
                .cards
                .iter()
                .find(|card| card.id == card_id)
                .expect("card survives reopen");
            assert_eq!(card.raw_text, "一段来自测试 PDF 的原文");
            assert_eq!(card.locator_json, locator_json);
            let annotation = snapshot
                .pdf_annotations
                .iter()
                .find(|annotation| annotation.id == annotation_id)
                .expect("annotation survives reopen");
            assert_eq!(annotation.kind, "highlight");
            assert_eq!(annotation.selected_text, "一段来自测试 PDF 的原文");

            let second_snapshot = repository
                .get_workspace(Some(&second_project_id))
                .expect("load second project after reopen");
            assert_eq!(second_snapshot.documents.len(), 1);
            assert_eq!(second_snapshot.documents[0].id, document_id);
            assert!(second_snapshot.cards.is_empty());
        }

        for suffix in ["", "-wal", "-shm"] {
            let path = format!("{}{}", database_path.display(), suffix);
            let _ = std::fs::remove_file(path);
        }
        std::fs::remove_dir_all(root).expect("remove test import directory");
    }
}
