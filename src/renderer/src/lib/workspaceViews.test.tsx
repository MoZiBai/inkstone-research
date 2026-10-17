import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectCardView, WorkspaceSnapshot } from '@shared/types'
import { LibraryView } from '../features/library/LibraryView'
import { SynthesisView } from '../features/synthesis/SynthesisView'
import { OutlineView } from '../features/outline/OutlineView'
import { buildOutlineWorkspaceIndexes, filterProjectCards, groupCardsByDocument } from './workspaceCollections'
import { BibliographicFields, ReadingView } from '../features/reading/ReadingView'
import { DatabaseTransferDialog } from '../features/backup/DatabaseTransferDialog'
import { ReadingCardItem } from '../features/reading/ReadingCardItem'
import { CardEditDialog } from '../components/CardEditDialog'
import { TagInput } from '../components/TagInput'
import { outlineToMarkdown } from './outlineExport'

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
  it('keeps optional bibliography collapsed during import without removing editable fields', () => {
    const value = { title: '文件标题', authors: '', year: '', journal: '', volume: '', issue: '', pages: '', doi: '', publisher: '', metadataRaw: '' }
    const compact = renderToStaticMarkup(<BibliographicFields value={value} onChange={() => undefined} compact />)
    expect(compact).toContain('<details class="bibliographic-details">')
    expect(compact).toContain('补充文献信息（可选）')
    expect(compact).toContain('粘贴引用信息自动识别')
    expect(compact).toContain('DOI')
    const full = renderToStaticMarkup(<BibliographicFields value={value} onChange={() => undefined} />)
    expect(full).toContain('<details class="bibliographic-details" open="">')
  })
  it('explains backup merge limits and retains import/export access even without registry data', () => {
    const noop = () => undefined
    const html = renderToStaticMarkup(<DatabaseTransferDialog busy={false} managerBusy={false} manager={null} runtime={null} managerError={null}
      onImportBackup={noop} onExport={noop} onMerge={noop} onImportProject={noop} onRefresh={noop} onChooseDirectory={noop} onResetDirectory={noop}
      onUpdateRetention={noop} onUpdateInterval={noop} onCreateSnapshot={noop} onCleanup={noop} onRevealDirectory={noop} onRevealBackup={noop} onDeleteBackup={noop} onClose={noop} />)
    expect(html).toContain('备份与导入')
    expect(html).toContain('不会把现有修改回退到旧版本')
    expect(html).toContain('不包含 PDF 文件')
    expect(html).toContain('导入单个项目')
    expect(html).toContain('导入完整备份')
    expect(html).toContain('导出全部记录')
  })
  it('gives a real first-card action instead of claiming PDF support is unavailable', () => {
    const html = renderToStaticMarkup(<LibraryView snapshot={fixture(0)} runMutation={async () => true} currentReadingDocumentId="document" onLocateSynthesis={() => undefined} onOpenSource={() => undefined} onGoReading={() => undefined} />)
    expect(html).toContain('前往阅读台摘录')
    expect(html).not.toContain('第一阶段')
    expect(html).not.toContain('功能接入后')
  })
  it('distinguishes a source filter with no matches from an empty project', () => {
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key.includes('library-source') ? '"doc:another-document"' : null } })
    const html = renderToStaticMarkup(<LibraryView snapshot={fixture(2)} runMutation={async () => true} currentReadingDocumentId="document" onLocateSynthesis={() => undefined} onOpenSource={() => undefined} />)
    expect(html).toContain('没有符合当前筛选的卡片')
    expect(html).toContain('查看全部卡片')
    expect(html).not.toContain('还没有阅读卡片')
  })
  it('does not describe filtered-out outline cards as already linked', () => {
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key.includes('outline-document') ? '"another-document"' : null } })
    const html = renderToStaticMarkup(<OutlineView snapshot={fixture(2)} runMutation={async () => true} onOpenSource={() => undefined} />)
    expect(html).toContain('没有符合当前筛选的卡片')
    expect(html).toContain('清除卡片筛选')
    expect(html).not.toContain('都已关联到当前章节')
  })
  it('offers card expansion and editing without leaving reading', () => {
    const snapshot = fixture(2)
    const html = renderToStaticMarkup(<ReadingCardItem card={snapshot.cards[0]!} onLocate={() => undefined} onEdit={() => undefined} />)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('展开完整笔记与摘录')
    expect(html).toContain('编辑卡片')
    expect(html).toContain('查看原文')
    const reading = renderToStaticMarkup(<ReadingView snapshot={snapshot} isActive runMutation={async () => true} notify={() => undefined} />)
    expect(reading).toContain('本页 2 / 全篇 2')
  })
  it('renders existing tags once, and reading edits without a central blurred dialog', () => {
    const tags = renderToStaticMarkup(<TagInput value="主题甲、主题乙、" onChange={() => undefined} />)
    expect(tags).toContain('value=""')
    expect(tags).not.toContain('value="主题甲、主题乙、"')
    expect((tags.match(/class="tag-input-chip"/g) ?? [])).toHaveLength(2)
    const card = fixture(1).cards[0]!
    const html = renderToStaticMarkup(<CardEditDialog card={card} researchRoles={[]} onSave={async () => undefined} onClose={() => undefined} placement="reading" />)
    expect(html).toContain('reading-composer-backdrop')
    expect(html).not.toContain('data-unsaved="true"')
    expect(html).toContain('卡片用途与印刷页码（可选）')
  })
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

it('copies all outline levels and ordered evidence, including shared and excluded linked cards', () => {
  const snapshot = fixture(2)
  snapshot.projects = [{ id: 'project', name: '阅读主题', description: '', color: '', sortOrder: 0, documentCount: 1, cardCount: 2, createdAt: '', updatedAt: '' }]
  const base = { projectId: 'project', notes: '写作说明内容', coreArgument: '核心观点内容', openQuestions: '待解决内容', createdAt: '', updatedAt: '' }
  snapshot.outlineNodes = [{ ...base, id: 'child', parentId: 'root', title: '子章节', sortOrder: 0 }, { ...base, id: 'root', parentId: null, title: '开篇', sortOrder: 0 }]
  snapshot.cards[0] = { ...snapshot.cards[0]!, displayText: '第一行\n第二行', printPage: '103', synthesisState: 'excluded' }
  snapshot.cards[1] = { ...snapshot.cards[1]!, comment: '应该最先出现' }
  snapshot.outlineLinks = [
    { id: 'link1', outlineNodeId: 'root', projectCardId: 'card-0', note: '用于限定观点', sortOrder: 2000, createdAt: '' },
    { id: 'link2', outlineNodeId: 'root', projectCardId: 'card-1', note: '', sortOrder: 1000, createdAt: '' },
    { id: 'link3', outlineNodeId: 'child', projectCardId: 'card-0', note: '同一材料用于子节', sortOrder: 1000, createdAt: '' }
  ]
  const before = JSON.stringify(snapshot)
  const result = outlineToMarkdown(snapshot)
  expect(result).toContain('# 阅读主题')
  expect(result).toContain('## 1 开篇')
  expect(result).toContain('### 1.1 子章节')
  expect(result).toContain('> 第一行\n> 第二行')
  expect(result).toContain('印刷第 103 页 · PDF 第 1 页')
  expect(result).toContain('同一材料用于子节')
  expect(result.indexOf('应该最先出现')).toBeLessThan(result.indexOf('用于限定观点'))
  expect(result.match(/> 第一行/g)).toHaveLength(2)
  expect(JSON.stringify(snapshot)).toBe(before)
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
