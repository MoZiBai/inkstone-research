use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::database::Repository;
use crate::error::{AppError, AppResult};
use crate::models::{
    BackupCleanupResult, BackupManagerState, BackupRuntimeStatus, BackupSettings,
    BatchUpdateCardsInput, CreateCardFromSelectionInput, CreateCategoryInput,
    CreateDocumentGroupInput, CreateDocumentInput, CreateOutlineNodeInput,
    CreatePdfAnnotationInput, CreateProjectInput, CreateReadingNoteInput, CreateResearchRoleInput,
    DatabaseImportPreview, DatabaseImportResult, ImportPdfInput, ImportPdfResult,
    MoveDocumentToGroupInput, MoveOutlineNodeInput, RemoveDocumentInput, UpdateBackupSettingsInput,
    UpdateCardInput, UpdateCategoryInput, UpdateDocumentGroupInput, UpdateDocumentInput,
    UpdateDocumentPrintPageMappingInput, UpdateOutlineCardLinkInput, UpdateOutlineNodeInput,
    UpdatePdfAnnotationInput, UpdateProjectInput, UpdateReadingNoteInput, UpdateResearchRoleInput,
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
    backup_runtime: Arc<Mutex<BackupRuntimeStatus>>,
}

impl AppState {
    async fn run_repository<T, F>(&self, action: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Repository) -> AppResult<T> + Send + 'static,
    {
        let repository = Arc::clone(&self.repository);
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = repository.lock().map_err(|_| {
                AppError::Validation("本地数据库状态不可用，请重新启动应用。".into())
            })?;
            if crate::EXIT_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(AppError::Validation("软件正在退出，请稍候。".into()));
            }
            action(&mut guard)
        })
        .await
        .map_err(|error| AppError::Validation(format!("资料库操作失败：{error}")))?
    }

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
            backup_runtime: Arc::new(Mutex::new(BackupRuntimeStatus::default())),
        }
    }

    fn lock(&self) -> AppResult<MutexGuard<'_, Repository>> {
        self.repository
            .lock()
            .map_err(|_| AppError::Validation("本地数据库状态不可用，请重新启动应用。".into()))
    }

    pub fn start_backup_scheduler(&self, app: AppHandle) {
        let repository = Arc::clone(&self.repository);
        let runtime = Arc::clone(&self.backup_runtime);
        let default_directory = self.backup_directory.clone();
        let thread_runtime = Arc::clone(&runtime);
        if let Err(error) = thread::Builder::new()
            .name("inkstone-backup-scheduler".into())
            .spawn(move || {
                let mut schedule = SessionBackupSchedule::default();
                loop {
                    if crate::EXIT_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
                        break;
                    }
                    let now = Instant::now();
                    // Never queue a scheduler check behind an active import/write.
                    if let Ok(mut guard) = repository.try_lock() {
                        if crate::EXIT_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
                            break;
                        }
                        match guard.backup_preferences() {
                            Ok(preferences) => {
                                schedule.configure(preferences.automatic_interval_minutes, now);
                                let due = schedule.take_due(now);
                                if due {
                                    if let Ok(mut status) = thread_runtime.lock() {
                                        status.running = true;
                                        status.last_error = None;
                                        let _ = app.emit("backup-status-changed", &*status);
                                    }
                                    let result =
                                        create_scheduled_backup(&mut guard, &default_directory);
                                    if let Ok(mut status) = thread_runtime.lock() {
                                        status.running = false;
                                        status.last_error =
                                            result.err().map(|error| error.to_string());
                                        if status.last_error.is_some() {
                                            schedule.retry_after_failure(Instant::now());
                                        }
                                    }
                                }
                                if let Ok(mut status) = thread_runtime.lock() {
                                    status.next_backup_at = schedule.next_due.map(|due| {
                                        let remaining =
                                            due.saturating_duration_since(Instant::now());
                                        (Utc::now()
                                            + chrono::Duration::seconds(remaining.as_secs() as i64))
                                        .to_rfc3339()
                                    });
                                    if due {
                                        let _ = app.emit("backup-status-changed", &*status);
                                    }
                                }
                            }
                            Err(error) => {
                                if let Ok(mut status) = thread_runtime.lock() {
                                    let message = error.to_string();
                                    if status.last_error.as_ref() != Some(&message) {
                                        status.last_error = Some(message);
                                        let _ = app.emit("backup-status-changed", &*status);
                                    }
                                }
                            }
                        }
                    }
                    thread::sleep(Duration::from_secs(10));
                }
            })
        {
            if let Ok(mut status) = runtime.lock() {
                status.last_error = Some(format!("自动备份未能启动：{error}"));
            }
        }
    }
}

