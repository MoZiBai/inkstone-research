import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleX,
  FilePlus2,
  FilePenLine,
  FileText,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Highlighter,
  Library,
  Lightbulb,
  Link2,
  LoaderCircle,
  MessageCircleQuestion,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Search,
  Trash2,
  Underline
} from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BibliographicMetadataInput,
  DocumentGroup,
  DocumentSummary,
  ImportPdfResult,
  PdfAnnotation,
  PdfAnnotationKind,
  PdfLocator,
  ReadingNote,
  ReadingNoteKind,
  WorkspaceSnapshot
} from '@shared/types'
import { EmptyState } from '../../components/EmptyState'
import { ContextMenu } from '../../components/ContextMenu'
import { ConfirmDialog, Modal } from '../../components/Modal'
import { api } from '../../lib/api'
import { usePersistentState, usePersistentSet } from '../../lib/preferences'
import { readReadingProgress } from './readingProgress'
import { TagInput } from '../../components/TagInput'
import { parseTags } from '../../lib/tags'
import { CardText } from '../../components/CardText'
import {
  filterAndSortDocuments,
  titleFromPdfPath,
  type DocumentFilter,
  type DocumentSort
} from '../../lib/workspaceEfficiency'
import type { Notify, RunMutation } from '../../types'
import {
  fillBibliographyFromRaw,
  mergeParsedBibliography,
  parseBibliography,
  type ParsedBibliography
} from './bibliographyParser'
import { titleAfterPdfSelection } from './pdfImportDraft'
import { parsePdfLocator, type PdfSelection } from './pdfLocator'
import { partitionItemsByPage } from './readingPageItems'
import {
  buildDocumentGroupTree,
  countDocumentsInGroup,
  descendantDocumentGroupIds,
  flattenDocumentGroups,
  type DocumentGroupTreeNode
} from './documentGroups'
import { selectionFromReadingNote } from './readingNoteCardDraft'
import {
  adjustReadingPanel,
  DEFAULT_READING_PANEL_WIDTHS,
  fitReadingPanelWidths,
  normalizeReadingPanelWidths,
  READING_PANEL_LIMITS,
  resizeReadingPanel,
  type ReadingPanel,
  type ReadingPanelWidths
} from './readingLayout'

const PdfViewer = lazy(async () => ({ default: (await import('./PdfViewer')).PdfViewer }))

export interface ReadingFocusRequest {
  token: number
  documentId: string
  page: number | null
  locator: PdfLocator | null
}

interface ReadingViewProps {
  snapshot: WorkspaceSnapshot
  isActive: boolean
  runMutation: RunMutation
  notify: Notify
  initialRequest?: ReadingFocusRequest | null
  onFocusHandled?: () => void
  onSelectedDocumentChange?: (documentId: string | null) => void
}

interface MetadataDraft {
  title: string
  authors: string
  year: string
  journal: string
  volume: string
  issue: string
  pages: string
  doi: string
  publisher: string
  metadataRaw: string
}

interface PdfImportAttempt {
  path: string
  title: string
  status: 'success' | 'error'
  documentId: string | null
  message: string
}

const EMPTY_METADATA: MetadataDraft = {
  title: '',
  authors: '',
  year: '',
  journal: '',
  volume: '',
  issue: '',
  pages: '',
  doi: '',
  publisher: '',
  metadataRaw: ''
}

const READING_PANEL_STORAGE_KEY = 'inkstone:reading-panel-widths:v1'
const UNCLASSIFIED_GROUP_KEY = '__unclassified__'
type ReadingInspectorSection = 'document' | 'notes' | 'cards' | 'annotations'

