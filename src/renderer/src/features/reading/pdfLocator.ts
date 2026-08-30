import type { PdfLocator, PdfRect } from '@shared/types'

export interface PdfSelection {
  pageNumber: number
  text: string
  locator: PdfLocator
  contextBefore: string
  contextAfter: string
  clientRect: DOMRect
}

const MAX_CONTEXT_LENGTH = 180
const RECT_PRECISION = 10_000
const DUPLICATE_TOLERANCE = 0.0006
const MIN_LINE_TOLERANCE = 0.0015
const MIN_HORIZONTAL_GAP_TOLERANCE = 0.0025

export function parsePdfLocator(value: string, expectedPage?: number): PdfLocator | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed) || typeof parsed.page !== 'number' || !Array.isArray(parsed.rects)) {
      return null
    }
    if (!Number.isInteger(parsed.page) || parsed.page < 1) return null
    if (expectedPage !== undefined && parsed.page !== expectedPage) return null
    if (parsed.rects.length === 0 || parsed.rects.length > 256 || !parsed.rects.every(isPdfRect)) {
      return null
    }
    const rects = parsed.rects
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      page: parsed.page,
      coordinateSpace: 'page-normalized',
      rects
    }
  } catch {
    return null
  }
}

export function locatorFromRange(
  range: Range,
  pageElement: HTMLElement,
  pageNumber: number
): PdfLocator | null {
  const pageRect = pageElement.getBoundingClientRect()
  if (pageRect.width <= 0 || pageRect.height <= 0) return null

  const rects = Array.from(range.getClientRects())
    .map((rect) => intersectRect(rect, pageRect))
    .filter((rect): rect is DOMRect => rect !== null)
    .map((rect) => ({
      x: clamp((rect.left - pageRect.left) / pageRect.width),
      y: clamp((rect.top - pageRect.top) / pageRect.height),
      width: clamp(rect.width / pageRect.width),
      height: clamp(rect.height / pageRect.height)
    }))
    .filter((rect) => rect.width > 0.0001 && rect.height > 0.0001)

  if (rects.length === 0) return null
  const mergedRects = mergePdfRects(rects)
  if (mergedRects.length === 0) return null
  return {
    version: 1,
    page: pageNumber,
    coordinateSpace: 'page-normalized',
    rects: mergedRects
  }
}

export function buildContext(pageText: string, selectedText: string): {
  before: string
  after: string
} {
  const haystack = normalizeWhitespace(pageText)
  const needle = normalizeWhitespace(selectedText)
  if (!haystack || !needle) return { before: '', after: '' }

  const index = haystack.indexOf(needle)
  if (index < 0) return { before: '', after: '' }
  const beforeStart = Math.max(0, index - MAX_CONTEXT_LENGTH)
  const afterEnd = Math.min(haystack.length, index + needle.length + MAX_CONTEXT_LENGTH)
  return {
    before: `${beforeStart > 0 ? '…' : ''}${haystack.slice(beforeStart, index).trim()}`,
    after: `${haystack.slice(index + needle.length, afterEnd).trim()}${afterEnd < haystack.length ? '…' : ''}`
  }
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function intersectRect(first: DOMRect, second: DOMRect): DOMRect | null {
  const left = Math.max(first.left, second.left)
  const top = Math.max(first.top, second.top)
  const right = Math.min(first.right, second.right)
  const bottom = Math.min(first.bottom, second.bottom)
  if (right <= left || bottom <= top) return null
  return new DOMRect(left, top, right - left, bottom - top)
}

/**
 * PDF.js may expose one client rectangle per glyph, especially for Chinese
 * PDFs. Persisting every glyph makes highlights fragmented and can exceed the
 * locator safety limit. Merge duplicate and adjacent glyph boxes into visual
 * line segments while preserving genuine gaps such as separate columns.
 */
export function mergePdfRects(rects: PdfRect[]): PdfRect[] {
  const normalized = rects
    .filter(isFinitePositiveRect)
    .map(roundRect)
    .sort(compareRects)

  const deduplicated: PdfRect[] = []
  for (const rect of normalized) {
    const containingIndex = deduplicated.findIndex((candidate) =>
      containsRect(candidate, rect, DUPLICATE_TOLERANCE)
    )
    if (containingIndex >= 0) continue

    for (let index = deduplicated.length - 1; index >= 0; index -= 1) {
      const candidate = deduplicated[index]
      if (candidate && containsRect(rect, candidate, DUPLICATE_TOLERANCE)) {
        deduplicated.splice(index, 1)
      }
    }
    deduplicated.push(rect)
  }

  const lines: Array<{ bounds: PdfRect; rects: PdfRect[] }> = []
  for (const rect of deduplicated.sort(compareRects)) {
    let bestLine: (typeof lines)[number] | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (!line) continue
      const distance = Math.abs(centerY(line.bounds) - centerY(rect))
      const tolerance = Math.max(
        MIN_LINE_TOLERANCE,
        Math.min(line.bounds.height, rect.height) * 0.65
      )
      if (distance <= tolerance && hasUsefulVerticalOverlap(line.bounds, rect)) {
        if (distance < bestDistance) {
          bestLine = line
          bestDistance = distance
        }
      }
      if (line.bounds.y + line.bounds.height < rect.y - tolerance * 2) break
    }

    if (bestLine) {
      bestLine.rects.push(rect)
      bestLine.bounds = unionPdfRects(bestLine.bounds, rect)
    } else {
      lines.push({ bounds: rect, rects: [rect] })
    }
  }

  return lines
    .flatMap((line) => mergeLineRects(line.rects))
    .map(roundRect)
    .sort(compareRects)
}