#[derive(Default)]
struct SessionBackupSchedule {
    interval_minutes: i64,
    next_due: Option<Instant>,
}

impl SessionBackupSchedule {
    fn retry_after_failure(&mut self, now: Instant) {
        self.next_due = Some(now + Duration::from_secs(60));
    }

    fn configure(&mut self, interval_minutes: i64, now: Instant) {
        if self.interval_minutes == interval_minutes {
            return;
        }
        self.interval_minutes = interval_minutes;
        self.next_due = interval_duration(interval_minutes).map(|interval| now + interval);
    }

    fn take_due(&mut self, now: Instant) -> bool {
        let Some(next_due) = self.next_due else {
            return false;
        };
        if now < next_due {
            return false;
        }
        self.next_due = interval_duration(self.interval_minutes).map(|interval| now + interval);
        true
    }
}

fn interval_duration(interval_minutes: i64) -> Option<Duration> {
    u64::try_from(interval_minutes)
        .ok()
        .filter(|minutes| *minutes > 0)
        .map(|minutes| Duration::from_secs(minutes.saturating_mul(60)))
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
            automatic_interval_minutes: preferences.automatic_interval_minutes,
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
pub async fn get_workspace(
    project_id: Option<String>,
    sections: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> AppResult<WorkspaceSnapshot> {
    let repository = Arc::clone(&state.repository);
    let pdf_directory = state.pdf_library_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = repository
            .lock()
            .map_err(|_| AppError::Validation("本地数据库状态不可用，请重新启动应用。".into()))?;
        let mut snapshot = match sections.as_deref() {
            Some(sections) => {
                guard.get_workspace_sections(project_id.as_deref(), Some(sections))?
            }
            None => guard.get_workspace(project_id.as_deref())?,
        };
        for document in &mut snapshot.documents {
            document.file_available = document
                .file_path
                .as_deref()
                .is_some_and(|path| managed_pdf_is_available(&PathBuf::from(path), &pdf_directory));
        }
        Ok(snapshot)
    })
    .await
    .map_err(|error| AppError::Validation(format!("读取资料库失败：{error}")))?
}

#[tauri::command]
pub async fn create_project(
    input: CreateProjectInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .run_repository(move |repository| repository.create_project(input))
        .await
}

#[tauri::command]
pub async fn update_project(
    input: UpdateProjectInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_project(input))
        .await
}

#[tauri::command]
pub async fn remove_project(project_id: String, state: State<'_, AppState>) -> AppResult<()> {
    let discarded_paths = state
        .run_repository(move |repository| repository.remove_project(&project_id))
        .await?;
    for path in discarded_paths {
        // The database transaction is authoritative. A locked Windows file may
        // leave an unreferenced copy behind; it must not turn a successful data
        // deletion into a misleading failure.
        let _ = discard_managed_pdf(&path, &state.pdf_library_directory);
    }
    Ok(())
}

#[tauri::command]
pub async fn create_document(
    input: CreateDocumentInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .run_repository(move |repository| repository.create_document(input))
        .await
}

#[tauri::command]
pub async fn update_document(
    input: UpdateDocumentInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_document(input))
        .await
}

