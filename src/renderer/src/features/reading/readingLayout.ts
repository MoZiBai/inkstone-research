export interface ReadingPanelWidths {
  documents: number
  inspector: number
}

export type ReadingPanel = keyof ReadingPanelWidths

export const DEFAULT_READING_PANEL_WIDTHS: ReadingPanelWidths = {
  documents: 240,
  inspector: 280
}

export const READING_PANEL_LIMITS = {
  documents: { min: 180, max: 520 },
  inspector: { min: 220, max: 640 },
  pdfMin: 360,
  handleTotal: 14
} as const

export function normalizeReadingPanelWidths(value: unknown): ReadingPanelWidths {
  if (!value || typeof value !== 'object') return { ...DEFAULT_READING_PANEL_WIDTHS }
  const candidate = value as Partial<ReadingPanelWidths>
  return {
    documents: clampNumber(
      candidate.documents,
      READING_PANEL_LIMITS.documents.min,
      READING_PANEL_LIMITS.documents.max,
      DEFAULT_READING_PANEL_WIDTHS.documents
    ),
    inspector: clampNumber(
      candidate.inspector,
      READING_PANEL_LIMITS.inspector.min,
      READING_PANEL_LIMITS.inspector.max,
      DEFAULT_READING_PANEL_WIDTHS.inspector
    )
  }
}

export function fitReadingPanelWidths(
  value: ReadingPanelWidths,
  layoutWidth: number
): ReadingPanelWidths {
  const normalized = normalizeReadingPanelWidths(value)
  if (!Number.isFinite(layoutWidth) || layoutWidth <= 0) return normalized

  const minimumFixed =
    READING_PANEL_LIMITS.documents.min + READING_PANEL_LIMITS.inspector.min
  const availableFixed = Math.max(
    minimumFixed,
    layoutWidth - READING_PANEL_LIMITS.pdfMin - READING_PANEL_LIMITS.handleTotal
  )
  const currentFixed = normalized.documents + normalized.inspector
  if (currentFixed <= availableFixed) return normalized

  const overflow = currentFixed - availableFixed
  const documentCapacity = normalized.documents - READING_PANEL_LIMITS.documents.min
  const inspectorCapacity = normalized.inspector - READING_PANEL_LIMITS.inspector.min
  const totalCapacity = documentCapacity + inspectorCapacity
  if (totalCapacity <= 0) return normalized

  const documentReduction = Math.min(
    documentCapacity,
    overflow * (documentCapacity / totalCapacity)
  )
  const inspectorReduction = Math.min(inspectorCapacity, overflow - documentReduction)
  return {
    documents: Math.round(normalized.documents - documentReduction),
    inspector: Math.round(normalized.inspector - inspectorReduction)
  }
}

export function resizeReadingPanel(
  value: ReadingPanelWidths,
  panel: ReadingPanel,
  pointerX: number,
  bounds: { left: number; right: number }
): ReadingPanelWidths {
  const layoutWidth = Math.max(0, bounds.right - bounds.left)
  const fitted = fitReadingPanelWidths(value, layoutWidth)
  if (panel === 'documents') {
    const maximum = Math.min(
      READING_PANEL_LIMITS.documents.max,
      layoutWidth - fitted.inspector - READING_PANEL_LIMITS.pdfMin - READING_PANEL_LIMITS.handleTotal
    )
    return {
      ...fitted,
      documents: Math.round(
        clamp(pointerX - bounds.left, READING_PANEL_LIMITS.documents.min, Math.max(READING_PANEL_LIMITS.documents.min, maximum))
      )
    }
  }

  const maximum = Math.min(
    READING_PANEL_LIMITS.inspector.max,
    layoutWidth - fitted.documents - READING_PANEL_LIMITS.pdfMin - READING_PANEL_LIMITS.handleTotal
  )
  return {
    ...fitted,
    inspector: Math.round(
      clamp(bounds.right - pointerX, READING_PANEL_LIMITS.inspector.min, Math.max(READING_PANEL_LIMITS.inspector.min, maximum))
    )
  }
}

export function adjustReadingPanel(
  value: ReadingPanelWidths,
  panel: ReadingPanel,
  delta: number,
  layoutWidth: number
): ReadingPanelWidths {
  const next = { ...value, [panel]: value[panel] + delta }
  return fitReadingPanelWidths(normalizeReadingPanelWidths(next), layoutWidth)
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(clamp(value, min, max))
    : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
