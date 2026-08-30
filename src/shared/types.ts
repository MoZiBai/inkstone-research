export type CardRole = 'unset' | 'support' | 'oppose' | 'qualify' | 'background'
export type SynthesisState = 'active' | 'excluded'
export type OutlinePlacement = 'before' | 'inside' | 'after'
export type PdfAnnotationKind = 'highlight' | 'underline'
export type ReadingNoteKind = 'insight' | 'critique'

export interface ProjectSummary {
  id: string
  name: string
  description: string
  color: string
  sortOrder: number
  documentCount: number
  cardCount: number
  createdAt: string
  updatedAt: string
}

export interface DocumentSummary {
  id: string
  title: string
  authors: string
  year: number | null
  journal: string
  volume: string
  issue: string
  pages: string
  doi: string
  publisher: string
  metadataRaw: string
  isRemoved: boolean
  filePath: string | null
  fileHash: string | null
  fileAvailable: boolean
  sortOrder: number
  cardCount: number
  createdAt: string
  updatedAt: string
}

export interface SynthesisCategory {
  id: string
  projectId: string
  name: string
  color: string
  sortOrder: number
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface ProjectCardView {
  id: string
  projectId: string
  excerptId: string
  documentId: string
  documentTitle: string
  documentAuthors: string
  documentYear: number | null
  rawText: string
  cleanText: string
  displayText: string
  pdfPage: number | null
  printPage: string | null
  locatorJson: string
  contextBefore: string
  contextAfter: string
  sourceHash: string | null
  comment: string
  role: CardRole
  categoryId: string | null
  synthesisState: SynthesisState
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface PdfAnnotation {
  id: string
  projectId: string
  documentId: string
  kind: PdfAnnotationKind
  pageNumber: number
  color: string
  selectedText: string
  locatorJson: string
  comment: string
  createdAt: string
  updatedAt: string
}

export interface ReadingNote {
  id: string
  projectId: string
  documentId: string
  kind: ReadingNoteKind
  content: string
  selectedText: string
  pageNumber: number | null
  locatorJson: string
  createdAt: string
  updatedAt: string
}

export interface PdfRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfLocator {
  version?: number
  page: number
  coordinateSpace?: 'page-normalized'
  rects: PdfRect[]
}

export interface OutlineNode {
  id: string
  projectId: string
  parentId: string | null
  title: string
  notes: string
  coreArgument: string
  openQuestions: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface OutlineCardLink {
  id: string
  outlineNodeId: string
  projectCardId: string
  note: string
  sortOrder: number
  createdAt: string
}

export interface WorkspaceSnapshot {
  projects: ProjectSummary[]
  currentProjectId: string | null
  documents: DocumentSummary[]
  categories: SynthesisCategory[]
  cards: ProjectCardView[]
  pdfAnnotations: PdfAnnotation[]
  readingNotes: ReadingNote[]
  outlineNodes: OutlineNode[]
  outlineLinks: OutlineCardLink[]
}

export interface CreateProjectInput {
  name: string
  description?: string
  color?: string
}

export interface BibliographicMetadataInput {
  title: string
  authors?: string
  year?: number | null
  journal?: string
  volume?: string
  issue?: string
  pages?: string
  doi?: string
  publisher?: string
  metadataRaw?: string
}

export interface CreateDocumentInput extends BibliographicMetadataInput {
  projectId: string
}

export interface ImportPdfInput extends BibliographicMetadataInput {
  projectId: string
  sourcePath: string
  targetDocumentId?: string | null
}

export interface UpdateDocumentInput extends BibliographicMetadataInput {
  documentId: string
}

export interface RemoveDocumentInput {
  projectId: string
  documentId: string
  keepCards: boolean
}

export interface ImportPdfResult {
  documentId: string
  reusedManagedFile: boolean
  reusedDocument: boolean
  relinkedDocument: boolean
  hashChanged: boolean
}

export interface DatabaseImportResult {
  safetyBackupPath: string
  missingPdfCount: number
}

export interface CreateCardFromSelectionInput {
  projectId: string
  documentId: string
  rawText: string
  displayText: string
  pdfPage: number
  printPage?: string | null
  locatorJson: string
  contextBefore?: string
  contextAfter?: string
  comment?: string
  role: CardRole
  tags?: string[]
}

export interface CreatePdfAnnotationInput {
  projectId: string
  documentId: string
  kind: PdfAnnotationKind
  pageNumber: number
  color: string
  selectedText?: string
  locatorJson: string
  comment?: string
}

export interface CreateReadingNoteInput {
  projectId: string
  documentId: string
  kind: ReadingNoteKind
  content: string
  selectedText?: string
  pageNumber?: number | null
  locatorJson?: string
}

export interface UpdateCardInput {
  cardId: string
  comment: string
  role: CardRole
  tags: string[]
}

export interface CreateCategoryInput {
  projectId: string
  name: string
  color: string
}

export interface UpdateCategoryInput {
  categoryId: string
  name: string
  color: string
}

export interface CreateOutlineNodeInput {
  projectId: string
  parentId?: string | null
  title: string
}

export interface UpdateOutlineNodeInput {
  nodeId: string
  title: string
  notes: string
  coreArgument: string
  openQuestions: string
}

export interface MoveOutlineNodeInput {
  nodeId: string
  targetNodeId: string
  placement: OutlinePlacement
}

export interface InkstoneApi {
  getWorkspace: (projectId?: string) => Promise<WorkspaceSnapshot>
  createProject: (input: CreateProjectInput) => Promise<string>
  createDocument: (input: CreateDocumentInput) => Promise<string>
  updateDocument: (input: UpdateDocumentInput) => Promise<void>
  removeDocument: (input: RemoveDocumentInput) => Promise<void>
  restoreDocument: (projectId: string, documentId: string) => Promise<void>
  importPdf: (input: ImportPdfInput) => Promise<ImportPdfResult>
  exportDatabase: (destinationPath: string) => Promise<string>
  importDatabase: (sourcePath: string) => Promise<DatabaseImportResult>
  readPdf: (documentId: string) => Promise<ArrayBuffer>
  revealPdfInFileManager: (documentId: string) => Promise<void>
  createCardFromSelection: (input: CreateCardFromSelectionInput) => Promise<string>
  createPdfAnnotation: (input: CreatePdfAnnotationInput) => Promise<string>
  deletePdfAnnotation: (annotationId: string) => Promise<void>
  createReadingNote: (input: CreateReadingNoteInput) => Promise<string>
  deleteReadingNote: (noteId: string) => Promise<void>
  updateCard: (input: UpdateCardInput) => Promise<void>
  moveCard: (cardId: string, categoryId: string) => Promise<void>
  setCardExcluded: (cardId: string, excluded: boolean) => Promise<void>
  deleteCard: (cardId: string) => Promise<void>
  createCategory: (input: CreateCategoryInput) => Promise<string>
  updateCategory: (input: UpdateCategoryInput) => Promise<void>
  deleteCategory: (categoryId: string) => Promise<void>
  reorderCategories: (projectId: string, orderedIds: string[]) => Promise<void>
  createOutlineNode: (input: CreateOutlineNodeInput) => Promise<string>
  updateOutlineNode: (input: UpdateOutlineNodeInput) => Promise<void>
  moveOutlineNode: (input: MoveOutlineNodeInput) => Promise<void>
  deleteOutlineNode: (nodeId: string) => Promise<void>
  linkCardToOutline: (nodeId: string, cardId: string) => Promise<string>
  removeOutlineLink: (linkId: string) => Promise<void>
  moveOutlineCard: (linkId: string, direction: -1 | 1) => Promise<void>
}