#[tauri::command]
pub async fn update_document_print_page_mapping(
    input: UpdateDocumentPrintPageMappingInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_document_print_page_mapping(input))
        .await
}

#[tauri::command]
pub async fn remove_document(
    input: RemoveDocumentInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let discarded_path = state
        .run_repository(move |repository| repository.remove_document(input))
        .await?;
    if let Some(path) = discarded_path {
        // The database transaction is authoritative. A locked Windows file may
        // leave an unreferenced copy behind; it must not turn a successful data
        // deletion into a misleading failure.
        let _ = discard_managed_pdf(&path, &state.pdf_library_directory);
    }
    Ok(())
}

#[tauri::command]
pub async fn restore_document(
    project_id: String,
    document_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.restore_document(&project_id, &document_id))
        .await
}

#[tauri::command]
pub async fn create_document_group(
    input: CreateDocumentGroupInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .run_repository(move |repository| repository.create_document_group(input))
        .await
}

#[tauri::command]
pub async fn update_document_group(
    input: UpdateDocumentGroupInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_document_group(input))
        .await
}

#[tauri::command]
pub async fn delete_document_group(group_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.delete_document_group(&group_id))
        .await
}

#[tauri::command]
pub async fn move_document_to_group(
    input: MoveDocumentToGroupInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.move_document_to_group(input))
        .await
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
pub fn get_backup_runtime(state: State<'_, AppState>) -> AppResult<BackupRuntimeStatus> {
    state
        .backup_runtime
        .lock()
        .map(|status| status.clone())
        .map_err(|_| AppError::Validation("备份状态暂不可用。".into()))
}

#[tauri::command]
pub async fn get_backup_manager(state: State<'_, AppState>) -> AppResult<BackupManagerState> {
    let repository = Arc::clone(&state.repository);
    let directory = state.backup_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = repository
            .lock()
            .map_err(|_| AppError::Validation("本地数据库状态不可用，请重新启动应用。".into()))?;
        backup_manager_state(&mut guard, &directory)
    })
    .await
    .map_err(|error| AppError::Validation(format!("读取备份列表失败：{error}")))?
}

#[tauri::command]
pub async fn update_backup_settings(
    input: UpdateBackupSettingsInput,
    state: State<'_, AppState>,
) -> AppResult<BackupManagerState> {
    let custom_directory = input
        .custom_directory
        .as_deref()
        .map(PathBuf::from)
        .map(|path| validated_writable_backup_directory(&path))
        .transpose()?;
    let directory = state.backup_directory.clone();
    state
        .run_repository(move |repository| {
            repository.set_backup_preferences(
                custom_directory.as_deref(),
                input.retention_days,
                input.retention_count,
                input.automatic_interval_minutes,
            )?;
            backup_manager_state(repository, &directory)
        })
        .await
}

