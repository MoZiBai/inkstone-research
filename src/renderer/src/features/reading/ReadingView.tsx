import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FilePenLine,
  FileText,
  FolderOpen,
  Highlighter,
  Library,
  Lightbulb,
  Link2,
  LoaderCircle,
  MessageCircleQuestion,
  RotateCcw,
  Trash2,
  Underline
} from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BibliographicMetadataInput,
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
import { ConfirmDialog, Modal } from '../../components/Modal'
import { api } from '../../lib/api'
import type { Notify, RunMutation } from '../../types'
import { PdfViewer } from './PdfViewer'
import {
  fillBibliographyFromRaw,
  mergeParsedBibliography,
  parseBibliography,
  type ParsedBibliography
} from './bibliographyParser'
import { titleAfterPdfSelection } from './pdfImportDraft'
import { parsePdfLocator, type PdfSelection } from './pdfLocator'
import { partitionItemsByPage } from './readingPageItems'
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

export interface ReadingFocusRequest {
  token: number
  documentId: string
  page: number | null
  locator: PdfLocator | null
}

interface ReadingViewProps {
  snapshot: WorkspaceSnapshot
  runMutation: RunMutation
  notify: Notify
  initialRequest?: ReadingFocusRequest | null
  onFocusHandled?: () => void
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
type ReadingInspectorSection = 'document' | 'notes' | 'cards' | 'annotations'

export function ReadingView({
  snapshot,
  runMutation,
  notify,
  initialRequest,
  onFocusHandled
}: ReadingViewProps): React.JSX.Element {
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(
    initialRequest?.documentId ?? snapshot.documents[0]?.id ?? null
  )
  const [showDocumentDialog, setShowDocumentDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importTargetDocumentId, setImportTargetDocumentId] = useState<string | null>(null)
  const [importSourcePath, setImportSourcePath] = useState<string | null>(null)
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
  const [collapsedInspectorSections, setCollapsedInspectorSections] = useState<
    Set<ReadingInspectorSection>
  >(() => new Set(['document']))
  const [panelWidths, setPanelWidths] = useState<ReadingPanelWidths>(loadReadingPanelWidths)
  const [resizingPanel, setResizingPanel] = useState<ReadingPanel | null>(null)
  const focusCounter = useRef(0)
  const readingLayoutRef = useRef<HTMLDivElement>(null)

  const selectedDocument = useMemo(
    () => snapshot.documents.find((document) => document.id === selectedDocumentId) ?? null,
    [selectedDocumentId, snapshot.documents]
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
  const activeDocuments = useMemo(
    () => snapshot.documents.filter((document) => !document.isRemoved),
    [snapshot.documents]
  )
  const removedDocuments = useMemo(
    () => snapshot.documents.filter((document) => document.isRemoved),
    [snapshot.documents]
  )

  useEffect(() => {
    if (initialRequest) {
      setSelectedDocumentId(initialRequest.documentId)
      setFocusRequest(initialRequest)
      const timeout = window.setTimeout(() => onFocusHandled?.(), 900)
      return () => window.clearTimeout(timeout)
    }
    return undefined
  }, [initialRequest, onFocusHandled])

  useEffect(() => {
    if (snapshot.documents.some((document) => document.id === selectedDocumentId)) return
    setSelectedDocumentId(activeDocuments[0]?.id ?? null)
  }, [activeDocuments, selectedDocumentId, snapshot.currentProjectId, snapshot.documents])

  useEffect(() => setCurrentPdfPage(1), [selectedDocument?.id])

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
    setImportSourcePath(null)
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
        multiple: false,
        directory: false,
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
      })
      if (typeof selected !== 'string') return
      setImportSourcePath(selected)
      setMetadata((current) => ({
        ...current,
        title: titleAfterPdfSelection(selected, importTargetDocumentId, current.title)
      }))
    } catch (error) {
      notify(normalizeError(error), 'error')
    }
  }

  const importPdf = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!snapshot.currentProjectId || !importSourcePath) {
      notify('请先选择一个 PDF 文件。', 'warning')
      return
    }
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
      setImportSourcePath(null)
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

  const revealDocument = async (): Promise<void> => {
    if (!selectedDocument?.filePath) return
    try {
      await api.revealPdfInFileManager(selectedDocument.id)
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
      if (!keepCards) setSelectedDocumentId(activeDocuments.find((document) => document.id !== removingDocument.id)?.id ?? null)
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
    printPage: string
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
          printPage: input.printPage.trim() || null,
          locatorJson: JSON.stringify(selection.locator),
          contextBefore: selection.contextBefore,
          contextAfter: selection.contextAfter,
          comment: input.comment,
          tags: input.tags,
          sourceReadingNoteId: pendingCard.sourceReadingNoteId
        }),
      pendingCard.sourceReadingNoteId
        ? '阅读笔记已转为研究卡片并从笔记列表移除。'
        : '研究卡片和对应高亮已创建，并放入“待归类”。'
    )
    if (succeeded) setPendingCard(null)
  }

  const createAnnotation = async (
    selection: PdfSelection,
    kind: PdfAnnotationKind
  ): Promise<void> => {
    if (!snapshot.currentProjectId || !selectedDocument) return
    await runMutation(
      () =>
        api.createPdfAnnotation({
          projectId: snapshot.currentProjectId as string,
          documentId: selectedDocument.id,
          kind,
          pageNumber: selection.pageNumber,
          color: kind === 'highlight' ? '#e8bd55' : '#a45f45',
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

  const updateAnnotation = async (color: string, comment: string): Promise<void> => {
    if (!editingAnnotation) return
    const succeeded = await runMutation(
      () => api.updatePdfAnnotation({ annotationId: editingAnnotation.id, color, comment }),
      'PDF 批注已更新。'
    )
    if (succeeded) setEditingAnnotation(null)
  }

  return (
    <div
      className={`reading-layout ${resizingPanel ? 'resizing' : ''}`}
      ref={readingLayoutRef}
      style={
        {
          '--document-rail-width': `${panelWidths.documents}px`,
          '--reading-inspector-width': `${panelWidths.inspector}px`
        } as React.CSSProperties
      }
    >
      <aside className="document-rail">
        <div className="panel-heading compact">
          <div>
            <span className="eyebrow">项目文献</span>
            <h2>{activeDocuments.length} 篇文献</h2>
          </div>
          <div className="document-rail-actions">
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
        <div className="document-list">
          {activeDocuments.map((document) => (
            <button
              className={`document-item ${selectedDocument?.id === document.id ? 'active' : ''}`}
              type="button"
              key={document.id}
              onClick={() => setSelectedDocumentId(document.id)}
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
                  {document.filePath ? '已连接 PDF' : '尚未连接 PDF'} · {document.cardCount} 张卡片
                </em>
              </span>
              {document.filePath ? null : <ChevronRight size={14} className="document-unlinked" />}
            </button>
          ))}
          {activeDocuments.length === 0 ? (
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
          <PdfViewer
            document={selectedDocument}
            annotations={documentAnnotations}
            cards={documentCards}
            focusToken={focusRequest?.documentId === selectedDocument.id ? focusRequest.token : 0}
            focusPage={focusRequest?.documentId === selectedDocument.id ? focusRequest.page : null}
            focusLocator={focusRequest?.documentId === selectedDocument.id ? focusRequest.locator : null}
            onCreateCard={(selection) => void createCard(selection)}
            onCreateAnnotation={(selection, kind) => void createAnnotation(selection, kind)}
            onCreateReadingNote={(selection, kind) => setPendingNote({ selection, kind })}
            onRequestDeleteAnnotation={setDeletingAnnotation}
            onCurrentPageChange={setCurrentPdfPage}
            onNotify={notify}
          />
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
                ? '数据库中的研究卡片、标注和原文坐标仍然完整。请选择这篇文献的 PDF 重新链接；原文件不会被修改。'
                : '选择原始 PDF 后，砚台会按 SHA-256 保存一份只读副本。原文件不会被修改，后续摘录和批注会保存在本地 SQLite。'}
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

      <ReadingResizeHandle
        panel="inspector"
        value={panelWidths.inspector}
        label="调整当前文献信息栏宽度"
        onPointerDown={() => setResizingPanel('inspector')}
        onAdjust={(delta) => adjustPanelWidth('inspector', delta)}
        onReset={() => resetPanelWidth('inspector')}
      />

      <aside className="reading-inspector">
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
                      <dt>研究数据</dt>
                      <dd>{documentCards.length} 卡片 · {documentAnnotations.length} 批注 · {documentNotes.length} 思考</dd>
                    </div>
                  </dl>
                  {selectedDocument.fileAvailable ? (
                    <div className="boundary-note">
                      <strong>当前能力边界</strong>
                      <span>支持文字型 PDF；扫描件 OCR 尚未接入。</span>
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
                  {documentNotes.length > 0 ? (
                    <div className="reading-note-list">
                      {documentNotes.map((note) => (
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
                    <p className="reading-inspector-empty">还没有灵感或质疑。</p>
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
                  {documentCards.length > 0 ? (
                    <div className="reading-reference-items">
                      {cardPagePartition.currentPageItems.length > 0 ? (
                        <div className="reading-page-group-label current">当前第 {currentPdfPage} 页</div>
                      ) : null}
                      {cardPagePartition.currentPageItems.map((card) => (
                        <button
                          type="button"
                          className="reading-reference-item current-page"
                          key={card.id}
                          onClick={() => focusDocumentLocation(card.documentId, card.pdfPage, card.locatorJson)}
                        >
                          <span className="reading-reference-page">{card.pdfPage ?? '—'}</span>
                          <span>
                            <strong>{card.displayText}</strong>
                            <small>当前页 · {card.comment || '点击回到原文位置'}</small>
                          </span>
                        </button>
                      ))}
                      {cardPagePartition.otherPageItems.length > 0 ? (
                        <div className="reading-page-group-label">其他页</div>
                      ) : null}
                      {cardPagePartition.otherPageItems.map((card) => (
                        <button
                          type="button"
                          className="reading-reference-item"
                          key={card.id}
                          onClick={() => focusDocumentLocation(card.documentId, card.pdfPage, card.locatorJson)}
                        >
                          <span className="reading-reference-page">{card.pdfPage ?? '—'}</span>
                          <span>
                            <strong>{card.displayText}</strong>
                            <small>{card.comment || '点击回到原文位置'}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="reading-inspector-empty">这篇文献还没有卡片。</p>
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
                  {documentAnnotations.length > 0 ? (
                    <div className="reading-reference-items">
                      {annotationPagePartition.currentPageItems.length > 0 ? (
                        <div className="reading-page-group-label current">当前第 {currentPdfPage} 页</div>
                      ) : null}
                      {annotationPagePartition.currentPageItems.map((annotation) => (
                        <ReadingAnnotationItem
                          key={annotation.id}
                          annotation={annotation}
                          currentPage
                          onLocate={focusDocumentLocation}
                          onEdit={setEditingAnnotation}
                          onDelete={setDeletingAnnotation}
                        />
                      ))}
                      {annotationPagePartition.otherPageItems.length > 0 ? (
                        <div className="reading-page-group-label">其他页</div>
                      ) : null}
                      {annotationPagePartition.otherPageItems.map((annotation) => (
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
                    <p className="reading-inspector-empty">这篇文献还没有高亮或下划线。</p>
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
      </aside>

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
          sourcePath={importSourcePath}
          targetDocument={snapshot.documents.find((document) => document.id === importTargetDocumentId) ?? null}
          metadata={metadata}
          onChoose={choosePdf}
          onMetadataChange={setMetadata}
          onSubmit={importPdf}
          onClose={() => setShowImportDialog(false)}
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
          availableTags={Array.from(new Set(snapshot.cards.flatMap((card) => card.tags))).sort()}
          onSave={saveCardFromSelection}
          onClose={() => setPendingCard(null)}
        />
      ) : null}

      {deletingAnnotation ? (
        <ConfirmDialog
          title="移除这条 PDF 批注？"
          description="这只会移除砚台保存的高亮或下划线，不会修改原始 PDF，也不会影响研究卡片。"
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
          description="这只删除独立的阅读笔记，不会删除研究卡片、PDF 高亮或来源文献。"
          confirmLabel="删除笔记"
          dangerous
          onConfirm={() => void removeReadingNote()}
          onCancel={() => setDeletingNote(null)}
        />
      ) : null}
    </div>
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
        title="编辑颜色与评论"
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
  const [color, setColor] = useState(annotation.color)
  const [comment, setComment] = useState(annotation.comment)
  const [saving, setSaving] = useState(false)

  return (
    <Modal
      title={`编辑${annotation.kind === 'highlight' ? '高亮' : '下划线'}批注`}
      subtitle={`PDF 第 ${annotation.pageNumber} 页 · 原文位置保持不变`}
      onClose={onClose}
      width="large"
      hasUnsavedChanges={color !== annotation.color || comment !== annotation.comment}
    >
      <form onSubmit={(event) => {
        event.preventDefault()
        setSaving(true)
        void onSave(color, comment).finally(() => setSaving(false))
      }}>
        <blockquote className="dialog-quote compact">{annotation.selectedText || '未记录选中文字'}</blockquote>
        <label className="field color-field">
          <span>批注颜色</span>
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
          <code>{color}</code>
        </label>
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
  sourcePath: string | null
  targetDocument: DocumentSummary | null
  metadata: MetadataDraft
  onChoose: () => Promise<void>
  onMetadataChange: (value: MetadataDraft) => void
  onSubmit: (event: React.FormEvent) => Promise<void>
  onClose: () => void
}

function ImportPdfDialog({
  sourcePath,
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
      subtitle="砚台会计算 SHA-256，并在应用目录保留一份只读副本；原文件不会被修改。"
      onClose={onClose}
      width="large"
      hasUnsavedChanges={
        sourcePath !== null ||
        !metadataDraftEqual(metadata, targetDocument ? metadataFromDocument(targetDocument) : EMPTY_METADATA)
      }
    >
      <form onSubmit={(event) => void onSubmit(event)}>
        <div className="pdf-file-picker">
          <div>
            <span className="eyebrow">PDF 文件</span>
            <strong>{sourcePath ? fileName(sourcePath) : '尚未选择文件'}</strong>
            <small>{sourcePath ?? '支持 .pdf；扫描件可以导入，但暂不提供 OCR 文字层。'}</small>
          </div>
          <button className="button secondary" type="button" onClick={() => void onChoose()}>
            <FilePlus2 size={15} /> 选择文件
          </button>
        </div>
        <BibliographicFields
          value={metadata}
          onChange={onMetadataChange}
          autoFocusTitle={!sourcePath}
        />
        <p className="import-note">
          同一个 PDF 在多个项目中导入时会复用文件实体；每个项目仍然拥有独立的评论、标签和论证用途。
        </p>
        <div className="modal-actions">
          <button className="button ghost" type="button" data-modal-close>
            取消
          </button>
          <button className="button primary" type="submit" disabled={!sourcePath}>
            <FilePlus2 size={15} /> 导入并打开
          </button>
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
          placeholder="输入论文、专著或报告标题"
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

interface CreateCardDialogProps {
  selection: PdfSelection
  initialComment: string
  availableTags: string[]
  onSave: (input: { displayText: string; comment: string; tags: string[]; printPage: string }) => Promise<void>
  onClose: () => void
}

function CreateCardDialog({
  selection,
  initialComment,
  availableTags,
  onSave,
  onClose
}: CreateCardDialogProps): React.JSX.Element {
  const [displayText, setDisplayText] = useState(selection.text)
  const [comment, setComment] = useState(initialComment)
  const [tags, setTags] = useState('')
  const [printPage, setPrintPage] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    try {
      await onSave({
        displayText,
        comment,
        printPage,
        tags: tags
          .split(/[、,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean)
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="创建研究卡片"
      subtitle={`PDF 第 ${selection.pageNumber} 页 · 原文和定位信息会永久保留`}
      onClose={onClose}
      width="large"
      hasUnsavedChanges={
        displayText !== selection.text ||
        comment !== initialComment ||
        tags.length > 0 ||
        printPage.length > 0
      }
    >
      <form onSubmit={(event) => void submit(event)}>
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
          <span>标签 <small>可选用已有标签，也可直接输入新标签</small></span>
          <input
            list="create-card-tag-options"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="空间组织、仪式"
          />
          <datalist id="create-card-tag-options">
            {availableTags.map((tag) => <option key={tag} value={tag} />)}
          </datalist>
        </label>
        <label className="field">
          <span>即时笔记</span>
          <textarea
            rows={5}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="记录这段材料为什么重要、如何使用或有哪些疑问……"
          />
        </label>
        <details className="card-source-details">
          <summary>来源与更多信息</summary>
          <div className="form-grid two-columns">
            <label className="field">
              <span>PDF 页码与定位</span>
              <input value={`第 ${selection.pageNumber} 页 · 已保存原文坐标`} readOnly />
            </label>
            <label className="field">
              <span>印刷页码（可选）</span>
              <input value={printPage} onChange={(event) => setPrintPage(event.target.value)} placeholder="例如 103" />
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
