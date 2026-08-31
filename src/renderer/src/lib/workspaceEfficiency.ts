import type {
  DocumentSummary,
  ProjectCardView,
  ProjectSummary,
  WorkspaceSnapshot
} from '@shared/types'

export type ProjectSort = 'updated' | 'name' | 'documents' | 'cards'
export type ProjectFilter = 'all' | 'documents' | 'cards' | 'empty'
export type DocumentSort = 'updated' | 'title' | 'authors' | 'year' | 'cards'
export type DocumentFilter = 'all' | 'available' | 'unlinked' | 'missing'

export interface ProjectSearchResults {
  documents: DocumentSummary[]
  cards: ProjectCardView[]
}

const chineseCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
})

export function filterAndSortProjects(
  projects: ProjectSummary[],
  query: string,
  filter: ProjectFilter,
  sort: ProjectSort
): ProjectSummary[] {
  const normalizedQuery = normalizeQuery(query)
  return projects
    .filter((project) => {
      if (filter === 'documents' && project.documentCount === 0) return false
      if (filter === 'cards' && project.cardCount === 0) return false
      if (filter === 'empty' && (project.documentCount > 0 || project.cardCount > 0)) return false
      return !normalizedQuery || searchable([project.name, project.description]).includes(normalizedQuery)
    })
    .sort((left, right) => compareProjects(left, right, sort))
}

export function filterAndSortDocuments(
  documents: DocumentSummary[],
  query: string,
  filter: DocumentFilter,
  sort: DocumentSort
): DocumentSummary[] {
  const normalizedQuery = normalizeQuery(query)
  return documents
    .filter((document) => {
      if (filter === 'available' && !document.fileAvailable) return false
      if (filter === 'unlinked' && document.filePath !== null) return false
      if (filter === 'missing' && (document.filePath === null || document.fileAvailable)) return false
      return !normalizedQuery || searchable([
        document.title,
        document.authors,
        document.journal,
        document.publisher,
        document.doi,
        document.year?.toString() ?? ''
      ]).includes(normalizedQuery)
    })
    .sort((left, right) => compareDocuments(left, right, sort))
}

export function searchCurrentProject(
  snapshot: WorkspaceSnapshot,
  query: string,
  limitPerGroup = 8
): ProjectSearchResults {
  const normalizedQuery = normalizeQuery(query)
  if (!normalizedQuery) return { documents: [], cards: [] }

  return {
    documents: snapshot.documents
      .filter((document) => searchable([
        document.title,
        document.authors,
        document.journal,
        document.publisher,
        document.doi
      ]).includes(normalizedQuery))
      .sort((left, right) => compareDocuments(left, right, 'updated'))
      .slice(0, limitPerGroup),
    cards: snapshot.cards
      .filter((card) => searchable([
        card.displayText,
        card.comment,
        card.documentTitle,
        card.documentAuthors,
        ...card.tags
      ]).includes(normalizedQuery))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limitPerGroup)
  }
}

export function titleFromPdfPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.replace(/\.pdf$/i, '').trim() || '未命名文献'
}

function compareProjects(left: ProjectSummary, right: ProjectSummary, sort: ProjectSort): number {
  if (sort === 'name') return chineseCollator.compare(left.name, right.name)
  if (sort === 'documents') {
    return right.documentCount - left.documentCount || chineseCollator.compare(left.name, right.name)
  }
  if (sort === 'cards') {
    return right.cardCount - left.cardCount || chineseCollator.compare(left.name, right.name)
  }
  return right.updatedAt.localeCompare(left.updatedAt) || left.sortOrder - right.sortOrder
}

function compareDocuments(
  left: DocumentSummary,
  right: DocumentSummary,
  sort: DocumentSort
): number {
  if (sort === 'title') return chineseCollator.compare(left.title, right.title)
  if (sort === 'authors') {
    return chineseCollator.compare(left.authors || '未知作者', right.authors || '未知作者') ||
      chineseCollator.compare(left.title, right.title)
  }
  if (sort === 'year') {
    return (right.year ?? -1) - (left.year ?? -1) || chineseCollator.compare(left.title, right.title)
  }
  if (sort === 'cards') {
    return right.cardCount - left.cardCount || chineseCollator.compare(left.title, right.title)
  }
  return right.updatedAt.localeCompare(left.updatedAt) || left.sortOrder - right.sortOrder
}

function searchable(values: string[]): string {
  return values.join('\n').toLocaleLowerCase()
}

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase()
}