export function ReadingView({
  snapshot,
  isActive,
  runMutation,
  notify,
  initialRequest,
  onFocusHandled,
  onSelectedDocumentChange
}: ReadingViewProps): React.JSX.Element {
  const [selectedDocumentId, setSelectedDocumentId] = usePersistentState<string>(`inkstone:reading-document:${snapshot.currentProjectId}`,
    initialRequest?.documentId ?? snapshot.documents.find((document) => !document.isRemoved)?.id ?? ''
  )
  const [showDocumentDialog, setShowDocumentDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importTargetDocumentId, setImportTargetDocumentId] = useState<string | null>(null)
  const [importSourcePaths, setImportSourcePaths] = useState<string[]>([])
  const [pdfImportAttempts, setPdfImportAttempts] = useState<PdfImportAttempt[]>([])
  const [importingPdfs, setImportingPdfs] = useState(false)
  const [metadata, setMetadata] = useState<MetadataDraft>(EMPTY_METADATA)
  const [pendingCard, setPendingCard] = useState<{
    selection: PdfSelection
    initialComment: string
    sourceReadingNoteId: string | null
  } | null>(null)
  const [editingDocument, setEditingDocument] = useState<DocumentSummary | null>(null)
  const [removingDocument, setRemovingDocument] = useState<DocumentSummary | null>(null)
  const [showRemovedDocuments, setShowRemovedDocuments] = useState(false)
  const [pendingNote, setPendingNote] = useState<{
    kind: ReadingNoteKind
    selection: PdfSelection | null
  } | null>(null)
  const [deletingNote, setDeletingNote] = useState<ReadingNote | null>(null)
  const [editingNote, setEditingNote] = useState<ReadingNote | null>(null)
  const [focusRequest, setFocusRequest] = useState<ReadingFocusRequest | null>(initialRequest ?? null)
  const [deletingAnnotation, setDeletingAnnotation] = useState<PdfAnnotation | null>(null)
  const [editingAnnotation, setEditingAnnotation] = useState<PdfAnnotation | null>(null)
  const [currentPdfPage, setCurrentPdfPage] = useState(1)
  const [inspectorScope, setInspectorScope] = usePersistentState<'page' | 'all'>(`inkstone:inspector-scope:${snapshot.currentProjectId}`, 'page')
  const [inspectorCollapsed, setInspectorCollapsed] = usePersistentState(`inkstone:inspector-hidden:${snapshot.currentProjectId}`, false)
  const [inspectorLimit, setInspectorLimit] = useState(30)
  useEffect(() => setInspectorLimit(30), [selectedDocumentId, inspectorScope])
  useEffect(() => { if (inspectorScope === 'page') setInspectorLimit(30) }, [currentPdfPage, inspectorScope])
  const [collapsedInspectorSections, setCollapsedInspectorSections] = usePersistentSet<ReadingInspectorSection>(`inkstone:reading-sections:${snapshot.currentProjectId}`, ['document'])
  const [panelWidths, setPanelWidths] = useState<ReadingPanelWidths>(loadReadingPanelWidths)
  const [resizingPanel, setResizingPanel] = useState<ReadingPanel | null>(null)
  const [documentQuery, setDocumentQuery] = usePersistentState(`inkstone:document-query:${snapshot.currentProjectId}`, '')
  const [documentFilter, setDocumentFilter] = usePersistentState<DocumentFilter>(`inkstone:document-filter:${snapshot.currentProjectId}`, 'all')
  const [documentSort, setDocumentSort] = usePersistentState<DocumentSort>(`inkstone:document-sort:${snapshot.currentProjectId}`, 'updated')
  const [documentRailCollapsed, setDocumentRailCollapsed] = usePersistentState(`inkstone:document-rail:${snapshot.currentProjectId}`, false)
  const [documentContextMenu, setDocumentContextMenu] = useState<{
    x: number
    y: number
    document: DocumentSummary
  } | null>(null)
  const [documentGroupContextMenu, setDocumentGroupContextMenu] = useState<{
    x: number
    y: number
    group: DocumentGroup
  } | null>(null)
  const [collapsedDocumentGroupIds, setCollapsedDocumentGroupIds] = usePersistentSet<string>(`inkstone:document-groups:${snapshot.currentProjectId}`)
  const [editingDocumentGroup, setEditingDocumentGroup] = useState<{
    group: DocumentGroup | null
    parentId: string | null
  } | null>(null)
  const [deletingDocumentGroup, setDeletingDocumentGroup] = useState<DocumentGroup | null>(null)
  const [assigningDocument, setAssigningDocument] = useState<DocumentSummary | null>(null)
  const deferredDocumentQuery = useDeferredValue(documentQuery)
  const focusCounter = useRef(0)
  const readingLayoutRef = useRef<HTMLDivElement>(null)

  const selectedDocument = useMemo(
    () => snapshot.documents.find((document) => document.id === selectedDocumentId) ?? null,
    [selectedDocumentId, snapshot.documents]
  )
  const selectedDocumentGroup = useMemo(
    () => snapshot.documentGroups.find((group) => group.id === selectedDocument?.groupId) ?? null,
    [selectedDocument?.groupId, snapshot.documentGroups]
  )
  const documentCards = useMemo(
    () => snapshot.cards.filter((card) => card.documentId === selectedDocument?.id),
    [selectedDocument?.id, snapshot.cards]
  )
  const documentAnnotations = useMemo(
    () => snapshot.pdfAnnotations.filter((annotation) => annotation.documentId === selectedDocument?.id),
    [selectedDocument?.id, snapshot.pdfAnnotations]
  )
  const documentNotes = useMemo(
    () => snapshot.readingNotes.filter((note) => note.documentId === selectedDocument?.id),
    [selectedDocument?.id, snapshot.readingNotes]
  )
  const cardPagePartition = useMemo(
    () => partitionItemsByPage(documentCards, currentPdfPage, (card) => card.pdfPage),
    [currentPdfPage, documentCards]
  )
  const annotationPagePartition = useMemo(
    () =>
      partitionItemsByPage(
        documentAnnotations,
        currentPdfPage,
        (annotation) => annotation.pageNumber
      ),
    [currentPdfPage, documentAnnotations]
  )
  const visibleNotes = useMemo(() => documentNotes.filter((note) => inspectorScope === 'all' || note.pageNumber === null || note.pageNumber === currentPdfPage), [documentNotes, currentPdfPage, inspectorScope])
  const allActiveDocuments = useMemo(
    () => snapshot.documents.filter((document) => !document.isRemoved),
    [snapshot.documents]
  )
  const activeDocuments = useMemo(
    () => filterAndSortDocuments(allActiveDocuments, deferredDocumentQuery, documentFilter, documentSort),
    [allActiveDocuments, deferredDocumentQuery, documentFilter, documentSort]
  )
  const removedDocuments = useMemo(
    () => filterAndSortDocuments(
      snapshot.documents.filter((document) => document.isRemoved),
      deferredDocumentQuery,
      documentFilter,
      documentSort
    ),
    [deferredDocumentQuery, documentFilter, documentSort, snapshot.documents]
  )
  const documentGroupingIsFiltered = Boolean(deferredDocumentQuery) || documentFilter !== 'all'
  const documentGroupTree = useMemo(
    () => buildDocumentGroupTree(
      snapshot.documentGroups,
      activeDocuments,
      !documentGroupingIsFiltered
    ),
    [activeDocuments, documentGroupingIsFiltered, snapshot.documentGroups]
  )
  const flatDocumentGroups = useMemo(
    () => flattenDocumentGroups(buildDocumentGroupTree(snapshot.documentGroups, []).roots),
    [snapshot.documentGroups]
  )

  useEffect(() => {
    if (initialRequest) {
      setSelectedDocumentId(initialRequest.documentId)
      setFocusRequest(initialRequest)
    }
    return undefined
  }, [initialRequest, onFocusHandled])

  const completeFocusRequest = useCallback((): void => {
    setFocusRequest(null)
    onFocusHandled?.()
  }, [onFocusHandled])
  useEffect(() => {
    if (selectedDocument && focusRequest?.documentId === selectedDocument.id && !selectedDocument.fileAvailable) completeFocusRequest()
  }, [focusRequest, selectedDocument, completeFocusRequest])

  useEffect(() => {
    if (snapshot.documents.some((document) => document.id === selectedDocumentId)) return
    setSelectedDocumentId(allActiveDocuments[0]?.id ?? '')
  }, [allActiveDocuments, selectedDocumentId, snapshot.currentProjectId, snapshot.documents])

  useEffect(() => setCurrentPdfPage(selectedDocument ? readReadingProgress(selectedDocument.id).page : 1), [selectedDocument?.id])

  useEffect(() => {
    onSelectedDocumentChange?.(selectedDocument?.id ?? null)
  }, [onSelectedDocumentChange, selectedDocument?.id])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(READING_PANEL_STORAGE_KEY, JSON.stringify(panelWidths))
      } catch {
        // Layout persistence is optional; resizing still works when storage is unavailable.
      }
    }, 180)
    return () => window.clearTimeout(timeout)
  }, [panelWidths])

  useEffect(() => {
    const layout = readingLayoutRef.current
    if (!layout || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (!width) return
      setPanelWidths((current) => {
        const next = fitReadingPanelWidths(current, width)
        return next.documents === current.documents && next.inspector === current.inspector
          ? current
          : next
      })
    })
    observer.observe(layout)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!resizingPanel) return undefined
    document.body.classList.add('reading-panel-resizing')
    const move = (event: PointerEvent): void => {
      const bounds = readingLayoutRef.current?.getBoundingClientRect()
      if (!bounds) return
      setPanelWidths((current) => resizeReadingPanel(current, resizingPanel, event.clientX, bounds))
    }
    const stop = (): void => setResizingPanel(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
    return () => {
      document.body.classList.remove('reading-panel-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [resizingPanel])

  const adjustPanelWidth = (panel: ReadingPanel, delta: number): void => {
    const layoutWidth = readingLayoutRef.current?.getBoundingClientRect().width ?? window.innerWidth
    setPanelWidths((current) => adjustReadingPanel(current, panel, delta, layoutWidth))
  }

  const resetPanelWidth = (panel: ReadingPanel): void => {
    const layoutWidth = readingLayoutRef.current?.getBoundingClientRect().width ?? window.innerWidth
    setPanelWidths((current) =>
      fitReadingPanelWidths(
        { ...current, [panel]: DEFAULT_READING_PANEL_WIDTHS[panel] },
        layoutWidth
      )
    )
  }

  const toggleInspectorSection = (section: ReadingInspectorSection): void => {
    setCollapsedInspectorSections((current) => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  const toggleDocumentGroup = (groupId: string): void => {
    setCollapsedDocumentGroupIds((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  const saveDocumentGroup = async (name: string, parentId: string | null): Promise<void> => {
    if (!snapshot.currentProjectId || !editingDocumentGroup) return
    const succeeded = editingDocumentGroup.group
      ? await runMutation(
          () => api.updateDocumentGroup({
            groupId: editingDocumentGroup.group?.id as string,
            parentId,
            name
          }),
          '文献分类已更新。'
        )
      : await runMutation(
          () => api.createDocumentGroup({
            projectId: snapshot.currentProjectId as string,
            parentId,
            name
          }),
          '文献分类已创建。'
        )
    if (succeeded) setEditingDocumentGroup(null)
  }

  const deleteSelectedDocumentGroup = async (): Promise<void> => {
    if (!deletingDocumentGroup) return
    const succeeded = await runMutation(
      () => api.deleteDocumentGroup(deletingDocumentGroup.id),
      '文献分类已移除；分类内文献已回到“未分类”。'
    )
    if (succeeded) setDeletingDocumentGroup(null)
  }

  const assignDocumentGroup = async (groupId: string | null): Promise<void> => {
    if (!assigningDocument || !snapshot.currentProjectId) return
    const succeeded = await runMutation(
      () => api.moveDocumentToGroup({
        projectId: snapshot.currentProjectId as string,
        documentId: assigningDocument.id,
        groupId
      }),
      groupId ? '文献分类已更新。' : '文献已移到“未分类”。'
    )
    if (succeeded) setAssigningDocument(null)
  }

  const nextFocusToken = (): number => {
    focusCounter.current += 1
    return focusCounter.current
  }

  const focusDocumentLocation = (
    documentId: string,
    page: number | null,
    locatorJson: string
  ): void => {
    setSelectedDocumentId(documentId)
    setFocusRequest({
      token: nextFocusToken(),
      documentId,
      page,
      locator: page ? parsePdfLocator(locatorJson, page) : null
    })
  }

  const beginImport = (targetDocument?: DocumentSummary): void => {
    const target = targetDocument ?? null
    setImportTargetDocumentId(target?.id ?? null)
    setImportSourcePaths([])
    setPdfImportAttempts([])
    setMetadata(target ? metadataFromDocument(target) : { ...EMPTY_METADATA })
    setShowImportDialog(true)
  }

  const beginCreateDocument = (): void => {
    setMetadata({ ...EMPTY_METADATA })
    setShowDocumentDialog(true)
  }

  const choosePdf = async (): Promise<void> => {
    try {
      const selected = await open({
        title: '选择要导入的 PDF',
        multiple: importTargetDocumentId === null,
        directory: false,
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
      })
      const paths = typeof selected === 'string' ? [selected] : selected
      if (!paths || paths.length === 0) return
      setImportSourcePaths(paths)
      setPdfImportAttempts([])
      if (paths.length === 1) {
        setMetadata((current) => ({
          ...current,
          title: titleAfterPdfSelection(paths[0] as string, importTargetDocumentId, current.title)
        }))
      }
    } catch (error) {
      notify(normalizeError(error), 'error')
    }
  }

  const importPdf = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!snapshot.currentProjectId || importSourcePaths.length === 0) {
      notify('请先选择一个 PDF 文件。', 'warning')
      return
    }
    if (importSourcePaths.length > 1 && !importTargetDocumentId) {
      const attempts: PdfImportAttempt[] = []
      setImportingPdfs(true)
      const succeeded = await runMutation(
        async () => {
          for (const path of importSourcePaths) {
            const title = titleFromPdfPath(path)
            try {
              const result = await api.importPdf({
                projectId: snapshot.currentProjectId as string,
                sourcePath: path,
                targetDocumentId: null,
                title
              })
              attempts.push({
                path,
                title,
                status: 'success',
                documentId: result.documentId,
                message: result.reusedDocument ? '已关联现有文献' : '导入成功'
              })
            } catch (error) {
              attempts.push({
                path,
                title,
                status: 'error',
                documentId: null,
                message: normalizeError(error)
              })
            }
            setPdfImportAttempts([...attempts])
          }
        },
        `已处理 ${importSourcePaths.length} 份 PDF。`
      )
      setImportingPdfs(false)
      if (!succeeded) return
      const successfulAttempts = attempts.filter((attempt) => attempt.status === 'success')
      if (successfulAttempts[0]?.documentId) setSelectedDocumentId(successfulAttempts[0].documentId)
      const failedCount = attempts.length - successfulAttempts.length
      if (failedCount > 0) {
        notify(`批量导入完成：${successfulAttempts.length} 份成功，${failedCount} 份失败。`, 'warning')
      }
      return
    }
    const importSourcePath = importSourcePaths[0] as string
    const targetDocument = snapshot.documents.find(
      (document) => document.id === importTargetDocumentId
    )
    const relinkingMissingPdf = Boolean(
      targetDocument?.filePath && !targetDocument.fileAvailable
    )
    const resultHolder: { value: ImportPdfResult | null } = { value: null }
    const succeeded = await runMutation(
      async () => {
        resultHolder.value = await api.importPdf({
          projectId: snapshot.currentProjectId as string,
          sourcePath: importSourcePath,
          targetDocumentId: importTargetDocumentId,
          ...metadataInput(metadata)
        })
      },
      relinkingMissingPdf ? 'PDF 已重新链接，原有研究数据保持不变。' : 'PDF 已导入本地文献库。'
    )
    const result = resultHolder.value
    if (succeeded && result) {
      setSelectedDocumentId(result.documentId)
      setShowImportDialog(false)
      setImportSourcePaths([])
      if (result.hashChanged) {
        notify('重新链接的 PDF 与原文件哈希不同；卡片和标注定位已保留，请抽查原文位置。', 'warning')
      }
    }
  }

  const createDocument = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!snapshot.currentProjectId) return
    const succeeded = await runMutation(
      () =>
        api.createDocument({
          projectId: snapshot.currentProjectId as string,
          ...metadataInput(metadata)
        }),
      '文献记录已保存。'
    )
    if (succeeded) {
      setMetadata({ ...EMPTY_METADATA })
      setShowDocumentDialog(false)
    }
  }

  const beginEditDocument = (document: DocumentSummary): void => {
    setMetadata(metadataFromDocument(document))
    setEditingDocument(document)
  }

  const saveDocumentMetadata = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!editingDocument) return
    const succeeded = await runMutation(
      () =>
        api.updateDocument({
          documentId: editingDocument.id,
          ...metadataInput(metadata)
        }),
      '文献书目信息已更新。'
    )
    if (succeeded) setEditingDocument(null)
  }

  const saveDocumentPrintPageMapping = async (
    pdfPageAnchor: number | null,
    printPageAnchor: number | null
  ): Promise<boolean> => {
    if (!selectedDocument) return false
    return runMutation(
      () => api.updateDocumentPrintPageMapping({
        documentId: selectedDocument.id,
        pdfPageAnchor,
        printPageAnchor
      }),
      pdfPageAnchor === null ? '文献印刷页映射已清除。' : '文献印刷页映射已保存。'
    )
  }

  const revealDocument = async (document: DocumentSummary | null = selectedDocument): Promise<void> => {
    if (!document?.filePath) return
    try {
      await api.revealPdfInFileManager(document.id)
      notify('已在文件资源管理器中选中砚台管理的 PDF 副本。')
    } catch (error) {
      notify(normalizeError(error), 'error')
    }
  }

  const removeDocument = async (keepCards: boolean): Promise<void> => {
    if (!removingDocument || !snapshot.currentProjectId) return
    const succeeded = await runMutation(
      () =>
        api.removeDocument({
          projectId: snapshot.currentProjectId as string,
          documentId: removingDocument.id,
          keepCards
        }),
      keepCards
        ? '文献已移入“已移除来源”；卡片和回原文能力均已保留。'
        : '文献及其在当前项目中的卡片、批注和阅读笔记已删除。'
    )
    if (succeeded) {
      setRemovingDocument(null)
      if (!keepCards) setSelectedDocumentId(allActiveDocuments.find((document) => document.id !== removingDocument.id)?.id ?? '')
    }
  }

  const restoreDocument = async (document: DocumentSummary): Promise<void> => {
    if (!snapshot.currentProjectId) return
    const succeeded = await runMutation(
      () => api.restoreDocument(snapshot.currentProjectId as string, document.id),
      '文献已恢复到阅读列表。'
    )
    if (succeeded) setSelectedDocumentId(document.id)
  }

  const saveReadingNote = async (content: string): Promise<void> => {
    if (!pendingNote || !snapshot.currentProjectId || !selectedDocument) return
    const selection = pendingNote.selection
    const succeeded = await runMutation(
      () =>
        api.createReadingNote({
          projectId: snapshot.currentProjectId as string,
          documentId: selectedDocument.id,
          kind: pendingNote.kind,
          content,
          selectedText: selection?.text ?? '',
          pageNumber: selection?.pageNumber ?? null,
          locatorJson: selection ? JSON.stringify(selection.locator) : ''
        }),
      pendingNote.kind === 'insight' ? '灵感笔记已保存。' : '质疑笔记已保存。'
    )
    if (succeeded) setPendingNote(null)
  }

  const removeReadingNote = async (): Promise<void> => {
    if (!deletingNote) return
    const succeeded = await runMutation(
      () => api.deleteReadingNote(deletingNote.id),
      '阅读笔记已删除。'
    )
    if (succeeded) setDeletingNote(null)
  }

  const updateReadingNote = async (content: string): Promise<void> => {
    if (!editingNote) return
    const succeeded = await runMutation(
      () => api.updateReadingNote({ noteId: editingNote.id, content }),
      `${editingNote.kind === 'insight' ? '灵感' : '质疑'}笔记已更新。`
    )
    if (succeeded) setEditingNote(null)
  }

  const createCard = async (selection: PdfSelection): Promise<void> => {
    if (!snapshot.currentProjectId || !selectedDocument) return
    setPendingCard({ selection, initialComment: '', sourceReadingNoteId: null })
  }

  const createCardFromReadingNote = (note: ReadingNote): void => {
    const selection = selectionFromReadingNote(note)
    if (!selection) return
    setPendingCard({ selection, initialComment: note.content, sourceReadingNoteId: note.id })
  }

  const saveCardFromSelection = async (input: {
    displayText: string
    comment: string
    tags: string[]
  }): Promise<void> => {
    if (!pendingCard || !snapshot.currentProjectId || !selectedDocument) return
    const selection = pendingCard.selection
    const succeeded = await runMutation(
      () =>
        api.createCardFromSelection({
          projectId: snapshot.currentProjectId as string,
          documentId: selectedDocument.id,
          rawText: selection.text,
          displayText: input.displayText,
          pdfPage: selection.pageNumber,
          locatorJson: JSON.stringify(selection.locator),
          contextBefore: selection.contextBefore,
          contextAfter: selection.contextAfter,
          comment: input.comment,
          tags: input.tags,
          sourceReadingNoteId: pendingCard.sourceReadingNoteId
        }),
      pendingCard.sourceReadingNoteId
        ? '阅读笔记已转为阅读卡片并从笔记列表移除。'
        : '阅读卡片和对应高亮已创建，并放入“待归类”。'
    )
    if (succeeded) setPendingCard(null)
  }

  const createAnnotation = async (
    selection: PdfSelection,
    kind: PdfAnnotationKind,
    color: string
  ): Promise<void> => {
    if (!snapshot.currentProjectId || !selectedDocument) return
    await runMutation(
      () =>
        api.createPdfAnnotation({
          projectId: snapshot.currentProjectId as string,
          documentId: selectedDocument.id,
          kind,
          pageNumber: selection.pageNumber,
          color,
          selectedText: selection.text,
          locatorJson: JSON.stringify(selection.locator)
        }),
      kind === 'highlight' ? '高亮已保存到本地。' : '下划线已保存到本地。'
    )
  }

  const removeAnnotation = async (): Promise<void> => {
    if (!deletingAnnotation) return
    const succeeded = await runMutation(
      () => api.deletePdfAnnotation(deletingAnnotation.id),
      'PDF 批注已移除。'
    )
    if (succeeded) setDeletingAnnotation(null)
  }

  const updateAnnotationRecord = async (
    annotation: PdfAnnotation,
    color: string,
    comment: string
  ): Promise<boolean> => runMutation(
    () => api.updatePdfAnnotation({ annotationId: annotation.id, color, comment }),
    'PDF 批注已更新。'
  )

  const updateAnnotation = async (color: string, comment: string): Promise<void> => {
    if (!editingAnnotation) return
    const succeeded = await updateAnnotationRecord(editingAnnotation, color, comment)
    if (succeeded) setEditingAnnotation(null)
  }

  const renderDocumentItem = (document: DocumentSummary): React.JSX.Element => (
    <button
      className={`document-item ${selectedDocument?.id === document.id ? 'active' : ''}`}
      type="button"
      key={document.id}
      onClick={() => setSelectedDocumentId(document.id)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setDocumentContextMenu({ x: event.clientX, y: event.clientY, document })
      }}
    >
      <span className="document-symbol">
        <BookOpen size={15} />
      </span>
      <span className="document-copy">
        <strong>{document.title}</strong>
        <small>
          {document.authors || '未知作者'}
          {document.year ? ` · ${document.year}` : ''}
        </small>
        <em>
          {document.fileAvailable ? 'PDF 可用' : document.filePath ? 'PDF 缺失' : '尚未连接 PDF'} · {document.cardCount} 张卡片
        </em>
      </span>
    </button>
  )

  return (
    <div
      data-operation-busy={importingPdfs ? 'true' : undefined}
      className={`reading-layout ${resizingPanel ? 'resizing' : ''} ${documentRailCollapsed ? 'document-rail-collapsed' : ''} ${inspectorCollapsed ? 'inspector-hidden' : ''}`}
      ref={readingLayoutRef}
      style={
        {
          '--document-rail-width': `${documentRailCollapsed ? 48 : panelWidths.documents}px`,
          '--reading-inspector-width': `${inspectorCollapsed ? 0 : panelWidths.inspector}px`
        } as React.CSSProperties
      }
    >
      <aside className="document-rail">
        <div className="panel-heading compact">
          <div>
            <span className="eyebrow">项目文献</span>
            <h2>{allActiveDocuments.length} 篇文献</h2>
          </div>
          <div className="document-rail-actions">
            <button
              className="icon-button document-rail-collapse"
              type="button"
              onClick={() => setDocumentRailCollapsed((current) => !current)}
              aria-label={documentRailCollapsed ? '展开项目文献' : '收起项目文献'}
              title={documentRailCollapsed ? '展开项目文献' : '收起项目文献'}
            >
              {documentRailCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => setEditingDocumentGroup({ group: null, parentId: null })}
              aria-label="新建文献分类"
              title="新建文献分类"
            >
              <FolderPlus size={15} />
            </button>
            <button
              className="icon-button warm"
              type="button"
              onClick={() => beginImport()}
              aria-label="导入 PDF"
              title="导入 PDF"
            >
              <FilePlus2 size={16} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={beginCreateDocument}
              aria-label="新增文献记录"
              title="新增文献记录"
            >
              <FileText size={15} />
            </button>
          </div>
        </div>
        <div className="document-list-tools">
          <label className="document-search-box">
            <Search size={14} />
            <input
              value={documentQuery}
              onChange={(event) => setDocumentQuery(event.target.value)}
              placeholder="搜索标题、作者、期刊或 DOI"
              aria-label="搜索项目文献"
            />
            <span>{activeDocuments.length}</span>
          </label>
          <div>
            <select
              value={documentFilter}
              onChange={(event) => setDocumentFilter(event.target.value as DocumentFilter)}
              aria-label="筛选文献文件状态"
            >
              <option value="all">全部状态</option>
              <option value="available">PDF 可用</option>
              <option value="unlinked">尚未连接</option>
              <option value="missing">PDF 缺失</option>
            </select>
            <select
              value={documentSort}
              onChange={(event) => setDocumentSort(event.target.value as DocumentSort)}
              aria-label="文献排序"
            >
              <option value="updated">最近更新</option>
              <option value="title">标题</option>
              <option value="authors">作者</option>
              <option value="year">年份</option>
              <option value="cards">卡片数</option>
            </select>
          </div>
        </div>
        <div className="document-list">
          {documentGroupTree.roots.map((node) => (
            <DocumentGroupBranch
              key={node.group.id}
              node={node}
              depth={0}
              forceExpanded={documentGroupingIsFiltered}
              collapsedIds={collapsedDocumentGroupIds}
              onToggle={toggleDocumentGroup}
              onContextMenu={(event, group) => {
                event.preventDefault()
                event.stopPropagation()
                setDocumentGroupContextMenu({ x: event.clientX, y: event.clientY, group })
              }}
              renderDocument={renderDocumentItem}
            />
          ))}
          {documentGroupTree.unclassified.length > 0 ? (
            <section className="document-group-branch unclassified">
              <button
                className="document-group-row"
                type="button"
                aria-expanded={documentGroupingIsFiltered || !collapsedDocumentGroupIds.has(UNCLASSIFIED_GROUP_KEY)}
                onClick={() => toggleDocumentGroup(UNCLASSIFIED_GROUP_KEY)}
              >
                {documentGroupingIsFiltered || !collapsedDocumentGroupIds.has(UNCLASSIFIED_GROUP_KEY)
                  ? <ChevronDown size={14} />
                  : <ChevronRight size={14} />}
                <FolderTree size={14} />
                <span>未分类</span>
                <small>{documentGroupTree.unclassified.length}</small>
              </button>
              {documentGroupingIsFiltered || !collapsedDocumentGroupIds.has(UNCLASSIFIED_GROUP_KEY) ? (
                <div className="document-group-contents">
                  {documentGroupTree.unclassified.map(renderDocumentItem)}
                </div>
              ) : null}
            </section>
          ) : null}
          {allActiveDocuments.length === 0 ? (
            <EmptyState
              icon={Library}
              title="项目中还没有文献"
              description="可以先导入 PDF，也可以只建立书目记录，稍后再连接文件。"
              action={
                <div className="empty-state-actions">
                  <button className="button primary small" onClick={() => beginImport()}>
                    <FilePlus2 size={14} /> 导入 PDF
                  </button>
                  <button className="button secondary small" onClick={beginCreateDocument}>
                    新增文献记录
                  </button>
                </div>
              }
            />
          ) : null}
          {allActiveDocuments.length > 0 && activeDocuments.length === 0 ? (
            <p className="document-list-empty">没有符合当前搜索或筛选条件的文献。</p>
          ) : null}
          {removedDocuments.length > 0 ? (
            <section className="removed-document-section">
              <button
                className="removed-document-toggle"
                type="button"
                onClick={() => setShowRemovedDocuments((current) => !current)}
                aria-expanded={showRemovedDocuments}
              >
                <Trash2 size={13} /> 已移除来源（{removedDocuments.length}）
                <ChevronRight className={showRemovedDocuments ? 'expanded' : ''} size={13} />
              </button>
              {showRemovedDocuments ? (
                <div className="removed-document-list">
                  {removedDocuments.map((document) => (
                    <div className="removed-document-item" key={document.id}>
                      <button type="button" onClick={() => setSelectedDocumentId(document.id)}>
                        <strong>{document.title}</strong>
                        <small>{document.cardCount} 张保留卡片</small>
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        title="恢复到阅读列表"
                        aria-label={`恢复文献“${document.title}”`}
                        onClick={() => void restoreDocument(document)}
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </aside>

      <ReadingResizeHandle
        panel="documents"
        value={panelWidths.documents}
        label="调整文献列表宽度"
        onPointerDown={() => setResizingPanel('documents')}
        onAdjust={(delta) => adjustPanelWidth('documents', delta)}
        onReset={() => resetPanelWidth('documents')}
      />

      <section className="pdf-stage">
        {selectedDocument?.fileAvailable ? (
          <Suspense fallback={<div className="pdf-placeholder" role="status"><LoaderCircle className="spin" size={22} /><p>正在加载阅读器…</p></div>}>
          <PdfViewer
            key={selectedDocument.id}
            isActive={isActive}
            document={selectedDocument}
            annotations={documentAnnotations}
            cards={documentCards}
            focusToken={focusRequest?.documentId === selectedDocument.id ? focusRequest.token : 0}
            focusPage={focusRequest?.documentId === selectedDocument.id ? focusRequest.page : null}
            focusLocator={focusRequest?.documentId === selectedDocument.id ? focusRequest.locator : null}
            onCreateCard={(selection) => void createCard(selection)}
            onCreateAnnotation={(selection, kind, color) => void createAnnotation(selection, kind, color)}
            onCreateReadingNote={(selection, kind) => setPendingNote({ selection, kind })}
            onRequestDeleteAnnotation={setDeletingAnnotation}
            onRequestEditAnnotation={setEditingAnnotation}
            onUpdateAnnotation={updateAnnotationRecord}
            onCurrentPageChange={setCurrentPdfPage}
            onFocusHandled={completeFocusRequest}
            onNotify={notify}
          />
          </Suspense>
        ) : selectedDocument ? (
          <div className="pdf-placeholder">
            <span className="paper-stack" aria-hidden="true">
              <span />
              <span />
              <BookOpen size={34} strokeWidth={1.35} />
            </span>
            <span className="eyebrow">
              {selectedDocument.filePath ? 'PDF 管理副本缺失' : '连接本地 PDF'}
            </span>
            <h2>{selectedDocument.title}</h2>
            <p>
              {selectedDocument.filePath
                ? '数据库中的阅读卡片、标注和原文坐标仍然完整。请选择这篇文献的 PDF 重新链接；原文件不会被修改。'
                : '选择 PDF 后，砚台会保存一份本地副本。原文件不会被修改，摘录和批注单独保存。'}
            </p>
            <button className="button primary" type="button" onClick={() => beginImport(selectedDocument)}>
              <Link2 size={15} /> {selectedDocument.filePath ? '重新链接 PDF' : '选择 PDF 文件'}
            </button>
            <div className="phase-checks">
              <span>
                <CheckCircle2 size={15} /> 支持连续滚动与页码跳转
              </span>
              <span>
                <CheckCircle2 size={15} /> 选中文字后可创建卡片
              </span>
              <span>
                <CheckCircle2 size={15} /> 可保存高亮与下划线
              </span>
            </div>
          </div>
        ) : (
          <div className="pdf-placeholder">
            <span className="paper-stack" aria-hidden="true">
              <span />
              <span />
              <BookOpen size={34} strokeWidth={1.35} />
            </span>
            <span className="eyebrow">阅读台</span>
            <h2>选择一篇文献开始阅读</h2>
            <p>导入 PDF 后，可以在这里连续阅读、选区摘录，并保存高亮与下划线。</p>
          </div>
        )}
      </section>

      {!inspectorCollapsed ? <ReadingResizeHandle
        panel="inspector"
        value={panelWidths.inspector}
        label="调整当前文献信息栏宽度"
        onPointerDown={() => setResizingPanel('inspector')}
        onAdjust={(delta) => adjustPanelWidth('inspector', delta)}
        onReset={() => resetPanelWidth('inspector')}
      /> : null}

      <button className="reading-inspector-toggle icon-button" type="button" aria-label={inspectorCollapsed ? '展开阅读侧栏' : '收起阅读侧栏'} title={inspectorCollapsed ? '展开阅读侧栏' : '收起阅读侧栏'} onClick={() => setInspectorCollapsed((value) => !value)}>{inspectorCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      <aside className="reading-inspector" hidden={inspectorCollapsed}>
        <div className="inspector-scope segmented-control" role="group" aria-label="侧栏内容范围">
          <button className={inspectorScope === 'page' ? 'active' : ''} type="button" onClick={() => setInspectorScope('page')}>当前页</button>
          <button className={inspectorScope === 'all' ? 'active' : ''} type="button" onClick={() => setInspectorScope('all')}>整篇文献</button>
        </div>
        {selectedDocument ? (
          <>
            <section className={`reading-inspector-section ${collapsedInspectorSections.has('document') ? 'collapsed' : ''}`}>
              <ReadingInspectorSectionToggle
                title={selectedDocument.title}
                eyebrow="当前文献"
                collapsed={collapsedInspectorSections.has('document')}
                onToggle={() => toggleInspectorSection('document')}
              />
              {!collapsedInspectorSections.has('document') ? (
                <div className="reading-inspector-section-body">
                  <p className="reading-inspector-description">
                    {selectedDocument.isRemoved
                      ? selectedDocument.fileAvailable
                        ? '这篇来源已从正常阅读列表移除；管理副本和原文定位仍可使用。'
                        : '这篇来源已移除且 PDF 缺失；卡片和定位数据仍已保留。'
                      : selectedDocument.fileAvailable
                        ? '选择文字可建立卡片；高亮和下划线只写入本地数据库。'
                        : selectedDocument.filePath
                          ? 'PDF 管理副本缺失；研究数据已保留，可重新链接。'
                          : '这篇文献还没有连接 PDF。'}
                  </p>
                  <div className="document-inspector-actions">
                    <button className="button secondary small" type="button" onClick={() => beginEditDocument(selectedDocument)}>
                      <FilePenLine size={14} /> 编辑书目信息
                    </button>
                    <button className="button secondary small" type="button" onClick={() => setAssigningDocument(selectedDocument)}>
                      <FolderInput size={14} /> {selectedDocumentGroup?.name ?? '未分类'}
                    </button>
                    {selectedDocument.fileAvailable ? (
                      <button className="button secondary small" type="button" onClick={() => void revealDocument()}>
                        <FolderOpen size={14} /> 打开所在位置
                      </button>
                    ) : null}
                    {selectedDocument.isRemoved ? (
                      <>
                        <button className="button secondary small" type="button" onClick={() => void restoreDocument(selectedDocument)}>
                          <RotateCcw size={14} /> 恢复文献
                        </button>
                        <button className="button ghost small danger-text" type="button" onClick={() => setRemovingDocument(selectedDocument)}>
                          <Trash2 size={14} /> 彻底删除
                        </button>
                      </>
                    ) : (
                      <button className="button ghost small danger-text" type="button" onClick={() => setRemovingDocument(selectedDocument)}>
                        <Trash2 size={14} /> 移除文献
                      </button>
                    )}
                  </div>
                  <dl className="inspector-list">
                    <div>
                      <dt>文件状态</dt>
                      <dd>
                        {selectedDocument.fileAvailable
                          ? '已连接 · 只读副本'
                          : selectedDocument.filePath
                            ? 'PDF 缺失 · 等待重新链接'
                            : '等待导入'}
                      </dd>
                    </div>
                    {selectedDocument.filePath ? (
                      <div>
                        <dt>{selectedDocument.fileAvailable ? '管理副本' : '原记录路径'}</dt>
                        <dd title={selectedDocument.filePath}>{selectedDocument.filePath}</dd>
                      </div>
                    ) : null}
                    {selectedDocument.journal || selectedDocument.doi ? (
                      <div>
                        <dt>书目来源</dt>
                        <dd title={[selectedDocument.journal, selectedDocument.doi].filter(Boolean).join(' · ')}>
                          {selectedDocument.journal || `DOI ${selectedDocument.doi}`}
                        </dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>阅读记录</dt>
                      <dd>{documentCards.length} 卡片 · {documentAnnotations.length} 批注 · {documentNotes.length} 思考</dd>
                    </div>
                  </dl>
                  <PrintPageMappingEditor
                    document={selectedDocument}
                    currentPdfPage={currentPdfPage}
                    onSave={saveDocumentPrintPageMapping}
                  />
                  {selectedDocument.fileAvailable ? (
                    <div className="boundary-note">
                      <span>扫描件需先完成 OCR 才能选中文字；目前不提供内置 OCR。</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className={`reading-inspector-section ${collapsedInspectorSections.has('notes') ? 'collapsed' : ''}`}>
              <ReadingInspectorSectionToggle
                title="阅读思考"
                count={documentNotes.length}
                collapsed={collapsedInspectorSections.has('notes')}
                onToggle={() => toggleInspectorSection('notes')}
              />
              {!collapsedInspectorSections.has('notes') ? (
                <div className="reading-inspector-section-body">
                  <div className="reading-note-actions">
                    <button type="button" onClick={() => setPendingNote({ kind: 'insight', selection: null })}>
                      <Lightbulb size={14} /> 记一条灵感
                    </button>
                    <button type="button" onClick={() => setPendingNote({ kind: 'critique', selection: null })}>
                      <MessageCircleQuestion size={14} /> 记一条质疑
                    </button>
                  </div>
                  {visibleNotes.length > 0 ? (
                    <div className="reading-note-list">
                      {visibleNotes.slice(0, inspectorLimit).map((note) => (
                        <article className={`reading-note-item ${note.kind}`} key={note.id}>
                          <button
                            className="reading-note-main"
                            type="button"
                            disabled={note.pageNumber === null}
                            title={note.pageNumber === null ? '这条笔记未关联具体原文' : '回到关联原文'}
                            onClick={() => {
                              if (note.pageNumber !== null) {
                                focusDocumentLocation(note.documentId, note.pageNumber, note.locatorJson)
                              }
                            }}
                          >
                            <span>{note.kind === 'insight' ? <Lightbulb size={13} /> : <MessageCircleQuestion size={13} />}</span>
                            <span>
                              <strong>{note.content}</strong>
                              <small>
                                {note.kind === 'insight' ? '灵感' : '质疑'}
                                {note.pageNumber ? ` · PDF ${note.pageNumber} 页` : ' · 文献级笔记'}
                              </small>
                            </span>
                          </button>
                          <div className="reading-note-item-actions">
                            {selectionFromReadingNote(note) ? (
                              <button
                                className="reading-note-convert"
                                type="button"
                                title="使用现有制卡流程；转换成功后移除本笔记"
                                onClick={() => createCardFromReadingNote(note)}
                              >
                                <FilePlus2 size={12} /> 转为卡片
                              </button>
                            ) : null}
                            <button
                              className="annotation-delete"
                              type="button"
                              aria-label="编辑阅读笔记"
                              title="编辑"
                              onClick={() => setEditingNote(note)}
                            >
                              <FilePenLine size={13} />
                            </button>
                            <button className="annotation-delete" type="button" aria-label="删除阅读笔记" onClick={() => setDeletingNote(note)}>
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="reading-inspector-empty">当前范围没有灵感或质疑，可切换“整篇文献”查看。</p>
                  )}
                </div>
              ) : null}
            </section>

            <section className={`reading-inspector-section ${collapsedInspectorSections.has('cards') ? 'collapsed' : ''}`}>
              <ReadingInspectorSectionToggle
                title="本篇卡片"
                count={documentCards.length}
                collapsed={collapsedInspectorSections.has('cards')}
                onToggle={() => toggleInspectorSection('cards')}
              />
              {!collapsedInspectorSections.has('cards') ? (
                <div className="reading-inspector-section-body">
                  {(inspectorScope === 'all' ? documentCards.length : cardPagePartition.currentPageItems.length) > 0 ? (
                    <div className="reading-reference-items">
                      {cardPagePartition.currentPageItems.length > 0 ? (
                        <div className="reading-page-group-label current">当前第 {currentPdfPage} 页</div>
                      ) : null}
                      {cardPagePartition.currentPageItems.slice(0, inspectorLimit).map((card) => (
                        <button
                          type="button"
                          className="reading-reference-item current-page"
                          key={card.id}
                          onClick={() => focusDocumentLocation(card.documentId, card.pdfPage, card.locatorJson)}
                        >
                          <span className="reading-reference-page">{card.pdfPage ?? '—'}</span>
                          <span>
                            <CardText card={card} compact />
                            <small>当前页 · 点击回到原文位置</small>
                          </span>
                        </button>
                      ))}
                      {inspectorScope === 'all' && cardPagePartition.otherPageItems.length > 0 ? (
                        <div className="reading-page-group-label">其他页</div>
                      ) : null}
                      {(inspectorScope === 'all' ? cardPagePartition.otherPageItems.slice(0, Math.max(0, inspectorLimit - cardPagePartition.currentPageItems.length)) : []).map((card) => (
                        <button
                          type="button"
                          className="reading-reference-item"
                          key={card.id}
                          onClick={() => focusDocumentLocation(card.documentId, card.pdfPage, card.locatorJson)}
                        >
                          <span className="reading-reference-page">{card.pdfPage ?? '—'}</span>
                          <span>
                            <CardText card={card} compact />
                            <small>点击回到原文位置</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="reading-inspector-empty">当前范围没有卡片，可切换“整篇文献”查看。</p>
                  )}
                </div>
              ) : null}
            </section>

            <section className={`reading-inspector-section ${collapsedInspectorSections.has('annotations') ? 'collapsed' : ''}`}>
              <ReadingInspectorSectionToggle
                title="本篇批注"
                count={documentAnnotations.length}
                collapsed={collapsedInspectorSections.has('annotations')}
                onToggle={() => toggleInspectorSection('annotations')}
              />
              {!collapsedInspectorSections.has('annotations') ? (
                <div className="reading-inspector-section-body">
                  {(inspectorScope === 'all' ? documentAnnotations.length : annotationPagePartition.currentPageItems.length) > 0 ? (
                    <div className="reading-reference-items">
                      {annotationPagePartition.currentPageItems.length > 0 ? (
                        <div className="reading-page-group-label current">当前第 {currentPdfPage} 页</div>
                      ) : null}
                      {annotationPagePartition.currentPageItems.slice(0, inspectorLimit).map((annotation) => (
                        <ReadingAnnotationItem
                          key={annotation.id}
                          annotation={annotation}
                          currentPage
                          onLocate={focusDocumentLocation}
                          onEdit={setEditingAnnotation}
                          onDelete={setDeletingAnnotation}
                        />
                      ))}
                      {inspectorScope === 'all' && annotationPagePartition.otherPageItems.length > 0 ? (
                        <div className="reading-page-group-label">其他页</div>
                      ) : null}
                      {(inspectorScope === 'all' ? annotationPagePartition.otherPageItems.slice(0, Math.max(0, inspectorLimit - annotationPagePartition.currentPageItems.length)) : []).map((annotation) => (
                        <ReadingAnnotationItem
                          key={annotation.id}
                          annotation={annotation}
                          onLocate={focusDocumentLocation}
                          onEdit={setEditingAnnotation}
                          onDelete={setDeletingAnnotation}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="reading-inspector-empty">当前范围没有批注，可切换“整篇文献”查看。</p>
                  )}
                </div>
              ) : null}
            </section>
          </>
        ) : (
          <div className="reading-inspector-empty-document">
            <span className="eyebrow">当前文献</span>
            <strong>尚未选择文献</strong>
          </div>
        )}
        {selectedDocument && (visibleNotes.length > inspectorLimit || (inspectorScope === 'all' ? documentCards.length : cardPagePartition.currentPageItems.length) > inspectorLimit || (inspectorScope === 'all' ? documentAnnotations.length : annotationPagePartition.currentPageItems.length) > inspectorLimit) ? <button className="button ghost compact" type="button" onClick={() => setInspectorLimit((limit) => limit + 30)}>再显示 30 条</button> : null}
      </aside>

      {documentContextMenu ? (
        <ContextMenu
          x={documentContextMenu.x}
          y={documentContextMenu.y}
          ariaLabel={`文献“${documentContextMenu.document.title}”操作`}
          onClose={() => setDocumentContextMenu(null)}
          items={[
            {
              id: 'open',
              label: '在阅读台打开',
              icon: <BookOpen size={14} />,
              onSelect: () => setSelectedDocumentId(documentContextMenu.document.id)
            },
            {
              id: 'edit',
              label: '编辑书目信息',
              icon: <FilePenLine size={14} />,
              onSelect: () => beginEditDocument(documentContextMenu.document)
            },
            {
              id: 'reveal',
              label: '在文件资源管理器中显示',
              icon: <FolderOpen size={14} />,
              disabled: !documentContextMenu.document.fileAvailable,
              onSelect: () => void revealDocument(documentContextMenu.document)
            },
            {
              id: 'group',
              label: '调整文献分类…',
              icon: <FolderInput size={14} />,
              onSelect: () => setAssigningDocument(documentContextMenu.document)
            },
            {
              id: 'remove',
              label: documentContextMenu.document.isRemoved ? '彻底删除文献' : '移除文献',
              icon: <Trash2 size={14} />,
              danger: true,
              separatorBefore: true,
              onSelect: () => setRemovingDocument(documentContextMenu.document)
            }
          ]}
        />
      ) : null}

      {documentGroupContextMenu ? (
        <ContextMenu
          x={documentGroupContextMenu.x}
          y={documentGroupContextMenu.y}
          ariaLabel={`文献分类“${documentGroupContextMenu.group.name}”操作`}
          onClose={() => setDocumentGroupContextMenu(null)}
          items={[
            {
              id: 'subgroup',
              label: '新建下级分类',
              icon: <FolderPlus size={14} />,
              onSelect: () => setEditingDocumentGroup({ group: null, parentId: documentGroupContextMenu.group.id })
            },
            {
              id: 'edit',
              label: '重命名或调整层级',
              icon: <FilePenLine size={14} />,
              onSelect: () => setEditingDocumentGroup({
                group: documentGroupContextMenu.group,
                parentId: documentGroupContextMenu.group.parentId
              })
            },
            {
              id: 'delete',
              label: '移除分类（保留文献）',
              icon: <Trash2 size={14} />,
              danger: true,
              separatorBefore: true,
              onSelect: () => setDeletingDocumentGroup(documentGroupContextMenu.group)
            }
          ]}
        />
      ) : null}

      {editingDocumentGroup ? (
        <DocumentGroupDialog
          groups={flatDocumentGroups}
          excludedGroupIds={editingDocumentGroup.group
            ? descendantDocumentGroupIds(snapshot.documentGroups, editingDocumentGroup.group.id)
            : new Set()}
          group={editingDocumentGroup.group}
          initialParentId={editingDocumentGroup.parentId}
          onSave={saveDocumentGroup}
          onClose={() => setEditingDocumentGroup(null)}
        />
      ) : null}

      {assigningDocument ? (
        <DocumentGroupAssignmentDialog
          document={assigningDocument}
          groups={flatDocumentGroups}
          onSave={assignDocumentGroup}
          onClose={() => setAssigningDocument(null)}
        />
      ) : null}

      {deletingDocumentGroup ? (
        <ConfirmDialog
          title={`移除文献分类“${deletingDocumentGroup.name}”？`}
          description="该分类及其下级分类会被移除，其中的文献将回到“未分类”。PDF、卡片、批注、二次整理和写作提纲都不会删除。"
          confirmLabel="移除分类，保留文献"
          onConfirm={() => void deleteSelectedDocumentGroup()}
          onCancel={() => setDeletingDocumentGroup(null)}
        />
      ) : null}

      {showDocumentDialog ? (
        <Modal
          title="新增文献记录"
          subtitle="先登记书目信息；PDF 可以稍后连接。"
          onClose={() => setShowDocumentDialog(false)}
          width="large"
          hasUnsavedChanges={!metadataDraftEqual(metadata, EMPTY_METADATA)}
        >
          <form onSubmit={createDocument}>
            <BibliographicFields
              value={metadata}
              onChange={setMetadata}
              autoFocusTitle
            />
            <div className="modal-actions">
              <button className="button ghost" type="button" data-modal-close>
                取消
              </button>
              <button className="button primary" type="submit">
                保存文献记录
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {showImportDialog ? (
        <ImportPdfDialog
          sourcePaths={importSourcePaths}
          attempts={pdfImportAttempts}
          busy={importingPdfs}
          targetDocument={snapshot.documents.find((document) => document.id === importTargetDocumentId) ?? null}
          metadata={metadata}
          onChoose={choosePdf}
          onMetadataChange={setMetadata}
          onSubmit={importPdf}
          onClose={() => {
            if (!importingPdfs) setShowImportDialog(false)
          }}
        />
      ) : null}

      {editingDocument ? (
        <Modal
          title="编辑文献书目信息"
          subtitle="粘贴引用会自动补齐空白字段；手工填写内容优先，也可以主动覆盖为识别结果。"
          onClose={() => setEditingDocument(null)}
          width="large"
          hasUnsavedChanges={!metadataDraftEqual(metadata, metadataFromDocument(editingDocument))}
        >
          <form onSubmit={(event) => void saveDocumentMetadata(event)}>
            <BibliographicFields value={metadata} onChange={setMetadata} autoFocusTitle />
            <div className="modal-actions">
              <button className="button ghost" type="button" data-modal-close>
                取消
              </button>
              <button className="button primary" type="submit">
                保存书目信息
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {pendingCard ? (
        <CreateCardDialog
          selection={pendingCard.selection}
          initialComment={pendingCard.initialComment}
          automaticPrintPage={mappedPrintPage(selectedDocument, pendingCard.selection.pageNumber)}
          availableTags={Array.from(new Set(snapshot.cards.flatMap((card) => card.tags))).sort()}
          onSave={saveCardFromSelection}
          onClose={() => setPendingCard(null)}
        />
      ) : null}

      {deletingAnnotation ? (
        <ConfirmDialog
          title="移除这条 PDF 批注？"
          description="这只会移除砚台保存的高亮或下划线，不会修改原始 PDF，也不会影响阅读卡片。"
          confirmLabel="移除批注"
          onConfirm={() => void removeAnnotation()}
          onCancel={() => setDeletingAnnotation(null)}
        />
      ) : null}

      {editingAnnotation ? (
        <PdfAnnotationEditDialog
          annotation={editingAnnotation}
          onSave={updateAnnotation}
          onClose={() => setEditingAnnotation(null)}
        />
      ) : null}

      {removingDocument ? (
        <DocumentRemovalDialog
          document={removingDocument}
          noteCount={snapshot.readingNotes.filter((note) => note.documentId === removingDocument.id).length}
          annotationCount={snapshot.pdfAnnotations.filter((annotation) => annotation.documentId === removingDocument.id).length}
          onKeepCards={() => void removeDocument(true)}
          onDeleteCards={() => void removeDocument(false)}
          onClose={() => setRemovingDocument(null)}
        />
      ) : null}

      {pendingNote ? (
        <ReadingNoteDialog
          kind={pendingNote.kind}
          selection={pendingNote.selection}
          initialContent=""
          onSave={saveReadingNote}
          onClose={() => setPendingNote(null)}
        />
      ) : null}

      {editingNote ? (
        <ReadingNoteDialog
          kind={editingNote.kind}
          selection={selectionFromReadingNote(editingNote)}
          initialContent={editingNote.content}
          editing
          onSave={updateReadingNote}
          onClose={() => setEditingNote(null)}
        />
      ) : null}

      {deletingNote ? (
        <ConfirmDialog
          title={`删除这条${deletingNote.kind === 'insight' ? '灵感' : '质疑'}笔记？`}
          description="这只删除独立的阅读笔记，不会删除阅读卡片、PDF 高亮或来源文献。"
          confirmLabel="删除笔记"
          dangerous
          onConfirm={() => void removeReadingNote()}
          onCancel={() => setDeletingNote(null)}
        />
      ) : null}
    </div>
  )
}

interface DocumentGroupBranchProps {
  node: DocumentGroupTreeNode
  depth: number
  forceExpanded: boolean
  collapsedIds: ReadonlySet<string>
  onToggle: (groupId: string) => void
  onContextMenu: (event: React.MouseEvent, group: DocumentGroup) => void
  renderDocument: (document: DocumentSummary) => React.JSX.Element
}

function DocumentGroupBranch({
  node,
  depth,
  forceExpanded,
  collapsedIds,
  onToggle,
  onContextMenu,
  renderDocument
}: DocumentGroupBranchProps): React.JSX.Element {
  const expanded = forceExpanded || !collapsedIds.has(node.group.id)
  return (
    <section
      className="document-group-branch"
      style={{ '--document-group-depth': depth } as React.CSSProperties}
    >
      <button
        className="document-group-row"
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggle(node.group.id)}
        onContextMenu={(event) => onContextMenu(event, node.group)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <FolderTree size={14} />
        <span>{node.group.name}</span>
        <small>{countDocumentsInGroup(node)}</small>
      </button>
      {expanded ? (
        <div className="document-group-contents">
          {node.documents.map(renderDocument)}
          {node.children.map((child) => (
            <DocumentGroupBranch
              key={child.group.id}
              node={child}
              depth={depth + 1}
              forceExpanded={forceExpanded}
              collapsedIds={collapsedIds}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
              renderDocument={renderDocument}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

interface DocumentGroupDialogProps {
  groups: Array<{ group: DocumentGroup; depth: number }>
  excludedGroupIds: ReadonlySet<string>
  group: DocumentGroup | null
  initialParentId: string | null
  onSave: (name: string, parentId: string | null) => Promise<void>
  onClose: () => void
}

function DocumentGroupDialog({
  groups,
  excludedGroupIds,
  group,
  initialParentId,
  onSave,
  onClose
}: DocumentGroupDialogProps): React.JSX.Element {
  const [name, setName] = useState(group?.name ?? '')
  const [parentId, setParentId] = useState(initialParentId ?? '')
  const [saving, setSaving] = useState(false)
  const availableParents = groups.filter((entry) =>
    entry.group.id !== group?.id && !excludedGroupIds.has(entry.group.id)
  )
  return (
    <Modal
      title={group ? '编辑文献分类' : initialParentId ? '新建下级文献分类' : '新建文献分类'}
      subtitle="分类只组织当前项目中的文献，不复制 PDF，也不改变卡片来源。"
      onClose={onClose}
      hasUnsavedChanges={name !== (group?.name ?? '') || parentId !== (initialParentId ?? '')}
    >
      <form onSubmit={(event) => {
        event.preventDefault()
        if (!name.trim()) return
        setSaving(true)
        void onSave(name, parentId || null).finally(() => setSaving(false))
      }}>
        <label className="field">
          <span>分类名称</span>
          <input autoFocus required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span>上级分类</span>
          <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
            <option value="">无（作为一级分类）</option>
            {availableParents.map(({ group: candidate, depth }) => (
              <option key={candidate.id} value={candidate.id}>{`${'　'.repeat(depth)}${candidate.name}`}</option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <button className="button ghost" type="button" data-modal-close>取消</button>
          <button className="button primary" type="submit" disabled={saving || !name.trim()}>
            {saving ? <LoaderCircle className="spin" size={15} /> : <FolderPlus size={15} />}
            {group ? '保存分类' : '创建分类'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

interface DocumentGroupAssignmentDialogProps {
  document: DocumentSummary
  groups: Array<{ group: DocumentGroup; depth: number }>
  onSave: (groupId: string | null) => Promise<void>
  onClose: () => void
}

function DocumentGroupAssignmentDialog({
  document,
  groups,
  onSave,
  onClose
}: DocumentGroupAssignmentDialogProps): React.JSX.Element {
  const [groupId, setGroupId] = useState(document.groupId ?? '')
  const [saving, setSaving] = useState(false)
  return (
    <Modal
      title="调整文献分类"
      subtitle={document.title}
      onClose={onClose}
      hasUnsavedChanges={groupId !== (document.groupId ?? '')}
    >
      <form onSubmit={(event) => {
        event.preventDefault()
        setSaving(true)
        void onSave(groupId || null).finally(() => setSaving(false))
      }}>
        <label className="field">
          <span>放入</span>
          <select autoFocus value={groupId} onChange={(event) => setGroupId(event.target.value)}>
            <option value="">未分类</option>
            {groups.map(({ group, depth }) => (
              <option key={group.id} value={group.id}>{`${'　'.repeat(depth)}${group.name}`}</option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <button className="button ghost" type="button" data-modal-close>取消</button>
          <button className="button primary" type="submit" disabled={saving || groupId === (document.groupId ?? '')}>
            {saving ? <LoaderCircle className="spin" size={15} /> : <FolderInput size={15} />}
            保存分类
          </button>
        </div>
      </form>
    </Modal>
  )
}

interface ReadingInspectorSectionToggleProps {
  title: string
  eyebrow?: string
  count?: number
  collapsed: boolean
  onToggle: () => void
}

function ReadingInspectorSectionToggle({
  title,
  eyebrow,
  count,
  collapsed,
  onToggle
}: ReadingInspectorSectionToggleProps): React.JSX.Element {
  return (
    <button
      className="reading-inspector-section-toggle"
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <span>
        {eyebrow ? <small className="eyebrow">{eyebrow}</small> : null}
        <strong>{title}</strong>
      </span>
      {count !== undefined ? <small className="reading-inspector-section-count">{count}</small> : null}
      {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
    </button>
  )
}

interface ReadingAnnotationItemProps {
  annotation: PdfAnnotation
  currentPage?: boolean
  onLocate: (documentId: string, page: number | null, locatorJson: string) => void
  onEdit: (annotation: PdfAnnotation) => void
  onDelete: (annotation: PdfAnnotation) => void
}

function ReadingAnnotationItem({
  annotation,
  currentPage = false,
  onLocate,
  onEdit,
  onDelete
}: ReadingAnnotationItemProps): React.JSX.Element {
  return (
    <article className={`reading-annotation-item ${currentPage ? 'current-page' : ''}`}>
      <button
        type="button"
        onClick={() => onLocate(annotation.documentId, annotation.pageNumber, annotation.locatorJson)}
      >
        <span className={`annotation-kind ${annotation.kind}`} style={{ '--annotation-color': annotation.color } as React.CSSProperties}>
          {annotation.kind === 'highlight' ? <Highlighter size={13} /> : <Underline size={13} />}
        </span>
        <span>
          <strong>{annotation.selectedText || '未记录文字'}</strong>
          <small>
            {currentPage ? '当前页 · ' : ''}第 {annotation.pageNumber} 页 · 点击定位
          </small>
          {annotation.comment ? <em>{annotation.comment}</em> : null}
        </span>
      </button>
      <button
        className="annotation-delete"
        type="button"
        aria-label="编辑批注"
        title="编辑批注评论"
        onClick={() => onEdit(annotation)}
      >
        <FilePenLine size={13} />
      </button>
      <button
        className="annotation-delete"
        type="button"
        aria-label="删除批注"
        title="删除批注"
        onClick={() => onDelete(annotation)}
      >
        <Trash2 size={13} />
      </button>
    </article>
  )
}

interface PdfAnnotationEditDialogProps {
  annotation: PdfAnnotation
  onSave: (color: string, comment: string) => Promise<void>
  onClose: () => void
}

function PdfAnnotationEditDialog({
  annotation,
  onSave,
  onClose
}: PdfAnnotationEditDialogProps): React.JSX.Element {
  const [comment, setComment] = useState(annotation.comment)
  const [saving, setSaving] = useState(false)

  return (
    <Modal
      title={`${annotation.kind === 'highlight' ? '高亮' : '下划线'}批注评论`}
      subtitle={`PDF 第 ${annotation.pageNumber} 页 · 颜色请在原文标记上直接修改`}
      onClose={onClose}
      width="large"
      hasUnsavedChanges={comment !== annotation.comment}
    >
      <form onSubmit={(event) => {
        event.preventDefault()
        setSaving(true)
        void onSave(annotation.color, comment).finally(() => setSaving(false))
      }}>
        <blockquote className="dialog-quote compact">{annotation.selectedText || '未记录选中文字'}</blockquote>
        <label className="field">
          <span>批注评论（可选）</span>
          <textarea
            rows={5}
            maxLength={20_000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="记录这处标记需要注意的内容……"
          />
        </label>
        <div className="modal-actions">
          <button className="button ghost" type="button" data-modal-close>取消</button>
          <button className="button primary" type="submit" disabled={saving}>
            {saving ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}
            保存批注
          </button>
        </div>
      </form>
    </Modal>
  )
}

interface ReadingResizeHandleProps {
  panel: ReadingPanel
  value: number
  label: string
  onPointerDown: () => void
  onAdjust: (delta: number) => void
  onReset: () => void
}

function ReadingResizeHandle({
  panel,
  value,
  label,
  onPointerDown,
  onAdjust,
  onReset
}: ReadingResizeHandleProps): React.JSX.Element {
  const limits = READING_PANEL_LIMITS[panel]
  return (
    <div
      className={`reading-resize-handle ${panel}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={value}
      tabIndex={0}
      title={`${label}；拖动或使用方向键，双击恢复默认宽度`}
      onPointerDown={(event) => {
        event.preventDefault()
        onPointerDown()
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 16
        const direction = panel === 'documents' ? 1 : -1
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onAdjust(-step * direction)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          onAdjust(step * direction)
        } else if (event.key === 'Home') {
          event.preventDefault()
          onReset()
        }
      }}
    >
      <span aria-hidden="true" />
    </div>
  )
}

interface ImportPdfDialogProps {
  sourcePaths: string[]
  attempts: PdfImportAttempt[]
  busy: boolean
  targetDocument: DocumentSummary | null
  metadata: MetadataDraft
  onChoose: () => Promise<void>
  onMetadataChange: (value: MetadataDraft) => void
  onSubmit: (event: React.FormEvent) => Promise<void>
  onClose: () => void
}

function ImportPdfDialog({
  sourcePaths,
  attempts,
  busy,
  targetDocument,
  metadata,
  onChoose,
  onMetadataChange,
  onSubmit,
  onClose
}: ImportPdfDialogProps): React.JSX.Element {
  return (
    <Modal
      title={targetDocument ? '为文献连接 PDF' : '导入 PDF 文献'}
      subtitle="砚台会保存 PDF 的本地副本，原文件不会被修改；重复文件不会重复复制。"
      onClose={onClose}
      width="large"
      hasUnsavedChanges={
        attempts.length === 0 && (
          sourcePaths.length > 0 ||
          !metadataDraftEqual(metadata, targetDocument ? metadataFromDocument(targetDocument) : EMPTY_METADATA)
        )
      }
    >
      <form onSubmit={(event) => void onSubmit(event)}>
        <div className="pdf-file-picker">
          <div>
            <span className="eyebrow">PDF 文件</span>
            <strong>
              {sourcePaths.length === 0
                ? '尚未选择文件'
                : sourcePaths.length === 1
                  ? fileName(sourcePaths[0] as string)
                  : `已选择 ${sourcePaths.length} 份 PDF`}
            </strong>
            <small>
              {sourcePaths.length === 1
                ? sourcePaths[0]
                : sourcePaths.length > 1
                  ? '批量导入会先使用文件名作为可编辑标题，并逐项显示结果。'
                  : '支持一次选择多个 .pdf；扫描件可以导入，但暂不提供 OCR 文字层。'}
            </small>
          </div>
          <button className="button secondary" type="button" disabled={busy} onClick={() => void onChoose()}>
            <FilePlus2 size={15} /> {targetDocument ? '选择文件' : '选择一个或多个文件'}
          </button>
        </div>
        {sourcePaths.length <= 1 ? (
          <BibliographicFields
            value={metadata}
            onChange={onMetadataChange}
            autoFocusTitle={sourcePaths.length === 0}
          />
        ) : (
          <div className="batch-pdf-import-list">
            {sourcePaths.map((path) => {
              const attempt = attempts.find((item) => item.path === path)
              return (
                <article className={attempt ? `status-${attempt.status}` : ''} key={path}>
                  <span>{attempt?.status === 'success' ? <CheckCircle2 size={15} /> : attempt?.status === 'error' ? <CircleX size={15} /> : busy ? <LoaderCircle className="spin" size={15} /> : <FileText size={15} />}</span>
                  <div><strong>{titleFromPdfPath(path)}</strong><small title={path}>{path}</small></div>
                  <em>{attempt?.message ?? '等待导入'}</em>
                </article>
              )
            })}
          </div>
        )}
        <p className="import-note">
          同一个 PDF 在多个项目中导入时会复用文件实体；每个项目仍然拥有独立的评论、标签和论证用途。
        </p>
        <div className="modal-actions">
          <button className="button ghost" type="button" disabled={busy} data-modal-close>
            {attempts.length > 0 ? '关闭' : '取消'}
          </button>
          {attempts.length === 0 ? (
            <button className="button primary" type="submit" disabled={sourcePaths.length === 0 || busy}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <FilePlus2 size={15} />}
              {busy
                ? `正在导入 ${sourcePaths.length} 份…`
                : sourcePaths.length > 1
                  ? `导入 ${sourcePaths.length} 份 PDF`
                  : '导入并打开'}
            </button>
          ) : null}
        </div>
      </form>
    </Modal>
  )
}

interface BibliographicFieldsProps {
  value: MetadataDraft
  onChange: (value: MetadataDraft) => void
  autoFocusTitle?: boolean
}

function BibliographicFields({
  value,
  onChange,
  autoFocusTitle = false
}: BibliographicFieldsProps): React.JSX.Element {
  const parsed = useMemo(() => parseBibliography(value.metadataRaw), [value.metadataRaw])
  const update = (key: keyof MetadataDraft, next: string): void => {
    onChange({ ...value, [key]: next })
  }
  const updateRawCitation = (nextRaw: string): void => {
    const next = { ...value, metadataRaw: nextRaw }
    const nextParsed = parseBibliography(nextRaw)
    onChange(nextParsed ? mergeParsedBibliography(next, nextParsed) : next)
  }
  const applyParsed = (): void => {
    if (!parsed) return
    onChange(mergeParsedBibliography(value, parsed, true))
  }

  return (
    <>
      <label className="field">
        <span>文献标题</span>
        <input
          autoFocus={autoFocusTitle}
          required
          maxLength={160}
          value={value.title}
          onChange={(event) => update('title', event.target.value)}
          placeholder="输入文献、书籍或资料标题"
        />
      </label>
      <div className="form-grid two-columns">
        <label className="field">
          <span>作者</span>
          <input value={value.authors} onChange={(event) => update('authors', event.target.value)} />
        </label>
        <label className="field">
          <span>年份</span>
          <input
            type="number"
            min="1"
            max="3000"
            value={value.year}
            onChange={(event) => update('year', event.target.value)}
          />
        </label>
      </div>
      <div className="form-grid two-columns">
        <label className="field">
          <span>期刊 / 来源</span>
          <input value={value.journal} onChange={(event) => update('journal', event.target.value)} />
        </label>
        <label className="field">
          <span>页码范围</span>
          <input value={value.pages} onChange={(event) => update('pages', event.target.value)} placeholder="例如 101-118" />
        </label>
      </div>
      <div className="form-grid metadata-volume-grid">
        <label className="field">
          <span>卷</span>
          <input value={value.volume} onChange={(event) => update('volume', event.target.value)} />
        </label>
        <label className="field">
          <span>期</span>
          <input value={value.issue} onChange={(event) => update('issue', event.target.value)} />
        </label>
        <label className="field">
          <span>DOI</span>
          <input value={value.doi} onChange={(event) => update('doi', event.target.value)} placeholder="10.xxxx/……" />
        </label>
      </div>
      <label className="field">
        <span>出版社（可选）</span>
        <input value={value.publisher} onChange={(event) => update('publisher', event.target.value)} />
      </label>
      <section className="bibliography-paste-panel">
        <div className="bibliography-paste-heading">
          <div>
            <strong>粘贴引用信息自动识别</strong>
            <small>自动补齐空白字段；支持知网、GB/T 7714、BibTeX、RIS、EndNote、APA 和字段文本。</small>
          </div>
          <button className="button secondary small" type="button" disabled={!parsed} onClick={applyParsed}>
            覆盖为识别结果
          </button>
        </div>
        <textarea
          rows={4}
          value={value.metadataRaw}
          onChange={(event) => updateRawCitation(event.target.value)}
          placeholder="例如：王明. 文章标题[J]. 期刊名,2024,12(3):45-60. DOI:10……"
        />
        {parsed ? (
          <div className="bibliography-preview">
            <span>已识别为 {bibliographyFormatLabel(parsed.format)}</span>
            <p>{bibliographyPreview(parsed)}</p>
          </div>
        ) : value.metadataRaw.trim() ? (
          <p className="bibliography-no-match">暂未识别出可靠字段，可继续手动填写；原始粘贴内容仍会保存。</p>
        ) : null}
      </section>
    </>
  )
}

interface DocumentRemovalDialogProps {
  document: DocumentSummary
  noteCount: number
  annotationCount: number
  onKeepCards: () => void
  onDeleteCards: () => void
  onClose: () => void
}

function DocumentRemovalDialog({
  document,
  noteCount,
  annotationCount,
  onKeepCards,
  onDeleteCards,
  onClose
}: DocumentRemovalDialogProps): React.JSX.Element {
  return (
    <Modal title={document.isRemoved ? '彻底删除这个已移除来源？' : '从当前项目移除这篇文献？'} subtitle={document.title} onClose={onClose} width="medium">
      <p className="confirm-description">
        {document.isRemoved
          ? `它目前仍支撑 ${document.cardCount} 张保留卡片。彻底删除会一并删除当前项目中的卡片、提纲关联、${annotationCount} 条批注和 ${noteCount} 条阅读笔记。`
          : `请选择是否保留这篇文献对应的 ${document.cardCount} 张卡片。为避免定位失效，保留卡片时也会保留 PDF 管理副本、原文坐标、${annotationCount} 条批注和 ${noteCount} 条阅读笔记。`}
      </p>
      <div className="document-removal-choices">
        {!document.isRemoved ? (
          <button className="removal-choice keep" type="button" onClick={onKeepCards}>
            <span><RotateCcw size={17} /></span>
            <strong>保留卡片并移除文献</strong>
            <small>文献进入“已移除来源”，卡片仍可查看原文，也可以随时恢复。</small>
          </button>
        ) : null}
        <button className="removal-choice delete" type="button" onClick={onDeleteCards}>
          <span><Trash2 size={17} /></span>
          <strong>连同项目卡片一起删除</strong>
          <small>删除当前项目的卡片、提纲关联、批注和阅读笔记；其他项目不受影响。</small>
        </button>
      </div>
      <div className="modal-actions">
        <button className="button ghost" type="button" onClick={onClose}>取消</button>
      </div>
    </Modal>
  )
}

interface ReadingNoteDialogProps {
  kind: ReadingNoteKind
  selection: PdfSelection | null
  initialContent: string
  editing?: boolean
  onSave: (content: string) => Promise<void>
  onClose: () => void
}

function ReadingNoteDialog({
  kind,
  selection,
  initialContent,
  editing = false,
  onSave,
  onClose
}: ReadingNoteDialogProps): React.JSX.Element {
  const [content, setContent] = useState(initialContent)
  const [saving, setSaving] = useState(false)
  const isInsight = kind === 'insight'
  return (
    <Modal
      title={editing ? `编辑${isInsight ? '灵感' : '质疑'}笔记` : isInsight ? '记录阅读灵感' : '记录对作者观点的质疑'}
      subtitle={selection ? `关联 PDF 第 ${selection.pageNumber} 页的原文位置保持不变` : '当前文献的独立阅读笔记'}
      onClose={onClose}
      width="large"
      hasUnsavedChanges={content !== initialContent}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setSaving(true)
          void onSave(content).finally(() => setSaving(false))
        }}
      >
        {selection ? <blockquote className="dialog-quote compact">{selection.text}</blockquote> : null}
        <label className="field">
          <span>{isInsight ? '我的灵感' : '质疑与理由'}</span>
          <textarea
            autoFocus
            required
            rows={6}
            maxLength={20_000}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={
              isInsight
                ? '记下联想到的材料、论证方向或后续要验证的问题……'
                : '作者的证据哪里不足？概念或推论有什么问题？需要用什么材料核验？'
            }
          />
        </label>
        <div className="modal-actions">
          <button className="button ghost" type="button" data-modal-close>取消</button>
          <button className="button primary" type="submit" disabled={saving || !content.trim()}>
            {saving ? <LoaderCircle className="spin" size={15} /> : isInsight ? <Lightbulb size={15} /> : <MessageCircleQuestion size={15} />}
            {editing ? '保存修改' : `保存${isInsight ? '灵感' : '质疑'}`}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function PrintPageMappingEditor({
  document,
  currentPdfPage,
  onSave
}: {
  document: DocumentSummary
  currentPdfPage: number
  onSave: (pdfPageAnchor: number | null, printPageAnchor: number | null) => Promise<boolean>
}): React.JSX.Element {
  const hasMapping = document.printPagePdfAnchor !== null && document.printPageNumberAnchor !== null
  const [pdfPageAnchor, setPdfPageAnchor] = useState(
    String(document.printPagePdfAnchor ?? currentPdfPage)
  )
  const [printPageAnchor, setPrintPageAnchor] = useState(
    String(document.printPageNumberAnchor ?? 1)
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setPdfPageAnchor(String(document.printPagePdfAnchor ?? currentPdfPage))
    setPrintPageAnchor(String(document.printPageNumberAnchor ?? 1))
  }, [document.id, document.printPageNumberAnchor, document.printPagePdfAnchor])

  const parsedPdfPage = Number(pdfPageAnchor)
  const parsedPrintPage = Number(printPageAnchor)
  const valid = Number.isInteger(parsedPdfPage) && parsedPdfPage >= 1 &&
    Number.isInteger(parsedPrintPage) && parsedPrintPage >= 1

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid) return
    setSaving(true)
    try {
      await onSave(parsedPdfPage, parsedPrintPage)
    } finally {
      setSaving(false)
    }
  }

  const clear = async (): Promise<void> => {
    setSaving(true)
    try {
      const succeeded = await onSave(null, null)
      if (succeeded) {
        setPdfPageAnchor(String(currentPdfPage))
        setPrintPageAnchor('1')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <details className="print-page-mapping-editor">
      <summary>
        <span>印刷页映射</span>
        <small>{hasMapping
          ? `PDF ${document.printPagePdfAnchor} = 印刷 ${document.printPageNumberAnchor}`
          : '未设置，仅在需要脚注页码时启用'}</small>
      </summary>
      <form onSubmit={(event) => void submit(event)}>
        <div className="print-page-anchor-fields">
          <label>
            <span>PDF 第</span>
            <input
              type="number"
              min="1"
              max="1000000"
              value={pdfPageAnchor}
              onChange={(event) => setPdfPageAnchor(event.target.value)}
            />
            <span>页</span>
          </label>
          <strong>=</strong>
          <label>
            <span>印刷第</span>
            <input
              type="number"
              min="1"
              max="1000000"
              value={printPageAnchor}
              onChange={(event) => setPrintPageAnchor(event.target.value)}
            />
            <span>页</span>
          </label>
        </div>
        <p>保存后自动推算这篇文献的卡片页码；目录等前置页不会显示零或负数。</p>
        <div className="print-page-mapping-actions">
          <button className="button ghost compact" type="button" onClick={() => setPdfPageAnchor(String(currentPdfPage))}>
            使用当前 PDF 页
          </button>
          {hasMapping ? (
            <button className="button ghost compact" type="button" disabled={saving} onClick={() => void clear()}>
              清除映射
            </button>
          ) : null}
          <button className="button secondary compact" type="submit" disabled={saving || !valid}>
            {saving ? '保存中…' : '保存映射'}
          </button>
        </div>
      </form>
    </details>
  )
}

interface CreateCardDialogProps {
  selection: PdfSelection
  initialComment: string
  automaticPrintPage: string | null
  availableTags: string[]
  onSave: (input: { displayText: string; comment: string; tags: string[] }) => Promise<void>
  onClose: () => void
}

function mappedPrintPage(document: DocumentSummary | null, pdfPage: number): string | null {
  if (!document || document.printPagePdfAnchor === null || document.printPageNumberAnchor === null) return null
  const mapped = document.printPageNumberAnchor + pdfPage - document.printPagePdfAnchor
  return mapped >= 1 ? String(mapped) : null
}

function CreateCardDialog({
  selection,
  initialComment,
  automaticPrintPage,
  availableTags,
  onSave,
  onClose
}: CreateCardDialogProps): React.JSX.Element {
  const [displayText, setDisplayText] = useState(selection.text)
  const [comment, setComment] = useState(initialComment)
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    try {
      await onSave({
        displayText,
        comment,
        tags: parseTags(tags)
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="创建阅读卡片"
      subtitle={`PDF 第 ${selection.pageNumber} 页 · 原文和定位信息会永久保留`}
      onClose={onClose}
      width="large"
      hasUnsavedChanges={
        displayText !== selection.text ||
        comment !== initialComment ||
        tags.length > 0
      }
    >
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>我的笔记</span>
          <textarea
            rows={5}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="记录这段材料为什么重要、如何使用或有哪些疑问……"
          />
        </label>
        <label className="field excerpt-text-editor">
          <span>卡片摘录文字 <small>可修正 OCR 识别结果</small></span>
          <textarea
            autoFocus
            required
            rows={5}
            maxLength={50_000}
            value={displayText}
            onChange={(event) => setDisplayText(event.target.value)}
          />
          <small>这里只调整卡片显示文字；PDF 原始选区、页码、高亮和定位不会改变。</small>
        </label>
        <label className="field">
          <span>标签</span>
          <TagInput value={tags} onChange={setTags} suggestions={availableTags} />
        </label>
        <details className="card-source-details">
          <summary>来源与更多信息</summary>
          <div className="form-grid two-columns">
            <label className="field">
              <span>PDF 页码与定位</span>
              <input value={`第 ${selection.pageNumber} 页 · 已保存原文坐标`} readOnly />
            </label>
            <label className="field">
              <span>印刷页码</span>
              <input
                value={automaticPrintPage ? `第 ${automaticPrintPage} 页（自动）` : '文献尚未设置印刷页映射'}
                readOnly
              />
            </label>
          </div>
          {displayText !== selection.text ? (
            <div className="original-selection-details">
              <span>未修改的 PDF 选区文字</span>
              <blockquote className="dialog-quote compact">{selection.text}</blockquote>
            </div>
          ) : null}
          <div className="source-context">
            <div>
              <span>前文</span>
              <p>{selection.contextBefore || '暂无可识别的前文'}</p>
            </div>
            <div>
              <span>后文</span>
              <p>{selection.contextAfter || '暂无可识别的后文'}</p>
            </div>
          </div>
        </details>
        <div className="modal-actions">
          <button className="button ghost" type="button" data-modal-close>
            取消
          </button>
          <button className="button primary" type="submit" disabled={saving}>
            {saving ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />} 保存卡片
          </button>
        </div>
      </form>
    </Modal>
  )
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function metadataFromDocument(document: DocumentSummary): MetadataDraft {
  return {
    title: document.title,
    authors: document.authors,
    year: document.year ? String(document.year) : '',
    journal: document.journal,
    volume: document.volume,
    issue: document.issue,
    pages: document.pages,
    doi: document.doi,
    publisher: document.publisher,
    metadataRaw: document.metadataRaw
  }
}

function metadataDraftEqual(left: MetadataDraft, right: MetadataDraft): boolean {
  return (Object.keys(EMPTY_METADATA) as Array<keyof MetadataDraft>).every(
    (key) => left[key] === right[key]
  )
}

function metadataInput(value: MetadataDraft): BibliographicMetadataInput {
  const resolved = fillBibliographyFromRaw(value)
  return {
    title: resolved.title.trim(),
    authors: resolved.authors.trim(),
    year: resolved.year ? Number(resolved.year) : null,
    journal: resolved.journal.trim(),
    volume: resolved.volume.trim(),
    issue: resolved.issue.trim(),
    pages: resolved.pages.trim(),
    doi: resolved.doi.trim(),
    publisher: resolved.publisher.trim(),
    metadataRaw: resolved.metadataRaw.trim()
  }
}

function bibliographyFormatLabel(format: ParsedBibliography['format']): string {
  return {
    bibtex: 'BibTeX',
    ris: 'RIS',
    endnote: 'EndNote Tagged',
    gbt7714: '知网 / GB/T 7714 引文',
    apa: 'APA 引文',
    labeled: '字段标签文本'
  }[format]
}

function bibliographyPreview(parsed: ParsedBibliography): string {
  return [
    parsed.authors,
    parsed.title,
    parsed.journal,
    parsed.year ? String(parsed.year) : undefined,
    parsed.volume ? `卷 ${parsed.volume}` : undefined,
    parsed.issue ? `期 ${parsed.issue}` : undefined,
    parsed.pages ? `页 ${parsed.pages}` : undefined,
    parsed.doi ? `DOI ${parsed.doi}` : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}

function loadReadingPanelWidths(): ReadingPanelWidths {
  if (typeof window === 'undefined') return { ...DEFAULT_READING_PANEL_WIDTHS }
  try {
    const stored = window.localStorage.getItem(READING_PANEL_STORAGE_KEY)
    return stored ? normalizeReadingPanelWidths(JSON.parse(stored) as unknown) : { ...DEFAULT_READING_PANEL_WIDTHS }
  } catch {
    return { ...DEFAULT_READING_PANEL_WIDTHS }
  }
}

function normalizeError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return '发生未知错误。'
  }
}
