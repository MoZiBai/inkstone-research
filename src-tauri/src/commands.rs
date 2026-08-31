use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::Utc;
use tauri::{ipc::Response, State};
use uuid::Uuid;

use crate::database::Repository;
use crate::error::{AppError, AppResult};
use crate::models::{
    BackupCleanupResult, BackupManagerState, BackupSettings, BatchUpdateCardsInput,
    CreateCardFromSelectionInput, CreateCategoryInput, CreateDocumentGroupInput,
    CreateDocumentInput, CreateOutlineNodeInput, CreatePdfAnnotationInput, CreateProjectInput,
    CreateReadingNoteInput, CreateResearchRoleInput, DatabaseImportPreview, DatabaseImportResult,
    ImportPdfInput, ImportPdfResult, MoveDocumentToGroupInput, MoveOutlineNodeInput,
    RemoveDocumentInput, UpdateBackupSettingsInput, UpdateCardInput, UpdateCategoryInput,
    UpdateDocumentGroupInput, UpdateDocumentInput, UpdateOutlineCardLinkInput,
    UpdateOutlineNodeInput, UpdatePdfAnnotationInput, UpdateProjectInput, UpdateReadingNoteInput,
    UpdateResearchRoleInput, WorkspaceSnapshot,
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

fn validated_writable_backup_directory(path: &Path) -> AppResult<PathBuf> {
    if !path.is_dir() {
        return Err(AppError::Validation("选择的备份目录不存在。".into()));
    }
    let canonical = path.canonicalize()?;
    let probe = canonical.join(format!(".inkstone-write-test-{}", Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?;
        file.write_all(b"inkstone")?;
        file.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(&probe);
    result?;
    Ok(canonical)
}

struct ResolvedBackupDirectory {
    directory: PathBuf,
    warning: Option<String>,
    retention_days: Option<i64>,
    retention_count: Option<i64>,
    last_cleanup_at: Option<String>,
    last_cleanup_result: Option<String>,
}

fn resolved_backup_directory(
    repository: &Repository,
    default_directory: &Path,
) -> AppResult<ResolvedBackupDirectory> {
    let preferences = repository.backup_preferences()?;
    if let Some(custom) = preferences.custom_directory.as_deref() {
        match validated_writable_backup_directory(Path::new(custom)) {
            Ok(directory) => {
                return Ok(ResolvedBackupDirectory {
                    directory,
                    warning: None,
                    retention_days: preferences.retention_days,
                    retention_count: preferences.retention_count,
                    last_cleanup_at: preferences.last_cleanup_at,
                    last_cleanup_result: preferences.last_cleanup_result,
                });
            }
            Err(error) => {
                let fallback = validated_writable_backup_directory(default_directory)?;
                return Ok(ResolvedBackupDirectory {
                    directory: fallback,
                    warning: Some(format!(
                        "自定义备份目录当前不可用，已回退到默认目录：{error}"
                    )),
                    retention_days: preferences.retention_days,
                    retention_count: preferences.retention_count,
                    last_cleanup_at: preferences.last_cleanup_at,
                    last_cleanup_result: preferences.last_cleanup_result,
                });
            }
        }
    }
    Ok(ResolvedBackupDirectory {
        directory: validated_writable_backup_directory(default_directory)?,
        warning: None,
        retention_days: preferences.retention_days,
        retention_count: preferences.retention_count,
        last_cleanup_at: preferences.last_cleanup_at,
        last_cleanup_result: preferences.last_cleanup_result,
    })
}

fn backup_manager_state(
    repository: &mut Repository,
    default_directory: &Path,
) -> AppResult<BackupManagerState> {
    let custom_directory = repository.backup_preferences()?.custom_directory;
    let resolved = resolved_backup_directory(repository, default_directory)?;
    repository.cleanup_orphaned_backup_sidecars(&resolved.directory)?;
    repository.register_automatic_backups_in_directory(&resolved.directory)?;
    let preferences = repository.backup_preferences()?;
    let records = repository.backup_records()?;
    let total_size_bytes = records
        .iter()
        .filter(|record| record.is_available)
        .fold(0_i64, |total, record| {
            total.saturating_add(record.size_bytes)
        });
    Ok(BackupManagerState {
        settings: BackupSettings {
            default_directory: default_directory.to_string_lossy().into_owned(),
            custom_directory,
            effective_directory: resolved.directory.to_string_lossy().into_owned(),
            retention_days: resolved.retention_days,
            retention_count: resolved.retention_count,
            automatic_interval_hours: preferences.automatic_interval_hours,
            last_automatic_backup_at: preferences.last_automatic_backup_at,
            last_automatic_backup_result: preferences.last_automatic_backup_result,
            directory_warning: resolved.warning,
            last_cleanup_at: resolved.last_cleanup_at,
            last_cleanup_result: resolved.last_cleanup_result,
        },
        records,
        total_size_bytes,
    })
}

fn reveal_path(path: &Path, select_file: bool) -> AppResult<()> {
    let canonical = path.canonicalize()?;
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        if select_file {
            command.arg("/select,");
        }
        command.arg(&canonical).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if select_file {
            command.arg("-R");
        }
        command.arg(&canonical).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(if select_file {
            canonical.parent().unwrap_or(&canonical)
        } else {
            canonical.as_path()
        })
        .spawn()?;
    Ok(())
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
pub fn create_document_group(
    input: CreateDocumentGroupInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state.lock()?.create_document_group(input)
}

#[tauri::command]
pub fn update_document_group(
    input: UpdateDocumentGroupInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.update_document_group(input)
}

#[tauri::command]
pub fn delete_document_group(group_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.delete_document_group(&group_id)
}

#[tauri::command]
pub fn move_document_to_group(
    input: MoveDocumentToGroupInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.move_document_to_group(input)
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
        let mut guard = repository.lock().map_err(|_| {
            crate::error::AppError::Validation("本地数据库状态不可用，请重新启动应用。".into())
        })?;
        guard.export_database(&destination)?;
        guard.record_backup(&destination, "full", None, None)
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
        let mut guard = repository.lock().map_err(|_| {
            crate::error::AppError::Validation("本地数据库状态不可用，请重新启动应用。".into())
        })?;
        guard.export_project_database(&project_id, &destination)?;
        guard.record_backup(&destination, "project", Some(&project_id), None)
    })
    .await
    .map_err(|error| {
        crate::error::AppError::Validation(format!("项目数据库导出任务失败：{error}"))
    })??;
    Ok(returned_path)
}

#[tauri::command]
pub async fn preview_database_import(
    source_path: String,
    project_only: bool,
    state: State<'_, AppState>,
) -> AppResult<DatabaseImportPreview> {
    let source = PathBuf::from(source_path);
    if paths_refer_to_same_file(&source, &state.database_path) {
        return Err(crate::error::AppError::Validation(
            "不能把应用正在使用的数据库作为导入文件。".into(),
        ));
    }
    let repository = Arc::clone(&state.repository);
    let working_directory = state.backup_directory.clone();
    let pdf_library_directory = state.pdf_library_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = repository.lock().map_err(|_| {
            crate::error::AppError::Validation("本地数据库状态不可用，请重新启动应用。".into())
        })?;
        let (mut preview, paths) =
            guard.preview_database_import(&source, &working_directory, project_only)?;
        preview.missing_pdf_count = paths
            .iter()
            .filter(|path| {
                path.as_deref()
                    .is_none_or(|path| !managed_pdf_is_available(path, &pdf_library_directory))
            })
            .count() as i64;
        Ok::<DatabaseImportPreview, crate::error::AppError>(preview)
    })
    .await
    .map_err(|error| {
        crate::error::AppError::Validation(format!("数据库导入预览任务失败：{error}"))
    })?
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
    let (backup_directory, backup_warning, retention_days, retention_count) = {
        let guard = state.lock()?;
        let resolved = resolved_backup_directory(&guard, &state.backup_directory)?;
        (
            resolved.directory,
            resolved.warning,
            resolved.retention_days,
            resolved.retention_count,
        )
    };
    let safety_backup = backup_directory.join(format!(
        "inkstone-before-import-{}-{}.db",
        Utc::now().format("%Y%m%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    ));
    let repository = Arc::clone(&state.repository);
    let pdf_library_directory = state.pdf_library_directory.clone();
    let returned_safety_path = safety_backup.to_string_lossy().into_owned();
    let (preview, cleanup) = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = repository.lock().map_err(|_| {
            crate::error::AppError::Validation("本地数据库状态不可用，请重新启动应用。".into())
        })?;
        let (mut preview, paths) =
            guard.preview_database_import(&source, &backup_directory, false)?;
        preview.missing_pdf_count = paths
            .iter()
            .filter(|path| {
                path.as_deref()
                    .is_none_or(|path| !managed_pdf_is_available(path, &pdf_library_directory))
            })
            .count() as i64;
        guard.import_database(&source, &safety_backup)?;
        let cleanup =
            guard.cleanup_automatic_backups(&backup_directory, retention_days, retention_count)?;
        Ok::<(DatabaseImportPreview, BackupCleanupResult), crate::error::AppError>((
            preview, cleanup,
        ))
    })
    .await
    .map_err(|error| {
        crate::error::AppError::Validation(format!("数据库导入任务失败：{error}"))
    })??;
    Ok(DatabaseImportResult {
        safety_backup_path: returned_safety_path,
        missing_pdf_count: preview.missing_pdf_count,
        source_project_count: preview.source_project_count,
        source_document_count: preview.source_document_count,
        source_card_count: preview.source_card_count,
        source_annotation_count: preview.source_annotation_count,
        source_outline_node_count: preview.source_outline_node_count,
        source_item_count: preview.source_item_count,
        created_project_count: preview.created_project_count,
        merged_project_count: preview.merged_project_count,
        added_item_count: preview.added_item_count,
        skipped_item_count: preview.skipped_item_count,
        conflict_item_count: preview.conflict_item_count,
        backup_warning,
        cleanup_deleted_count: cleanup.deleted_count,
        cleanup_freed_bytes: cleanup.freed_bytes,
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
    let (backup_directory, backup_warning, retention_days, retention_count) = {
        let guard = state.lock()?;
        let resolved = resolved_backup_directory(&guard, &state.backup_directory)?;
        (
            resolved.directory,
            resolved.warning,
            resolved.retention_days,
            resolved.retention_count,
        )
    };
    let safety_backup = backup_directory.join(format!(
        "inkstone-before-project-import-{}-{}.db",
        Utc::now().format("%Y%m%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    ));
    let repository = Arc::clone(&state.repository);
    let pdf_library_directory = state.pdf_library_directory.clone();
    let returned_safety_path = safety_backup.to_string_lossy().into_owned();
    let (preview, cleanup) = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = repository.lock().map_err(|_| {
            crate::error::AppError::Validation("本地数据库状态不可用，请重新启动应用。".into())
        })?;
        let (mut preview, paths) =
            guard.preview_database_import(&source, &backup_directory, true)?;
        preview.missing_pdf_count = paths
            .iter()
            .filter(|path| {
                path.as_deref()
                    .is_none_or(|path| !managed_pdf_is_available(path, &pdf_library_directory))
            })
            .count() as i64;
        guard.import_project_database(&source, &safety_backup)?;
        let cleanup =
            guard.cleanup_automatic_backups(&backup_directory, retention_days, retention_count)?;
        Ok::<(DatabaseImportPreview, BackupCleanupResult), crate::error::AppError>((
            preview, cleanup,
        ))
    })
    .await
    .map_err(|error| {
        crate::error::AppError::Validation(format!("项目数据库导入任务失败：{error}"))
    })??;
    Ok(DatabaseImportResult {
        safety_backup_path: returned_safety_path,
        missing_pdf_count: preview.missing_pdf_count,
        source_project_count: preview.source_project_count,
        source_document_count: preview.source_document_count,
        source_card_count: preview.source_card_count,
        source_annotation_count: preview.source_annotation_count,
        source_outline_node_count: preview.source_outline_node_count,
        source_item_count: preview.source_item_count,
        created_project_count: preview.created_project_count,
        merged_project_count: preview.merged_project_count,
        added_item_count: preview.added_item_count,
        skipped_item_count: preview.skipped_item_count,
        conflict_item_count: preview.conflict_item_count,
        backup_warning,
        cleanup_deleted_count: cleanup.deleted_count,
        cleanup_freed_bytes: cleanup.freed_bytes,
    })
}

#[tauri::command]
pub fn get_backup_manager(state: State<'_, AppState>) -> AppResult<BackupManagerState> {
    let mut guard = state.lock()?;
    backup_manager_state(&mut guard, &state.backup_directory)
}

#[tauri::command]
pub fn update_backup_settings(
    input: UpdateBackupSettingsInput,
    state: State<'_, AppState>,
) -> AppResult<BackupManagerState> {
    let custom_directory = input
        .custom_directory
        .as_deref()
        .map(PathBuf::from)
        .map(|path| validated_writable_backup_directory(&path))
        .transpose()?;
    let mut guard = state.lock()?;
    guard.set_backup_preferences(
        custom_directory.as_deref(),
        input.retention_days,
        input.retention_count,
        input.automatic_interval_hours,
    )?;
    backup_manager_state(&mut guard, &state.backup_directory)
}

#[tauri::command]
pub async fn run_scheduled_backup(state: State<'_, AppState>) -> AppResult<BackupManagerState> {
    let repository = Arc::clone(&state.repository);
    let default_directory = state.backup_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = repository
            .lock()
            .map_err(|_| AppError::Validation("本地数据库状态不可用，请重新启动应用。".into()))?;
        let resolved = resolved_backup_directory(&guard, &default_directory)?;
        guard.register_automatic_backups_in_directory(&resolved.directory)?;
        let preferences = guard.backup_preferences()?;
        let interval_hours = preferences.automatic_interval_hours;
        let now = Utc::now();
        let due = scheduled_backup_is_due(
            interval_hours,
            preferences.last_automatic_backup_at.as_deref(),
            now,
        );
        if due {
            let destination = resolved.directory.join(format!(
                "inkstone-before-scheduled-{}-{}.db",
                now.format("%Y%m%d-%H%M%S"),
                &Uuid::new_v4().to_string()[..8]
            ));
            guard.export_database(&destination)?;
            guard.record_backup(&destination, "auto", None, Some(&resolved.directory))?;
            guard.mark_automatic_backup_completed(&destination)?;
            guard.cleanup_automatic_backups(
                &resolved.directory,
                resolved.retention_days,
                resolved.retention_count,
            )?;
        }
        backup_manager_state(&mut guard, &default_directory)
    })
    .await
    .map_err(|error| AppError::Validation(format!("自动备份任务失败：{error}")))?
}

#[tauri::command]
pub async fn create_backup_snapshot(state: State<'_, AppState>) -> AppResult<BackupManagerState> {
    let repository = Arc::clone(&state.repository);
    let default_directory = state.backup_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = repository
            .lock()
            .map_err(|_| AppError::Validation("本地数据库状态不可用，请重新启动应用。".into()))?;
        let resolved = resolved_backup_directory(&guard, &default_directory)?;
        let destination = resolved.directory.join(format!(
            "inkstone-before-manual-{}-{}.db",
            Utc::now().format("%Y%m%d-%H%M%S"),
            &Uuid::new_v4().to_string()[..8]
        ));
        guard.export_database(&destination)?;
        guard.record_backup(&destination, "auto", None, Some(&resolved.directory))?;
        guard.mark_automatic_backup_completed(&destination)?;
        guard.cleanup_automatic_backups(
            &resolved.directory,
            resolved.retention_days,
            resolved.retention_count,
        )?;
        backup_manager_state(&mut guard, &default_directory)
    })
    .await
    .map_err(|error| AppError::Validation(format!("主动备份任务失败：{error}")))?
}

