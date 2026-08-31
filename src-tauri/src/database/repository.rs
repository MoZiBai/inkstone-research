use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rusqlite::backup::Backup;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    BackupCleanupResult, BackupPreferences, BackupRecord, BatchUpdateCardsInput,
    CreateCardFromSelectionInput, CreateCategoryInput, CreateDocumentGroupInput,
    CreateDocumentInput, CreateOutlineNodeInput, CreatePdfAnnotationInput, CreateProjectInput,
    CreateReadingNoteInput, CreateResearchRoleInput, DatabaseImportPreview, DocumentGroup,
    DocumentSummary, ImportPdfInput, ImportPdfResult, MoveDocumentToGroupInput,
    MoveOutlineNodeInput, OutlineCardLink, OutlineNode, OutlinePlacement, PdfAnnotation,
    ProjectCardView, ProjectSummary, ReadingNote, RemoveDocumentInput, ResearchRole,
    SynthesisCategory, UpdateCardInput, UpdateCategoryInput, UpdateDocumentGroupInput,
    UpdateDocumentInput, UpdateOutlineCardLinkInput, UpdateOutlineNodeInput,
    UpdatePdfAnnotationInput, UpdateProjectInput, UpdateReadingNoteInput, UpdateResearchRoleInput,
    WorkspaceSnapshot,
};

