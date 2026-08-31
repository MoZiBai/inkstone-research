import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  MousePointer2,
  Search,
  Trash2,
  Underline,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask
} from 'pdfjs-dist'
import { TextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DocumentSummary,
  PdfAnnotation,
  PdfAnnotationKind,
  PdfLocator,
  ProjectCardView
} from '@shared/types'
import { api } from '../../lib/api'
import { ContextMenu } from '../../components/ContextMenu'
import type { Notify } from '../../types'
import {
  buildContext,
  locatorFromRange,
  parsePdfLocator,
  pdfLocatorContainsPoint,
  type PdfSelection
} from './pdfLocator'
import { clampPdfScale, scaleFromCtrlWheel, scaleFromStep } from './pdfZoom'
import { findPdfTextMatches, nextPdfSearchIndex, type PdfTextSearchMatch } from './pdfSearch'

GlobalWorkerOptions.workerSrc = workerUrl

const EMPTY_PDF_ANNOTATIONS: PdfAnnotation[] = []
const EMPTY_PROJECT_CARDS: ProjectCardView[] = []
const EMPTY_PDF_SEARCH_MATCHES: PdfTextSearchMatch[] = []

interface PdfViewerProps {
  document: DocumentSummary
  annotations: PdfAnnotation[]
  cards: ProjectCardView[]
  focusToken: number
  focusPage: number | null
  focusLocator: PdfLocator | null
  onCreateCard: (selection: PdfSelection) => void
  onCreateAnnotation: (selection: PdfSelection, kind: PdfAnnotationKind, color: string) => void
  onCreateReadingNote: (selection: PdfSelection, kind: 'insight' | 'critique') => void
  onRequestDeleteAnnotation: (annotation: PdfAnnotation) => void
  onRequestEditAnnotation: (annotation: PdfAnnotation) => void
  onUpdateAnnotation: (annotation: PdfAnnotation, color: string, comment: string) => Promise<boolean>
  onCurrentPageChange: (pageNumber: number) => void
  onNotify: Notify
}

interface PageInfo {
  pageNumber: number
  width: number
  height: number
}

interface ToolbarPosition {
  left: number
  top: number
}

interface AnnotationMenuState extends ToolbarPosition {
  pageNumber: number
  annotations: PdfAnnotation[]
}

interface SelectionColorPickerState extends ToolbarPosition {
  kind: PdfAnnotationKind
}

