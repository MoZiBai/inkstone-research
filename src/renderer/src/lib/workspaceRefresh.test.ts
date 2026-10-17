import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceSnapshot } from '@shared/types'
import { consumeWorkspaceChanges, mergeWorkspace, recordWorkspaceCommand } from './workspaceRefresh'

const emptyWorkspace = (projectId = 'project-a'): WorkspaceSnapshot => ({
  currentProjectId: projectId, projects: [], documents: [], documentGroups: [], cards: [], categories: [], researchRoles: [], pdfAnnotations: [], readingNotes: [], outlineNodes: [], outlineLinks: []
})
beforeEach(() => consumeWorkspaceChanges())

describe('scoped workspace refresh', () => {
  it('combines changed sections and resets them after consumption', () => {
    recordWorkspaceCommand('create_pdf_annotation')
    recordWorkspaceCommand('update_reading_note')
    recordWorkspaceCommand('update_pdf_annotation')
    expect(consumeWorkspaceChanges()).toEqual(['pdfAnnotations', 'readingNotes'])
    expect(consumeWorkspaceChanges()).toBeUndefined()
  })
  it('refreshes every dependent section when a note becomes a card or a card is deleted', () => {
    recordWorkspaceCommand('create_card_from_selection')
    expect(consumeWorkspaceChanges()).toEqual(['cards', 'documents', 'pdfAnnotations', 'readingNotes'])
    recordWorkspaceCommand('delete_card')
    expect(consumeWorkspaceChanges()).toContain('outlineLinks')
  })
  it('uses a complete refresh for destructive structural changes and imports', () => {
    recordWorkspaceCommand('update_card')
    recordWorkspaceCommand('remove_document')
    expect(consumeWorkspaceChanges()).toBeUndefined()
    recordWorkspaceCommand('import_project_database')
    expect(consumeWorkspaceChanges()).toBeUndefined()
  })
  it('keeps unrelated and identical arrays stable, including source data', () => {
    const previous = emptyWorkspace()
    const next = emptyWorkspace()
    const merged = mergeWorkspace(previous, next, ['pdfAnnotations'])
    expect(merged.cards).toBe(previous.cards)
    expect(merged.documents).toBe(previous.documents)
    expect(merged.pdfAnnotations).toBe(previous.pdfAnnotations)
    expect(merged.projects).toBe(previous.projects)
    expect(merged).not.toBe(previous)
  })
  it('does not carry sections from one project into another', () => {
    const previous = emptyWorkspace()
    const next = emptyWorkspace('project-b')
    expect(mergeWorkspace(previous, next, ['cards'])).toBe(next)
  })
})