function mergeLineRects(rects: PdfRect[]): PdfRect[] {
  const ordered = [...rects].sort((first, second) => first.x - second.x)
  const merged: PdfRect[] = []
  for (const rect of ordered) {
    const previous = merged.at(-1)
    if (!previous) {
      merged.push(rect)
      continue
    }
    const horizontalGap = rect.x - (previous.x + previous.width)
    const gapTolerance = Math.max(
      MIN_HORIZONTAL_GAP_TOLERANCE,
      Math.min(previous.height, rect.height) * 0.8
    )
    if (horizontalGap <= gapTolerance && hasUsefulVerticalOverlap(previous, rect)) {
      merged[merged.length - 1] = unionPdfRects(previous, rect)
    } else {
      merged.push(rect)
    }
  }
  return merged
}

function hasUsefulVerticalOverlap(first: PdfRect, second: PdfRect): boolean {
  const overlap = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y)
  return overlap >= Math.min(first.height, second.height) * 0.35
}

function containsRect(container: PdfRect, candidate: PdfRect, tolerance: number): boolean {
  return (
    candidate.x >= container.x - tolerance &&
    candidate.y >= container.y - tolerance &&
    candidate.x + candidate.width <= container.x + container.width + tolerance &&
    candidate.y + candidate.height <= container.y + container.height + tolerance
  )
}

function unionPdfRects(first: PdfRect, second: PdfRect): PdfRect {
  const left = Math.min(first.x, second.x)
  const top = Math.min(first.y, second.y)
  const right = Math.max(first.x + first.width, second.x + second.width)
  const bottom = Math.max(first.y + first.height, second.y + second.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function centerY(rect: PdfRect): number {
  return rect.y + rect.height / 2
}

function compareRects(first: PdfRect, second: PdfRect): number {
  return first.y - second.y || first.x - second.x
}

function isFinitePositiveRect(rect: PdfRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0.0001 &&
    rect.height > 0.0001
  )
}

function roundRect(rect: PdfRect): PdfRect {
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height)
  }
}

function round(value: number): number {
  return Math.round(value * RECT_PRECISION) / RECT_PRECISION
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPdfRect(value: unknown): value is PdfRect {
  if (!isRecord(value)) return false
  const x = value.x
  const y = value.y
  const width = value.width
  const height = value.height
  return (
    typeof x === 'number' &&
    Number.isFinite(x) &&
    typeof y === 'number' &&
    Number.isFinite(y) &&
    typeof width === 'number' &&
    Number.isFinite(width) &&
    typeof height === 'number' &&
    Number.isFinite(height) &&
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= 1.001 &&
    y + height <= 1.001
  )
}
