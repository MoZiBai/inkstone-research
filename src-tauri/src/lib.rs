mod commands;
mod database;
mod error;
mod models;
mod pdf_files;

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};

use commands::AppState;
use database::Repository;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

pub(crate) static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn request_exit(app: &tauri::AppHandle) {
    show_main_window(app);
    let _ = app.emit("app-close-requested", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_directory = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_directory)?;
            let database_path = app_data_directory.join("inkstone.db");
            let repository = Repository::open(&database_path)?;
            let backup_directory = app_data_directory.join("backups");
            fs::create_dir_all(&backup_directory)?;
            let pdf_library_directory = app_data_directory.join("pdf-library");
            fs::create_dir_all(&pdf_library_directory)?;
            let state = AppState::new(
                repository,
                database_path,
                backup_directory,
                pdf_library_directory,
            );
            state.start_backup_scheduler(app.handle().clone());
            app.manage(state);

            let open_item = MenuItem::with_id(app, "open", "打开窗口", true, None::<&str>)?;
            let exit_item = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &exit_item])?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "exit" => request_exit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !EXIT_REQUESTED.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("app-close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_workspace,
            commands::create_project,
            commands::update_project,
            commands::remove_project,
            commands::create_document,
            commands::update_document,
            commands::update_document_print_page_mapping,
            commands::remove_document,
            commands::restore_document,
            commands::create_document_group,
            commands::update_document_group,
            commands::delete_document_group,
            commands::move_document_to_group,
            commands::import_pdf,
            commands::export_database,
            commands::export_project_database,
            commands::import_database,
            commands::import_project_database,
            commands::preview_database_import,
            commands::get_backup_manager,
            commands::get_backup_runtime,
            commands::update_backup_settings,
            commands::create_backup_snapshot,
            commands::cleanup_backups,
            commands::delete_automatic_backup,
            commands::reveal_backup,
            commands::reveal_backup_directory,
            commands::hide_to_tray,
            commands::exit_application,
            commands::read_pdf,
            commands::reveal_pdf_in_file_manager,
            commands::create_card_from_selection,
            commands::create_pdf_annotation,
            commands::update_pdf_annotation,
            commands::delete_pdf_annotation,
            commands::create_reading_note,
            commands::update_reading_note,
            commands::delete_reading_note,
            commands::update_card,
            commands::batch_update_cards,
            commands::create_research_role,
            commands::update_research_role,
            commands::set_research_role_archived,
            commands::reorder_research_roles,
            commands::move_card,
            commands::set_card_excluded,
            commands::delete_card,
            commands::create_category,
            commands::update_category,
            commands::delete_category,
            commands::reorder_categories,
            commands::create_outline_node,
            commands::update_outline_node,
            commands::move_outline_node,
            commands::delete_outline_node,
            commands::link_card_to_outline,
            commands::update_outline_card_link,
            commands::remove_outline_link,
            commands::move_outline_card
        ])
        .run(tauri::generate_context!())
        .expect("砚台启动失败");
}
