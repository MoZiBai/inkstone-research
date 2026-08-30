mod commands;
mod database;
mod error;
mod models;
mod pdf_files;

use std::fs;

use commands::AppState;
use database::Repository;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_directory = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_directory)?;
            let repository = Repository::open(&app_data_directory.join("inkstone.db"))?;
            let pdf_library_directory = app_data_directory.join("pdf-library");
            fs::create_dir_all(&pdf_library_directory)?;
            app.manage(AppState::new(repository, pdf_library_directory));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_workspace,
            commands::create_project,
            commands::create_document,
            commands::update_document,
            commands::remove_document,
            commands::restore_document,
            commands::import_pdf,
            commands::read_pdf,
            commands::reveal_pdf_in_file_manager,
            commands::create_card_from_selection,
            commands::create_pdf_annotation,
            commands::delete_pdf_annotation,
            commands::create_reading_note,
            commands::delete_reading_note,
            commands::update_card,
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
            commands::remove_outline_link,
            commands::move_outline_card
        ])
        .run(tauri::generate_context!())
        .expect("砚台启动失败");
}
