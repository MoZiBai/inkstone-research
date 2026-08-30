import type { ReadingNote } from '@shared/types'
import { parsePdfLocator, type PdfSelection } from './pdfLocator'

export function selectionFromReadingNote(note: ReadingNote): PdfSelection | null {
  if (note.pageNumber === null || !note.selectedText.trim()) return null
  const locator = parsePdfLocator(note.locatorJson, note.pageNumber)
  if (!locator) return null
  return {
    pageNumber: note.pageNumber,
    text: note.selectedText,
    locator,
    contextBefore: '',
    contextAfter: ''
  }
}