use super::schema::{migrate_database, seed_database, SCHEMA_VERSION};

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
                document_groups: Vec::new(),
                categories: Vec::new(),
                research_roles: Vec::new(),
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
                       pd.removed_at IS NOT NULL, d.file_path, d.file_hash, pd.group_id, pd.sort_order,
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
                    file_available: false,
                    group_id: row.get(14)?,
                    sort_order: row.get(15)?,
                    card_count: row.get(16)?,
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let document_groups = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT id, project_id, parent_id, name, sort_order, created_at, updated_at
                FROM document_groups
                WHERE project_id = ?1
                ORDER BY parent_id IS NOT NULL, sort_order, created_at
                "#,
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok(DocumentGroup {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    parent_id: row.get(2)?,
                    name: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
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

        let research_roles = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT id, project_id, name, color, sort_order, is_default, is_archived,
                       created_at, updated_at
                FROM research_roles
                WHERE project_id = ?1
                ORDER BY is_archived, sort_order, created_at
                "#,
            )?;
            let rows = statement.query_map(params![project_id], research_role_from_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let mut cards = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT pc.id, pc.project_id, pc.excerpt_id,
                       d.id, d.title, d.authors, d.year,
                       se.raw_text, se.clean_text,
                       COALESCE(NULLIF(pc.text_override, ''), se.clean_text),
                       se.pdf_page, se.print_page,
                       se.locator_json, se.context_before, se.context_after, se.source_hash,
                       pc.comment, pc.origin_kind, pc.category_id, pc.synthesis_state,
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
                let tags_value: String = row.get(20)?;
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
                    display_text: row.get(9)?,
                    pdf_page: row.get(10)?,
                    print_page: row.get(11)?,
                    locator_json: row.get(12)?,
                    context_before: row.get(13)?,
                    context_after: row.get(14)?,
                    source_hash: row.get(15)?,
                    comment: row.get(16)?,
                    origin_kind: row.get(17)?,
                    research_roles: Vec::new(),
                    category_id: row.get(18)?,
                    synthesis_state: row.get(19)?,
                    tags,
                    created_at: row.get(21)?,
                    updated_at: row.get(22)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let roles_by_card = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT pcr.project_card_id,
                       rr.id, rr.project_id, rr.name, rr.color, rr.sort_order,
                       rr.is_default, rr.is_archived, rr.created_at, rr.updated_at
                FROM project_card_roles pcr
                JOIN project_cards pc ON pc.id = pcr.project_card_id
                JOIN research_roles rr ON rr.id = pcr.research_role_id
                WHERE pc.project_id = ?1
                ORDER BY pcr.project_card_id, rr.sort_order, rr.created_at
                "#,
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ResearchRole {
                        id: row.get(1)?,
                        project_id: row.get(2)?,
                        name: row.get(3)?,
                        color: row.get(4)?,
                        sort_order: row.get(5)?,
                        is_default: row.get::<_, i64>(6)? == 1,
                        is_archived: row.get::<_, i64>(7)? == 1,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    },
                ))
            })?;
            let mut result = BTreeMap::<String, Vec<ResearchRole>>::new();
            for row in rows {
                let (card_id, role) = row?;
                result.entry(card_id).or_default().push(role);
            }
            result
        };
        for card in &mut cards {
            card.research_roles = roles_by_card.get(&card.id).cloned().unwrap_or_default();
        }

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
            document_groups,
            categories,
            research_roles,
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
        write_default_research_roles(&transaction, &project_id, &now)?;
        transaction.commit()?;
        Ok(project_id)
    }

    pub fn update_project(&mut self, input: UpdateProjectInput) -> AppResult<()> {
        let name = required_text(&input.name, "项目名称")?;
        let description = limited_text(&input.description, "项目说明", 20_000)?;
        let color = validated_color(input.color.as_deref().unwrap_or("#9a5d45"))?;
        let changed = self.connection.execute(
            r#"
            UPDATE projects
            SET name = ?1, description = ?2, color = ?3, updated_at = ?4
            WHERE id = ?5
            "#,
            params![name, description, color, timestamp(), input.project_id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("项目".into()));
        }
        Ok(())
    }

    pub fn remove_project(&mut self, project_id: &str) -> AppResult<Vec<PathBuf>> {
        ensure_project_exists(&self.connection, project_id)?;
        let transaction = self.connection.transaction()?;
        let candidate_documents = {
            let mut statement = transaction.prepare(
                r#"
                SELECT d.id, d.file_path
                FROM project_documents pd
                JOIN documents d ON d.id = pd.document_id
                WHERE pd.project_id = ?1
                "#,
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        transaction.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
        let mut discarded_paths = BTreeSet::new();
        for (document_id, file_path) in candidate_documents {
            let still_referenced: i64 = transaction.query_row(
                r#"
                SELECT EXISTS(
                  SELECT 1 FROM project_documents WHERE document_id = ?1
                  UNION ALL
                  SELECT 1 FROM project_cards pc
                  JOIN source_excerpts se ON se.id = pc.excerpt_id
                  WHERE se.document_id = ?1
                  UNION ALL
                  SELECT 1 FROM pdf_annotations WHERE document_id = ?1
                  UNION ALL
                  SELECT 1 FROM reading_notes WHERE document_id = ?1
                )
                "#,
                params![document_id],
                |row| row.get(0),
            )?;
            if still_referenced == 1 {
                continue;
            }
            transaction.execute(
                "DELETE FROM source_excerpts WHERE document_id = ?1",
                params![document_id],
            )?;
            transaction.execute("DELETE FROM documents WHERE id = ?1", params![document_id])?;
            if let Some(path) = file_path {
                let path_references: i64 = transaction.query_row(
                    "SELECT COUNT(*) FROM documents WHERE file_path = ?1",
                    params![path],
                    |row| row.get(0),
                )?;
                if path_references == 0 {
                    discarded_paths.insert(PathBuf::from(path));
                }
            }
        }
        transaction.commit()?;
        Ok(discarded_paths.into_iter().collect())
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

    pub fn create_document_group(&mut self, input: CreateDocumentGroupInput) -> AppResult<String> {
        let name = required_text(&input.name, "文献分类名称")?;
        ensure_project_exists(&self.connection, &input.project_id)?;
        ensure_document_group_parent(
            &self.connection,
            &input.project_id,
            input.parent_id.as_deref(),
            None,
        )?;
        ensure_document_group_name_available(
            &self.connection,
            &input.project_id,
            input.parent_id.as_deref(),
            &name,
            None,
        )?;

        let sort_order: i64 = self.connection.query_row(
            r#"
            SELECT COALESCE(MAX(sort_order), 0) + 1000
            FROM document_groups
            WHERE project_id = ?1 AND parent_id IS ?2
            "#,
            params![input.project_id, input.parent_id],
            |row| row.get(0),
        )?;
        let group_id = Uuid::new_v4().to_string();
        let now = timestamp();
        self.connection.execute(
            r#"
            INSERT INTO document_groups
              (id, project_id, parent_id, name, sort_order, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
            "#,
            params![
                group_id,
                input.project_id,
                input.parent_id,
                name,
                sort_order,
                now
            ],
        )?;
        Ok(group_id)
    }

    pub fn update_document_group(&mut self, input: UpdateDocumentGroupInput) -> AppResult<()> {
        let name = required_text(&input.name, "文献分类名称")?;
        let project_id: String = self
            .connection
            .query_row(
                "SELECT project_id FROM document_groups WHERE id = ?1",
                params![input.group_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("文献分类".into()))?;
        ensure_document_group_parent(
            &self.connection,
            &project_id,
            input.parent_id.as_deref(),
            Some(&input.group_id),
        )?;
        ensure_document_group_name_available(
            &self.connection,
            &project_id,
            input.parent_id.as_deref(),
            &name,
            Some(&input.group_id),
        )?;
        self.connection.execute(
            r#"
            UPDATE document_groups
            SET parent_id = ?1, name = ?2, updated_at = ?3
            WHERE id = ?4
            "#,
            params![input.parent_id, name, timestamp(), input.group_id],
        )?;
        Ok(())
    }

    pub fn delete_document_group(&mut self, group_id: &str) -> AppResult<()> {
        let changed = self.connection.execute(
            "DELETE FROM document_groups WHERE id = ?1",
            params![group_id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("文献分类".into()));
        }
        Ok(())
    }

    pub fn move_document_to_group(&mut self, input: MoveDocumentToGroupInput) -> AppResult<()> {
        ensure_project_document_relation(&self.connection, &input.project_id, &input.document_id)?;
        if let Some(group_id) = input.group_id.as_deref() {
            let group_project_id: Option<String> = self
                .connection
                .query_row(
                    "SELECT project_id FROM document_groups WHERE id = ?1",
                    params![group_id],
                    |row| row.get(0),
                )
                .optional()?;
            if group_project_id.as_deref() != Some(input.project_id.as_str()) {
                return Err(AppError::Validation("目标文献分类不属于当前项目。".into()));
            }
        }
        self.connection.execute(
            r#"
            UPDATE project_documents
            SET group_id = ?1
            WHERE project_id = ?2 AND document_id = ?3
            "#,
            params![input.group_id, input.project_id, input.document_id],
        )?;
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
        allow_missing_pdf_relink: bool,
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
        let mut relinked_document = false;
        let mut hash_changed = false;
        let (document_id, reused_document) = if let Some(target_document_id) =
            input.target_document_id.as_deref()
        {
            let (current_file_path, current_file_hash) = transaction
                .query_row(
                    r#"
                        SELECT d.file_path, d.file_hash
                        FROM documents d
                        JOIN project_documents pd ON pd.document_id = d.id
                        WHERE d.id = ?1 AND pd.project_id = ?2
                        "#,
                    params![target_document_id, input.project_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| AppError::NotFound("当前项目中的文献".into()))?;
            if current_file_path.is_some() && !allow_missing_pdf_relink {
                return Err(AppError::Validation(
                    "这篇文献已经连接 PDF；为避免改变已有摘录的来源，本阶段不允许直接替换。".into(),
                ));
            }
            relinked_document = current_file_path.is_some();
            hash_changed = current_file_hash
                .as_deref()
                .is_some_and(|current_hash| current_hash != file_hash);
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
            relinked_document,
            hash_changed,
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

    pub fn stored_pdf_path(&self, document_id: &str) -> AppResult<Option<PathBuf>> {
        let file_path = self
            .connection
            .query_row(
                "SELECT file_path FROM documents WHERE id = ?1",
                params![document_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("文献".into()))?;
        Ok(file_path.map(PathBuf::from))
    }

    pub fn export_database(&self, destination: &Path) -> AppResult<()> {
        let parent = destination
            .parent()
            .filter(|parent| parent.is_dir())
            .ok_or_else(|| AppError::Validation("备份目标目录不存在。".into()))?;
        let temporary = parent.join(format!(".inkstone-export-{}.tmp", Uuid::new_v4()));
        let result = (|| -> AppResult<()> {
            create_database_copy(&self.connection, &temporary)?;
            validate_database_file(&temporary)?;
            replace_file(&temporary, destination)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn export_project_database(&self, project_id: &str, destination: &Path) -> AppResult<()> {
        ensure_project_exists(&self.connection, project_id)?;
        let parent = destination
            .parent()
            .filter(|parent| parent.is_dir())
            .ok_or_else(|| AppError::Validation("备份目标目录不存在。".into()))?;
        let temporary = parent.join(format!(".inkstone-project-export-{}.tmp", Uuid::new_v4()));
        let result = (|| -> AppResult<()> {
            create_database_copy(&self.connection, &temporary)?;
            {
                let mut exported = Connection::open(&temporary)?;
                exported.pragma_update(None, "foreign_keys", "ON")?;
                let transaction = exported.transaction()?;
                transaction.execute("DELETE FROM projects WHERE id <> ?1", params![project_id])?;
                transaction.execute(
                    r#"
                    DELETE FROM source_excerpts
                    WHERE NOT EXISTS(
                      SELECT 1 FROM project_cards pc WHERE pc.excerpt_id = source_excerpts.id
                    )
                    "#,
                    [],
                )?;
                transaction.execute(
                    r#"
                    DELETE FROM documents
                    WHERE NOT EXISTS(
                      SELECT 1 FROM project_documents pd WHERE pd.document_id = documents.id
                    )
                      AND NOT EXISTS(
                        SELECT 1 FROM source_excerpts se WHERE se.document_id = documents.id
                      )
                      AND NOT EXISTS(
                        SELECT 1 FROM pdf_annotations pa WHERE pa.document_id = documents.id
                      )
                      AND NOT EXISTS(
                        SELECT 1 FROM reading_notes rn WHERE rn.document_id = documents.id
                      )
                    "#,
                    [],
                )?;
                transaction.execute("DELETE FROM backup_records", [])?;
                transaction.execute(
                    "DELETE FROM app_metadata WHERE key LIKE 'backup\\_%' ESCAPE '\\'",
                    [],
                )?;
                transaction.commit()?;
                ensure_foreign_keys_are_valid(&exported)?;
                exported.execute_batch(
                    "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
                )?;
            }
            validate_database_file(&temporary)?;
            replace_file(&temporary, destination)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn backup_preferences(&self) -> AppResult<BackupPreferences> {
        let custom_directory = metadata_value(&self.connection, "backup_custom_directory")?
            .filter(|value| !value.trim().is_empty());
        let retention_days = metadata_value(&self.connection, "backup_retention_days")?
            .map(|value| {
                value.parse::<i64>().map_err(|_| {
                    AppError::Validation("自动备份保留天数设置损坏，请重新设置。".into())
                })
            })
            .transpose()?;
        let retention_count = metadata_value(&self.connection, "backup_retention_count")?
            .map(|value| {
                value.parse::<i64>().map_err(|_| {
                    AppError::Validation("自动备份保留份数设置损坏，请重新设置。".into())
                })
            })
            .transpose()?;
        validate_backup_retention(retention_days, retention_count)?;
        let last_cleanup_at = metadata_value(&self.connection, "backup_last_cleanup_at")?;
        let last_cleanup_result = metadata_value(&self.connection, "backup_last_cleanup_result")?;
        let automatic_interval_hours =
            metadata_value(&self.connection, "backup_automatic_interval_hours")?
                .map(|value| {
                    value.parse::<i64>().map_err(|_| {
                        AppError::Validation("自动备份频率设置损坏，请重新设置。".into())
                    })
                })
                .transpose()?
                .unwrap_or(24);
        validate_automatic_backup_interval(automatic_interval_hours)?;
        let last_automatic_backup_at =
            metadata_value(&self.connection, "backup_last_automatic_at")?;
        let last_automatic_backup_result =
            metadata_value(&self.connection, "backup_last_automatic_result")?;
        Ok(BackupPreferences {
            custom_directory,
            retention_days,
            retention_count,
            automatic_interval_hours,
            last_automatic_backup_at,
            last_automatic_backup_result,
            last_cleanup_at,
            last_cleanup_result,
        })
    }

    pub fn set_backup_preferences(
        &mut self,
        custom_directory: Option<&Path>,
        retention_days: Option<i64>,
        retention_count: Option<i64>,
        automatic_interval_hours: i64,
    ) -> AppResult<()> {
        validate_backup_retention(retention_days, retention_count)?;
        validate_automatic_backup_interval(automatic_interval_hours)?;
        let transaction = self.connection.transaction()?;
        set_or_remove_metadata(
            &transaction,
            "backup_custom_directory",
            custom_directory.map(|path| path.to_string_lossy().into_owned()),
        )?;
        set_or_remove_metadata(
            &transaction,
            "backup_retention_days",
            retention_days.map(|days| days.to_string()),
        )?;
        set_or_remove_metadata(
            &transaction,
            "backup_retention_count",
            retention_count.map(|count| count.to_string()),
        )?;
        set_or_remove_metadata(
            &transaction,
            "backup_automatic_interval_hours",
            Some(automatic_interval_hours.to_string()),
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_automatic_backup_completed(&mut self, path: &Path) -> AppResult<()> {
        let transaction = self.connection.transaction()?;
        set_or_remove_metadata(&transaction, "backup_last_automatic_at", Some(timestamp()))?;
        set_or_remove_metadata(
            &transaction,
            "backup_last_automatic_result",
            Some(format!("已创建 {}", path.to_string_lossy())),
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn record_backup(
        &mut self,
        path: &Path,
        kind: &str,
        project_id: Option<&str>,
        managed_directory: Option<&Path>,
    ) -> AppResult<()> {
        self.record_backup_at(path, kind, project_id, managed_directory, &timestamp())
    }

    fn record_backup_at(
        &mut self,
        path: &Path,
        kind: &str,
        project_id: Option<&str>,
        managed_directory: Option<&Path>,
        created_at: &str,
    ) -> AppResult<()> {
        if !["auto", "full", "project"].contains(&kind) {
            return Err(AppError::Validation("备份类型无效。".into()));
        }
        if kind == "auto" && managed_directory.is_none() {
            return Err(AppError::Validation(
                "自动安全备份缺少受管理的备份目录。".into(),
            ));
        }
        let metadata = fs::metadata(path)?;
        if !metadata.is_file() {
            return Err(AppError::Validation("备份记录指向的不是文件。".into()));
        }
        let size_bytes = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
        self.connection.execute(
            r#"
            INSERT INTO backup_records
              (id, path, kind, project_id, managed_directory, size_bytes, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(path) DO UPDATE SET
              kind = excluded.kind,
              project_id = excluded.project_id,
              managed_directory = excluded.managed_directory,
              size_bytes = excluded.size_bytes,
              created_at = excluded.created_at
            "#,
            params![
                Uuid::new_v4().to_string(),
                path.to_string_lossy(),
                kind,
                project_id,
                managed_directory.map(|directory| directory.to_string_lossy().into_owned()),
                size_bytes,
                created_at
            ],
        )?;
        Ok(())
    }

    pub fn register_automatic_backups_in_directory(&mut self, directory: &Path) -> AppResult<i64> {
        let canonical_directory = directory.canonicalize()?;
        let mut registered = 0_i64;
        for entry in fs::read_dir(&canonical_directory)? {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let Ok(validated) = validated_automatic_backup_path(
                &path,
                &canonical_directory,
                Some(&canonical_directory),
            ) else {
                continue;
            };
            let path_value = validated.to_string_lossy().into_owned();
            let exists: i64 = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM backup_records WHERE path = ?1)",
                params![path_value],
                |row| row.get(0),
            )?;
            if exists == 1 || validate_database_file(&validated).is_err() {
                continue;
            }
            let created_at = fs::metadata(&validated)
                .and_then(|metadata| metadata.modified())
                .map(DateTime::<Utc>::from)
                .unwrap_or_else(|_| Utc::now())
                .to_rfc3339();
            self.record_backup_at(
                &validated,
                "auto",
                None,
                Some(&canonical_directory),
                &created_at,
            )?;
            registered += 1;
        }
        Ok(registered)
    }

    pub fn cleanup_orphaned_backup_sidecars(&self, directory: &Path) -> AppResult<i64> {
        let canonical_directory = directory.canonicalize()?;
        let mut removed = 0_i64;
        for entry in fs::read_dir(&canonical_directory)? {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let is_inkstone_temporary_sidecar = [
                ".inkstone-export-",
                ".inkstone-project-export-",
                ".inkstone-import-",
                ".inkstone-merge-",
            ]
            .iter()
            .any(|prefix| file_name.starts_with(prefix))
                && (file_name.ends_with(".tmp-wal") || file_name.ends_with(".tmp-shm"));
            if !is_inkstone_temporary_sidecar {
                continue;
            }
            let base_name = file_name
                .strip_suffix("-wal")
                .or_else(|| file_name.strip_suffix("-shm"))
                .unwrap_or(file_name);
            if canonical_directory.join(base_name).exists() {
                continue;
            }
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    pub fn backup_records(&self) -> AppResult<Vec<BackupRecord>> {
        let mut statement = self.connection.prepare(
            r#"
            SELECT id, path, kind, project_id, size_bytes, created_at
            FROM backup_records
            ORDER BY created_at DESC
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            let path: String = row.get(1)?;
            let current_size = fs::metadata(&path)
                .ok()
                .filter(|metadata| metadata.is_file())
                .and_then(|metadata| i64::try_from(metadata.len()).ok());
            Ok(BackupRecord {
                id: row.get(0)?,
                path,
                kind: row.get(2)?,
                project_id: row.get(3)?,
                size_bytes: current_size.unwrap_or_else(|| row.get(4).unwrap_or(0)),
                created_at: row.get(5)?,
                is_available: current_size.is_some(),
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn backup_record_path(&self, backup_id: &str) -> AppResult<PathBuf> {
        let path = self
            .connection
            .query_row(
                "SELECT path FROM backup_records WHERE id = ?1",
                params![backup_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("备份记录".into()))?;
        let path = PathBuf::from(path);
        if !path.is_file() {
            return Err(AppError::Validation("备份文件已经不在原位置。".into()));
        }
        Ok(path)
    }

    pub fn delete_automatic_backup(&mut self, backup_id: &str) -> AppResult<()> {
        let record = self
            .connection
            .query_row(
                "SELECT path, kind, managed_directory FROM backup_records WHERE id = ?1",
                params![backup_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("备份记录".into()))?;
        if record.1 != "auto" {
            return Err(AppError::Validation(
                "只能在此处删除砚台自动创建的安全备份。".into(),
            ));
        }
        let path = PathBuf::from(&record.0);
        if path.exists() {
            let managed_directory = record
                .2
                .as_deref()
                .ok_or_else(|| AppError::Validation("自动备份记录缺少管理目录。".into()))?;
            let validated =
                validated_automatic_backup_path(&path, Path::new(managed_directory), None)?;
            fs::remove_file(validated)?;
        }
        self.connection.execute(
            "DELETE FROM backup_records WHERE id = ?1",
            params![backup_id],
        )?;
        Ok(())
    }

    pub fn cleanup_automatic_backups(
        &mut self,
        directory: &Path,
        retention_days: Option<i64>,
        retention_count: Option<i64>,
    ) -> AppResult<BackupCleanupResult> {
        validate_backup_retention(retention_days, retention_count)?;
        if retention_days.is_none() && retention_count.is_none() {
            return Ok(BackupCleanupResult::default());
        }
        let records = {
            let mut statement = self.connection.prepare(
                r#"
                SELECT id, path, managed_directory, size_bytes, created_at
                FROM backup_records
                WHERE kind = 'auto'
                ORDER BY created_at DESC
                "#,
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let cutoff = retention_days.map(|days| Utc::now() - ChronoDuration::days(days));
        let canonical_directory = directory.canonicalize()?;
        let mut valid_index = 0_usize;
        let mut result = BackupCleanupResult::default();
        let mut failure_reasons = Vec::new();
        for (id, path_value, managed_directory, stored_size, created_at) in records {
            let path = PathBuf::from(path_value);
            if !path.is_file() {
                continue;
            }
            let Some(managed_directory) = managed_directory else {
                result.failed_count += 1;
                if failure_reasons.len() < 3 {
                    failure_reasons.push(format!(
                        "{}：登记信息缺少受管理目录",
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("未知文件")
                    ));
                }
                continue;
            };
            let registered_directory = match Path::new(&managed_directory).canonicalize() {
                Ok(directory) => directory,
                Err(error) => {
                    result.failed_count += 1;
                    if failure_reasons.len() < 3 {
                        failure_reasons.push(format!("{managed_directory}：{error}"));
                    }
                    continue;
                }
            };
            if registered_directory != canonical_directory {
                continue;
            }
            let validated = match validated_automatic_backup_path(
                &path,
                &registered_directory,
                Some(&canonical_directory),
            ) {
                Ok(path) => path,
                Err(error) => {
                    result.failed_count += 1;
                    if failure_reasons.len() < 3 {
                        failure_reasons.push(format!(
                            "{}：{error}",
                            path.file_name()
                                .and_then(|name| name.to_str())
                                .unwrap_or("未知文件")
                        ));
                    }
                    continue;
                }
            };
            valid_index += 1;
            let should_delete = if let Some(retention_count) = retention_count {
                valid_index > retention_count as usize
            } else {
                if valid_index <= 3 {
                    continue;
                }
                let created = match DateTime::parse_from_rfc3339(&created_at) {
                    Ok(value) => value.with_timezone(&Utc),
                    Err(error) => {
                        result.failed_count += 1;
                        if failure_reasons.len() < 3 {
                            failure_reasons.push(format!(
                                "{}：创建时间无效（{error}）",
                                path.file_name()
                                    .and_then(|name| name.to_str())
                                    .unwrap_or("未知文件")
                            ));
                        }
                        continue;
                    }
                };
                created < cutoff.expect("retention cutoff")
            };
            if !should_delete {
                continue;
            }
            let size = fs::metadata(&validated)
                .ok()
                .and_then(|metadata| i64::try_from(metadata.len()).ok())
                .unwrap_or(stored_size);
            match fs::remove_file(&validated) {
                Ok(()) => {
                    self.connection
                        .execute("DELETE FROM backup_records WHERE id = ?1", params![id])?;
                    result.deleted_count += 1;
                    result.freed_bytes = result.freed_bytes.saturating_add(size.max(0));
                }
                Err(error) => {
                    result.failed_count += 1;
                    if failure_reasons.len() < 3 {
                        failure_reasons.push(format!(
                            "{}：{error}",
                            validated
                                .file_name()
                                .and_then(|name| name.to_str())
                                .unwrap_or("未知文件")
                        ));
                    }
                }
            }
        }
        let mut summary = format!(
            "删除 {} 份，释放 {} 字节，失败 {} 份",
            result.deleted_count, result.freed_bytes, result.failed_count
        );
        if !failure_reasons.is_empty() {
            summary.push_str("；失败原因：");
            summary.push_str(&failure_reasons.join("；"));
            if result.failed_count as usize > failure_reasons.len() {
                summary.push_str("；其余失败已省略");
            }
        }
        let transaction = self.connection.transaction()?;
        set_or_remove_metadata(&transaction, "backup_last_cleanup_at", Some(timestamp()))?;
        set_or_remove_metadata(&transaction, "backup_last_cleanup_result", Some(summary))?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn import_database(
        &mut self,
        source: &Path,
        safety_backup: &Path,
    ) -> AppResult<(i64, i64)> {
        self.merge_database(source, safety_backup, false)
    }

    pub fn preview_database_import(
        &self,
        source: &Path,
        working_directory: &Path,
        require_single_project: bool,
    ) -> AppResult<(DatabaseImportPreview, Vec<Option<PathBuf>>)> {
        validate_database_file(source)?;
        if !working_directory.is_dir() {
            return Err(AppError::Validation(
                "数据库导入预览的临时目录不可用。".into(),
            ));
        }
        let prepared =
            working_directory.join(format!(".inkstone-import-preview-{}.tmp", Uuid::new_v4()));
        let result = (|| -> AppResult<(DatabaseImportPreview, Vec<Option<PathBuf>>)> {
            fs::copy(source, &prepared)?;
            let mut prepared_connection = Connection::open(&prepared)?;
            migrate_database(&mut prepared_connection)?;
            ensure_foreign_keys_are_valid(&prepared_connection)?;
            let source_project_count: i64 =
                prepared_connection
                    .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
            if source_project_count == 0 {
                return Err(AppError::Validation("导入文件中没有研究项目。".into()));
            }
            if require_single_project && source_project_count != 1 {
                return Err(AppError::Validation(format!(
                    "项目导入文件应只包含 1 个项目，但当前文件包含 {source_project_count} 个。请改用“合并数据库备份”。"
                )));
            }
            prepared_connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
            drop(prepared_connection);
            validate_database_file(&prepared)?;
            inspect_import_database(&self.connection, &prepared)
        })();
        remove_sqlite_temporary_files(&prepared);
        result
    }

    pub fn import_project_database(
        &mut self,
        source: &Path,
        safety_backup: &Path,
    ) -> AppResult<(i64, i64)> {
        self.merge_database(source, safety_backup, true)
    }

    fn merge_database(
        &mut self,
        source: &Path,
        safety_backup: &Path,
        require_single_project: bool,
    ) -> AppResult<(i64, i64)> {
        validate_database_file(source)?;
        let database_parent = safety_backup
            .parent()
            .ok_or_else(|| AppError::Validation("无法确定数据库导入目录。".into()))?;
        let prepared = database_parent.join(format!(".inkstone-merge-{}.tmp", Uuid::new_v4()));
        let prepare_result = (|| -> AppResult<Vec<String>> {
            fs::copy(source, &prepared)?;
            let mut prepared_connection = Connection::open(&prepared)?;
            migrate_database(&mut prepared_connection)?;
            ensure_foreign_keys_are_valid(&prepared_connection)?;
            let project_ids = {
                let mut statement = prepared_connection
                    .prepare("SELECT id FROM projects ORDER BY sort_order, created_at")?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            prepared_connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
            validate_database_file(&prepared)?;
            Ok(project_ids)
        })();
        let source_project_ids = match prepare_result {
            Ok(project_ids) => project_ids,
            Err(error) => {
                remove_sqlite_temporary_files(&prepared);
                return Err(error);
            }
        };
        if source_project_ids.is_empty() {
            remove_sqlite_temporary_files(&prepared);
            return Err(AppError::Validation("导入文件中没有研究项目。".into()));
        }
        if require_single_project && source_project_ids.len() != 1 {
            remove_sqlite_temporary_files(&prepared);
            return Err(AppError::Validation(format!(
                "项目导入文件应只包含 1 个项目，但当前文件包含 {} 个。请改用“合并数据库备份”。",
                source_project_ids.len()
            )));
        }

        let existing_project_ids = {
            let mut statement = self.connection.prepare("SELECT id FROM projects")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<BTreeSet<_>, _>>()?
        };
        let created_project_count = source_project_ids
            .iter()
            .filter(|project_id| !existing_project_ids.contains(*project_id))
            .count() as i64;

        self.export_database(safety_backup)?;
        self.record_backup(safety_backup, "auto", None, safety_backup.parent())?;
        let merge_result = merge_database_copy(&mut self.connection, &prepared);
        remove_sqlite_temporary_files(&prepared);
        merge_result?;
        ensure_foreign_keys_are_valid(&self.connection)?;
        Ok((source_project_ids.len() as i64, created_project_count))
    }

    pub fn create_card_from_selection(
        &mut self,
        input: CreateCardFromSelectionInput,
    ) -> AppResult<String> {
        validate_selection_text(&input.raw_text)?;
        let display_text = required_long_text(&input.display_text, "卡片摘录文字", 50_000)?;
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
        let origin_kind = if let Some(note_id) = input.source_reading_note_id.as_deref() {
            transaction
                .query_row(
                    r#"
                SELECT kind FROM reading_notes
                WHERE id = ?1 AND project_id = ?2 AND document_id = ?3
                  AND selected_text = ?4 AND page_number = ?5 AND locator_json = ?6
                "#,
                    params![
                        note_id,
                        input.project_id,
                        input.document_id,
                        input.raw_text,
                        input.pdf_page,
                        input.locator_json
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| {
                    AppError::Validation("待转换的阅读笔记与当前 PDF 原文位置不匹配。".into())
                })?
        } else {
            "normal".to_owned()
        };
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

        if transaction
            .query_row(
                "SELECT id FROM project_cards WHERE project_id = ?1 AND excerpt_id = ?2",
                params![input.project_id, excerpt_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some()
        {
            return Err(AppError::Validation(
                "这段原文已经存在研究卡片；原阅读笔记仍已保留。".into(),
            ));
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
        let text_override = if display_text == input.raw_text {
            ""
        } else {
            display_text.as_str()
        };
        transaction.execute(
            r#"
            INSERT INTO project_cards
              (id, project_id, excerpt_id, text_override, comment, category_id,
               synthesis_state, origin_kind, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?8)
            "#,
            params![
                card_id,
                input.project_id,
                excerpt_id,
                text_override,
                input.comment.trim(),
                category_id,
                origin_kind,
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
        if let Some(note_id) = input.source_reading_note_id.as_deref() {
            transaction.execute("DELETE FROM reading_notes WHERE id = ?1", params![note_id])?;
        }
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

    pub fn update_pdf_annotation(&mut self, input: UpdatePdfAnnotationInput) -> AppResult<()> {
        let color = validated_color(&input.color)?;
        let comment = limited_text(&input.comment, "批注评论", 20_000)?;
        let changed = self.connection.execute(
            "UPDATE pdf_annotations SET color = ?1, comment = ?2, updated_at = ?3 WHERE id = ?4",
            params![color, comment, timestamp(), input.annotation_id],
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
                ensure_project_document(&self.connection, &input.project_id, &input.document_id)?;
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

    pub fn update_reading_note(&mut self, input: UpdateReadingNoteInput) -> AppResult<()> {
        let content = required_long_text(&input.content, "阅读笔记", 20_000)?;
        let changed = self.connection.execute(
            "UPDATE reading_notes SET content = ?1, updated_at = ?2 WHERE id = ?3",
            params![content, timestamp(), input.note_id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("阅读笔记".into()));
        }
        Ok(())
    }

    pub fn update_card(&mut self, input: UpdateCardInput) -> AppResult<()> {
        let display_text = required_long_text(&input.display_text, "卡片摘录文字", 50_000)?;
        let normalized_tags = normalize_tags(&input.tags)?;
        let research_role_ids = input
            .research_role_ids
            .iter()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        if research_role_ids.len() > 24 {
            return Err(AppError::Validation(
                "单张卡片最多使用 24 个研究作用。".into(),
            ));
        }
        let print_page = input
            .print_page
            .as_deref()
            .map(|value| limited_text(value, "印刷页码", 80))
            .transpose()?
            .filter(|value| !value.is_empty());

        let now = timestamp();
        let transaction = self.connection.transaction()?;
        let (project_id, excerpt_id, clean_text): (String, String, String) = transaction
            .query_row(
                r#"
                SELECT pc.project_id, pc.excerpt_id, se.clean_text
                FROM project_cards pc
                JOIN source_excerpts se ON se.id = pc.excerpt_id
                WHERE pc.id = ?1
                "#,
                params![input.card_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("卡片".into()))?;
        for role_id in &research_role_ids {
            let valid: i64 = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM research_roles WHERE id = ?1 AND project_id = ?2)",
                params![role_id, project_id],
                |row| row.get(0),
            )?;
            if valid != 1 {
                return Err(AppError::Validation(
                    "所选研究作用不属于当前卡片项目。".into(),
                ));
            }
        }
        let text_override = if display_text == clean_text {
            ""
        } else {
            display_text.as_str()
        };
        transaction.execute(
            "UPDATE project_cards SET text_override = ?1, comment = ?2, updated_at = ?3 WHERE id = ?4",
            params![text_override, input.comment.trim(), now, input.card_id],
        )?;
        transaction.execute(
            "UPDATE source_excerpts SET print_page = ?1 WHERE id = ?2",
            params![print_page, excerpt_id],
        )?;
        transaction.execute(
            "DELETE FROM project_card_tags WHERE project_card_id = ?1",
            params![input.card_id],
        )?;
        write_card_tags(
            &transaction,
            &project_id,
            &input.card_id,
            normalized_tags,
            &now,
        )?;
        transaction.execute(
            "DELETE FROM project_card_roles WHERE project_card_id = ?1",
            params![input.card_id],
        )?;
        for role_id in research_role_ids {
            transaction.execute(
                r#"
                INSERT INTO project_card_roles
                  (project_card_id, research_role_id, created_at)
                VALUES (?1, ?2, ?3)
                "#,
                params![input.card_id, role_id, now],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn batch_update_cards(&mut self, input: BatchUpdateCardsInput) -> AppResult<usize> {
        ensure_project_exists(&self.connection, &input.project_id)?;
        let card_ids = input
            .card_ids
            .iter()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        if card_ids.is_empty() {
            return Err(AppError::Validation("请至少选择一张卡片。".into()));
        }
        if card_ids.len() > 5_000 {
            return Err(AppError::Validation(
                "单次最多批量处理 5000 张卡片。".into(),
            ));
        }

        let add_tags = normalize_tags(&input.add_tags)?;
        let remove_tags = normalize_tags(&input.remove_tags)?;
        if add_tags.iter().any(|tag| remove_tags.contains(tag)) {
            return Err(AppError::Validation(
                "同一个标签不能在一次操作中同时添加和移除。".into(),
            ));
        }
        if input.category_id.is_some() && input.synthesis_state.as_deref() == Some("excluded") {
            return Err(AppError::Validation(
                "批量移动分类和批量剔除应分开执行。".into(),
            ));
        }
        if let Some(state) = input.synthesis_state.as_deref() {
            if state != "active" && state != "excluded" {
                return Err(AppError::Validation("未知的卡片整理状态。".into()));
            }
        }

        let transaction = self.connection.transaction()?;
        if let Some(category_id) = input.category_id.as_deref() {
            let valid: i64 = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM synthesis_categories WHERE id = ?1 AND project_id = ?2)",
                params![category_id, input.project_id],
                |row| row.get(0),
            )?;
            if valid != 1 {
                return Err(AppError::Validation("整理分类不属于当前项目。".into()));
            }
        }

        for card_id in &card_ids {
            let valid: i64 = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM project_cards WHERE id = ?1 AND project_id = ?2)",
                params![card_id, input.project_id],
                |row| row.get(0),
            )?;
            if valid != 1 {
                return Err(AppError::Validation(
                    "所选卡片包含不存在或不属于当前项目的记录。".into(),
                ));
            }
        }

        let now = timestamp();
        for card_id in &card_ids {
            if !add_tags.is_empty() || !remove_tags.is_empty() {
                let existing_tags = {
                    let mut statement = transaction.prepare(
                        r#"
                        SELECT t.name
                        FROM project_card_tags pct
                        JOIN tags t ON t.id = pct.tag_id
                        WHERE pct.project_card_id = ?1
                        "#,
                    )?;
                    let rows =
                        statement.query_map(params![card_id], |row| row.get::<_, String>(0))?;
                    rows.collect::<Result<BTreeSet<_>, _>>()?
                };
                let next_tags = existing_tags
                    .difference(&remove_tags)
                    .cloned()
                    .chain(add_tags.iter().cloned())
                    .collect::<BTreeSet<_>>();
                if next_tags.len() > 24 {
                    return Err(AppError::Validation(
                        "批量添加后单张卡片不能超过 24 个标签。".into(),
                    ));
                }
                transaction.execute(
                    "DELETE FROM project_card_tags WHERE project_card_id = ?1",
                    params![card_id],
                )?;
                write_card_tags(&transaction, &input.project_id, card_id, next_tags, &now)?;
            }
            if let Some(category_id) = input.category_id.as_deref() {
                transaction.execute(
                    "UPDATE project_cards SET category_id = ?1, synthesis_state = 'active', updated_at = ?2 WHERE id = ?3",
                    params![category_id, now, card_id],
                )?;
            } else if let Some(state) = input.synthesis_state.as_deref() {
                transaction.execute(
                    "UPDATE project_cards SET synthesis_state = ?1, updated_at = ?2 WHERE id = ?3",
                    params![state, now, card_id],
                )?;
            } else if !add_tags.is_empty() || !remove_tags.is_empty() {
                transaction.execute(
                    "UPDATE project_cards SET updated_at = ?1 WHERE id = ?2",
                    params![now, card_id],
                )?;
            }
        }
        transaction.commit()?;
        Ok(card_ids.len())
    }

    pub fn create_research_role(&mut self, input: CreateResearchRoleInput) -> AppResult<String> {
        ensure_project_exists(&self.connection, &input.project_id)?;
        let name = required_text(&input.name, "研究作用名称")?;
        let color = validated_color(&input.color)?;
        let exists: i64 = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM research_roles WHERE project_id = ?1 AND name = ?2)",
            params![input.project_id, name],
            |row| row.get(0),
        )?;
        if exists == 1 {
            return Err(AppError::Validation("当前项目已经有同名研究作用。".into()));
        }
        let sort_order: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM research_roles WHERE project_id = ?1",
            params![input.project_id],
            |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let now = timestamp();
        self.connection.execute(
            r#"
            INSERT INTO research_roles
              (id, project_id, name, color, sort_order, is_default, is_archived,
               created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?6)
            "#,
            params![id, input.project_id, name, color, sort_order, now],
        )?;
        Ok(id)
    }

    pub fn update_research_role(&mut self, input: UpdateResearchRoleInput) -> AppResult<()> {
        let name = required_text(&input.name, "研究作用名称")?;
        let color = validated_color(&input.color)?;
        let project_id: String = self
            .connection
            .query_row(
                "SELECT project_id FROM research_roles WHERE id = ?1",
                params![input.research_role_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("研究作用".into()))?;
        let duplicate: i64 = self.connection.query_row(
            r#"
            SELECT EXISTS(
              SELECT 1 FROM research_roles
              WHERE project_id = ?1 AND name = ?2 AND id <> ?3
            )
            "#,
            params![project_id, name, input.research_role_id],
            |row| row.get(0),
        )?;
        if duplicate == 1 {
            return Err(AppError::Validation("当前项目已经有同名研究作用。".into()));
        }
        self.connection.execute(
            "UPDATE research_roles SET name = ?1, color = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, color, timestamp(), input.research_role_id],
        )?;
        Ok(())
    }

    pub fn set_research_role_archived(
        &mut self,
        research_role_id: &str,
        archived: bool,
    ) -> AppResult<()> {
        let changed = self.connection.execute(
            "UPDATE research_roles SET is_archived = ?1, updated_at = ?2 WHERE id = ?3",
            params![i64::from(archived), timestamp(), research_role_id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("研究作用".into()));
        }
        Ok(())
    }

    pub fn reorder_research_roles(
        &mut self,
        project_id: &str,
        ordered_ids: &[String],
    ) -> AppResult<()> {
        ensure_project_exists(&self.connection, project_id)?;
        let existing = {
            let mut statement = self
                .connection
                .prepare("SELECT id FROM research_roles WHERE project_id = ?1")?;
            let rows = statement.query_map(params![project_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<BTreeSet<_>, _>>()?
        };
        let requested = ordered_ids.iter().cloned().collect::<BTreeSet<_>>();
        if requested != existing || requested.len() != ordered_ids.len() {
            return Err(AppError::Validation(
                "研究作用排序必须包含当前项目的全部研究作用且不能重复。".into(),
            ));
        }
        let transaction = self.connection.transaction()?;
        let now = timestamp();
        for (index, id) in ordered_ids.iter().enumerate() {
            transaction.execute(
                "UPDATE research_roles SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
                params![(index as i64 + 1) * 1000, now, id],
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

    pub fn update_outline_card_link(&mut self, input: UpdateOutlineCardLinkInput) -> AppResult<()> {
        let note = limited_text(&input.note, "章节内使用说明", 20_000)?;
        let changed = self.connection.execute(
            "UPDATE outline_card_links SET note = ?1 WHERE id = ?2",
            params![note, input.link_id],
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

fn create_database_copy(source: &Connection, destination: &Path) -> AppResult<()> {
    if destination.exists() {
        return Err(AppError::Validation("临时数据库文件已存在。".into()));
    }
    let mut destination_connection = Connection::open(destination)?;
    let backup = Backup::new(source, &mut destination_connection)?;
    backup.run_to_completion(128, Duration::from_millis(10), None)?;
    drop(backup);
    destination_connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")?;
    Ok(())
}

fn remove_sqlite_temporary_files(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut exact_path = path.as_os_str().to_os_string();
        exact_path.push(suffix);
        let _ = fs::remove_file(PathBuf::from(exact_path));
    }
}

fn metadata_value(connection: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT value FROM app_metadata WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?)
}

fn set_or_remove_metadata(
    transaction: &Transaction<'_>,
    key: &str,
    value: Option<String>,
) -> AppResult<()> {
    if let Some(value) = value {
        transaction.execute(
            r#"
            INSERT INTO app_metadata (key, value) VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            "#,
            params![key, value],
        )?;
    } else {
        transaction.execute("DELETE FROM app_metadata WHERE key = ?1", params![key])?;
    }
    Ok(())
}

fn validate_automatic_backup_interval(interval_hours: i64) -> AppResult<()> {
    if [0, 24, 72, 168, 720].contains(&interval_hours) {
        Ok(())
    } else {
        Err(AppError::Validation(
            "自动备份频率必须使用应用提供的常用选项。".into(),
        ))
    }
}

fn validate_backup_retention(
    retention_days: Option<i64>,
    retention_count: Option<i64>,
) -> AppResult<()> {
    if retention_days.is_some() && retention_count.is_some() {
        return Err(AppError::Validation(
            "备份只能选择一种自动清理策略。".into(),
        ));
    }
    if retention_days.is_some_and(|days| !(1..=3650).contains(&days)) {
        return Err(AppError::Validation(
            "自动备份保留天数必须在 1 到 3650 天之间。".into(),
        ));
    }
    if retention_count.is_some_and(|count| !(3..=500).contains(&count)) {
        return Err(AppError::Validation(
            "自动备份保留份数必须在 3 到 500 份之间。".into(),
        ));
    }
    Ok(())
}

fn validated_automatic_backup_path(
    path: &Path,
    managed_directory: &Path,
    expected_directory: Option<&Path>,
) -> AppResult<PathBuf> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Validation("自动备份文件名无效。".into()))?;
    let valid_name = file_name.starts_with("inkstone-before-")
        && path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("db"));
    if !valid_name {
        return Err(AppError::Validation(
            "拒绝处理不符合砚台自动备份命名规则的文件。".into(),
        ));
    }
    let canonical_directory = managed_directory.canonicalize()?;
    if let Some(expected_directory) = expected_directory {
        let canonical_expected = expected_directory.canonicalize()?;
        if canonical_directory != canonical_expected {
            return Err(AppError::Validation(
                "自动备份不在当前设置的备份目录中。".into(),
            ));
        }
    }
    let canonical_path = path.canonicalize()?;
    if canonical_path.parent() != Some(canonical_directory.as_path()) || !canonical_path.is_file() {
        return Err(AppError::Validation(
            "自动备份文件不在登记的受管理目录中。".into(),
        ));
    }
    Ok(canonical_path)
}

struct ImportTableSpec {
    table: &'static str,
    identity: &'static str,
    columns: &'static [&'static str],
}

const IMPORT_TABLES: &[ImportTableSpec] = &[
    ImportTableSpec {
        table: "projects",
        identity: "d.id IS s.id",
        columns: &["id", "name", "description", "color", "sort_order", "created_at", "updated_at"],
    },
    ImportTableSpec {
        table: "documents",
        identity: "d.id IS s.id",
        columns: &["id", "title", "authors", "year", "file_path", "file_hash", "created_at", "updated_at", "journal", "volume", "issue", "pages", "doi", "publisher", "metadata_raw"],
    },
    ImportTableSpec {
        table: "document_groups",
        identity: "d.id IS s.id OR (d.project_id IS s.project_id AND d.parent_id IS s.parent_id AND d.name IS s.name)",
        columns: &["id", "project_id", "parent_id", "name", "sort_order", "created_at", "updated_at"],
    },
    ImportTableSpec {
        table: "project_documents",
        identity: "d.project_id IS s.project_id AND d.document_id IS s.document_id",
        columns: &["project_id", "document_id", "sort_order", "created_at", "removed_at", "group_id"],
    },
    ImportTableSpec {
        table: "source_excerpts",
        identity: "d.id IS s.id",
        columns: &["id", "document_id", "raw_text", "clean_text", "pdf_page", "print_page", "locator_json", "context_before", "context_after", "source_hash", "created_at"],
    },
    ImportTableSpec {
        table: "synthesis_categories",
        identity: "d.id IS s.id OR (d.project_id IS s.project_id AND d.name IS s.name)",
        columns: &["id", "project_id", "name", "color", "sort_order", "is_default", "created_at", "updated_at"],
    },
    ImportTableSpec {
        table: "research_roles",
        identity: "d.id IS s.id OR (d.project_id IS s.project_id AND d.name IS s.name)",
        columns: &["id", "project_id", "name", "color", "sort_order", "is_default", "is_archived", "created_at", "updated_at"],
    },
    ImportTableSpec {
        table: "project_cards",
        identity: "d.id IS s.id OR (d.project_id IS s.project_id AND d.excerpt_id IS s.excerpt_id)",
        columns: &["id", "project_id", "excerpt_id", "text_override", "comment", "role", "category_id", "synthesis_state", "origin_kind", "created_at", "updated_at"],
    },
    ImportTableSpec {
        table: "tags",
        identity: "d.id IS s.id OR (d.project_id IS s.project_id AND d.name IS s.name)",
        columns: &["id", "project_id", "name", "created_at"],
    },
    ImportTableSpec {
        table: "project_card_tags",
        identity: "d.project_card_id IS s.project_card_id AND d.tag_id IS s.tag_id",
        columns: &["project_card_id", "tag_id"],
    },
    ImportTableSpec {
        table: "project_card_roles",
        identity: "d.project_card_id IS s.project_card_id AND d.research_role_id IS s.research_role_id",
        columns: &["project_card_id", "research_role_id", "created_at"],
    },
    ImportTableSpec {
        table: "pdf_annotations",
        identity: "d.id IS s.id",
        columns: &["id", "project_id", "document_id", "kind", "page_number", "color", "selected_text", "locator_json", "comment", "created_at", "updated_at"],
    },
    ImportTableSpec {
        table: "reading_notes",
        identity: "d.id IS s.id",
        columns: &["id", "project_id", "document_id", "kind", "content", "selected_text", "page_number", "locator_json", "created_at", "updated_at"],
    },
    ImportTableSpec {
        table: "outline_nodes",
        identity: "d.id IS s.id",
        columns: &["id", "project_id", "parent_id", "title", "notes", "core_argument", "open_questions", "sort_order", "created_at", "updated_at"],
    },
    ImportTableSpec {
        table: "outline_card_links",
        identity: "d.id IS s.id OR (d.outline_node_id IS s.outline_node_id AND d.project_card_id IS s.project_card_id)",
        columns: &["id", "outline_node_id", "project_card_id", "note", "sort_order", "created_at"],
    },
];

fn inspect_import_database(
    destination: &Connection,
    source: &Path,
) -> AppResult<(DatabaseImportPreview, Vec<Option<PathBuf>>)> {
    destination.execute(
        "ATTACH DATABASE ?1 AS import_preview",
        params![source.to_string_lossy()],
    )?;
    let inspection = (|| -> AppResult<(DatabaseImportPreview, Vec<Option<PathBuf>>)> {
        let mut preview = DatabaseImportPreview::default();
        for spec in IMPORT_TABLES {
            let source_count: i64 = destination.query_row(
                &format!("SELECT COUNT(*) FROM import_preview.{}", spec.table),
                [],
                |row| row.get(0),
            )?;
            let added_count: i64 = destination.query_row(
                &format!(
                    "SELECT COUNT(*) FROM import_preview.{0} s WHERE NOT EXISTS (SELECT 1 FROM main.{0} d WHERE {1})",
                    spec.table, spec.identity
                ),
                [],
                |row| row.get(0),
            )?;
            let exact_match = spec
                .columns
                .iter()
                .map(|column| format!("d.{column} IS s.{column}"))
                .collect::<Vec<_>>()
                .join(" AND ");
            let conflict_count: i64 = destination.query_row(
                &format!(
                    "SELECT COUNT(*) FROM import_preview.{0} s WHERE EXISTS (SELECT 1 FROM main.{0} d WHERE {1}) AND NOT EXISTS (SELECT 1 FROM main.{0} d WHERE ({1}) AND {2})",
                    spec.table, spec.identity, exact_match
                ),
                [],
                |row| row.get(0),
            )?;
            let existing_count = source_count.saturating_sub(added_count);
            preview.source_item_count = preview.source_item_count.saturating_add(source_count);
            preview.added_item_count = preview.added_item_count.saturating_add(added_count);
            preview.conflict_item_count =
                preview.conflict_item_count.saturating_add(conflict_count);
            preview.skipped_item_count = preview
                .skipped_item_count
                .saturating_add(existing_count.saturating_sub(conflict_count));
            match spec.table {
                "projects" => {
                    preview.source_project_count = source_count;
                    preview.created_project_count = added_count;
                    preview.merged_project_count = existing_count;
                }
                "documents" => preview.source_document_count = source_count,
                "project_cards" => preview.source_card_count = source_count,
                "pdf_annotations" => preview.source_annotation_count = source_count,
                "outline_nodes" => preview.source_outline_node_count = source_count,
                _ => {}
            }
        }

        let mut statement = destination.prepare(
            r#"
            SELECT CASE WHEN d.id IS NULL THEN s.file_path ELSE d.file_path END
            FROM import_preview.documents s
            LEFT JOIN main.documents d ON d.id = s.id
            ORDER BY s.id
            "#,
        )?;
        let paths = statement
            .query_map([], |row| row.get::<_, Option<String>>(0))?
            .map(|value| value.map(|path| path.map(PathBuf::from)))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((preview, paths))
    })();
    let detach = destination
        .execute_batch("DETACH DATABASE import_preview")
        .map_err(AppError::from);
    inspection.and_then(|value| detach.map(|_| value))
}

fn merge_database_copy(destination: &mut Connection, source: &Path) -> AppResult<()> {
    destination.execute(
        "ATTACH DATABASE ?1 AS import_db",
        params![source.to_string_lossy()],
    )?;
    let merge_result = (|| -> AppResult<()> {
        let transaction = destination.transaction()?;
        transaction.execute_batch(
            r#"
            INSERT OR IGNORE INTO projects
              (id, name, description, color, sort_order, created_at, updated_at)
            SELECT id, name, description, color, sort_order, created_at, updated_at
            FROM import_db.projects;

            INSERT OR IGNORE INTO documents
              (id, title, authors, year, file_path, file_hash, created_at, updated_at,
               journal, volume, issue, pages, doi, publisher, metadata_raw)
            SELECT id, title, authors, year, file_path, file_hash, created_at, updated_at,
                   journal, volume, issue, pages, doi, publisher, metadata_raw
            FROM import_db.documents;

            INSERT OR IGNORE INTO document_groups
              (id, project_id, parent_id, name, sort_order, created_at, updated_at)
            SELECT id, project_id, parent_id, name, sort_order, created_at, updated_at
            FROM import_db.document_groups;

            INSERT OR IGNORE INTO project_documents
              (project_id, document_id, sort_order, created_at, removed_at, group_id)
            SELECT pd.project_id, pd.document_id, pd.sort_order, pd.created_at, pd.removed_at,
                   CASE WHEN EXISTS(
                     SELECT 1 FROM main.document_groups dg
                     WHERE dg.id = pd.group_id AND dg.project_id = pd.project_id
                   ) THEN pd.group_id ELSE NULL END
            FROM import_db.project_documents pd;

            INSERT OR IGNORE INTO source_excerpts
              (id, document_id, raw_text, clean_text, pdf_page, print_page,
               locator_json, context_before, context_after, source_hash, created_at)
            SELECT id, document_id, raw_text, clean_text, pdf_page, print_page,
                   locator_json, context_before, context_after, source_hash, created_at
            FROM import_db.source_excerpts;

            INSERT OR IGNORE INTO synthesis_categories
              (id, project_id, name, color, sort_order, is_default, created_at, updated_at)
            SELECT id, project_id, name, color, sort_order, is_default, created_at, updated_at
            FROM import_db.synthesis_categories;

            INSERT OR IGNORE INTO research_roles
              (id, project_id, name, color, sort_order, is_default, is_archived,
               created_at, updated_at)
            SELECT id, project_id, name, color, sort_order, is_default, is_archived,
                   created_at, updated_at
            FROM import_db.research_roles;

            INSERT OR IGNORE INTO project_cards
              (id, project_id, excerpt_id, text_override, comment, role, category_id,
               synthesis_state, origin_kind, created_at, updated_at)
            SELECT pc.id, pc.project_id, pc.excerpt_id, pc.text_override, pc.comment, pc.role,
                   CASE
                     WHEN pc.category_id IS NULL THEN NULL
                     WHEN EXISTS(
                       SELECT 1 FROM main.synthesis_categories dc
                       WHERE dc.id = pc.category_id
                     ) THEN pc.category_id
                     ELSE (
                       SELECT dc.id
                       FROM import_db.synthesis_categories sc
                       JOIN main.synthesis_categories dc
                         ON dc.project_id = pc.project_id AND dc.name = sc.name
                       WHERE sc.id = pc.category_id
                       LIMIT 1
                     )
                   END,
                   pc.synthesis_state, pc.origin_kind, pc.created_at, pc.updated_at
            FROM import_db.project_cards pc;

            INSERT OR IGNORE INTO tags (id, project_id, name, created_at)
            SELECT id, project_id, name, created_at
            FROM import_db.tags;

            WITH resolved_card_tags AS (
              SELECT
                COALESCE(
                  (SELECT dc.id FROM main.project_cards dc
                   WHERE dc.id = pct.project_card_id),
                  (SELECT dc.id
                   FROM import_db.project_cards sc
                   JOIN main.project_cards dc
                     ON dc.project_id = sc.project_id AND dc.excerpt_id = sc.excerpt_id
                   WHERE sc.id = pct.project_card_id
                   LIMIT 1)
                ) AS project_card_id,
                COALESCE(
                  (SELECT dt.id FROM main.tags dt WHERE dt.id = pct.tag_id),
                  (SELECT dt.id
                   FROM import_db.tags st
                   JOIN main.tags dt
                     ON dt.project_id = st.project_id AND dt.name = st.name
                   WHERE st.id = pct.tag_id
                   LIMIT 1)
                ) AS tag_id
              FROM import_db.project_card_tags pct
            )
            INSERT OR IGNORE INTO project_card_tags (project_card_id, tag_id)
            SELECT project_card_id, tag_id
            FROM resolved_card_tags
            WHERE project_card_id IS NOT NULL AND tag_id IS NOT NULL;

            WITH resolved_card_roles AS (
              SELECT
                COALESCE(
                  (SELECT dc.id FROM main.project_cards dc
                   WHERE dc.id = pcr.project_card_id),
                  (SELECT dc.id
                   FROM import_db.project_cards sc
                   JOIN main.project_cards dc
                     ON dc.project_id = sc.project_id AND dc.excerpt_id = sc.excerpt_id
                   WHERE sc.id = pcr.project_card_id
                   LIMIT 1)
                ) AS project_card_id,
                COALESCE(
                  (SELECT dr.id FROM main.research_roles dr
                   WHERE dr.id = pcr.research_role_id),
                  (SELECT dr.id
                   FROM import_db.research_roles sr
                   JOIN main.research_roles dr
                     ON dr.project_id = sr.project_id AND dr.name = sr.name
                   WHERE sr.id = pcr.research_role_id
                   LIMIT 1)
                ) AS research_role_id,
                pcr.created_at
              FROM import_db.project_card_roles pcr
            )
            INSERT OR IGNORE INTO project_card_roles
              (project_card_id, research_role_id, created_at)
            SELECT project_card_id, research_role_id, created_at
            FROM resolved_card_roles
            WHERE project_card_id IS NOT NULL AND research_role_id IS NOT NULL;

            INSERT OR IGNORE INTO pdf_annotations
              (id, project_id, document_id, kind, page_number, color,
               selected_text, locator_json, comment, created_at, updated_at)
            SELECT id, project_id, document_id, kind, page_number, color,
                   selected_text, locator_json, comment, created_at, updated_at
            FROM import_db.pdf_annotations;

            INSERT OR IGNORE INTO reading_notes
              (id, project_id, document_id, kind, content, selected_text,
               page_number, locator_json, created_at, updated_at)
            SELECT id, project_id, document_id, kind, content, selected_text,
                   page_number, locator_json, created_at, updated_at
            FROM import_db.reading_notes;

            INSERT OR IGNORE INTO outline_nodes
              (id, project_id, parent_id, title, notes, core_argument,
               open_questions, sort_order, created_at, updated_at)
            SELECT id, project_id, parent_id, title, notes, core_argument,
                   open_questions, sort_order, created_at, updated_at
            FROM import_db.outline_nodes;

            WITH resolved_outline_links AS (
              SELECT
                sl.id,
                sl.outline_node_id,
                COALESCE(
                  (SELECT dc.id FROM main.project_cards dc
                   WHERE dc.id = sl.project_card_id),
                  (SELECT dc.id
                   FROM import_db.project_cards sc
                   JOIN main.project_cards dc
                     ON dc.project_id = sc.project_id AND dc.excerpt_id = sc.excerpt_id
                   WHERE sc.id = sl.project_card_id
                   LIMIT 1)
                ) AS project_card_id,
                sl.note,
                sl.sort_order,
                sl.created_at
              FROM import_db.outline_card_links sl
            )
            INSERT OR IGNORE INTO outline_card_links
              (id, outline_node_id, project_card_id, note, sort_order, created_at)
            SELECT id, outline_node_id, project_card_id, note, sort_order, created_at
            FROM resolved_outline_links
            WHERE project_card_id IS NOT NULL;

            "#,
        )?;
        transaction.commit()?;
        Ok(())
    })();
    let detach_result = destination
        .execute_batch("DETACH DATABASE import_db")
        .map_err(AppError::from);
    merge_result?;
    detach_result
}

fn validate_database_file(path: &Path) -> AppResult<()> {
    if !path.is_file() {
        return Err(AppError::Validation("选择的数据库备份不存在。".into()));
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Validation(format!(
            "数据库完整性检查未通过：{integrity}"
        )));
    }
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if !(1..=SCHEMA_VERSION).contains(&version) {
        return Err(AppError::Validation(format!(
            "数据库版本不受支持（版本 {version}，当前支持 1–{SCHEMA_VERSION}）。"
        )));
    }
    let mut required_tables = vec![
        "projects",
        "documents",
        "project_documents",
        "source_excerpts",
        "project_cards",
        "synthesis_categories",
        "outline_nodes",
        "outline_card_links",
    ];
    if version >= 2 {
        required_tables.push("pdf_annotations");
    }
    if version >= 4 {
        required_tables.push("reading_notes");
    }
    if version >= 6 {
        required_tables.push("app_metadata");
    }
    if version >= 7 {
        required_tables.push("research_roles");
        required_tables.push("project_card_roles");
    }
    if version >= 8 {
        required_tables.push("backup_records");
    }
    if version >= 9 {
        required_tables.push("document_groups");
    }
    for table in required_tables {
        let exists: i64 = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get(0),
        )?;
        if exists != 1 {
            return Err(AppError::Validation(format!(
                "所选文件不是完整的砚台数据库（缺少 {table}）。"
            )));
        }
    }
    Ok(())
}

fn ensure_foreign_keys_are_valid(connection: &Connection) -> AppResult<()> {
    let violation = connection
        .query_row(
            "SELECT \"table\" FROM pragma_foreign_key_check LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(table) = violation {
        return Err(AppError::Validation(format!(
            "数据库关联完整性检查未通过（表 {table}）。"
        )));
    }
    Ok(())
}

fn replace_file(source: &Path, destination: &Path) -> AppResult<()> {
    if !destination.exists() {
        fs::rename(source, destination)?;
        return Ok(());
    }

    let parent = destination
        .parent()
        .ok_or_else(|| AppError::Validation("无法确定备份目标目录。".into()))?;
    let displaced = parent.join(format!(".inkstone-replaced-{}.tmp", Uuid::new_v4()));
    fs::rename(destination, &displaced)?;
    match fs::rename(source, destination) {
        Ok(()) => {
            let _ = fs::remove_file(displaced);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&displaced, destination);
            Err(AppError::Io(error))
        }
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

fn research_role_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResearchRole> {
    Ok(ResearchRole {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        color: row.get(3)?,
        sort_order: row.get(4)?,
        is_default: row.get::<_, i64>(5)? == 1,
        is_archived: row.get::<_, i64>(6)? == 1,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn write_default_research_roles(
    transaction: &Transaction<'_>,
    project_id: &str,
    now: &str,
) -> AppResult<()> {
    for (name, color, sort_order) in [
        ("支持", "#5f7f69", 1000_i64),
        ("反对", "#a65e52", 2000_i64),
        ("限定", "#7b6d94", 3000_i64),
        ("背景", "#687d8d", 4000_i64),
    ] {
        transaction.execute(
            r#"
            INSERT INTO research_roles
              (id, project_id, name, color, sort_order, is_default, is_archived,
               created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, ?6, ?6)
            "#,
            params![
                Uuid::new_v4().to_string(),
                project_id,
                name,
                color,
                sort_order,
                now
            ],
        )?;
    }
    Ok(())
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

fn ensure_document_group_parent(
    connection: &Connection,
    project_id: &str,
    parent_id: Option<&str>,
    moving_group_id: Option<&str>,
) -> AppResult<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    if moving_group_id == Some(parent_id) {
        return Err(AppError::Validation("文献分类不能成为自己的上级。".into()));
    }
    let parent_project_id: Option<String> = connection
        .query_row(
            "SELECT project_id FROM document_groups WHERE id = ?1",
            params![parent_id],
            |row| row.get(0),
        )
        .optional()?;
    if parent_project_id.as_deref() != Some(project_id) {
        return Err(AppError::Validation("上级文献分类不属于当前项目。".into()));
    }
    if let Some(group_id) = moving_group_id {
        let creates_cycle: i64 = connection.query_row(
            r#"
            WITH RECURSIVE descendants(id) AS (
              SELECT id FROM document_groups WHERE parent_id = ?1
              UNION ALL
              SELECT dg.id
              FROM document_groups dg
              JOIN descendants d ON dg.parent_id = d.id
            )
            SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)
            "#,
            params![group_id, parent_id],
            |row| row.get(0),
        )?;
        if creates_cycle == 1 {
            return Err(AppError::Validation(
                "不能把文献分类移入自己的下级分类。".into(),
            ));
        }
    }
    Ok(())
}

fn ensure_document_group_name_available(
    connection: &Connection,
    project_id: &str,
    parent_id: Option<&str>,
    name: &str,
    excluded_id: Option<&str>,
) -> AppResult<()> {
    let duplicate: i64 = connection.query_row(
        r#"
        SELECT EXISTS(
          SELECT 1 FROM document_groups
          WHERE project_id = ?1 AND parent_id IS ?2 AND name = ?3
            AND id != COALESCE(?4, '')
        )
        "#,
        params![project_id, parent_id, name, excluded_id],
        |row| row.get(0),
    )?;
    if duplicate == 1 {
        return Err(AppError::Validation("同一级中已存在同名文献分类。".into()));
    }
    Ok(())
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
    fn hierarchical_document_groups_move_documents_and_delete_without_data_loss() {
        let mut repository = Repository::memory().expect("memory database");
        let root_group = repository
            .create_document_group(CreateDocumentGroupInput {
                project_id: "seed-project-tombs".into(),
                parent_id: None,
                name: "时代".into(),
            })
            .expect("create root group");
        let child_group = repository
            .create_document_group(CreateDocumentGroupInput {
                project_id: "seed-project-tombs".into(),
                parent_id: Some(root_group.clone()),
                name: "汉代".into(),
            })
            .expect("create child group");
        repository
            .move_document_to_group(MoveDocumentToGroupInput {
                project_id: "seed-project-tombs".into(),
                document_id: "seed-document-space".into(),
                group_id: Some(child_group.clone()),
            })
            .expect("assign document to child group");

        let grouped = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("grouped workspace");
        assert_eq!(grouped.document_groups.len(), 2);
        assert_eq!(
            grouped
                .documents
                .iter()
                .find(|document| document.id == "seed-document-space")
                .expect("grouped document")
                .group_id
                .as_deref(),
            Some(child_group.as_str())
        );
        assert!(repository
            .update_document_group(UpdateDocumentGroupInput {
                group_id: root_group.clone(),
                parent_id: Some(child_group),
                name: "时代".into(),
            })
            .is_err());

        repository
            .delete_document_group(&root_group)
            .expect("delete group tree");
        let ungrouped = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after group deletion");
        assert!(ungrouped.document_groups.is_empty());
        assert!(ungrouped
            .documents
            .iter()
            .find(|document| document.id == "seed-document-space")
            .expect("retained document")
            .group_id
            .is_none());
        assert!(ungrouped.cards.iter().any(|card| card.id == "seed-card-1"));
    }

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
    fn batch_card_updates_tags_category_and_synthesis_state_in_one_transaction() {
        let mut repository = Repository::memory().expect("memory database");
        let category_id = repository
            .create_category(CreateCategoryInput {
                project_id: "seed-project-tombs".into(),
                name: "批量分类".into(),
                color: "#8a6757".into(),
            })
            .expect("create batch category");

        let affected = repository
            .batch_update_cards(BatchUpdateCardsInput {
                project_id: "seed-project-tombs".into(),
                card_ids: vec!["seed-card-1".into(), "seed-card-4".into()],
                add_tags: vec!["批量标签".into()],
                remove_tags: vec!["墓葬空间".into()],
                category_id: Some(category_id.clone()),
                synthesis_state: None,
            })
            .expect("batch update cards");
        assert_eq!(affected, 2);

        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after batch update");
        for card_id in ["seed-card-1", "seed-card-4"] {
            let card = snapshot
                .cards
                .iter()
                .find(|card| card.id == card_id)
                .expect("updated card");
            assert_eq!(card.category_id.as_deref(), Some(category_id.as_str()));
            assert!(card.tags.iter().any(|tag| tag == "批量标签"));
            assert!(!card.tags.iter().any(|tag| tag == "墓葬空间"));
            assert_eq!(card.synthesis_state, "active");
        }

        repository
            .batch_update_cards(BatchUpdateCardsInput {
                project_id: "seed-project-tombs".into(),
                card_ids: vec!["seed-card-1".into(), "seed-card-4".into()],
                add_tags: vec![],
                remove_tags: vec![],
                category_id: None,
                synthesis_state: Some("excluded".into()),
            })
            .expect("batch exclude cards");
        let excluded = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after batch exclusion");
        assert!(excluded
            .cards
            .iter()
            .filter(|card| ["seed-card-1", "seed-card-4"].contains(&card.id.as_str()))
            .all(|card| card.synthesis_state == "excluded"));
    }

    #[test]
    fn batch_card_update_rejects_cross_project_selection_without_partial_writes() {
        let mut repository = Repository::memory().expect("memory database");
        let result = repository.batch_update_cards(BatchUpdateCardsInput {
            project_id: "seed-project-tombs".into(),
            card_ids: vec!["seed-card-1".into(), "seed-card-6".into()],
            add_tags: vec!["不应写入".into()],
            remove_tags: vec![],
            category_id: None,
            synthesis_state: None,
        });
        assert!(result.is_err());
        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after rejected batch");
        assert!(!snapshot
            .cards
            .iter()
            .find(|card| card.id == "seed-card-1")
            .expect("unchanged card")
            .tags
            .iter()
            .any(|tag| tag == "不应写入"));
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
    fn reading_notes_annotations_and_outline_link_notes_can_be_edited_in_place() {
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
                kind: "insight".into(),
                content: "初始灵感".into(),
                selected_text: String::new(),
                page_number: None,
                locator_json: String::new(),
            })
            .expect("create note");
        repository
            .update_reading_note(UpdateReadingNoteInput {
                note_id: note_id.clone(),
                content: "修订后的灵感".into(),
            })
            .expect("update note");

        let annotation_id = repository
            .create_pdf_annotation(CreatePdfAnnotationInput {
                project_id: "seed-project-tombs".into(),
                document_id: "seed-document-space".into(),
                kind: "highlight".into(),
                page_number: 17,
                color: "#e8bd55".into(),
                selected_text: "批注原文".into(),
                locator_json: r#"{"version":1,"page":17,"rects":[{"x":0.1,"y":0.2,"width":0.3,"height":0.04}]}"#.into(),
                comment: String::new(),
            })
            .expect("create annotation");
        repository
            .update_pdf_annotation(UpdatePdfAnnotationInput {
                annotation_id: annotation_id.clone(),
                color: "#a45f45".into(),
                comment: "补充的批注评论".into(),
            })
            .expect("update annotation");
        repository
            .update_outline_card_link(UpdateOutlineCardLinkInput {
                link_id: "seed-link-1".into(),
                note: "用于本章界定研究方法的边界。".into(),
            })
            .expect("update outline link note");

        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after edits");
        assert_eq!(
            snapshot
                .reading_notes
                .iter()
                .find(|note| note.id == note_id)
                .expect("updated note")
                .content,
            "修订后的灵感"
        );
        let annotation = snapshot
            .pdf_annotations
            .iter()
            .find(|annotation| annotation.id == annotation_id)
            .expect("updated annotation");
        assert_eq!(annotation.color, "#a45f45");
        assert_eq!(annotation.comment, "补充的批注评论");
        assert_eq!(
            snapshot
                .outline_links
                .iter()
                .find(|link| link.id == "seed-link-1")
                .expect("updated link")
                .note,
            "用于本章界定研究方法的边界。"
        );
    }

    #[test]
    fn full_database_merge_preserves_existing_data_and_is_idempotent() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-database-transfer")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create database transfer directory");
        let source_path = root.join("source.db");
        let exported_path = root.join("exported.db");
        let target_path = root.join("target.db");
        let safety_path = root.join("before-import.db");
        let repeat_safety_path = root.join("before-repeat-import.db");

        let (note_id, annotation_id, source_only_project) = {
            let mut source = Repository::open(&source_path).expect("open source repository");
            source
                .connection
                .execute(
                    "UPDATE documents SET file_path = 'managed.pdf', file_hash = 'managed-hash' WHERE id = 'seed-document-space'",
                    [],
                )
                .expect("attach PDF metadata for annotation backup test");
            source
                .connection
                .execute(
                    "UPDATE project_cards SET text_override = '人工修正后的摘录' WHERE id = 'seed-card-1'",
                    [],
                )
                .expect("store corrected excerpt text");
            let note_id = source
                .create_reading_note(CreateReadingNoteInput {
                    project_id: "seed-project-tombs".into(),
                    document_id: "seed-document-space".into(),
                    kind: "insight".into(),
                    content: "这条笔记用于验证整库备份。".into(),
                    selected_text: String::new(),
                    page_number: None,
                    locator_json: String::new(),
                })
                .expect("create source note");
            let annotation_id = source
                .create_pdf_annotation(CreatePdfAnnotationInput {
                    project_id: "seed-project-tombs".into(),
                    document_id: "seed-document-space".into(),
                    kind: "underline".into(),
                    page_number: 17,
                    color: "#a45f45".into(),
                    selected_text: "用于验证批注备份".into(),
                    locator_json: r#"{"version":1,"page":17,"rects":[{"x":0.1,"y":0.2,"width":0.3,"height":0.04}]}"#.into(),
                    comment: String::new(),
                })
                .expect("create source annotation");
            let source_only_project = source
                .create_project(CreateProjectInput {
                    name: "备份文件独有项目".into(),
                    description: "用于验证完整备份合并会补充缺失项目。".into(),
                    color: Some("#456789".into()),
                })
                .expect("create source-only project");
            source
                .export_database(&exported_path)
                .expect("export consistent database copy");
            (note_id, annotation_id, source_only_project)
        };

        {
            let mut target = Repository::open(&target_path).expect("open target repository");
            let target_only_project = target
                .create_project(CreateProjectInput {
                    name: "导入前独有项目".into(),
                    description: String::new(),
                    color: None,
                })
                .expect("create target-only project");
            let (preview, preview_paths) = target
                .preview_database_import(&exported_path, &root, false)
                .expect("preview complete database merge");
            assert_eq!(preview.source_project_count, 3);
            assert_eq!(preview.created_project_count, 1);
            assert_eq!(preview.merged_project_count, 2);
            assert!(preview.source_document_count > 0);
            assert!(preview.source_card_count > 0);
            assert!(preview.added_item_count > 0);
            assert!(preview.conflict_item_count > 0);
            assert_eq!(preview_paths.len() as i64, preview.source_document_count);
            let (source_project_count, created_project_count) = target
                .import_database(&exported_path, &safety_path)
                .expect("import complete database");
            assert_eq!(source_project_count, 3);
            assert_eq!(created_project_count, 1);

            let restored = target
                .get_workspace(Some("seed-project-tombs"))
                .expect("load imported workspace");
            assert!(restored.reading_notes.iter().any(|note| note.id == note_id));
            assert!(restored
                .pdf_annotations
                .iter()
                .any(|annotation| annotation.id == annotation_id));
            assert_eq!(
                restored
                    .cards
                    .iter()
                    .find(|card| card.id == "seed-card-1")
                    .expect("existing target card")
                    .display_text,
                "墓葬空间并非被动地反映社会关系，而是在仪式实践中持续参与关系的生产。"
            );
            assert!(restored
                .outline_links
                .iter()
                .any(|link| link.id == "seed-link-1"));
            assert!(restored
                .projects
                .iter()
                .any(|project| project.id == target_only_project));
            assert!(restored
                .projects
                .iter()
                .any(|project| project.id == source_only_project));

            let counts_before_repeat = (
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM projects", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("count projects"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM project_cards", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("count cards"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM pdf_annotations", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("count annotations"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM reading_notes", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("count reading notes"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM outline_card_links", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("count outline links"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM research_roles", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("count research roles"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM project_card_roles", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("count card role links"),
            );
            let (_, created_on_repeat) = target
                .import_database(&exported_path, &repeat_safety_path)
                .expect("repeat complete database merge");
            assert_eq!(created_on_repeat, 0);
            let counts_after_repeat = (
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM projects", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("recount projects"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM project_cards", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("recount cards"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM pdf_annotations", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("recount annotations"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM reading_notes", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("recount reading notes"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM outline_card_links", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("recount outline links"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM research_roles", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("recount research roles"),
                target
                    .connection
                    .query_row("SELECT COUNT(*) FROM project_card_roles", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("recount card role links"),
            );
            assert_eq!(counts_after_repeat, counts_before_repeat);
            let (repeat_preview, _) = target
                .preview_database_import(&exported_path, &root, false)
                .expect("preview idempotent repeat merge");
            assert_eq!(repeat_preview.created_project_count, 0);
            assert_eq!(repeat_preview.added_item_count, 0);
            assert!(repeat_preview.skipped_item_count > 0);
            assert!(repeat_preview.conflict_item_count > 0);
            ensure_foreign_keys_are_valid(&target.connection)
                .expect("foreign keys after repeated merge");

            let safety = Repository::open(&safety_path).expect("open automatic safety backup");
            assert!(safety
                .get_workspace(Some(&target_only_project))
                .expect("load safety backup")
                .projects
                .iter()
                .any(|project| project.id == target_only_project));
        }

        fs::remove_dir_all(root).expect("remove database transfer directory");
    }

    #[test]
    fn relinking_a_missing_pdf_preserves_existing_excerpts_and_reports_hash_change() {
        let mut repository = Repository::memory().expect("memory database");
        repository
            .connection
            .execute(
                "UPDATE documents SET file_path = 'missing-old.pdf', file_hash = 'old-hash' WHERE id = 'seed-document-space'",
                [],
            )
            .expect("record missing PDF");
        let original = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace before relink")
            .cards
            .into_iter()
            .find(|card| card.id == "seed-card-1")
            .expect("original card");

        let result = repository
            .register_imported_pdf(
                &ImportPdfInput {
                    project_id: "seed-project-tombs".into(),
                    source_path: "replacement.pdf".into(),
                    target_document_id: Some("seed-document-space".into()),
                    title: "从墓葬空间看社会关系的形成".into(),
                    authors: "陈明远".into(),
                    year: Some(2022),
                    journal: String::new(),
                    volume: String::new(),
                    issue: String::new(),
                    pages: String::new(),
                    doi: String::new(),
                    publisher: String::new(),
                    metadata_raw: String::new(),
                },
                Path::new("managed-new.pdf"),
                "new-hash",
                false,
                true,
            )
            .expect("relink missing PDF");
        assert!(result.relinked_document);
        assert!(result.hash_changed);

        let restored = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after relink");
        let card = restored
            .cards
            .iter()
            .find(|card| card.id == "seed-card-1")
            .expect("card remains after relink");
        assert_eq!(card.raw_text, original.raw_text);
        assert_eq!(card.locator_json, original.locator_json);
        assert_eq!(card.source_hash, original.source_hash);
        assert!(restored
            .outline_links
            .iter()
            .any(|link| link.project_card_id == "seed-card-1"));
    }

    #[test]
    fn converting_a_linked_reading_note_creates_a_card_and_consumes_the_note_atomically() {
        let mut repository = Repository::memory().expect("memory database");
        repository
            .connection
            .execute(
                "UPDATE documents SET file_path = 'managed.pdf', file_hash = 'hash' WHERE id = 'seed-document-space'",
                [],
            )
            .expect("attach test PDF metadata");
        let locator_json = r#"{"version":1,"page":9,"coordinateSpace":"page-normalized","rects":[{"x":0.12,"y":0.24,"width":0.38,"height":0.04}]}"#;
        let note_id = repository
            .create_reading_note(CreateReadingNoteInput {
                project_id: "seed-project-tombs".into(),
                document_id: "seed-document-space".into(),
                kind: "critique".into(),
                content: "这条质疑应成为卡片评论。".into(),
                selected_text: "一段尚未制卡的原文".into(),
                page_number: Some(9),
                locator_json: locator_json.into(),
            })
            .expect("create linked note");

        let card_id = repository
            .create_card_from_selection(CreateCardFromSelectionInput {
                project_id: "seed-project-tombs".into(),
                document_id: "seed-document-space".into(),
                raw_text: "一段尚未制卡的原文".into(),
                display_text: "一段经人工校正的原文".into(),
                pdf_page: 9,
                print_page: None,
                locator_json: locator_json.into(),
                context_before: String::new(),
                context_after: String::new(),
                comment: "这条质疑应成为卡片评论。".into(),
                tags: vec!["质疑".into()],
                source_reading_note_id: Some(note_id.clone()),
            })
            .expect("convert note to card");

        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after conversion");
        assert!(!snapshot.reading_notes.iter().any(|note| note.id == note_id));
        let card = snapshot
            .cards
            .iter()
            .find(|card| card.id == card_id)
            .expect("converted card");
        assert_eq!(card.display_text, "一段经人工校正的原文");
        assert_eq!(card.comment, "这条质疑应成为卡片评论。");
        assert_eq!(card.origin_kind, "critique");
        assert!(card.research_roles.is_empty());
        assert!(snapshot.pdf_annotations.iter().any(|annotation| {
            annotation.document_id == "seed-document-space"
                && annotation.page_number == 9
                && annotation.locator_json == locator_json
        }));
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
        let oppose_role_id = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace roles")
            .research_roles
            .into_iter()
            .find(|role| role.name == "反对")
            .expect("default oppose role")
            .id;
        repository
            .update_card(UpdateCardInput {
                card_id: "seed-card-4".into(),
                display_text: "重复举行的纪念活动使墓地空间获得了超出单次埋葬行为的社会记忆。"
                    .into(),
                print_page: Some("57".into()),
                comment: "更新后的项目评论".into(),
                research_role_ids: vec![oppose_role_id],
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
        assert_eq!(card.research_roles.len(), 1);
        assert_eq!(card.research_roles[0].name, "反对");
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
    fn card_supports_multiple_project_roles_and_archived_roles_keep_links() {
        let mut repository = Repository::memory().expect("memory database");
        let custom_role_id = repository
            .create_research_role(CreateResearchRoleInput {
                project_id: "seed-project-tombs".into(),
                name: "史料例证".into(),
                color: "#825f4d".into(),
            })
            .expect("create custom role");
        let support_role_id = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace roles")
            .research_roles
            .into_iter()
            .find(|role| role.name == "支持")
            .expect("support role")
            .id;

        repository
            .update_card(UpdateCardInput {
                card_id: "seed-card-1".into(),
                display_text: "人工校正后的卡片显示文字".into(),
                print_page: Some("103a".into()),
                comment: "新的即时笔记".into(),
                research_role_ids: vec![support_role_id, custom_role_id.clone()],
                tags: vec!["空间".into()],
            })
            .expect("update card with multiple roles");
        repository
            .set_research_role_archived(&custom_role_id, true)
            .expect("archive custom role");

        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after role updates");
        let card = snapshot
            .cards
            .iter()
            .find(|card| card.id == "seed-card-1")
            .expect("updated card");
        let archived_role = card
            .research_roles
            .iter()
            .find(|role| role.id == custom_role_id)
            .expect("archived role remains linked");

        assert_eq!(card.research_roles.len(), 2);
        assert!(archived_role.is_archived);
        assert_eq!(card.display_text, "人工校正后的卡片显示文字");
        assert_ne!(card.raw_text, card.display_text);
        assert_eq!(card.print_page.as_deref(), Some("103a"));
        assert_eq!(card.comment, "新的即时笔记");
    }

    #[test]
    fn updating_project_persists_name_description_and_color() {
        let mut repository = Repository::memory().expect("memory database");
        repository
            .update_project(UpdateProjectInput {
                project_id: "seed-project-tombs".into(),
                name: "墓葬空间研究（修订）".into(),
                description: "更新后的研究范围与说明。".into(),
                color: Some("#456789".into()),
            })
            .expect("update project");

        let snapshot = repository
            .get_workspace(Some("seed-project-tombs"))
            .expect("workspace after project update");
        let project = snapshot
            .projects
            .iter()
            .find(|project| project.id == "seed-project-tombs")
            .expect("updated project");
        assert_eq!(project.name, "墓葬空间研究（修订）");
        assert_eq!(project.description, "更新后的研究范围与说明。");
        assert_eq!(project.color, "#456789");
    }

    #[test]
    fn removing_project_preserves_other_project_and_shared_document() {
        let mut repository = Repository::memory().expect("memory database");
        repository
            .connection
            .execute(
                r#"
                INSERT INTO project_documents (project_id, document_id, sort_order, created_at)
                VALUES ('seed-project-regions', 'seed-document-space', 2000, '2026-08-30T00:00:00Z')
                "#,
                [],
            )
            .expect("share document with second project");

        repository
            .remove_project("seed-project-tombs")
            .expect("remove first project");

        let snapshot = repository
            .get_workspace(Some("seed-project-regions"))
            .expect("remaining workspace");
        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(
            snapshot.current_project_id.as_deref(),
            Some("seed-project-regions")
        );
        assert!(snapshot
            .documents
            .iter()
            .any(|document| document.id == "seed-document-space"));
        assert!(snapshot
            .cards
            .iter()
            .all(|card| card.project_id == "seed-project-regions"));

        let removed_project_rows: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE id = 'seed-project-tombs'",
                [],
                |row| row.get(0),
            )
            .expect("count removed project");
        let removed_unique_document_rows: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE id = 'seed-document-ritual'",
                [],
                |row| row.get(0),
            )
            .expect("count removed unique document");
        assert_eq!(removed_project_rows, 0);
        assert_eq!(removed_unique_document_rows, 0);
        ensure_foreign_keys_are_valid(&repository.connection).expect("foreign keys after removal");
    }

    #[test]
    fn removing_all_projects_does_not_restore_examples_after_reopen() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-empty-workspace")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create empty workspace directory");
        let database_path = root.join("inkstone.db");

        {
            let mut repository = Repository::open(&database_path).expect("open database");
            repository
                .remove_project("seed-project-tombs")
                .expect("remove first seed project");
            repository
                .remove_project("seed-project-regions")
                .expect("remove second seed project");
            assert!(repository
                .get_workspace(None)
                .expect("empty workspace")
                .projects
                .is_empty());
        }

        {
            let repository = Repository::open(&database_path).expect("reopen empty database");
            let snapshot = repository.get_workspace(None).expect("reopened workspace");
            assert!(snapshot.projects.is_empty());
            assert!(snapshot.current_project_id.is_none());
        }

        fs::remove_dir_all(root).expect("remove empty workspace directory");
    }

    #[test]
    fn project_database_export_contains_only_selected_project() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-project-export")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create project export directory");
        let source_path = root.join("source.db");
        let export_path = root.join("project.db");
        let manual_backup_path = root.join("manual-full.db");

        {
            let mut source = Repository::open(&source_path).expect("open source repository");
            source
                .set_backup_preferences(Some(&root), Some(30), None, 24)
                .expect("set source-only backup preferences");
            source
                .export_database(&manual_backup_path)
                .expect("create source backup record fixture");
            source
                .record_backup(&manual_backup_path, "full", None, None)
                .expect("record source-only manual backup");
            source
                .export_project_database("seed-project-tombs", &export_path)
                .expect("export selected project");
        }

        {
            let exported = Repository::open(&export_path).expect("open project export");
            let snapshot = exported
                .get_workspace(Some("seed-project-tombs"))
                .expect("load exported project");
            assert_eq!(snapshot.projects.len(), 1);
            assert_eq!(snapshot.projects[0].id, "seed-project-tombs");
            assert!(!snapshot
                .documents
                .iter()
                .any(|document| document.id == "seed-document-region"));
            let unrelated_excerpts: i64 = exported
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM source_excerpts WHERE document_id = 'seed-document-region'",
                    [],
                    |row| row.get(0),
                )
                .expect("count unrelated excerpts");
            assert_eq!(unrelated_excerpts, 0);
            let backup_records: i64 = exported
                .connection
                .query_row("SELECT COUNT(*) FROM backup_records", [], |row| row.get(0))
                .expect("count exported backup records");
            let local_backup_settings: i64 = exported
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM app_metadata WHERE key LIKE 'backup\\_%' ESCAPE '\\'",
                    [],
                    |row| row.get(0),
                )
                .expect("count exported local backup settings");
            assert_eq!(backup_records, 0);
            assert_eq!(local_backup_settings, 0);
            ensure_foreign_keys_are_valid(&exported.connection)
                .expect("foreign keys in project export");
        }

        fs::remove_dir_all(root).expect("remove project export directory");
    }

    #[test]
    fn single_project_import_restores_all_project_relations_without_removing_others() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-project-import")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create project import directory");
        let source_path = root.join("source.db");
        let project_export_path = root.join("project.db");
        let target_path = root.join("target.db");
        let safety_path = root.join("before-project-import.db");
        let repeat_safety_path = root.join("before-repeat-project-import.db");

        let (note_id, annotation_id, document_group_id) = {
            let mut source = Repository::open(&source_path).expect("open source repository");
            source
                .connection
                .execute(
                    "UPDATE documents SET file_path = 'missing-after-transfer.pdf', file_hash = 'project-import-hash' WHERE id = 'seed-document-space'",
                    [],
                )
                .expect("attach source PDF metadata");
            source
                .connection
                .execute(
                    "UPDATE project_cards SET text_override = '项目导入保留的人工修正文' WHERE id = 'seed-card-1'",
                    [],
                )
                .expect("customize source card");
            let note_id = source
                .create_reading_note(CreateReadingNoteInput {
                    project_id: "seed-project-tombs".into(),
                    document_id: "seed-document-space".into(),
                    kind: "critique".into(),
                    content: "项目导入应保留这条质疑。".into(),
                    selected_text: String::new(),
                    page_number: None,
                    locator_json: String::new(),
                })
                .expect("create source project note");
            let annotation_id = source
                .create_pdf_annotation(CreatePdfAnnotationInput {
                    project_id: "seed-project-tombs".into(),
                    document_id: "seed-document-space".into(),
                    kind: "highlight".into(),
                    page_number: 8,
                    color: "#e8bd55".into(),
                    selected_text: "项目导入批注".into(),
                    locator_json: r#"{"version":1,"page":8,"rects":[{"x":0.12,"y":0.22,"width":0.25,"height":0.04}]}"#.into(),
                    comment: "项目导入批注说明".into(),
                })
                .expect("create source project annotation");
            let document_group_id = source
                .create_document_group(CreateDocumentGroupInput {
                    project_id: "seed-project-tombs".into(),
                    parent_id: None,
                    name: "导入保留的文献分类".into(),
                })
                .expect("create source document group");
            source
                .move_document_to_group(MoveDocumentToGroupInput {
                    project_id: "seed-project-tombs".into(),
                    document_id: "seed-document-space".into(),
                    group_id: Some(document_group_id.clone()),
                })
                .expect("assign source document group");
            source
                .export_project_database("seed-project-tombs", &project_export_path)
                .expect("export one project");
            (note_id, annotation_id, document_group_id)
        };

        {
            let mut target = Repository::open(&target_path).expect("open project import target");
            target
                .remove_project("seed-project-tombs")
                .expect("remove project before restore test");
            let target_only_project = target
                .create_project(CreateProjectInput {
                    name: "导入目标中原有项目".into(),
                    description: String::new(),
                    color: None,
                })
                .expect("create target-only project");

            let result = target
                .import_project_database(&project_export_path, &safety_path)
                .expect("import single project");
            assert_eq!(result, (1, 1));
            let restored = target
                .get_workspace(Some("seed-project-tombs"))
                .expect("load imported project");
            assert!(restored
                .projects
                .iter()
                .any(|project| project.id == "seed-project-regions"));
            assert!(restored
                .projects
                .iter()
                .any(|project| project.id == target_only_project));
            assert_eq!(
                restored
                    .cards
                    .iter()
                    .find(|card| card.id == "seed-card-1")
                    .expect("imported project card")
                    .display_text,
                "项目导入保留的人工修正文"
            );
            assert!(restored.reading_notes.iter().any(|note| note.id == note_id));
            assert!(restored
                .pdf_annotations
                .iter()
                .any(|annotation| annotation.id == annotation_id));
            assert!(restored
                .document_groups
                .iter()
                .any(|group| group.id == document_group_id));
            assert_eq!(
                restored
                    .documents
                    .iter()
                    .find(|document| document.id == "seed-document-space")
                    .expect("imported grouped document")
                    .group_id
                    .as_deref(),
                Some(document_group_id.as_str())
            );
            assert!(restored
                .outline_links
                .iter()
                .any(|link| link.id == "seed-link-1"));
            ensure_foreign_keys_are_valid(&target.connection)
                .expect("foreign keys after project import");

            let first_group_count = restored.document_groups.len();
            assert_eq!(
                target
                    .import_project_database(&project_export_path, &repeat_safety_path)
                    .expect("repeat project import"),
                (1, 0)
            );
            let repeated = target
                .get_workspace(Some("seed-project-tombs"))
                .expect("workspace after repeated project import");
            assert_eq!(repeated.document_groups.len(), first_group_count);
            assert_eq!(
                repeated
                    .documents
                    .iter()
                    .find(|document| document.id == "seed-document-space")
                    .expect("repeated grouped document")
                    .group_id
                    .as_deref(),
                Some(document_group_id.as_str())
            );
        }

        fs::remove_dir_all(root).expect("remove project import directory");
    }

    #[test]
    fn project_export_merged_through_full_backup_entry_keeps_existing_projects() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-project-import-through-merge")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create wrong-entry import directory");
        let source_path = root.join("source.db");
        let project_export_path = root.join("project.db");
        let target_path = root.join("target.db");
        let safety_path = root.join("before-merge.db");

        {
            let source = Repository::open(&source_path).expect("open export source");
            source
                .export_project_database("seed-project-tombs", &project_export_path)
                .expect("export one project");
        }
        {
            let mut target = Repository::open(&target_path).expect("open merge target");
            target
                .remove_project("seed-project-tombs")
                .expect("remove project before merge");
            let target_only_project = target
                .create_project(CreateProjectInput {
                    name: "不能因误选入口而消失".into(),
                    description: String::new(),
                    color: None,
                })
                .expect("create protected project");
            assert_eq!(
                target
                    .import_database(&project_export_path, &safety_path)
                    .expect("merge project export through full backup entry"),
                (1, 1)
            );
            let snapshot = target
                .get_workspace(Some("seed-project-tombs"))
                .expect("workspace after safe merge");
            assert!(snapshot
                .projects
                .iter()
                .any(|project| project.id == target_only_project));
            assert!(snapshot
                .projects
                .iter()
                .any(|project| project.id == "seed-project-regions"));
            ensure_foreign_keys_are_valid(&target.connection)
                .expect("foreign keys after wrong-entry merge");
        }

        fs::remove_dir_all(root).expect("remove wrong-entry import directory");
    }

    #[test]
    fn single_project_entry_rejects_multi_project_database_without_changes() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-reject-multi-project-import")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create rejection test directory");
        let source_path = root.join("source.db");
        let exported_path = root.join("complete.db");
        let target_path = root.join("target.db");
        let safety_path = root.join("should-not-exist.db");

        {
            let source = Repository::open(&source_path).expect("open complete export source");
            source
                .export_database(&exported_path)
                .expect("export multi-project database");
        }
        {
            let mut target = Repository::open(&target_path).expect("open rejection target");
            let protected_project = target
                .create_project(CreateProjectInput {
                    name: "验证失败时保持不变".into(),
                    description: String::new(),
                    color: None,
                })
                .expect("create protected project");
            let project_count_before: i64 = target
                .connection
                .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
                .expect("count projects before rejection");
            let error = target
                .import_project_database(&exported_path, &safety_path)
                .expect_err("reject multi-project file in project entry");
            assert!(
                matches!(error, AppError::Validation(message) if message.contains("只包含 1 个项目"))
            );
            let snapshot = target
                .get_workspace(Some(&protected_project))
                .expect("workspace after rejected import");
            assert_eq!(snapshot.projects.len() as i64, project_count_before);
            assert!(snapshot
                .projects
                .iter()
                .any(|project| project.id == protected_project));
            assert!(!safety_path.exists());
            ensure_foreign_keys_are_valid(&target.connection)
                .expect("foreign keys after rejected import");
        }

        fs::remove_dir_all(root).expect("remove rejection test directory");
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
                    false,
                )
                .expect("register first PDF import");
            assert!(!first_import.reused_document);
            assert!(!first_import.reused_managed_file);

            let card_id = repository
                .create_card_from_selection(CreateCardFromSelectionInput {
                    project_id: project_id.clone(),
                    document_id: first_import.document_id.clone(),
                    raw_text: "一段来自测试 PDF 的原文".into(),
                    display_text: "一段经人工修正的 PDF 原文".into(),
                    pdf_page: 1,
                    print_page: Some("7".into()),
                    locator_json: locator_json.into(),
                    context_before: "前文".into(),
                    context_after: "后文".into(),
                    comment: "用于验证重启后仍可回到原文。".into(),
                    tags: vec!["PDF".into(), "定位".into()],
                    source_reading_note_id: None,
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
                    false,
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
            assert_eq!(card.clean_text, "一段来自测试 PDF 的原文");
            assert_eq!(card.display_text, "一段经人工修正的 PDF 原文");
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

    #[test]
    fn backup_preferences_survive_database_reopen() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-backups")
            .join(Uuid::new_v4().to_string());
        let custom_directory = root.join("custom");
        fs::create_dir_all(&custom_directory).expect("create custom backup directory");
        let database_path = root.join("inkstone.db");

        {
            let mut repository = Repository::open(&database_path).expect("open database");
            repository
                .set_backup_preferences(Some(&custom_directory), None, Some(12), 72)
                .expect("save backup preferences");
        }

        {
            let repository = Repository::open(&database_path).expect("reopen database");
            let preferences = repository
                .backup_preferences()
                .expect("read persisted backup preferences");
            assert_eq!(
                preferences.custom_directory.as_deref(),
                Some(custom_directory.to_string_lossy().as_ref())
            );
            assert_eq!(preferences.retention_days, None);
            assert_eq!(preferences.retention_count, Some(12));
            assert_eq!(preferences.automatic_interval_hours, 72);
        }

        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{}", database_path.display(), suffix));
        }
        fs::remove_dir(&custom_directory).expect("remove empty custom directory");
        fs::remove_dir(&root).expect("remove empty backup test root");
    }

    #[test]
    fn backup_directory_scan_registers_only_valid_inkstone_automatic_backups() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-backups")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create backup scan directory");
        let database_path = root.join("inkstone.db");
        let valid_backup = root.join("inkstone-before-scheduled-20260831-120000-valid.db");
        let invalid_backup = root.join("inkstone-before-scheduled-20260831-120001-invalid.db");
        let unrelated_backup = root.join("renamed-manual-export.db");
        let orphan_wal = root.join(".inkstone-export-old.tmp-wal");
        let orphan_shm = root.join(".inkstone-import-old.tmp-shm");
        let unrelated_sidecar = root.join("unrelated.tmp-shm");

        {
            let mut repository = Repository::open(&database_path).expect("open database");
            repository
                .export_database(&valid_backup)
                .expect("create valid automatic backup fixture");
            repository
                .export_database(&unrelated_backup)
                .expect("create unrelated valid database fixture");
            fs::write(&invalid_backup, b"not a sqlite database")
                .expect("create invalid automatic backup fixture");
            fs::write(&orphan_wal, b"old wal").expect("create orphan wal fixture");
            fs::write(&orphan_shm, b"old shm").expect("create orphan shm fixture");
            fs::write(&unrelated_sidecar, b"keep").expect("create unrelated sidecar fixture");

            assert_eq!(
                repository
                    .cleanup_orphaned_backup_sidecars(&root)
                    .expect("cleanup orphaned backup sidecars"),
                2
            );
            assert!(!orphan_wal.exists());
            assert!(!orphan_shm.exists());
            assert!(unrelated_sidecar.is_file());

            assert_eq!(
                repository
                    .register_automatic_backups_in_directory(&root)
                    .expect("scan automatic backups"),
                1
            );
            assert_eq!(
                repository
                    .register_automatic_backups_in_directory(&root)
                    .expect("repeat automatic backup scan"),
                0
            );
            let records = repository.backup_records().expect("read backup records");
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].kind, "auto");
            assert_eq!(
                Path::new(&records[0].path),
                valid_backup.canonicalize().expect("canonical backup path")
            );

            repository
                .mark_automatic_backup_completed(&valid_backup)
                .expect("mark completed automatic backup");
            let preferences = repository
                .backup_preferences()
                .expect("read automatic backup completion");
            assert!(preferences.last_automatic_backup_at.is_some());
            assert!(preferences
                .last_automatic_backup_result
                .as_deref()
                .is_some_and(|result| result.contains("inkstone-before-scheduled")));
            assert!(repository
                .set_backup_preferences(None, None, None, 5)
                .is_err());
        }

        for entry in fs::read_dir(&root).expect("list backup scan fixtures") {
            let path = entry.expect("backup scan fixture entry").path();
            fs::remove_file(path).expect("remove backup scan fixture");
        }
        fs::remove_dir(&root).expect("remove backup scan directory");
    }

    #[test]
    fn automatic_backup_cleanup_is_scoped_and_keeps_three_valid_backups() {
        let mut repository = Repository::memory().expect("memory database");
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-backups")
            .join(Uuid::new_v4().to_string());
        let current_directory = root.join("current");
        let other_directory = root.join("other");
        fs::create_dir_all(&current_directory).expect("create current backup directory");
        fs::create_dir_all(&other_directory).expect("create other backup directory");

        let mut automatic_paths = Vec::new();
        for (index, age_days) in [40_i64, 41, 42, 43, 44].into_iter().enumerate() {
            let path = current_directory.join(format!(
                "inkstone-before-import-2026010{}-auto{}.db",
                index + 1,
                index
            ));
            fs::write(&path, vec![index as u8; 10 + index]).expect("write automatic backup");
            repository
                .record_backup(&path, "auto", None, Some(&current_directory))
                .expect("record automatic backup");
            repository
                .connection
                .execute(
                    "UPDATE backup_records SET created_at = ?1 WHERE path = ?2",
                    params![
                        (Utc::now() - ChronoDuration::days(age_days)).to_rfc3339(),
                        path.to_string_lossy()
                    ],
                )
                .expect("age automatic backup record");
            automatic_paths.push(path);
        }

        let manual_path = current_directory.join("manual-full-export.db");
        fs::write(&manual_path, vec![7_u8; 31]).expect("write manual export");
        repository
            .record_backup(&manual_path, "full", None, None)
            .expect("record manual export");
        repository
            .connection
            .execute(
                "UPDATE backup_records SET created_at = ?1 WHERE path = ?2",
                params![
                    (Utc::now() - ChronoDuration::days(120)).to_rfc3339(),
                    manual_path.to_string_lossy()
                ],
            )
            .expect("age manual export record");

        let outside_path = other_directory.join("inkstone-before-import-20250101-outside.db");
        fs::write(&outside_path, vec![8_u8; 29]).expect("write outside automatic backup");
        repository
            .record_backup(&outside_path, "auto", None, Some(&current_directory))
            .expect("record outside automatic backup");
        repository
            .connection
            .execute(
                "UPDATE backup_records SET created_at = ?1 WHERE path = ?2",
                params![
                    (Utc::now() - ChronoDuration::days(130)).to_rfc3339(),
                    outside_path.to_string_lossy()
                ],
            )
            .expect("age outside automatic backup record");

        let pdf_path = current_directory.join("source-document.pdf");
        fs::write(&pdf_path, b"%PDF-1.4\nnot part of database backups\n")
            .expect("write unrelated PDF");

        let cleanup = repository
            .cleanup_automatic_backups(&current_directory, Some(30), None)
            .expect("cleanup automatic backups");

        assert_eq!(cleanup.deleted_count, 2);
        assert_eq!(cleanup.freed_bytes, 13 + 14);
        assert_eq!(cleanup.failed_count, 1);
        assert!(automatic_paths[0].is_file());
        assert!(automatic_paths[1].is_file());
        assert!(automatic_paths[2].is_file());
        assert!(!automatic_paths[3].exists());
        assert!(!automatic_paths[4].exists());
        assert!(
            manual_path.is_file(),
            "manual exports must never be auto-cleaned"
        );
        assert!(
            outside_path.is_file(),
            "files outside the active directory must remain"
        );
        assert!(
            pdf_path.is_file(),
            "PDF originals must not be touched by cleanup"
        );
        let preferences = repository
            .backup_preferences()
            .expect("read cleanup metadata");
        assert!(preferences.last_cleanup_at.is_some());
        assert!(preferences
            .last_cleanup_result
            .as_deref()
            .is_some_and(|summary| summary.contains("删除 2 份")));
        assert!(repository
            .delete_automatic_backup(
                &repository
                    .backup_records()
                    .expect("backup records")
                    .into_iter()
                    .find(|record| record.kind == "full")
                    .expect("manual record")
                    .id
            )
            .is_err());

        for path in automatic_paths.into_iter().take(3) {
            fs::remove_file(path).expect("remove surviving automatic backup");
        }
        fs::remove_file(manual_path).expect("remove manual export");
        fs::remove_file(outside_path).expect("remove outside backup");
        fs::remove_file(pdf_path).expect("remove unrelated PDF");
        fs::remove_dir(&current_directory).expect("remove empty current directory");
        fs::remove_dir(&other_directory).expect("remove empty other directory");
        fs::remove_dir(&root).expect("remove empty backup test root");
    }

    #[test]
    fn automatic_backup_cleanup_can_keep_a_configured_number_of_files() {
        let mut repository = Repository::memory().expect("memory database");
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-backups")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create count-retention directory");
        let mut paths = Vec::new();
        for index in 0..5 {
            let path = root.join(format!(
                "inkstone-before-manual-20260831-12000{index}-count.db"
            ));
            fs::write(&path, vec![index as u8; 20 + index]).expect("write count backup");
            repository
                .record_backup(&path, "auto", None, Some(&root))
                .expect("record count backup");
            paths.push(path);
        }

        let cleanup = repository
            .cleanup_automatic_backups(&root, None, Some(3))
            .expect("cleanup by count");
        assert_eq!(cleanup.deleted_count, 2);
        assert_eq!(paths.iter().filter(|path| path.is_file()).count(), 3);
        assert!(repository
            .cleanup_automatic_backups(&root, Some(30), Some(12))
            .is_err());

        for path in paths.into_iter().filter(|path| path.is_file()) {
            fs::remove_file(path).expect("remove count backup");
        }
        fs::remove_dir(&root).expect("remove count-retention directory");
    }
}
