import { describe, expect, it } from 'vitest'
import { partitionItemsByPage } from './readingPageItems'

describe('reading inspector page priority', () => {
  it('keeps current-page items first without changing order inside either group', () => {
    const items = [
      { id: 'other-a', page: 2 },
      { id: 'current-a', page: 5 },
      { id: 'other-b', page: null },
      { id: 'current-b', page: 5 }
    ]
    const result = partitionItemsByPage(items, 5, (item) => item.page)
    expect(result.currentPageItems.map((item) => item.id)).toEqual(['current-a', 'current-b'])
    expect(result.otherPageItems.map((item) => item.id)).toEqual(['other-a', 'other-b'])
    expect(items.map((item) => item.id)).toEqual(['other-a', 'current-a', 'other-b', 'current-b'])
  })
})
