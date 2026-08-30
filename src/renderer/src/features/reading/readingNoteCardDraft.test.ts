import { describe, expect, it } from 'vitest'
import type { ReadingNote } from '@shared/types'
import { selectionFromReadingNote } from './readingNoteCardDraft'

const linkedNote: ReadingNote = {
  id: 'note-1',
  projectId: 'project-1',
  documentId: 'document-1',
  kind: 'critique',
  content: '证据不足。',
  selectedText: '作者的原始论断',
  pageNumber: 7,
  locatorJson: JSON.stringify({
    version: 1,
    page: 7,
    coordinateSpace: 'page-normalized',
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }]
  }),
  createdAt: '2026-08-31T00:00:00Z',
  updatedAt: '2026-08-31T00:00:00Z'
}

describe('selectionFromReadingNote', () => {
  it('reuses the linked PDF text, page, and locator for the existing card flow', () => {
    const selection = selectionFromReadingNote(linkedNote)
    expect(selection?.text).toBe('作者的原始论断')
    expect(selection?.pageNumber).toBe(7)
    expect(selection?.locator.rects).toHaveLength(1)
  })

  it('does not treat a document-level note as a source excerpt', () => {
    expect(
      selectionFromReadingNote({
        ...linkedNote,
        selectedText: '',
        pageNumber: null,
        locatorJson: ''
      })
    ).toBeNull()
  })

  it('rejects a note whose saved locator no longer matches its page', () => {
    expect(selectionFromReadingNote({ ...linkedNote, pageNumber: 8 })).toBeNull()
  })
})
