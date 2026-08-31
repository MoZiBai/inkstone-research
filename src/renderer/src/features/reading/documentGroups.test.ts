import { describe, expect, it } from 'vitest'
import type { DocumentGroup, DocumentSummary } from '@shared/types'
import {
  buildDocumentGroupTree,
  countDocumentsInGroup,
  descendantDocumentGroupIds,
  flattenDocumentGroups
} from './documentGroups'

const groups = [
  { id: 'period', parentId: null, name: '时代', sortOrder: 1000 },
  { id: 'han', parentId: 'period', name: '汉代', sortOrder: 1000 },
  { id: 'method', parentId: null, name: '方法', sortOrder: 2000 }
] as DocumentGroup[]

const documents = [
  { id: 'a', groupId: 'han', sortOrder: 1000 },
  { id: 'b', groupId: null, sortOrder: 2000 }
] as DocumentSummary[]

describe('document group tree', () => {
  it('builds nested groups and keeps unclassified documents separate', () => {
    const tree = buildDocumentGroupTree(groups, documents)
    expect(tree.roots.map((node) => node.group.id)).toEqual(['period', 'method'])
    expect(tree.roots[0]?.children[0]?.documents[0]?.id).toBe('a')
    expect(tree.unclassified.map((document) => document.id)).toEqual(['b'])
    expect(countDocumentsInGroup(tree.roots[0]!)).toBe(1)
  })

  it('provides descendants and flattened depth for safe editing', () => {
    expect([...descendantDocumentGroupIds(groups, 'period')]).toEqual(['han'])
    expect(flattenDocumentGroups(buildDocumentGroupTree(groups, documents).roots).map((entry) => [entry.group.id, entry.depth])).toEqual([
      ['period', 0],
      ['han', 1],
      ['method', 0]
    ])
  })
})
