import { describe, expect, it } from 'vitest'
import type { OutlineNode } from '@shared/types'
import { flattenOutline } from './outline'

function node(id: string, parentId: string | null, sortOrder: number): OutlineNode {
  return {
    id,
    projectId: 'project',
    parentId,
    title: id,
    notes: '',
    coreArgument: '',
    openQuestions: '',
    sortOrder,
    createdAt: '2026-08-30T00:00:00Z',
    updatedAt: '2026-08-30T00:00:00Z'
  }
}

describe('flattenOutline', () => {
  it('keeps sibling order and emits children directly after their parent', () => {
    const result = flattenOutline([
      node('chapter-b', null, 2000),
      node('section-a-2', 'chapter-a', 2000),
      node('chapter-a', null, 1000),
      node('section-a-1', 'chapter-a', 1000)
    ])

    expect(result.map(({ node: item, depth }) => [item.id, depth])).toEqual([
      ['chapter-a', 0],
      ['section-a-1', 1],
      ['section-a-2', 1],
      ['chapter-b', 0]
    ])
  })

  it('keeps orphaned subtrees visible without looping on corrupt cycles', () => {
    const result = flattenOutline([
      node('orphan', 'missing-parent', 1000),
      node('orphan-child', 'orphan', 1000),
      node('cycle-a', 'cycle-b', 1000),
      node('cycle-b', 'cycle-a', 1000)
    ])

    expect(result.map(({ node: item }) => item.id)).toEqual([
      'orphan',
      'orphan-child',
      'cycle-a',
      'cycle-b'
    ])
    expect(new Set(result.map(({ node: item }) => item.id)).size).toBe(result.length)
  })
})
