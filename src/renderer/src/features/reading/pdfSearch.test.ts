import { describe, expect, it } from 'vitest'
import { findPdfTextMatches, nextPdfSearchIndex } from './pdfSearch'

describe('PDF text search', () => {
  it('finds every non-overlapping Chinese and case-insensitive match', () => {
    expect(findPdfTextMatches('墓葬 ABC 墓葬 abc', '墓葬', 3).map((match) => match.start)).toEqual([0, 7])
    expect(findPdfTextMatches('ABC abc', 'abc', 1).map((match) => match.start)).toEqual([0, 4])
  })

  it('keeps stable page-specific match identifiers and honors limits', () => {
    expect(findPdfTextMatches('aaaa', 'a', 2, 8, 2).map((match) => match.id)).toEqual(['2:0:8', '2:1:9'])
  })

  it('wraps previous and next navigation', () => {
    expect(nextPdfSearchIndex(2, 3, 1)).toBe(0)
    expect(nextPdfSearchIndex(0, 3, -1)).toBe(2)
    expect(nextPdfSearchIndex(0, 0, 1)).toBe(-1)
  })
})
