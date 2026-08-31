use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::Utc;
use tauri::{ipc::Response, State};
use uuid::Uuid;

use crate::database::Repository;
use crate::error::{AppError, AppResult};
use crate::models::{
    CreateCardFromSelectionInput, CreateCategoryInput, CreateDocumentInput, CreateOutlineNodeInput,
    CreatePdfAnnotationInput, CreateProjectInput, CreateReadingNoteInput, DatabaseImportResult,
    ImportPdfInput, ImportPdfResult, MoveOutlineNodeInput, RemoveDocumentInput, UpdateCardInput,
    UpdateCategoryInput, UpdateDocumentInput, UpdateOutlineNodeInput, UpdateProjectInput,
    WorkspaceSnapshot,
};
use crate::pdf_files::{
    discard_managed_pdf, managed_pdf_is_available, prepare_pdf_copy, read_managed_pdf,
    reveal_managed_pdf,
};

pub struct AppState {
    repository: Arc<Mutex<Repository>>,
    database_path: PathBuf,
    backup_directory: PathBuf,
    pdf_library_directory: PathBuf,
}

impl AppState {
    pub fn new(
        repository: Repository,
        database_path: PathBuf,
        backup_directory: PathBuf,
        pdf_library_directory: PathBuf,
    ) -> Self {
        Self {
            repository: Arc::new(Mutex::new(repository)),
            database_path,
            backup_directory,
            pdf_library_directory,
        }
    }

    fn lock(&self) -> AppResult<MutexGuard<'_, Repository>> {
        self.repository
            .lock()
            .map_err(|_| AppError::Validation("本地数据库状态不可用，请重新启动应用。".into()))
    }
}

#[tauri::command]
pub fn get_workspace(
    project_id: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<WorkspaceSnapshot> {
    let mut snapshot = state.lock()?.get_workspace(project_id.as_deref())?;
    for document in &mut snapshot.documents {
        document.file_available = document.file_path.as_deref().is_some_and(|path| {
            managed_pdf_is_available(&PathBuf::from(path), &state.pdf_library_directory)
        });
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn create_project(input: CreateProjectInput, state: State<'_, AppState>) -> AppResult<String> {
    state.lock()?.create_project(input)
}

#[tauri::command]
pub fn update_project(input: UpdateProjectInput, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.update_project(input)
}

#[tauri::command]
pub fn remove_project(project_id: String, state: State<'_, AppState>) -> AppResult<()> {
    let discarded_paths = state.lock()?.remove_project(&project_id)?;
    for path in discarded_paths {
        // The database transaction is authoritative. A locked Windows file may
        // leave an unreferenced copy behind; it must not turn a successful data
        // deletion into a misleading failure.
        let _ = discard_managed_pdf(&path, &state.pdf_library_directory);
    }
    Ok(())
}

#[tauri::command]
pub fn create_document(
    input: CreateDocumentInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state.lock()?.create_document(input)
}

#[tauri::command]
pub fn update_document(input: UpdateDocumentInput, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.update_document(input)
}

#[tauri::command]
pub fn remove_document(input: RemoveDocumentInput, state: State<'_, AppState>) -> AppResult<()> {
    let discarded_path = state.lock()?.remove_document(input)?;
    if let Some(path) = discarded_path {
        // The database transaction is authoritative. A locked Windows file may
        // leave an unreferenced copy behind; it must not turn a successful data
        // deletion into a misleading failure.
        let _ = discard_managed_pdf(&path, &state.pdf_library_directory);
    }
    Ok(())
}

#[tauri::command]
pub fn restore_document(
    project_id: String,
    document_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.restore_document(&project_id, &document_id)
}

#[tauri::command]
pub async fn import_pdf(
    input: ImportPdfInput,
    state: State<'_, AppState>,
) -> AppResult<ImportPdfResult> {
    let allow_missing_pdf_relink = if let Some(document_id) = input.target_document_id.as_deref() {
        state
            .lock()?
            .stored_pdf_path(document_id)?
            .as_deref()
            .is_some_and(|path| !managed_pdf_is_available(path, &state.pdf_library_directory))
    } else {
        false
    };
    let source_path = PathBuf::from(&input.source_path);
    let library_directory = state.pdf_library_directory.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_pdf_copy(&source_path, &library_directory)
    })
    .await
    .map_err(|error| AppError::Validation(format!("PDF 导入任务失败：{error}")))??;
    state.lock()?.register_imported_pdf(
        &input,
        &prepared.managed_path,
        &prepared.file_hash,
        prepared.reused_managed_file,
        allow_missing_pdf_relink,
    )
}

#[tauri::command]
pub async fn export_database(
    destination_path: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let destination = PathBuf::from(destination_path);
    if paths_refer_to_same_file(&destination, &state.database_path) {
        return Err(crate::error::AppError::Validation(
            "不能用导出文件覆盖应用正在使用的数据库。".into(),
        ));
    }
    let repository = Arc::clone(&state.repository);
    let returned_path = destination.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = repository.lock().map_err(|_| {
            crate::error::AppError::Validation("本地数据库状态不可用，请重新启动应用。".into())
        })?;
        guard.export_database(&destination)
    })
    .await
    .map_err(|error| {
        crate::error::AppError::Validation(format!("数据库导出任务失败：{error}"))
    })??;
    Ok(returned_path)
}