fn scheduled_backup_is_due(
    interval_hours: i64,
    last_automatic_backup_at: Option<&str>,
    now: chrono::DateTime<Utc>,
) -> bool {
    if interval_hours <= 0 {
        return false;
    }
    last_automatic_backup_at
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_none_or(|last| {
            now.signed_duration_since(last.with_timezone(&Utc))
                .num_hours()
                >= interval_hours
        })
}

#[tauri::command]
pub fn cleanup_backups(state: State<'_, AppState>) -> AppResult<BackupCleanupResult> {
    let mut guard = state.lock()?;
    let resolved = resolved_backup_directory(&guard, &state.backup_directory)?;
    guard.cleanup_automatic_backups(
        &resolved.directory,
        resolved.retention_days,
        resolved.retention_count,
    )
}

#[tauri::command]
pub fn delete_automatic_backup(backup_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.delete_automatic_backup(&backup_id)
}

#[tauri::command]
pub fn reveal_backup(backup_id: String, state: State<'_, AppState>) -> AppResult<()> {
    let path = state.lock()?.backup_record_path(&backup_id)?;
    reveal_path(&path, true)
}

#[tauri::command]
pub fn reveal_backup_directory(state: State<'_, AppState>) -> AppResult<()> {
    let guard = state.lock()?;
    let resolved = resolved_backup_directory(&guard, &state.backup_directory)?;
    reveal_path(&resolved.directory, false)
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
pub fn update_pdf_annotation(
    input: UpdatePdfAnnotationInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.update_pdf_annotation(input)
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
pub fn update_reading_note(
    input: UpdateReadingNoteInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.update_reading_note(input)
}

#[tauri::command]
pub fn update_card(input: UpdateCardInput, state: State<'_, AppState>) -> AppResult<()> {
    state.lock()?.update_card(input)
}

#[tauri::command]
pub fn batch_update_cards(
    input: BatchUpdateCardsInput,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    state.lock()?.batch_update_cards(input)
}

#[tauri::command]
pub fn create_research_role(
    input: CreateResearchRoleInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state.lock()?.create_research_role(input)
}

#[tauri::command]
pub fn update_research_role(
    input: UpdateResearchRoleInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.update_research_role(input)
}

#[tauri::command]
pub fn set_research_role_archived(
    research_role_id: String,
    archived: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .lock()?
        .set_research_role_archived(&research_role_id, archived)
}

#[tauri::command]
pub fn reorder_research_roles(
    project_id: String,
    ordered_ids: Vec<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .lock()?
        .reorder_research_roles(&project_id, &ordered_ids)
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
pub fn update_outline_card_link(
    input: UpdateOutlineCardLinkInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.update_outline_card_link(input)
}

#[tauri::command]
pub fn move_outline_card(
    link_id: String,
    direction: i64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.lock()?.move_outline_card(&link_id, direction)
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, TimeZone};

    use super::scheduled_backup_is_due;

    #[test]
    fn scheduled_backup_respects_disabled_and_elapsed_intervals() {
        let now = chrono::Utc
            .with_ymd_and_hms(2026, 8, 31, 12, 0, 0)
            .single()
            .expect("test time");
        let twenty_three_hours_ago = (now - Duration::hours(23)).to_rfc3339();
        let twenty_four_hours_ago = (now - Duration::hours(24)).to_rfc3339();
        assert!(!scheduled_backup_is_due(0, None, now));
        assert!(scheduled_backup_is_due(24, None, now));
        assert!(!scheduled_backup_is_due(
            24,
            Some(&twenty_three_hours_ago),
            now
        ));
        assert!(scheduled_backup_is_due(
            24,
            Some(&twenty_four_hours_ago),
            now
        ));
        assert!(scheduled_backup_is_due(24, Some("invalid"), now));
    }
}