export function PdfViewer({
  document,
  annotations,
  cards,
  focusToken,
  focusPage,
  focusLocator,
  onCreateCard,
  onCreateAnnotation,
  onCreateReadingNote,
  onRequestDeleteAnnotation,
  onRequestEditAnnotation,
  onUpdateAnnotation,
  onCurrentPageChange,
  onNotify
}: PdfViewerProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  const pageRefCallbacks = useRef(
    new Map<number, (element: HTMLDivElement | null) => void>()
  )
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const fitModeRef = useRef(true)
  const scaleRef = useRef(1)
  const zoomFrameRef = useRef<number | null>(null)
  const focusHandledRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchGenerationRef = useRef(0)
  const pageTextCacheRef = useRef(new Map<number, string>())
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState<PageInfo[]>([])
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set([1, 2]))
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [selection, setSelection] = useState<PdfSelection | null>(null)
  const [toolbarPosition, setToolbarPosition] = useState<ToolbarPosition | null>(null)
  const [annotationMenu, setAnnotationMenu] = useState<AnnotationMenuState | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState<PdfTextSearchMatch[]>([])
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1)
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'ready' | 'error'>('idle')
  const [viewerContextMenu, setViewerContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [annotationColors, setAnnotationColors] = useState<Record<PdfAnnotationKind, string>>(
    loadDefaultAnnotationColors
  )
  const [selectionColorPicker, setSelectionColorPicker] = useState<SelectionColorPickerState | null>(null)

  const clearSelection = useCallback((): void => {
    setSelection(null)
    setToolbarPosition(null)
    setAnnotationMenu(null)
    setSelectionColorPicker(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  const closeSearch = useCallback((): void => {
    searchGenerationRef.current += 1
    setSearchOpen(false)
    setSearchQuery('')
    setSearchMatches([])
    setActiveSearchIndex(-1)
    setSearchState('idle')
  }, [])

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 'f') return
      event.preventDefault()
      setSearchOpen(true)
      window.setTimeout(() => searchInputRef.current?.focus(), 0)
    }
    window.addEventListener('keydown', handleFindShortcut)
    return () => window.removeEventListener('keydown', handleFindShortcut)
  }, [])

  useEffect(() => {
    if (!selection || !toolbarPosition) return undefined
    const dismissOnOutsidePointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.pdf-selection-toolbar, .selection-annotation-colors')) return
      clearSelection()
    }
    window.addEventListener('pointerdown', dismissOnOutsidePointerDown, true)
    return () => window.removeEventListener('pointerdown', dismissOnOutsidePointerDown, true)
  }, [clearSelection, selection, toolbarPosition])

  useEffect(() => {
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | null = null
    let loadedPdf: PDFDocumentProxy | null = null
    fitModeRef.current = true
    scaleRef.current = 1
    focusHandledRef.current = 0
    setPdf(null)
    setPages([])
    pageRefs.current.clear()
    setNumPages(0)
    setCurrentPage(1)
    setScale(1)
    setVisiblePages(new Set([1, 2]))
    setSelection(null)
    setToolbarPosition(null)
    setLoadState('loading')
    setLoadError('')
    pageTextCacheRef.current.clear()
    searchGenerationRef.current += 1
    setSearchQuery('')
    setSearchMatches([])
    setActiveSearchIndex(-1)
    setSearchState('idle')

    const load = async (): Promise<void> => {
      try {
        const buffer = await api.readPdf(document.id)
        if (cancelled) return
        const data = new Uint8Array(buffer)
        loadingTask = getDocument({ data })
        loadingTaskRef.current = loadingTask
        loadedPdf = await loadingTask.promise
        if (cancelled) {
          await loadedPdf.cleanup()
          return
        }
        pdfRef.current = loadedPdf
        setPdf(loadedPdf)
        setNumPages(loadedPdf.numPages)

        // The first page is enough to show the reader. Use its dimensions as a
        // temporary estimate for the remaining pages, then refine those sizes
        // in small batches in the background. A large monograph should not
        // remain blank while every page is being inspected serially.
        const firstPage = await loadedPdf.getPage(1)
        const firstViewport = firstPage.getViewport({ scale: 1 })
        const estimatedSize = {
          width: firstViewport.width,
          height: firstViewport.height
        }
        firstPage.cleanup()
        const initialPages = Array.from({ length: loadedPdf.numPages }, (_, index) => ({
          pageNumber: index + 1,
          ...estimatedSize
        }))
        if (cancelled) return
        setPages(initialPages)
        setVisiblePages(new Set([1, 2].filter((page) => page <= loadedPdf!.numPages)))
        setLoadState('ready')

        const pageDocument = loadedPdf
        const batchSize = 4
        for (let start = 2; start <= pageDocument.numPages; start += batchSize) {
          if (cancelled) return
          const pageNumbers = Array.from(
            { length: Math.min(batchSize, pageDocument.numPages - start + 1) },
            (_, index) => start + index
          )
          const batch = await Promise.all(
            pageNumbers.map(async (pageNumber): Promise<PageInfo | null> => {
              let page: PDFPageProxy | null = null
              try {
                page = await pageDocument.getPage(pageNumber)
                const viewport = page.getViewport({ scale: 1 })
                return {
                  pageNumber,
                  width: viewport.width,
                  height: viewport.height
                }
              } catch {
                // Keep the estimated page size if one page has a recoverable
                // metadata error; the page renderer will report a more useful
                // error if the user scrolls to it.
                return null
              } finally {
                page?.cleanup()
              }
            })
          )
          if (cancelled) return
          const refined = new Map(
            batch
              .filter((page): page is PageInfo => page !== null)
              .map((page) => [page.pageNumber, page] as const)
          )
          if (refined.size > 0) {
            setPages((current) => current.map((page) => refined.get(page.pageNumber) ?? page))
          }
          // Yield between batches so scrolling and selection remain responsive.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
        }
      } catch (error) {
        if (cancelled) return
        setLoadState('error')
        setLoadError(normalizePdfError(error))
      }
    }

    void load()
    return () => {
      cancelled = true
      loadingTaskRef.current = null
      if (loadingTask) void loadingTask.destroy()
      if (loadedPdf) void loadedPdf.cleanup()
      pdfRef.current = null
    }
  }, [document.id])

  useEffect(() => {
    if (!searchOpen || !pdf) return undefined
    const query = searchQuery.trim().toLocaleLowerCase()
    const generation = searchGenerationRef.current + 1
    searchGenerationRef.current = generation
    if (!query) {
      setSearchMatches([])
      setActiveSearchIndex(-1)
      setSearchState('idle')
      return undefined
    }

    const timeout = window.setTimeout(() => {
      const search = async (): Promise<void> => {
        setSearchState('searching')
        const matches: PdfTextSearchMatch[] = []
        try {
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            if (searchGenerationRef.current !== generation) return
            let pageText = pageTextCacheRef.current.get(pageNumber)
            if (pageText === undefined) {
              const page = await pdf.getPage(pageNumber)
              try {
                const content = await page.getTextContent()
                pageText = content.items
                  .map((item) => ('str' in item ? item.str : ''))
                  .join('')
                pageTextCacheRef.current.set(pageNumber, pageText)
              } finally {
                page.cleanup()
              }
            }
            matches.push(...findPdfTextMatches(
              pageText,
              query,
              pageNumber,
              matches.length,
              20_000 - matches.length
            ))
            if (matches.length >= 20_000) break
            if (pageNumber % 8 === 0) {
              await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
            }
          }
          if (searchGenerationRef.current !== generation) return
          setSearchMatches(matches)
          setActiveSearchIndex(matches.length > 0 ? 0 : -1)
          setSearchState('ready')
        } catch {
          if (searchGenerationRef.current !== generation) return
          setSearchMatches([])
          setActiveSearchIndex(-1)
          setSearchState('error')
        }
      }
      void search()
    }, 180)

    return () => window.clearTimeout(timeout)
  }, [pdf, searchOpen, searchQuery])

  useEffect(() => onCurrentPageChange(currentPage), [currentPage, onCurrentPageChange])

  useEffect(() => {
    const root = stageRef.current
    if (!root || pages.length === 0) return

    const renderObserver = new IntersectionObserver(
      (entries) => {
        setVisiblePages((current) => {
          const next = new Set(current)
          for (const entry of entries) {
            const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber)
            if (!Number.isInteger(pageNumber)) continue
            if (entry.isIntersecting) next.add(pageNumber)
            else next.delete(pageNumber)
          }
          return next
        })
      },
      { root, rootMargin: '900px 0px', threshold: [0, 0.1, 0.5, 0.9] }
    )

    const actualVisibility = new Map<number, number>()
    const pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber)
          if (!Number.isInteger(pageNumber)) continue
          if (entry.isIntersecting) actualVisibility.set(pageNumber, entry.intersectionRatio)
          else actualVisibility.delete(pageNumber)
        }
        setCurrentPage((current) => {
          let next = current
          let bestRatio = actualVisibility.get(current) ?? -1
          for (const [pageNumber, ratio] of actualVisibility) {
            if (ratio > bestRatio + 0.001) {
              next = pageNumber
              bestRatio = ratio
            }
          }
          return next
        })
      },
      { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1] }
    )

    for (const element of pageRefs.current.values()) {
      renderObserver.observe(element)
      pageObserver.observe(element)
    }
    return () => {
      renderObserver.disconnect()
      pageObserver.disconnect()
    }
  }, [document.id, pages.length, scale])

  const firstPageWidth = pages[0]?.width ?? 0
  const fitToWidth = useCallback((): void => {
    const root = stageRef.current
    if (!firstPageWidth || !root) return
    const availableWidth = Math.max(240, root.clientWidth - 64)
    const nextScale = clampPdfScale(availableWidth / firstPageWidth)
    fitModeRef.current = true
    scaleRef.current = nextScale
    setScale(nextScale)
  }, [firstPageWidth])

  useEffect(() => {
    if (pages.length === 0) return
    const root = stageRef.current
    if (!root) return
    const fit = (): void => {
      if (root.clientWidth > 0 && fitModeRef.current) fitToWidth()
    }
    fit()
    let resizeTimeout: number | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimeout !== null) window.clearTimeout(resizeTimeout)
      resizeTimeout = window.setTimeout(fit, 180)
    })
    observer.observe(root)
    return () => {
      observer.disconnect()
      if (resizeTimeout !== null) window.clearTimeout(resizeTimeout)
    }
  }, [fitToWidth, pages.length])

  const changeScale = useCallback((nextScale: number): void => {
    const clamped = clampPdfScale(nextScale)
    fitModeRef.current = false
    scaleRef.current = clamped
    setScale(clamped)
  }, [])

  useEffect(() => {
    const root = stageRef.current
    if (!root || loadState !== 'ready') return undefined

    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const nextScale = scaleFromCtrlWheel(scaleRef.current, event.deltaY)
      if (nextScale === scaleRef.current) return

      const target = event.target instanceof Element ? event.target : null
      const pageElement = target?.closest<HTMLDivElement>('[data-page-number]') ?? null
      const pageNumber = pageElement ? Number(pageElement.dataset.pageNumber) : null
      const pageRect = pageElement?.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      const anchor = pageRect && pageRect.width > 0 && pageRect.height > 0
        ? {
            pageNumber,
            x: (event.clientX - pageRect.left) / pageRect.width,
            y: (event.clientY - pageRect.top) / pageRect.height
          }
        : null
      const fallback = {
        x: root.scrollLeft + event.clientX - rootRect.left,
        y: root.scrollTop + event.clientY - rootRect.top,
        ratio: nextScale / scaleRef.current
      }

      clearSelection()
      changeScale(nextScale)

      if (zoomFrameRef.current !== null) window.cancelAnimationFrame(zoomFrameRef.current)
      zoomFrameRef.current = window.requestAnimationFrame(() => {
        zoomFrameRef.current = window.requestAnimationFrame(() => {
          if (anchor?.pageNumber) {
            const updatedPage = pageRefs.current.get(anchor.pageNumber)
            const updatedRect = updatedPage?.getBoundingClientRect()
            if (updatedRect) {
              root.scrollLeft += updatedRect.left + updatedRect.width * anchor.x - event.clientX
              root.scrollTop += updatedRect.top + updatedRect.height * anchor.y - event.clientY
            }
          } else {
            root.scrollLeft = fallback.x * fallback.ratio - (event.clientX - rootRect.left)
            root.scrollTop = fallback.y * fallback.ratio - (event.clientY - rootRect.top)
          }
          zoomFrameRef.current = null
        })
      })
    }

    root.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      root.removeEventListener('wheel', handleWheel)
      if (zoomFrameRef.current !== null) window.cancelAnimationFrame(zoomFrameRef.current)
    }
  }, [changeScale, clearSelection, loadState])

  const scrollToPage = useCallback((pageNumber: number, locator?: PdfLocator | null): void => {
    const root = stageRef.current
    const pageElement = pageRefs.current.get(pageNumber)
    if (!root || !pageElement) return
    setCurrentPage(pageNumber)
    const rootRect = root.getBoundingClientRect()
    const pageRect = pageElement.getBoundingClientRect()
    const offset = locator?.rects[0]?.y
      ? locator.rects[0].y * pageRect.height
      : 0
    const top = root.scrollTop + pageRect.top - rootRect.top + offset - 72
    root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [])

  const activeSearchMatch = activeSearchIndex >= 0 ? searchMatches[activeSearchIndex] ?? null : null

  useEffect(() => {
    if (!activeSearchMatch) return undefined
    setVisiblePages((current) => {
      if (current.has(activeSearchMatch.pageNumber)) return current
      const next = new Set(current)
      next.add(activeSearchMatch.pageNumber)
      return next
    })
    const timeout = window.setTimeout(() => scrollToPage(activeSearchMatch.pageNumber), 40)
    return () => window.clearTimeout(timeout)
  }, [activeSearchMatch, scrollToPage])

  const moveSearchResult = (direction: -1 | 1): void => {
    if (searchMatches.length === 0) return
    setActiveSearchIndex((current) => nextPdfSearchIndex(current, searchMatches.length, direction))
  }

  useEffect(() => {
    if (!focusToken || focusToken === focusHandledRef.current || pages.length === 0) return
    if (!focusPage || focusPage < 1 || focusPage > pages.length) return
    focusHandledRef.current = focusToken
    const timeout = window.setTimeout(() => scrollToPage(focusPage, focusLocator), 80)
    return () => window.clearTimeout(timeout)
  }, [focusLocator, focusPage, focusToken, pages.length, scrollToPage])

  const handleSelection = useCallback(
    (pageNumber: number, pageElement: HTMLDivElement): void => {
      window.requestAnimationFrame(() => {
        const browserSelection = window.getSelection()
        if (!browserSelection || browserSelection.rangeCount === 0 || browserSelection.isCollapsed) {
          return
        }
        const range = browserSelection.getRangeAt(0)
        const selectedText = browserSelection.toString()
        if (!selectedText.trim()) return

        const rangeRects = selectionClientRects(range, pageRefs.current.values())
        if (rangeRects.length === 0) {
          onNotify('没有取得有效的文字范围，请重新选择文字。')
          return
        }
        const touchedPages = Array.from(pageRefs.current.entries()).filter(([, candidate]) => {
          const candidateRect = candidate.getBoundingClientRect()
          return rangeRects.some((rect) => rectanglesOverlap(rect, candidateRect))
        })
        if (touchedPages.length > 1) {
          onNotify('暂只支持在同一页内创建摘录或批注，请分开选择。')
          clearSelection()
          return
        }
        const locator = locatorFromRange(range, pageElement, pageNumber, rangeRects)
        if (!locator) {
          onNotify('没有取得有效的文字位置，请重新选择文字。')
          return
        }
        const textLayer = pageElement.querySelector<HTMLElement>('.textLayer')
        const context = buildContext(textLayer?.textContent ?? '', selectedText)
        const clientRect = unionRects(rangeRects)
        setSelection({
          pageNumber,
          text: selectedText,
          locator,
          contextBefore: context.before,
          contextAfter: context.after,
          clientRect
        })
        setAnnotationMenu(null)
        const toolbarWidth = Math.min(660, window.innerWidth - 24)
        setToolbarPosition({
          left: Math.min(
            window.innerWidth - toolbarWidth - 12,
            Math.max(12, clientRect.left + clientRect.width / 2 - toolbarWidth / 2)
          ),
          top: Math.max(12, clientRect.top - 48)
        })
      })
    },
    [clearSelection, onNotify]
  )

  const openAnnotationMenu = useCallback(
    (
      pageNumber: number,
      matchedAnnotations: PdfAnnotation[],
      clientX: number,
      clientY: number
    ): void => {
      clearSelection()
      const menuWidth = Math.min(310, Math.max(0, window.innerWidth - 24))
      const menuHeight = Math.min(274, 46 + matchedAnnotations.length * 54)
      const left = Math.min(
        window.innerWidth - menuWidth - 12,
        Math.max(12, clientX - menuWidth / 2)
      )
      const preferredTop = clientY > window.innerHeight * 0.65
        ? clientY - menuHeight - 12
        : clientY + 12
      const top = Math.max(12, Math.min(window.innerHeight - menuHeight - 12, preferredTop))
      setAnnotationMenu({ pageNumber, annotations: matchedAnnotations, left, top })
    },
    [clearSelection]
  )

  const createCard = (): void => {
    if (!selection) return
    onCreateCard(selection)
    clearSelection()
  }

  const createAnnotation = (kind: PdfAnnotationKind, color = annotationColors[kind]): void => {
    if (!selection) return
    onCreateAnnotation(selection, kind, color)
    clearSelection()
  }

  const chooseAnnotationColor = (kind: PdfAnnotationKind, color: string): void => {
    setAnnotationColors((current) => ({ ...current, [kind]: color }))
    saveDefaultAnnotationColor(kind, color)
    createAnnotation(kind, color)
  }

  const toggleSelectionColorPicker = (
    event: React.MouseEvent<HTMLButtonElement>,
    kind: PdfAnnotationKind
  ): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const menuWidth = 166
    const menuHeight = 38
    const preferredTop = rect.bottom + 7
    setSelectionColorPicker((current) => current?.kind === kind
      ? null
      : {
          kind,
          left: Math.min(
            window.innerWidth - menuWidth - 12,
            Math.max(12, rect.left + rect.width / 2 - menuWidth / 2)
          ),
          top: preferredTop + menuHeight <= window.innerHeight - 12
            ? preferredTop
            : Math.max(12, rect.top - menuHeight - 7)
        })
  }

  const createReadingNote = (kind: 'insight' | 'critique'): void => {
    if (!selection) return
    onCreateReadingNote(selection, kind)
    clearSelection()
  }

  const pageAnnotations = useMemo(() => {
    const byPage = new Map<number, PdfAnnotation[]>()
    for (const annotation of annotations) {
      const current = byPage.get(annotation.pageNumber) ?? []
      current.push(annotation)
      byPage.set(annotation.pageNumber, current)
    }
    return byPage
  }, [annotations])

  const pageSearchMatches = useMemo(() => {
    const byPage = new Map<number, PdfTextSearchMatch[]>()
    for (const match of searchMatches) {
      const current = byPage.get(match.pageNumber) ?? []
      current.push(match)
      byPage.set(match.pageNumber, current)
    }
    return byPage
  }, [searchMatches])

  const cardsByPage = useMemo(() => {
    const byPage = new Map<number, ProjectCardView[]>()
    for (const card of cards) {
      if (card.pdfPage === null) continue
      const current = byPage.get(card.pdfPage) ?? []
      current.push(card)
      byPage.set(card.pdfPage, current)
    }
    return byPage
  }, [cards])

  const pageRefFor = useCallback((pageNumber: number) => {
    const existing = pageRefCallbacks.current.get(pageNumber)
    if (existing) return existing
    const callback = (element: HTMLDivElement | null): void => {
      if (element) pageRefs.current.set(pageNumber, element)
      else pageRefs.current.delete(pageNumber)
    }
    pageRefCallbacks.current.set(pageNumber, callback)
    return callback
  }, [])

  if (loadState === 'loading') {
    return (
      <div className="pdf-viewer-state">
        <LoaderCircle className="spin" size={24} />
        <strong>正在打开 PDF</strong>
        <span>只在需要时渲染页面，文字层随后加载。</span>
      </div>
    )
  }

  if (loadState === 'error') {
    return (
      <div className="pdf-viewer-state error">
        <AlertTriangle size={24} />
        <strong>PDF 无法打开</strong>
        <span>{loadError || '文件可能已损坏，或暂不支持该加密方式。'}</span>
      </div>
    )
  }

  if (!pdf || pages.length === 0) {
    return (
      <div className="pdf-viewer-state">
        <LoaderCircle className="spin" size={24} />
        <strong>正在准备页面</strong>
      </div>
    )
  }

  return (
    <div
      className="pdf-viewer"
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setViewerContextMenu({ x: event.clientX, y: event.clientY })
      }}
      onPointerDownCapture={(event) => {
        if (!annotationMenu) return
        const target = event.target instanceof Element ? event.target : null
        if (!target?.closest('.pdf-annotation-menu')) setAnnotationMenu(null)
      }}
    >
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF 阅读工具">
        <div className="pdf-toolbar-group">
          <button
            className="pdf-tool-button"
            type="button"
            onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            aria-label="上一页"
            title="上一页"
          >
            <ChevronLeft size={16} />
          </button>
          <label className="pdf-page-input">
            <span className="sr-only">当前页</span>
            <input
              type="number"
              min={1}
              max={numPages}
              value={currentPage}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (Number.isInteger(next)) setCurrentPage(Math.min(numPages, Math.max(1, next)))
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') scrollToPage(currentPage)
              }}
              onBlur={() => scrollToPage(currentPage)}
            />
            <span>/ {numPages}</span>
          </label>
          <button
            className="pdf-tool-button"
            type="button"
            onClick={() => scrollToPage(Math.min(numPages, currentPage + 1))}
            disabled={currentPage >= numPages}
            aria-label="下一页"
            title="下一页"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="pdf-toolbar-divider" />
        <div className="pdf-toolbar-group">
          <button
            className="pdf-tool-button"
            type="button"
            onClick={() => changeScale(scaleFromStep(scaleRef.current, -1))}
            aria-label="缩小"
            title="缩小"
          >
            <ZoomOut size={15} />
          </button>
          <span className="pdf-zoom-value">{Math.round(scale * 100)}%</span>
          <button
            className="pdf-tool-button"
            type="button"
            onClick={() => changeScale(scaleFromStep(scaleRef.current, 1))}
            aria-label="放大"
            title="放大"
          >
            <ZoomIn size={15} />
          </button>
          <button className="pdf-tool-button text-tool" type="button" onClick={fitToWidth} title="适合宽度">
            <Maximize2 size={14} />
            <span>适合宽度</span>
          </button>
        </div>
        <div className="pdf-toolbar-divider" />
        <button
          className={`pdf-tool-button text-tool ${searchOpen ? 'active' : ''}`}
          type="button"
          onClick={() => {
            if (searchOpen) closeSearch()
            else {
              setSearchOpen(true)
              window.setTimeout(() => searchInputRef.current?.focus(), 0)
            }
          }}
          title="在当前 PDF 中查找（Ctrl+F）"
          aria-pressed={searchOpen}
        >
          <Search size={14} /><span>查找</span>
        </button>
        <div className="pdf-toolbar-hint">
          <MousePointer2 size={14} /> 选中文字后可摘录、划线或高亮 · Ctrl + 滚轮缩放
        </div>
      </div>

      {searchOpen ? (
        <div className="pdf-search-panel" role="search" aria-label="在当前 PDF 中查找">
          <Search size={15} />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                moveSearchResult(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                closeSearch()
              }
            }}
            placeholder="输入关键词"
            aria-label="PDF 搜索关键词"
          />
          <span className={`pdf-search-count ${searchState === 'error' ? 'error' : ''}`}>
            {searchState === 'searching'
              ? '正在检索…'
              : searchState === 'error'
                ? '检索失败'
                : searchMatches.length > 0
                  ? `${activeSearchIndex + 1} / ${searchMatches.length}`
                  : searchQuery.trim()
                    ? '0 / 0'
                    : '输入后搜索'}
          </span>
          <button type="button" disabled={searchMatches.length === 0} onClick={() => moveSearchResult(-1)} aria-label="上一个匹配" title="上一个匹配（Shift+Enter）"><ChevronLeft size={15} /></button>
          <button type="button" disabled={searchMatches.length === 0} onClick={() => moveSearchResult(1)} aria-label="下一个匹配" title="下一个匹配（Enter）"><ChevronRight size={15} /></button>
          <button type="button" onClick={closeSearch} aria-label="关闭 PDF 搜索"><X size={15} /></button>
        </div>
      ) : null}

      <div
        className="pdf-scroll"
        ref={stageRef}
        onScroll={() => {
          if (selection) clearSelection()
        }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) clearSelection()
        }}
      >
        <div className="pdf-page-stack">
          {pages.map((pageInfo) => (
            <PdfPageView
              key={pageInfo.pageNumber}
              pageInfo={pageInfo}
              pdf={pdf}
              scale={scale}
              visible={visiblePages.has(pageInfo.pageNumber)}
              annotations={pageAnnotations.get(pageInfo.pageNumber) ?? EMPTY_PDF_ANNOTATIONS}
              cards={cardsByPage.get(pageInfo.pageNumber) ?? EMPTY_PROJECT_CARDS}
              searchMatches={pageSearchMatches.get(pageInfo.pageNumber) ?? EMPTY_PDF_SEARCH_MATCHES}
              activeSearchMatchId={activeSearchMatch?.pageNumber === pageInfo.pageNumber ? activeSearchMatch.id : null}
              onSelection={handleSelection}
              onAnnotationClick={openAnnotationMenu}
              pageRef={pageRefFor(pageInfo.pageNumber)}
            />
          ))}
        </div>
      </div>

      {selection && toolbarPosition ? (
        <div
          className="pdf-selection-toolbar"
          style={{ left: toolbarPosition.left, top: toolbarPosition.top }}
          onMouseDown={(event) => event.preventDefault()}
          role="toolbar"
          aria-label="选区操作"
        >
          <button type="button" onClick={createCard} title="创建研究卡片">
            <span className="selection-tool-mark card-mark">卡</span>摘录成卡片
          </button>
          <div className="selection-annotation-tool">
            <button type="button" onClick={() => createAnnotation('highlight')} title="使用当前颜色保存高亮">
              <Highlighter size={14} />高亮
              <span className="selection-current-color" style={{ '--swatch-color': annotationColors.highlight } as React.CSSProperties} />
            </button>
            <button
              className="selection-color-trigger"
              type="button"
              onClick={(event) => toggleSelectionColorPicker(event, 'highlight')}
              title="选择高亮颜色"
              aria-label="选择高亮颜色"
              aria-expanded={selectionColorPicker?.kind === 'highlight'}
            >
              <ChevronRight size={12} />
            </button>
          </div>
          <div className="selection-annotation-tool">
            <button type="button" onClick={() => createAnnotation('underline')} title="使用当前颜色保存下划线">
              <Underline size={14} />下划线
              <span className="selection-current-color" style={{ '--swatch-color': annotationColors.underline } as React.CSSProperties} />
            </button>
            <button
              className="selection-color-trigger"
              type="button"
              onClick={(event) => toggleSelectionColorPicker(event, 'underline')}
              title="选择下划线颜色"
              aria-label="选择下划线颜色"
              aria-expanded={selectionColorPicker?.kind === 'underline'}
            >
              <ChevronRight size={12} />
            </button>
          </div>
          <button type="button" onClick={() => createReadingNote('insight')} title="记录与原文关联的灵感">
            <span className="selection-tool-mark insight-mark">灵</span>灵感
          </button>
          <button type="button" onClick={() => createReadingNote('critique')} title="记录对原文的质疑">
            <span className="selection-tool-mark critique-mark">疑</span>质疑
          </button>
        </div>
      ) : null}

      {selection && selectionColorPicker ? (
        <SelectionAnnotationColors
          kind={selectionColorPicker.kind}
          currentColor={annotationColors[selectionColorPicker.kind]}
          position={selectionColorPicker}
          onChoose={chooseAnnotationColor}
        />
      ) : null}

      {annotationMenu ? (
        <aside
          className="pdf-annotation-menu"
          style={{ left: annotationMenu.left, top: annotationMenu.top }}
          role="dialog"
          aria-label={`PDF 第 ${annotationMenu.pageNumber} 页批注`}
        >
          <header>
            <span>
              第 {annotationMenu.pageNumber} 页
              {annotationMenu.annotations.length > 1
                ? ` · ${annotationMenu.annotations.length} 条重叠批注`
                : ' · 当前批注'}
            </span>
            <button type="button" onClick={() => setAnnotationMenu(null)} aria-label="关闭批注菜单">
              <X size={13} />
            </button>
          </header>
          <div className="pdf-annotation-menu-items">
            {annotationMenu.annotations.map((annotation) => (
              <div className="pdf-annotation-menu-row" key={annotation.id}>
                <span className={`annotation-kind ${annotation.kind}`}>
                  {annotation.kind === 'highlight' ? <Highlighter size={13} /> : <Underline size={13} />}
                </span>
                <span>
                  <strong>{annotation.kind === 'highlight' ? '高亮' : '下划线'}</strong>
                  <small>{annotation.selectedText || '未记录文字'}</small>
                </span>
                <div className="pdf-annotation-menu-controls">
                  <div className="pdf-annotation-swatches" aria-label="批注颜色">
                    {ANNOTATION_COLORS.map((color) => (
                      <button
                        className={annotation.color.toLocaleLowerCase() === color ? 'active' : ''}
                        key={color}
                        type="button"
                        style={{ '--swatch-color': color } as React.CSSProperties}
                        title={`改为 ${color}`}
                        aria-label={`将批注颜色改为 ${color}`}
                        onClick={() => {
                          void onUpdateAnnotation(annotation, color, annotation.comment).then((succeeded) => {
                            if (succeeded) setAnnotationMenu(null)
                          })
                        }}
                      />
                    ))}
                  </div>
                  <button
                    className="annotation-menu-action"
                    type="button"
                    title="编辑批注评论"
                    aria-label="编辑批注评论"
                    onClick={() => {
                      setAnnotationMenu(null)
                      onRequestEditAnnotation(annotation)
                    }}
                  >
                    <MessageSquareText size={13} />
                  </button>
                  <button
                    className="annotation-menu-action danger"
                    type="button"
                    title="删除这条批注"
                    aria-label={`删除${annotation.kind === 'highlight' ? '高亮' : '下划线'}`}
                    onClick={() => {
                      setAnnotationMenu(null)
                      onRequestDeleteAnnotation(annotation)
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>
      ) : null}

      {viewerContextMenu ? (
        <ContextMenu
          x={viewerContextMenu.x}
          y={viewerContextMenu.y}
          ariaLabel="PDF 阅读操作"
          onClose={() => setViewerContextMenu(null)}
          items={[
            { id: 'zoom-in', label: '放大 PDF', icon: <ZoomIn size={14} />, onSelect: () => changeScale(scaleFromStep(scaleRef.current, 1)) },
            { id: 'zoom-out', label: '缩小 PDF', icon: <ZoomOut size={14} />, onSelect: () => changeScale(scaleFromStep(scaleRef.current, -1)) },
            { id: 'fit-width', label: '适合阅读区宽度', icon: <Maximize2 size={14} />, separatorBefore: true, onSelect: fitToWidth },
            { id: 'find', label: '在文献中查找', icon: <Search size={14} />, onSelect: () => {
              setSearchOpen(true)
              window.setTimeout(() => searchInputRef.current?.focus(), 0)
            } }
          ]}
        />
      ) : null}
    </div>
  )
}

const ANNOTATION_COLORS = ['#e8bd55', '#7fa88b', '#6f9fb4', '#c97d77', '#a45f45', '#8b7eae']
const DEFAULT_ANNOTATION_COLORS: Record<PdfAnnotationKind, string> = {
  highlight: '#e8bd55',
  underline: '#a45f45'
}
const ANNOTATION_COLOR_STORAGE_KEYS: Record<PdfAnnotationKind, string> = {
  highlight: 'inkstone:pdf-highlight-color:v1',
  underline: 'inkstone:pdf-underline-color:v1'
}

interface SelectionAnnotationColorsProps {
  kind: PdfAnnotationKind
  currentColor: string
  position: ToolbarPosition
  onChoose: (kind: PdfAnnotationKind, color: string) => void
}

function SelectionAnnotationColors({
  kind,
  currentColor,
  position,
  onChoose
}: SelectionAnnotationColorsProps): React.JSX.Element {
  return (
    <div
      className="selection-annotation-colors"
      style={{ left: position.left, top: position.top }}
      onMouseDown={(event) => event.preventDefault()}
      role="group"
      aria-label={`${kind === 'highlight' ? '高亮' : '下划线'}颜色`}
    >
      {ANNOTATION_COLORS.map((color) => (
        <button
          className={currentColor.toLocaleLowerCase() === color ? 'active' : ''}
          key={color}
          type="button"
          style={{ '--swatch-color': color } as React.CSSProperties}
          title={`使用 ${color} 并设为默认`}
          aria-label={`使用 ${color} 并设为默认`}
          onClick={() => onChoose(kind, color)}
        />
      ))}
    </div>
  )
}

function loadDefaultAnnotationColors(): Record<PdfAnnotationKind, string> {
  return {
    highlight: loadDefaultAnnotationColor('highlight'),
    underline: loadDefaultAnnotationColor('underline')
  }
}

function loadDefaultAnnotationColor(kind: PdfAnnotationKind): string {
  try {
    const stored = window.localStorage.getItem(ANNOTATION_COLOR_STORAGE_KEYS[kind])?.toLocaleLowerCase()
    if (stored && ANNOTATION_COLORS.includes(stored)) return stored
  } catch {
    // Persisting a preferred color is optional; annotation creation still works.
  }
  return DEFAULT_ANNOTATION_COLORS[kind]
}

function saveDefaultAnnotationColor(kind: PdfAnnotationKind, color: string): void {
  try {
    window.localStorage.setItem(ANNOTATION_COLOR_STORAGE_KEYS[kind], color)
  } catch {
    // Keep the in-memory preference when local storage is unavailable.
  }
}

interface PdfPageViewProps {
  pageInfo: PageInfo
  pdf: PDFDocumentProxy
  scale: number
  visible: boolean
  annotations: PdfAnnotation[]
  cards: ProjectCardView[]
  searchMatches: PdfTextSearchMatch[]
  activeSearchMatchId: string | null
  onSelection: (pageNumber: number, pageElement: HTMLDivElement) => void
  onAnnotationClick: (
    pageNumber: number,
    annotations: PdfAnnotation[],
    clientX: number,
    clientY: number
  ) => void
  pageRef: (element: HTMLDivElement | null) => void
}

const PdfPageView = memo(function PdfPageView({
  pageInfo,
  pdf,
  scale,
  visible,
  annotations,
  cards,
  searchMatches,
  activeSearchMatchId,
  onSelection,
  onAnnotationClick,
  pageRef
}: PdfPageViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const textLayerInstanceRef = useRef<TextLayerBuilder | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [textLayerVersion, setTextLayerVersion] = useState(0)
  const pageWidth = pageInfo.width * scale
  const pageHeight = pageInfo.height * scale

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let page: PDFPageProxy | null = null
    let renderTask: RenderTask | null = null

    const render = async (): Promise<void> => {
      const canvas = canvasRef.current
      const textLayerContainer = textLayerRef.current
      if (!canvas || !textLayerContainer) return
      setRenderError(null)
      textLayerContainer.replaceChildren()
      textLayerInstanceRef.current?.cancel()
      textLayerInstanceRef.current = null
      try {
        page = await pdf.getPage(pageInfo.pageNumber)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        // Keep high zoom useful for figures without allocating a second full
        // device-pixel copy of a page once the CSS zoom is already large.
        const outputScale = Math.min(window.devicePixelRatio || 1, 2, Math.max(1, 4 / scale))
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('当前环境无法创建画布。')
        context.save()
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.restore()
        renderTask = page.render({
          canvasContext: context,
          canvas,
          viewport,
          transform:
            outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
        })
        await renderTask.promise
        if (cancelled) return
        const textLayer = new TextLayerBuilder({
          pdfPage: page
        })
        textLayerInstanceRef.current = textLayer
        await textLayer.render({ viewport })
        if (cancelled) return
        textLayerContainer.replaceChildren(textLayer.div)
        setTextLayerVersion((version) => version + 1)
      } catch (error) {
        if (!cancelled) setRenderError(normalizePdfError(error))
      } finally {
        if (cancelled) {
          renderTask?.cancel()
          textLayerInstanceRef.current?.cancel()
        }
        page?.cleanup()
      }
    }

    void render()
    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayerInstanceRef.current?.cancel()
      textLayerInstanceRef.current = null
      page?.cleanup()
    }
  }, [pageInfo.pageNumber, pdf, scale, visible])

  useEffect(() => {
    const host = textLayerRef.current
    if (!host) return
    const spans = Array.from(host.querySelectorAll<HTMLElement>('.textLayer span'))
    let offset = 0
    let activeElement: HTMLElement | null = null
    for (const span of spans) {
      span.classList.remove('pdf-search-match', 'current')
      const textLength = span.textContent?.length ?? 0
      const spanStart = offset
      const spanEnd = offset + textLength
      const overlapping = searchMatches.filter((match) => match.start < spanEnd && match.end > spanStart)
      if (overlapping.length > 0) span.classList.add('pdf-search-match')
      if (activeSearchMatchId && overlapping.some((match) => match.id === activeSearchMatchId)) {
        span.classList.add('current')
        activeElement ??= span
      }
      offset = spanEnd
    }
    if (activeElement) {
      window.requestAnimationFrame(() => activeElement?.scrollIntoView({ block: 'center', inline: 'nearest' }))
    }
  }, [activeSearchMatchId, searchMatches, textLayerVersion])

  const cardCount = cards.length
  return (
    <div
      className="pdf-page-shell"
      ref={pageRef}
      data-page-number={pageInfo.pageNumber}
      style={{
        width: pageWidth,
        height: pageHeight,
        '--total-scale-factor': scale,
        '--scale-round-x': '1px',
        '--scale-round-y': '1px'
      } as React.CSSProperties}
      onMouseUp={(event) => {
        const pageElement = event.currentTarget
        onSelection(pageInfo.pageNumber, pageElement)
      }}
      onClick={(event) => {
        const browserSelection = window.getSelection()
        if (browserSelection && !browserSelection.isCollapsed) return
        const pageRect = event.currentTarget.getBoundingClientRect()
        if (pageRect.width <= 0 || pageRect.height <= 0) return
        const x = (event.clientX - pageRect.left) / pageRect.width
        const y = (event.clientY - pageRect.top) / pageRect.height
        const matched = annotations.filter((annotation) => {
          const locator = parsePdfLocator(annotation.locatorJson, pageInfo.pageNumber)
          return locator ? pdfLocatorContainsPoint(locator, x, y) : false
        })
        if (matched.length > 0) {
          onAnnotationClick(pageInfo.pageNumber, matched, event.clientX, event.clientY)
        }
      }}
      aria-label={`PDF 第 ${pageInfo.pageNumber} 页`}
    >
      {visible ? (
        <>
          <canvas ref={canvasRef} className="pdf-page-canvas" aria-hidden="true" />
          <div ref={textLayerRef} className="pdf-text-layer-host" />
        </>
      ) : (
        <div className="pdf-page-lazy-placeholder">
          <span>第 {pageInfo.pageNumber} 页</span>
          <small>滚动到附近后渲染</small>
        </div>
      )}
      <div className="pdf-user-annotation-layer" aria-hidden="true">
        {annotations.map((annotation) => (
          <PdfAnnotationOverlay
            key={annotation.id}
            annotation={annotation}
          />
        ))}
      </div>
      {renderError ? (
        <div className="pdf-page-error">
          <AlertTriangle size={14} /> {renderError}
        </div>
      ) : null}
      {cardCount > 0 ? <span className="pdf-page-card-count">{cardCount} 张卡片</span> : null}
    </div>
  )
})