#[tauri::command]
pub async fn export_project_database(
    project_id: String,
    destination_path: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let destination = PathBuf::from(destination_path);
    if paths_refer_to_same_file(&destination, &state.database_path) {
        return Err(crate::error::AppError::Validation(
            "不能用项目导出文件覆盖应用正在使用的数据库。".into(),
        ));
    }
    let repository = Arc::clone(&state.repository);
    let returned_path = destination.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = repository.lock().map_err(|_| {
            crate::error::AppError::Validation("本地数据库状态不可用，请重新启动应用。".into())
        })?;
        guard.export_project_database(&project_id, &destination)
    })
    .await
    .map_err(|error| {
        crate::error::AppError::Validation(format!("项目数据库导出任务失败：{error}"))
    })??;
    Ok(returned_path)
}

#[tauri::command]
pub async fn import_database(
    source_path: String,
    state: State<'_, AppState>,
) -> AppResult<DatabaseImportResult> {
    let source = PathBuf::from(source_path);
    if paths_refer_to_same_file(&source, &state.database_path) {
        return Err(crate::error::AppError::Validation(
            "不能把应用正在使用的数据库作为导入文件。".into(),
        ));
    }
    let safety_backup = state.backup_directory.join(format!(
        "inkstone-before-import-{}-{}.db",
        Utc::now().format("%Y%m%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    ));
    let repository = Arc::clone(&state.repository);
    let pdf_library_directory = state.pdf_library_directory.clone();
    let returned_safety_path = safety_backup.to_string_lossy().into_owned();
    let (source_project_count, created_project_count, missing_pdf_count) =
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = repository.lock().map_err(|_| {
                crate::error::AppError::Validation("本地数据库状态不可用，请重新启动应用。".into())
            })?;
            let (source_project_count, created_project_count) =
                guard.import_database(&source, &safety_backup)?;
            let paths = guard.document_pdf_paths()?;
            let missing_pdf_count = paths
                .iter()
                .filter(|path| !managed_pdf_is_available(path, &pdf_library_directory))
                .count() as i64;
            Ok::<(i64, i64, i64), crate::error::AppError>((
                source_project_count,
                created_project_count,
                missing_pdf_count,
            ))
        })
        .await
        .map_err(|error| {
            crate::error::AppError::Validation(format!("数据库导入任务失败：{error}"))
        })??;
    Ok(DatabaseImportResult {
        safety_backup_path: returned_safety_path,
        missing_pdf_count,
        source_project_count,
        created_project_count,
    })
}

#[tauri::command]
pub async fn import_project_database(
    source_path: String,
    state: State<'_, AppState>,
) -> AppResult<DatabaseImportResult> {
    let source = PathBuf::from(source_path);
    if paths_refer_to_same_file(&source, &state.database_path) {
        return Err(crate::error::AppError::Validation(
            "不能把应用正在使用的数据库作为项目导入文件。".into(),
        ));
    }
    let safety_backup = state.backup_directory.join(format!(
        "inkstone-before-project-import-{}-{}.db",
        Utc::now().format("%Y%m%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    ));
    let repository = Arc::clone(&state.repository);
    let pdf_library_directory = state.pdf_library_directory.clone();
    let returned_safety_path = safety_backup.to_string_lossy().into_owned();
    let (source_project_count, created_project_count, missing_pdf_count) =
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = repository.lock().map_err(|_| {
                crate::error::AppError::Validation("本地数据库状态不可用，请重新启动应用。".into())
            })?;
            let (source_project_count, created_project_count) =
                guard.import_project_database(&source, &safety_backup)?;
            let paths = guard.document_pdf_paths()?;
            let missing_pdf_count = paths
                .iter()
                .filter(|path| !managed_pdf_is_available(path, &pdf_library_directory))
                .count() as i64;
            Ok::<(i64, i64, i64), crate::error::AppError>((
                source_project_count,
                created_project_count,
                missing_pdf_count,
            ))
        })
        .await
        .map_err(|error| {
            crate::error::AppError::Validation(format!("项目数据库导入任务失败：{error}"))
        })??;
    Ok(DatabaseImportResult {
        safety_backup_path: returned_safety_path,
        missing_pdf_count,
        source_project_count,
        created_project_count,
    })
}

fn paths_refer_to_same_file(first: &std::path::Path, second: &std::path::Path) -> bool {
    match (first.canonicalize(), second.canonicalize()) {
        (Ok(first), Ok(second)) => first == second,
        _ => first == second,
    }
}

#[tauri::command]
pub async fn read_pdf(document_id: String, state: State<'_, AppState>) -> AppResult<Response> {
    let pdf_path = state.lock()?.pdf_path(&document_id)?;
    let library_directory = state.pdf_library_directory.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        read_managed_pdf(&pdf_path, &library_directory)
    })
    .await
    .map_err(|error| AppError::Validation(format!("PDF 读取任务失败：{error}")))??;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn reveal_pdf_in_file_manager(
    document_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let pdf_path = state.lock()?.pdf_path(&document_id)?;
    reveal_managed_pdf(&pdf_path, &state.pdf_library_directory)
}

#[tauri::command]
pub fn create_card_from_selection(
    input: CreateCardFromSelectionInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state.lock()?.create_card_from_selection(input)
}

#[tauri::command]
pub fn create_pdf_annotation(
    input: CreatePdfAnnotationInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state.lock()?.create_pdf_annotation(input)
}

#[tauri::command]
pub fn delete_pdf_annotation(annotation_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.delete_pdf_annotation(&annotation_id)
}

#[tauri::command]
pub fn create_reading_note(
    input: CreateReadingNoteInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state.lock()?.create_reading_note(input)
}

#[tauri::command]
pub fn delete_reading_note(note_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.delete_reading_note(&note_id)
}

#[tauri::command]
pub fn update_card(input: UpdateCardInput, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.update_card(input)
}

#[tauri::command]
pub fn move_card(
    card_id: String,
    category_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.move_card(&card_id, &category_id)
}

#[tauri::command]
pub fn set_card_excluded(
    card_id: String,
    excluded: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.set_card_excluded(&card_id, excluded)
}

#[tauri::command]
pub fn delete_card(card_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.delete_card(&card_id)
}

#[tauri::command]
pub fn create_category(
    input: CreateCategoryInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state.lock()?.create_category(input)
}

#[tauri::command]
pub fn update_category(input: UpdateCategoryInput, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.update_category(input)
}

#[tauri::command]
pub fn delete_category(category_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.delete_category(&category_id)
}

#[tauri::command]
pub fn reorder_categories(
    project_id: String,
    ordered_ids: Vec<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.reorder_categories(&project_id, &ordered_ids)
}

#[tauri::command]
pub fn create_outline_node(
    input: CreateOutlineNodeInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state.lock()?.create_outline_node(input)
}

#[tauri::command]
pub fn update_outline_node(
    input: UpdateOutlineNodeInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.update_outline_node(input)
}

#[tauri::command]
pub fn move_outline_node(input: MoveOutlineNodeInput, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.move_outline_node(input)
}

#[tauri::command]
pub fn delete_outline_node(node_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.delete_outline_node(&node_id)
}

#[tauri::command]
pub fn link_card_to_outline(
    node_id: String,
    card_id: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state.lock()?.link_card_to_outline(&node_id, &card_id)
}

#[tauri::command]
pub fn remove_outline_link(link_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.remove_outline_link(&link_id)
}

#[tauri::command]
pub fn move_outline_card(
    link_id: String,
    direction: i64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.move_outline_card(&link_id, direction)
}
