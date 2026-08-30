import { invoke } from '@tauri-apps/api/core'
import type {
  CreateCategoryInput,
  CreateCardFromSelectionInput,
  CreateDocumentInput,
  CreateOutlineNodeInput,
  CreatePdfAnnotationInput,
  CreateProjectInput,
  CreateReadingNoteInput,
  DatabaseImportResult,
  ImportPdfInput,
  ImportPdfResult,
  InkstoneApi,
  MoveOutlineNodeInput,
  RemoveDocumentInput,
  UpdateCardInput,
  UpdateCategoryInput,
  UpdateDocumentInput,
  UpdateOutlineNodeInput,
  WorkspaceSnapshot
} from '@shared/types'

export const api: InkstoneApi = {
  getWorkspace: (projectId?: string) =>
    invoke<WorkspaceSnapshot>('get_workspace', { projectId }),
  createProject: (input: CreateProjectInput) =>
    invoke<string>('create_project', { input }),
  createDocument: (input: CreateDocumentInput) =>
    invoke<string>('create_document', { input }),
  updateDocument: (input: UpdateDocumentInput) =>
    invoke<void>('update_document', { input }),
  removeDocument: (input: RemoveDocumentInput) =>
    invoke<void>('remove_document', { input }),
  restoreDocument: (projectId: string, documentId: string) =>
    invoke<void>('restore_document', { projectId, documentId }),
  importPdf: (input: ImportPdfInput) =>
    invoke<ImportPdfResult>('import_pdf', { input }),
  exportDatabase: (destinationPath: string) =>
    invoke<string>('export_database', { destinationPath }),
  importDatabase: (sourcePath: string) =>
    invoke<DatabaseImportResult>('import_database', { sourcePath }),
  readPdf: (documentId: string) => invoke<ArrayBuffer>('read_pdf', { documentId }),
  revealPdfInFileManager: (documentId: string) =>
    invoke<void>('reveal_pdf_in_file_manager', { documentId }),
  createCardFromSelection: (input: CreateCardFromSelectionInput) =>
    invoke<string>('create_card_from_selection', { input }),
  createPdfAnnotation: (input: CreatePdfAnnotationInput) =>
    invoke<string>('create_pdf_annotation', { input }),
  deletePdfAnnotation: (annotationId: string) =>
    invoke<void>('delete_pdf_annotation', { annotationId }),
  createReadingNote: (input: CreateReadingNoteInput) =>
    invoke<string>('create_reading_note', { input }),
  deleteReadingNote: (noteId: string) =>
    invoke<void>('delete_reading_note', { noteId }),
  updateCard: (input: UpdateCardInput) => invoke<void>('update_card', { input }),
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
  removeOutlineLink: (linkId: string) =>
    invoke<void>('remove_outline_link', { linkId }),
  moveOutlineCard: (linkId: string, direction: -1 | 1) =>
    invoke<void>('move_outline_card', { linkId, direction })
}
