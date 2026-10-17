import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectCardView, WorkspaceSnapshot } from '@shared/types'
import { LibraryView } from '../features/library/LibraryView'
import { SynthesisView } from '../features/synthesis/SynthesisView'
import { OutlineView } from '../features/outline/OutlineView'
import { buildOutlineWorkspaceIndexes, filterProjectCards, groupCardsByDocument } from './workspaceCollections'

function fixture(count: number): WorkspaceSnapshot {
  const card: ProjectCardView = {
    id: 'card', projectId: 'project', excerptId: 'excerpt', documentId: 'document', documentTitle: '测试资料', documentAuthors: '作者', documentYear: 2026,
    rawText: '来源原文', cleanText: '来源原文', displayText: '来源原文', pdfPage: 1, printPage: null, printPageOverride: null,
    locatorJson: '{}', contextBefore: '', contextAfter: '', sourceHash: null, comment: '自己的思考', originKind: 'normal', researchRoles: [],
    categoryId: 'category', synthesisState: 'active', tags: ['主题'], createdAt: '', updatedAt: ''
  }
  return {
    currentProjectId: 'project', projects: [],
    documents: [{ id: 'document', title: '测试资料', authors: '作者', year: 2026, journal: '', volume: '', issue: '', pages: '', doi: '', publisher: '', metadataRaw: '', isRemoved: false, filePath: null, fileHash: null, fileAvailable: false, printPagePdfAnchor: null, printPageNumberAnchor: null, groupId: 'parent', sortOrder: 1000, cardCount: count, createdAt: '', updatedAt: '' }],
    documentGroups: [{ id: 'parent', projectId: 'project', parentId: null, name: '资料分类', sortOrder: 1000, createdAt: '', updatedAt: '' }],
    cards: Array.from({ length: count }, (_, index) => ({ ...card, id: `card-${index}`, excerptId: `excerpt-${index}` })),
    categories: [{ id: 'category', projectId: 'project', name: '待归类', color: '#999999', sortOrder: 1000, isDefault: true, createdAt: '', updatedAt: '' }],
    researchRoles: [], pdfAnnotations: [], readingNotes: [], outlineNodes: [], outlineLinks: []
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('workspace view rendering boundaries', () => {
  it('keeps library previews bounded and retains the full source-group filter', () => {
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key.includes('library-source') ? '"group:parent"' : null } })
    const html = renderToStaticMarkup(<LibraryView snapshot={fixture(1000)} runMutation={async () => true} currentReadingDocumentId="document" onLocateSynthesis={() => undefined} onOpenSource={() => undefined} />)
    expect((html.match(/<article class="library-card /g) ?? [])).toHaveLength(10)
    expect(html).toContain('1000 张卡片')
    expect(html).toContain('自己的思考')
    expect(html.indexOf('class="card-text-thought"')).toBeLessThan(html.indexOf('class="card-text-quote"'))
  })
  it('caps expanded synthesis columns and the outline pool independently', () => {
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key.includes('synthesis-expanded') ? '["category"]' : null } })
    const snapshot = fixture(1000)
    const board = renderToStaticMarkup(<SynthesisView snapshot={snapshot} runMutation={async () => true} focusCardId={null} initialMode="active" onFocusHandled={() => undefined} onOpenSource={() => undefined} />)
    expect((board.match(/<article class="synthesis-card /g) ?? [])).toHaveLength(50)
    const outline = renderToStaticMarkup(<OutlineView snapshot={snapshot} runMutation={async () => true} onOpenSource={() => undefined} />)
    expect((outline.match(/<article class="pool-card"/g) ?? [])).toHaveLength(50)
  })
})

it('processes a synthetic 10,000-card workspace without quadratic card grouping', () => {
  const snapshot = fixture(10_000)
  const started = performance.now()
  const filtered = filterProjectCards(snapshot.cards, '思考')
  const grouped = groupCardsByDocument(filtered)
  const indexed = buildOutlineWorkspaceIndexes([], snapshot.cards, [])
  const elapsed = performance.now() - started
  expect(grouped.get('document')).toHaveLength(10_000)
  expect(indexed.cardsById.size).toBe(10_000)
  // A generous regression guard, not a desktop frame-rate benchmark.
  expect(elapsed).toBeLessThan(2000)
  console.info(`Synthetic 10,000-card filter/group/index: ${elapsed.toFixed(1)} ms`)
})
