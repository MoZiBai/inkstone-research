import type { WorkspaceSection, WorkspaceSnapshot } from '@shared/types'

const sectionsByCommand: Record<string, WorkspaceSection[]> = {
  update_card: ['cards'], move_card: ['cards'], set_card_excluded: ['cards'], batch_update_cards: ['cards'],
  create_card_from_selection: ['cards', 'documents', 'pdfAnnotations', 'readingNotes'], delete_card: ['cards', 'documents', 'outlineLinks'],
  create_pdf_annotation: ['pdfAnnotations'], update_pdf_annotation: ['pdfAnnotations'], delete_pdf_annotation: ['pdfAnnotations'],
  create_reading_note: ['readingNotes'], update_reading_note: ['readingNotes'], delete_reading_note: ['readingNotes'],
  create_category: ['categories'], update_category: ['categories'], reorder_categories: ['categories'], delete_category: ['categories', 'cards'],
  create_research_role: ['researchRoles'], update_research_role: ['researchRoles', 'cards'], reorder_research_roles: ['researchRoles', 'cards'], set_research_role_archived: ['researchRoles', 'cards'],
  create_outline_node: ['outlineNodes'], update_outline_node: ['outlineNodes'], move_outline_node: ['outlineNodes'], delete_outline_node: ['outlineNodes', 'outlineLinks'],
  link_card_to_outline: ['outlineLinks'], remove_outline_link: ['outlineLinks'], move_outline_card: ['outlineLinks'], update_outline_card_link: ['outlineLinks'],
  create_document_group: ['documentGroups'], update_document_group: ['documentGroups'], delete_document_group: ['documentGroups', 'documents'], move_document_to_group: ['documents'],
  create_document: ['documents'], update_document: ['documents', 'cards'], update_document_print_page_mapping: ['documents', 'cards'], import_pdf: ['documents', 'cards']
}
let pending = new Set<WorkspaceSection>()
let fullRefresh = false
export function recordWorkspaceCommand(command: string): void {
  const sections = sectionsByCommand[command]
  if (sections) for (const section of sections) pending.add(section)
  else if (['create_project', 'update_project', 'remove_project', 'remove_document', 'restore_document', 'import_database', 'import_project_database'].includes(command)) fullRefresh = true
}
export function consumeWorkspaceChanges(): WorkspaceSection[] | undefined {
  const sections = !fullRefresh && pending.size > 0 ? [...pending] : undefined
  pending = new Set()
  fullRefresh = false
  return sections
}
export function mergeWorkspace(previous: WorkspaceSnapshot | null, next: WorkspaceSnapshot, sections?: WorkspaceSection[]): WorkspaceSnapshot {
  if (!previous || previous.currentProjectId !== next.currentProjectId) return next
  const merged = { ...previous, projects: next.projects, currentProjectId: next.currentProjectId }
  for (const key of (sections ?? Object.keys(next).filter((key) => key !== 'currentProjectId')) as Array<keyof Omit<WorkspaceSnapshot, 'currentProjectId'>>) {
    const before = previous[key]
    const after = next[key]
    // Keep unchanged arrays stable so unrelated views and PDF layers can skip work.
    if (JSON.stringify(before) !== JSON.stringify(after)) Object.assign(merged, { [key]: after })
    else Object.assign(merged, { [key]: before })
  }
  if (JSON.stringify(previous.projects) === JSON.stringify(next.projects)) merged.projects = previous.projects
  return merged
}
