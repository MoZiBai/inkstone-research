import { describe, expect, it } from 'vitest'
import {
  buildContext,
  mergePdfRects,
  normalizeWhitespace,
  parsePdfLocator,
  pdfLocatorContainsPoint
} from './pdfLocator'

describe('PDF locator helpers', () => {
  it('parses normalized locators and rejects malformed coordinates', () => {
    expect(
      parsePdfLocator(
        JSON.stringify({
          version: 1,
          page: 3,
          coordinateSpace: 'page-normalized',
          rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }]
        }),
        3
      )
    ).toEqual({
      version: 1,
      page: 3,
      coordinateSpace: 'page-normalized',
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }]
    })
    expect(parsePdfLocator('{"page":2,"rects":[]}', 2)).toBeNull()
    expect(parsePdfLocator('{"page":2,"rects":[{"x":"bad"}]}', 2)).toBeNull()
    expect(
      parsePdfLocator(
        JSON.stringify({ page: 2, rects: [{ x: 0.8, y: 0.2, width: 0.3, height: 0.04 }] }),
        2
      )
    ).toBeNull()
  })

  it('normalizes text only for context matching and keeps useful surrounding text', () => {
    const context = buildContext('前文\n有多个   空格。目标句子在这里。\n后文', '目标句子在这里。')
    expect(normalizeWhitespace('前文\n有多个   空格。')).toBe('前文 有多个 空格。')
    expect(context.before).toContain('前文')
    expect(context.after).toBe('后文')
  })

  it('merges hundreds of adjacent Chinese glyph boxes into visual lines', () => {
    const glyphRects = Array.from({ length: 360 }, (_, index) => {
      const line = Math.floor(index / 40)
      const column = index % 40
      return {
        x: 0.08 + column * 0.012,
        y: 0.1 + line * 0.032,
        width: 0.0115,
        height: 0.022
      }
    })

    const merged = mergePdfRects(glyphRects)

    expect(merged).toHaveLength(9)
    expect(merged[0]).toMatchObject({ x: 0.08, y: 0.1, height: 0.022 })
    expect(merged[0]?.width).toBeGreaterThan(0.47)
  })

  it('removes duplicate boxes but keeps separated columns apart', () => {
    const merged = mergePdfRects([
      { x: 0.1, y: 0.2, width: 0.1, height: 0.025 },
      { x: 0.1, y: 0.2, width: 0.1, height: 0.025 },
      { x: 0.2, y: 0.2, width: 0.08, height: 0.025 },
      { x: 0.65, y: 0.2, width: 0.12, height: 0.025 }
    ])

    expect(merged).toEqual([
      { x: 0.1, y: 0.2, width: 0.18, height: 0.025 },
      { x: 0.65, y: 0.2, width: 0.12, height: 0.025 }
    ])
  })

  it('detects clicks on a saved annotation rectangle with a small edge tolerance', () => {
    const locator = {
      page: 2,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }]
    }
    expect(pdfLocatorContainsPoint(locator, 0.2, 0.22)).toBe(true)
    expect(pdfLocatorContainsPoint(locator, 0.402, 0.22)).toBe(true)
    expect(pdfLocatorContainsPoint(locator, 0.7, 0.22)).toBe(false)
  })
})
