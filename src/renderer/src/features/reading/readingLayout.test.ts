import { describe, expect, it } from 'vitest'
import {
  DEFAULT_READING_PANEL_WIDTHS,
  fitReadingPanelWidths,
  normalizeReadingPanelWidths,
  resizeReadingPanel
} from './readingLayout'

describe('reading panel layout', () => {
  it('rejects invalid persisted widths and clamps oversized values', () => {
    expect(normalizeReadingPanelWidths(null)).toEqual(DEFAULT_READING_PANEL_WIDTHS)
    expect(normalizeReadingPanelWidths({ documents: 20, inspector: 900 })).toEqual({
      documents: 180,
      inspector: 520
    })
  })

  it('keeps enough room for the PDF when the window narrows', () => {
    const fitted = fitReadingPanelWidths({ documents: 500, inspector: 600 }, 1000)
    expect(fitted.documents + fitted.inspector).toBeLessThanOrEqual(626)
    expect(fitted.documents).toBeGreaterThanOrEqual(180)
    expect(fitted.inspector).toBeGreaterThanOrEqual(210)
  })

  it('resizes either side panel from its adjacent separator', () => {
    const bounds = { left: 100, right: 1500 }
    expect(
      resizeReadingPanel(DEFAULT_READING_PANEL_WIDTHS, 'documents', 430, bounds).documents
    ).toBe(330)
    expect(
      resizeReadingPanel(DEFAULT_READING_PANEL_WIDTHS, 'inspector', 1040, bounds).inspector
    ).toBe(460)
  })
})