fn create_scheduled_backup(repository: &mut Repository, default_directory: &Path) -> AppResult<()> {
    let resolved = resolved_backup_directory(repository, default_directory)?;
    repository.register_automatic_backups_in_directory(&resolved.directory)?;
    let destination = resolved.directory.join(format!(
        "inkstone-before-scheduled-{}-{}.db",
        Utc::now().format("%Y%m%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    ));
    repository.export_database(&destination)?;
    repository.record_backup(&destination, "auto", None, Some(&resolved.directory))?;
    repository.mark_automatic_backup_completed(&destination)?;
    repository.cleanup_automatic_backups(
        &resolved.directory,
        resolved.retention_days,
        resolved.retention_count,
    )?;
    Ok(())
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

#[tauri::command]
pub async fn cleanup_backups(state: State<'_, AppState>) -> AppResult<BackupCleanupResult> {
    let directory = state.backup_directory.clone();
    state
        .run_repository(move |repository| {
            let resolved = resolved_backup_directory(repository, &directory)?;
            repository.cleanup_automatic_backups(
                &resolved.directory,
                resolved.retention_days,
                resolved.retention_count,
            )
        })
        .await
}

#[tauri::command]
pub async fn delete_automatic_backup(
    backup_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.delete_automatic_backup(&backup_id))
        .await
}

#[tauri::command]
pub async fn reveal_backup(backup_id: String, state: State<'_, AppState>) -> AppResult<()> {
    let path = state
        .run_repository(move |repository| repository.backup_record_path(&backup_id))
        .await?;
    reveal_path(&path, true)
}

#[tauri::command]
pub async fn reveal_backup_directory(state: State<'_, AppState>) -> AppResult<()> {
    let directory = state.backup_directory.clone();
    let path = state
        .run_repository(move |repository| {
            Ok(resolved_backup_directory(repository, &directory)?.directory)
        })
        .await?;
    reveal_path(&path, false)
}

#[tauri::command]
pub fn hide_to_tray(app: AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::NotFound("主窗口".into()))?;
    window
        .hide()
        .map_err(|error| AppError::Validation(format!("隐藏主窗口失败：{error}")))
}

#[tauri::command]
pub async fn exit_application(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let repository = Arc::clone(&state.repository);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = repository
            .lock()
            .map_err(|_| AppError::Validation("数据库正在恢复，请重试退出。".into()))?;
        crate::EXIT_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
        drop(guard);
        app.exit(0);
        Ok(())
    })
    .await
    .map_err(|error| AppError::Validation(format!("退出失败：{error}")))?
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
pub async fn reveal_pdf_in_file_manager(
    document_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let pdf_path = state
        .run_repository(move |repository| repository.pdf_path(&document_id))
        .await?;
    reveal_managed_pdf(&pdf_path, &state.pdf_library_directory)
}

#[tauri::command]
pub async fn create_card_from_selection(
    input: CreateCardFromSelectionInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .run_repository(move |repository| repository.create_card_from_selection(input))
        .await
}

#[tauri::command]
pub async fn create_pdf_annotation(
    input: CreatePdfAnnotationInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .run_repository(move |repository| repository.create_pdf_annotation(input))
        .await
}

#[tauri::command]
pub async fn delete_pdf_annotation(
    annotation_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.delete_pdf_annotation(&annotation_id))
        .await
}

#[tauri::command]
pub async fn update_pdf_annotation(
    input: UpdatePdfAnnotationInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_pdf_annotation(input))
        .await
}

#[tauri::command]
pub async fn create_reading_note(
    input: CreateReadingNoteInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .run_repository(move |repository| repository.create_reading_note(input))
        .await
}

#[tauri::command]
pub async fn delete_reading_note(note_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.delete_reading_note(&note_id))
        .await
}

#[tauri::command]
pub async fn update_reading_note(
    input: UpdateReadingNoteInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_reading_note(input))
        .await
}

#[tauri::command]
pub async fn update_card(input: UpdateCardInput, state: State<'_, AppState>) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_card(input))
        .await
}

#[tauri::command]
pub async fn batch_update_cards(
    input: BatchUpdateCardsInput,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    state
        .run_repository(move |repository| repository.batch_update_cards(input))
        .await
}

#[tauri::command]
pub async fn create_research_role(
    input: CreateResearchRoleInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .run_repository(move |repository| repository.create_research_role(input))
        .await
}

#[tauri::command]
pub async fn update_research_role(
    input: UpdateResearchRoleInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_research_role(input))
        .await
}

#[tauri::command]
pub async fn set_research_role_archived(
    research_role_id: String,
    archived: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| {
            repository.set_research_role_archived(&research_role_id, archived)
        })
        .await
}

#[tauri::command]
pub async fn reorder_research_roles(
    project_id: String,
    ordered_ids: Vec<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| {
            repository.reorder_research_roles(&project_id, &ordered_ids)
        })
        .await
}

#[tauri::command]
pub async fn move_card(
    card_id: String,
    category_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.move_card(&card_id, &category_id))
        .await
}