interface PdfAnnotationOverlayProps {
  annotation: PdfAnnotation
}

function PdfAnnotationOverlay({ annotation }: PdfAnnotationOverlayProps): React.JSX.Element | null {
  const locator: PdfLocator | null = parsePdfLocator(annotation.locatorJson, annotation.pageNumber)
  if (!locator) return null
  return (
    <>
      {locator.rects.map((rect, index) => (
        <span
          className={`pdf-user-annotation ${annotation.kind}`}
          key={`${annotation.id}-${index}`}
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.width * 100}%`,
            height: `${rect.height * 100}%`,
            '--annotation-color': annotation.color
          } as React.CSSProperties}
          title={
            annotation.comment ||
            `${annotation.kind === 'highlight' ? '高亮' : '下划线'}：${annotation.selectedText.slice(0, 120)}`
          }
        />
      ))}
    </>
  )
}

function rectanglesOverlap(first: DOMRect, second: DOMRect): boolean {
  return (
    first.right > second.left &&
    first.left < second.right &&
    first.bottom > second.top &&
    first.top < second.bottom
  )
}

function selectionClientRects(
  range: Range,
  pageElements: Iterable<HTMLElement>
): DOMRect[] {
  const endMarkers = Array.from(pageElements).flatMap((pageElement) =>
    Array.from(pageElement.querySelectorAll<HTMLElement>('.textLayer .endOfContent'))
  )
  const previousDisplay = endMarkers.map((marker) => marker.style.display)
  for (const marker of endMarkers) marker.style.display = 'none'
  try {
    return Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0.1 && rect.height > 0.1
    )
  } finally {
    endMarkers.forEach((marker, index) => {
      const display = previousDisplay[index]
      if (display) marker.style.display = display
      else marker.style.removeProperty('display')
    })
  }
}

function unionRects(rects: DOMRect[]): DOMRect {
  if (rects.length === 0) return new DOMRect(0, 0, 0, 0)
  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.right))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  return new DOMRect(left, top, right - left, bottom - top)
}

function normalizePdfError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '未知 PDF 错误。'
}
