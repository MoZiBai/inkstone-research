import { clampPdfScale } from './pdfZoom'
import { readPreference, writePreference } from '../../lib/preferences'

export interface ReadingProgress { page: number; scale: number; fitWidth: boolean; offset: number; left: number }
export const INITIAL_READING_PROGRESS: ReadingProgress = { page: 1, scale: 1, fitWidth: true, offset: 0, left: 0 }
export function normalizeReadingProgress(value: Partial<ReadingProgress>): ReadingProgress {
  const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    page: Math.max(1, Math.floor(finite(value.page, 1))),
    scale: clampPdfScale(finite(value.scale, 1)),
    fitWidth: typeof value.fitWidth === 'boolean' ? value.fitWidth : true,
    offset: Math.max(0, Math.min(1, finite(value.offset, 0))),
    left: Math.max(0, Math.min(1, finite(value.left, 0)))
  }
}
export function readReadingProgress(documentId: string): ReadingProgress {
  return normalizeReadingProgress(readPreference('inkstone:reading-position:' + documentId, INITIAL_READING_PROGRESS))
}
export function saveReadingProgress(documentId: string, progress: ReadingProgress): void {
  writePreference('inkstone:reading-position:' + documentId, normalizeReadingProgress(progress))
}
export function canvasOutputScale(width: number, height: number, deviceScale: number): number {
  return Math.min(Math.max(1, deviceScale), 2, Math.sqrt(20_000_000 / Math.max(1, width * height)), 8192 / Math.max(1, width, height))
}
