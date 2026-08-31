import { describe, expect, it } from 'vitest'
import type { ProjectCardView } from '@shared/types'
import { collectTagOccurrences, parseTags } from './BulkCardActions'

function card(id: string, tags: string[]): ProjectCardView {
  return { id, tags } as ProjectCardView
}

describe('bulk card tag helpers', () => {
  it('normalizes comma and line separated tags without duplicates', () => {
    expect(parseTags('墓葬，年代\n墓葬, 区域')).toEqual(['墓葬', '年代', '区域'])
  })

  it('lists only tags that actually exist on the selected cards with occurrence counts', () => {
    expect(collectTagOccurrences([
      card('one', ['墓葬', '年代']),
      card('two', ['墓葬', '区域']),
      card('three', ['年代'])
    ])).toEqual([
      { tag: '墓葬', count: 2 },
      { tag: '年代', count: 2 },
      { tag: '区域', count: 1 }
    ])
  })
})
