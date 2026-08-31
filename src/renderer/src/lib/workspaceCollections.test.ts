import { describe, expect, it } from 'vitest'
import type { OutlineCardLink, OutlineNode, ProjectCardView, SynthesisCategory } from '@shared/types'
import {
  buildOutlineWorkspaceIndexes,
  filterProjectCards,
  groupCardsByCategory,
  groupCardsByDocument
} from './workspaceCollections'

function card(id: string, documentId: string, state: 'active' | 'excluded' = 'active'): ProjectCardView {
  return {
    id,
    projectId: 'project',
    excerptId: `excerpt-${id}`,
    documentId,
    documentTitle: documentId === 'document-a' ? '墓葬空间研究' : '区域互动研究',
    documentAuthors: '测试作者',
    documentYear: 2026,
    rawText: `原文 ${id}`,
    cleanText: `原文 ${id}`,
    displayText: id === 'card-a' ? '人工修正的空间论述' : `摘录 ${id}`,
    pdfPage: 1,
    printPage: null,
    locatorJson: '{"page":1,"rects":[]}',
    contextBefore: '',
    contextAfter: '',
    sourceHash: null,
    comment: id === 'card-b' ? '需要核对年代' : '',
    originKind: 'normal',
    researchRoles: [],
    categoryId: id === 'card-a' ? 'category-a' : null,
    synthesisState: state,
    tags: id === 'card-c' ? ['传播机制'] : [],
    createdAt: '2026-08-31T00:00:00Z',
    updatedAt: '2026-08-31T00:00:00Z'
  }
}

const cards = [
  card('card-a', 'document-a'),
  card('card-b', 'document-a', 'excluded'),
  card('card-c', 'document-b')
]

describe('workspace card collections', () => {
  it('filters across corrected text, comments and tags without changing card state', () => {
    expect(filterProjectCards(cards, '人工').map((item) => item.id)).toEqual(['card-a'])
    expect(filterProjectCards(cards, '年代').map((item) => item.id)).toEqual(['card-b'])
    expect(filterProjectCards(cards, '传播').map((item) => item.id)).toEqual(['card-c'])
    expect(filterProjectCards(cards, '', 'excluded').map((item) => item.id)).toEqual(['card-b'])
  })

  it('groups cards once by source document and assigns null categories to the default category', () => {
    expect(groupCardsByDocument(cards).get('document-a')?.map((item) => item.id)).toEqual([
      'card-a',
      'card-b'
    ])
    const categories: SynthesisCategory[] = [
      {
        id: 'category-default',
        projectId: 'project',
        name: '待归类',
        color: '#999999',
        sortOrder: 1000,
        isDefault: true,
        createdAt: '',
        updatedAt: ''
      },
      {
        id: 'category-a',
        projectId: 'project',
        name: '论点',
        color: '#a45f45',
        sortOrder: 2000,
        isDefault: false,
        createdAt: '',
        updatedAt: ''
      }
    ]
    const grouped = groupCardsByCategory(cards, categories)
    expect(grouped.get('category-a')?.map((item) => item.id)).toEqual(['card-a'])
    expect(grouped.get('category-default')?.map((item) => item.id)).toEqual(['card-b', 'card-c'])
  })
})

describe('outline workspace indexes', () => {
  it('indexes links in both directions and retains every usage title', () => {
    const nodes: OutlineNode[] = ['chapter-a', 'chapter-b'].map((id, index) => ({
      id,
      projectId: 'project',
      parentId: null,
      title: `章节 ${index + 1}`,
      notes: '',
      coreArgument: '',
      openQuestions: '',
      sortOrder: (index + 1) * 1000,
      createdAt: '',
      updatedAt: ''
    }))
    const links: OutlineCardLink[] = nodes.map((node, index) => ({
      id: `link-${index}`,
      outlineNodeId: node.id,
      projectCardId: 'card-a',
      note: '',
      sortOrder: 1000,
      createdAt: ''
    }))
    const indexes = buildOutlineWorkspaceIndexes(nodes, cards, links)
    expect(indexes.linksByNodeId.get('chapter-a')).toHaveLength(1)
    expect(indexes.linkedCardIdsByNodeId.get('chapter-b')?.has('card-a')).toBe(true)
    expect(indexes.usageTitlesByCardId.get('card-a')).toEqual(['章节 1', '章节 2'])
  })
})
