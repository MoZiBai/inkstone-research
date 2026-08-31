use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub sort_order: i64,
    pub document_count: i64,
    pub card_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub id: String,
    pub title: String,
    pub authors: String,
    pub year: Option<i64>,
    pub journal: String,
    pub volume: String,
    pub issue: String,
    pub pages: String,
    pub doi: String,
    pub publisher: String,
    pub metadata_raw: String,
    pub is_removed: bool,
    pub file_path: Option<String>,
    pub file_hash: Option<String>,
    pub file_available: bool,
    pub sort_order: i64,
    pub card_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisCategory {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRole {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    pub is_default: bool,
    pub is_archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCardView {
    pub id: String,
    pub project_id: String,
    pub excerpt_id: String,
    pub document_id: String,
    pub document_title: String,
    pub document_authors: String,
    pub document_year: Option<i64>,
    pub raw_text: String,
    pub clean_text: String,
    pub display_text: String,
    pub pdf_page: Option<i64>,
    pub print_page: Option<String>,
    pub locator_json: String,
    pub context_before: String,
    pub context_after: String,
    pub source_hash: Option<String>,
    pub comment: String,
    pub origin_kind: String,
    pub research_roles: Vec<ResearchRole>,
    pub category_id: Option<String>,
    pub synthesis_state: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnnotation {
    pub id: String,
    pub project_id: String,
    pub document_id: String,
    pub kind: String,
    pub page_number: i64,
    pub color: String,
    pub selected_text: String,
    pub locator_json: String,
    pub comment: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingNote {
    pub id: String,
    pub project_id: String,
    pub document_id: String,
    pub kind: String,
    pub content: String,
    pub selected_text: String,
    pub page_number: Option<i64>,
    pub locator_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineNode {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub notes: String,
    pub core_argument: String,
    pub open_questions: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineCardLink {
    pub id: String,
    pub outline_node_id: String,
    pub project_card_id: String,
    pub note: String,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub projects: Vec<ProjectSummary>,
    pub current_project_id: Option<String>,
    pub documents: Vec<DocumentSummary>,
    pub categories: Vec<SynthesisCategory>,
    pub research_roles: Vec<ResearchRole>,
    pub cards: Vec<ProjectCardView>,
    pub pdf_annotations: Vec<PdfAnnotation>,
    pub reading_notes: Vec<ReadingNote>,
    pub outline_nodes: Vec<OutlineNode>,
    pub outline_links: Vec<OutlineCardLink>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectInput {
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDocumentInput {
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub authors: String,
    pub year: Option<i64>,
    #[serde(default)]
    pub journal: String,
    #[serde(default)]
    pub volume: String,
    #[serde(default)]
    pub issue: String,
    #[serde(default)]
    pub pages: String,
    #[serde(default)]
    pub doi: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub metadata_raw: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPdfInput {
    pub project_id: String,
    pub source_path: String,
    pub target_document_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub authors: String,
    pub year: Option<i64>,
    #[serde(default)]
    pub journal: String,
    #[serde(default)]
    pub volume: String,
    #[serde(default)]
    pub issue: String,
    #[serde(default)]
    pub pages: String,
    #[serde(default)]
    pub doi: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub metadata_raw: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDocumentInput {
    pub document_id: String,
    pub title: String,
    #[serde(default)]
    pub authors: String,
    pub year: Option<i64>,
    #[serde(default)]
    pub journal: String,
    #[serde(default)]
    pub volume: String,
    #[serde(default)]
    pub issue: String,
    #[serde(default)]
    pub pages: String,
    #[serde(default)]
    pub doi: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub metadata_raw: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDocumentInput {
    pub project_id: String,
    pub document_id: String,
    pub keep_cards: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPdfResult {
    pub document_id: String,
    pub reused_managed_file: bool,
    pub reused_document: bool,
    pub relinked_document: bool,
    pub hash_changed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseImportResult {
    pub safety_backup_path: String,
    pub missing_pdf_count: i64,
    pub source_project_count: i64,
    pub created_project_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCardFromSelectionInput {
    pub project_id: String,
    pub document_id: String,
    pub raw_text: String,
    pub display_text: String,
    pub pdf_page: i64,
    pub print_page: Option<String>,
    pub locator_json: String,
    #[serde(default)]
    pub context_before: String,
    #[serde(default)]
    pub context_after: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_reading_note_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePdfAnnotationInput {
    pub project_id: String,
    pub document_id: String,
    pub kind: String,
    pub page_number: i64,
    pub color: String,
    #[serde(default)]
    pub selected_text: String,
    pub locator_json: String,
    #[serde(default)]
    pub comment: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReadingNoteInput {
    pub project_id: String,
    pub document_id: String,
    pub kind: String,
    pub content: String,
    #[serde(default)]
    pub selected_text: String,
    pub page_number: Option<i64>,
    #[serde(default)]
    pub locator_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCardInput {
    pub card_id: String,
    pub display_text: String,
    pub print_page: Option<String>,
    pub comment: String,
    #[serde(default)]
    pub research_role_ids: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResearchRoleInput {
    pub project_id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResearchRoleInput {
    pub research_role_id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCategoryInput {
    pub project_id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCategoryInput {
    pub category_id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOutlineNodeInput {
    pub project_id: String,
    pub parent_id: Option<String>,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutlineNodeInput {
    pub node_id: String,
    pub title: String,
    pub notes: String,
    pub core_argument: String,
    pub open_questions: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutlineNodeInput {
    pub node_id: String,
    pub target_node_id: String,
    pub placement: OutlinePlacement,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum OutlinePlacement {
    Before,
    Inside,
    After,
}
