import { invoke } from '@tauri-apps/api/core'
import type {
  CreateCategoryInput,
  CreateCardFromSelectionInput,
  CreateDocumentInput,
  CreateDocumentGroupInput,
  CreateOutlineNodeInput,
  CreatePdfAnnotationInput,
  CreateProjectInput,
  CreateReadingNoteInput,
  CreateResearchRoleInput,
  BackupCleanupResult,
  BackupManagerState,
  BatchUpdateCardsInput,
  DatabaseImportResult,
  DatabaseImportPreview,
  ImportPdfInput,
  ImportPdfResult,
  InkstoneApi,
  MoveOutlineNodeInput,
  MoveDocumentToGroupInput,
  RemoveDocumentInput,
  UpdateCardInput,
  UpdateCategoryInput,
  UpdateDocumentInput,
  UpdateDocumentPrintPageMappingInput,
  UpdateDocumentGroupInput,
  UpdateOutlineCardLinkInput,
  UpdateOutlineNodeInput,
  UpdatePdfAnnotationInput,
  UpdateProjectInput,
  UpdateReadingNoteInput,
  UpdateResearchRoleInput,
  UpdateBackupSettingsInput,
  WorkspaceSnapshot
} from '@shared/types'

export const api: InkstoneApi = {
  getWorkspace: (projectId?: string) =>
    invoke<WorkspaceSnapshot>('get_workspace', { projectId }),
  createProject: (input: CreateProjectInput) =>
    invoke<string>('create_project', { input }),
  updateProject: (input: UpdateProjectInput) =>
    invoke<void>('update_project', { input }),
  removeProject: (projectId: string) =>
    invoke<void>('remove_project', { projectId }),
  exportProjectDatabase: (projectId: string, destinationPath: string) =>
    invoke<string>('export_project_database', { projectId, destinationPath }),
  createDocument: (input: CreateDocumentInput) =>
    invoke<string>('create_document', { input }),
  updateDocument: (input: UpdateDocumentInput) =>
    invoke<void>('update_document', { input }),
  updateDocumentPrintPageMapping: (input: UpdateDocumentPrintPageMappingInput) =>
    invoke<void>('update_document_print_page_mapping', { input }),
  removeDocument: (input: RemoveDocumentInput) =>
    invoke<void>('remove_document', { input }),
  restoreDocument: (projectId: string, documentId: string) =>
    invoke<void>('restore_document', { projectId, documentId }),
  createDocumentGroup: (input: CreateDocumentGroupInput) =>
    invoke<string>('create_document_group', { input }),
  updateDocumentGroup: (input: UpdateDocumentGroupInput) =>
    invoke<void>('update_document_group', { input }),
  deleteDocumentGroup: (groupId: string) =>
    invoke<void>('delete_document_group', { groupId }),
  moveDocumentToGroup: (input: MoveDocumentToGroupInput) =>
    invoke<void>('move_document_to_group', { input }),
  importPdf: (input: ImportPdfInput) =>
    invoke<ImportPdfResult>('import_pdf', { input }),
  exportDatabase: (destinationPath: string) =>
    invoke<string>('export_database', { destinationPath }),
  importDatabase: (sourcePath: string) =>
    invoke<DatabaseImportResult>('import_database', { sourcePath }),
  importProjectDatabase: (sourcePath: string) =>
    invoke<DatabaseImportResult>('import_project_database', { sourcePath }),
  previewDatabaseImport: (sourcePath: string, projectOnly: boolean) =>
    invoke<DatabaseImportPreview>('preview_database_import', { sourcePath, projectOnly }),
  getBackupManager: () => invoke<BackupManagerState>('get_backup_manager'),
  createBackupSnapshot: () => invoke<BackupManagerState>('create_backup_snapshot'),
  runScheduledBackup: () => invoke<BackupManagerState>('run_scheduled_backup'),
  updateBackupSettings: (input: UpdateBackupSettingsInput) =>
    invoke<BackupManagerState>('update_backup_settings', { input }),
  cleanupBackups: () => invoke<BackupCleanupResult>('cleanup_backups'),
  deleteAutomaticBackup: (backupId: string) =>
    invoke<void>('delete_automatic_backup', { backupId }),
  revealBackup: (backupId: string) => invoke<void>('reveal_backup', { backupId }),
  revealBackupDirectory: () => invoke<void>('reveal_backup_directory'),
  readPdf: (documentId: string) => invoke<ArrayBuffer>('read_pdf', { documentId }),
  revealPdfInFileManager: (documentId: string) =>
    invoke<void>('reveal_pdf_in_file_manager', { documentId }),
  createCardFromSelection: (input: CreateCardFromSelectionInput) =>
    invoke<string>('create_card_from_selection', { input }),
  createPdfAnnotation: (input: CreatePdfAnnotationInput) =>
    invoke<string>('create_pdf_annotation', { input }),
  updatePdfAnnotation: (input: UpdatePdfAnnotationInput) =>
    invoke<void>('update_pdf_annotation', { input }),
  deletePdfAnnotation: (annotationId: string) =>
    invoke<void>('delete_pdf_annotation', { annotationId }),
  createReadingNote: (input: CreateReadingNoteInput) =>
    invoke<string>('create_reading_note', { input }),
  updateReadingNote: (input: UpdateReadingNoteInput) =>
    invoke<void>('update_reading_note', { input }),
  deleteReadingNote: (noteId: string) =>
    invoke<void>('delete_reading_note', { noteId }),
  updateCard: (input: UpdateCardInput) => invoke<void>('update_card', { input }),
  batchUpdateCards: (input: BatchUpdateCardsInput) =>
    invoke<number>('batch_update_cards', { input }),
  createResearchRole: (input: CreateResearchRoleInput) =>
    invoke<string>('create_research_role', { input }),
  updateResearchRole: (input: UpdateResearchRoleInput) =>
    invoke<void>('update_research_role', { input }),
  setResearchRoleArchived: (researchRoleId: string, archived: boolean) =>
    invoke<void>('set_research_role_archived', { researchRoleId, archived }),
  reorderResearchRoles: (projectId: string, orderedIds: string[]) =>
    invoke<void>('reorder_research_roles', { projectId, orderedIds }),
  moveCard: (cardId: string, categoryId: string) =>
    invoke<void>('move_card', { cardId, categoryId }),
  setCardExcluded: (cardId: string, excluded: boolean) =>
    invoke<void>('set_card_excluded', { cardId, excluded }),
  deleteCard: (cardId: string) => invoke<void>('delete_card', { cardId }),
  createCategory: (input: CreateCategoryInput) =>
    invoke<string>('create_category', { input }),
  updateCategory: (input: UpdateCategoryInput) =>
    invoke<void>('update_category', { input }),
  deleteCategory: (categoryId: string) =>
    invoke<void>('delete_category', { categoryId }),
  reorderCategories: (projectId: string, orderedIds: string[]) =>
    invoke<void>('reorder_categories', { projectId, orderedIds }),
  createOutlineNode: (input: CreateOutlineNodeInput) =>
    invoke<string>('create_outline_node', { input }),
  updateOutlineNode: (input: UpdateOutlineNodeInput) =>
    invoke<void>('update_outline_node', { input }),
  moveOutlineNode: (input: MoveOutlineNodeInput) =>
    invoke<void>('move_outline_node', { input }),
  deleteOutlineNode: (nodeId: string) =>
    invoke<void>('delete_outline_node', { nodeId }),
  linkCardToOutline: (nodeId: string, cardId: string) =>
    invoke<string>('link_card_to_outline', { nodeId, cardId }),
  updateOutlineCardLink: (input: UpdateOutlineCardLinkInput) =>
    invoke<void>('update_outline_card_link', { input }),
  removeOutlineLink: (linkId: string) =>
    invoke<void>('remove_outline_link', { linkId }),
  moveOutlineCard: (linkId: string, direction: -1 | 1) =>
    invoke<void>('move_outline_card', { linkId, direction })
}
