import { describe, expect, it } from 'vitest'
import {
  MAX_PDF_SCALE,
  MIN_PDF_SCALE,
  scaleFromCtrlWheel,
  scaleFromStep
} from './pdfZoom'

describe('scaleFromCtrlWheel', () => {
  it('zooms in for an upward Ctrl+wheel gesture and out for a downward gesture', () => {
    expect(scaleFromCtrlWheel(1, -100)).toBe(1.1)
    expect(scaleFromCtrlWheel(1.1, 100)).toBe(1)
  })

  it('keeps repeated wheel zoom within the PDF reader limits', () => {
    expect(scaleFromCtrlWheel(MAX_PDF_SCALE, -100)).toBe(MAX_PDF_SCALE)
    expect(scaleFromCtrlWheel(MIN_PDF_SCALE, 100)).toBe(MIN_PDF_SCALE)
  })

  it('uses the same limits for toolbar and context-menu zoom steps', () => {
    expect(MAX_PDF_SCALE).toBe(5)
    expect(scaleFromStep(MAX_PDF_SCALE, 1)).toBe(MAX_PDF_SCALE)
    expect(scaleFromStep(MIN_PDF_SCALE, -1)).toBe(MIN_PDF_SCALE)
    expect(scaleFromStep(1, 1)).toBe(1.1)
  })
})
