import { describe, expect, it } from 'vitest'
import type { DocumentSummary, ProjectCardView, ProjectSummary, WorkspaceSnapshot } from '@shared/types'
import {
  filterAndSortDocuments,
  filterAndSortProjects,
  searchCurrentProject,
  titleFromPdfPath
} from './workspaceEfficiency'

const projects: ProjectSummary[] = [
  { id: 'p1', name: '青铜器', description: '礼制', color: '#111111', sortOrder: 1000, documentCount: 2, cardCount: 4, createdAt: '2024-01-01', updatedAt: '2024-02-01' },
  { id: 'p2', name: '空项目', description: '', color: '#222222', sortOrder: 2000, documentCount: 0, cardCount: 0, createdAt: '2024-01-02', updatedAt: '2024-03-01' }
]

const documents: DocumentSummary[] = [
  { id: 'd1', title: '礼制研究', authors: '王明', year: 2020, journal: '考古', volume: '', issue: '', pages: '', doi: '', publisher: '', metadataRaw: '', isRemoved: false, filePath: 'managed/a.pdf', fileHash: 'a', fileAvailable: true, printPagePdfAnchor: null, printPageNumberAnchor: null, groupId: null, sortOrder: 1000, cardCount: 2, createdAt: '2024-01-01', updatedAt: '2024-02-01' },
  { id: 'd2', title: '墓葬材料', authors: '', year: null, journal: '', volume: '', issue: '', pages: '', doi: '', publisher: '', metadataRaw: '', isRemoved: false, filePath: 'managed/b.pdf', fileHash: 'b', fileAvailable: false, printPagePdfAnchor: null, printPageNumberAnchor: null, groupId: null, sortOrder: 2000, cardCount: 0, createdAt: '2024-01-02', updatedAt: '2024-03-01' },
  { id: 'd3', title: '未连接文献', authors: '李华', year: 2024, journal: '', volume: '', issue: '', pages: '', doi: '', publisher: '', metadataRaw: '', isRemoved: false, filePath: null, fileHash: null, fileAvailable: false, printPagePdfAnchor: null, printPageNumberAnchor: null, groupId: null, sortOrder: 3000, cardCount: 1, createdAt: '2024-01-03', updatedAt: '2024-01-03' }
]

const card: ProjectCardView = {
  id: 'c1', projectId: 'p1', excerptId: 'e1', documentId: 'd1', documentTitle: '礼制研究', documentAuthors: '王明', documentYear: 2020,
  rawText: '原文', cleanText: '原文', displayText: '器物组合反映等级秩序', pdfPage: 2, printPage: null, printPageOverride: null, locatorJson: '{}', contextBefore: '', contextAfter: '', sourceHash: 'a', comment: '需要与墓葬年代对照', originKind: 'normal', researchRoles: [], categoryId: null, synthesisState: 'active', tags: ['礼制'], createdAt: '2024-01-01', updatedAt: '2024-02-02'
}

it('filters and sorts projects without mutating the source order', () => {
  expect(filterAndSortProjects(projects, '礼制', 'all', 'updated').map((item) => item.id)).toEqual(['p1'])
  expect(filterAndSortProjects(projects, '', 'empty', 'name').map((item) => item.id)).toEqual(['p2'])
  expect(projects.map((item) => item.id)).toEqual(['p1', 'p2'])
})

it('distinguishes available, missing and never-linked documents', () => {
  expect(filterAndSortDocuments(documents, '', 'available', 'title').map((item) => item.id)).toEqual(['d1'])
  expect(filterAndSortDocuments(documents, '', 'missing', 'updated').map((item) => item.id)).toEqual(['d2'])
  expect(filterAndSortDocuments(documents, '李华', 'unlinked', 'updated').map((item) => item.id)).toEqual(['d3'])
})

it('searches current project documents and card excerpts, notes and tags', () => {
  const snapshot = { projects, currentProjectId: 'p1', documents, documentGroups: [], cards: [card], categories: [], researchRoles: [], pdfAnnotations: [], readingNotes: [], outlineNodes: [], outlineLinks: [] } satisfies WorkspaceSnapshot
  expect(searchCurrentProject(snapshot, '王明').documents.map((item) => item.id)).toContain('d1')
  expect(searchCurrentProject(snapshot, '年代').cards.map((item) => item.id)).toEqual(['c1'])
  expect(searchCurrentProject(snapshot, '礼制').cards.map((item) => item.id)).toEqual(['c1'])
})

describe('PDF filenames', () => {
  it('derives editable titles for Windows and POSIX paths', () => {
    expect(titleFromPdfPath('C:\\papers\\论文一.PDF')).toBe('论文一')
    expect(titleFromPdfPath('/tmp/paper.pdf')).toBe('paper')
  })
})