#[tauri::command]
pub async fn set_card_excluded(
    card_id: String,
    excluded: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.set_card_excluded(&card_id, excluded))
        .await
}

#[tauri::command]
pub async fn delete_card(card_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.delete_card(&card_id))
        .await
}

#[tauri::command]
pub async fn create_category(
    input: CreateCategoryInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .run_repository(move |repository| repository.create_category(input))
        .await
}

#[tauri::command]
pub async fn update_category(
    input: UpdateCategoryInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_category(input))
        .await
}

#[tauri::command]
pub async fn delete_category(category_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.delete_category(&category_id))
        .await
}

#[tauri::command]
pub async fn reorder_categories(
    project_id: String,
    ordered_ids: Vec<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.reorder_categories(&project_id, &ordered_ids))
        .await
}

#[tauri::command]
pub async fn create_outline_node(
    input: CreateOutlineNodeInput,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .run_repository(move |repository| repository.create_outline_node(input))
        .await
}

#[tauri::command]
pub async fn update_outline_node(
    input: UpdateOutlineNodeInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_outline_node(input))
        .await
}

#[tauri::command]
pub async fn move_outline_node(
    input: MoveOutlineNodeInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.move_outline_node(input))
        .await
}

#[tauri::command]
pub async fn delete_outline_node(node_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.delete_outline_node(&node_id))
        .await
}

#[tauri::command]
pub async fn link_card_to_outline(
    node_id: String,
    card_id: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .run_repository(move |repository| repository.link_card_to_outline(&node_id, &card_id))
        .await
}

#[tauri::command]
pub async fn remove_outline_link(link_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.remove_outline_link(&link_id))
        .await
}

#[tauri::command]
pub async fn update_outline_card_link(
    input: UpdateOutlineCardLinkInput,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.update_outline_card_link(input))
        .await
}

#[tauri::command]
pub async fn move_outline_card(
    link_id: String,
    direction: i64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .run_repository(move |repository| repository.move_outline_card(&link_id, direction))
        .await
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::SessionBackupSchedule;

    #[test]
    fn session_schedule_starts_from_launch_and_repeats_after_each_due_time() {
        let launch = Instant::now();
        let mut schedule = SessionBackupSchedule::default();

        schedule.configure(30, launch);
        assert!(!schedule.take_due(launch + Duration::from_secs(29 * 60 + 59)));
        assert!(schedule.take_due(launch + Duration::from_secs(30 * 60)));
        assert!(!schedule.take_due(launch + Duration::from_secs(59 * 60 + 59)));
        assert!(schedule.take_due(launch + Duration::from_secs(60 * 60)));
    }

    #[test]
    fn failed_backup_retries_after_one_minute_without_a_catch_up_burst() {
        let launch = Instant::now();
        let mut schedule = SessionBackupSchedule::default();
        schedule.configure(30, launch);
        let due = launch + Duration::from_secs(30 * 60);
        assert!(schedule.take_due(due));
        schedule.retry_after_failure(due);
        assert!(!schedule.take_due(due + Duration::from_secs(59)));
        assert!(schedule.take_due(due + Duration::from_secs(60)));
        assert!(!schedule.take_due(due + Duration::from_secs(61)));
        schedule.configure(0, due);
        assert!(!schedule.take_due(due + Duration::from_secs(60 * 60)));
    }

    #[test]
    fn session_schedule_can_be_disabled_and_interval_changes_reset_the_timer() {
        let launch = Instant::now();
        let mut schedule = SessionBackupSchedule::default();

        schedule.configure(0, launch);
        assert!(!schedule.take_due(launch + Duration::from_secs(24 * 60 * 60)));

        schedule.configure(30, launch);
        let changed_at = launch + Duration::from_secs(20 * 60);
        schedule.configure(60, changed_at);
        assert!(!schedule.take_due(launch + Duration::from_secs(70 * 60)));
        assert!(schedule.take_due(launch + Duration::from_secs(80 * 60)));
    }
}
