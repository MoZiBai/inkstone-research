export interface PdfTextSearchMatch {
  id: string
  pageNumber: number
  start: number
  end: number
}

export function findPdfTextMatches(
  text: string,
  query: string,
  pageNumber: number,
  startSequence = 0,
  limit = 20_000
): PdfTextSearchMatch[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle || limit <= 0) return []
  const haystack = text.toLocaleLowerCase()
  const matches: PdfTextSearchMatch[] = []
  let offset = 0
  while (offset <= haystack.length - needle.length && matches.length < limit) {
    const start = haystack.indexOf(needle, offset)
    if (start < 0) break
    matches.push({
      id: `${pageNumber}:${start}:${startSequence + matches.length}`,
      pageNumber,
      start,
      end: start + needle.length
    })
    offset = start + Math.max(1, needle.length)
  }
  return matches
}

export function nextPdfSearchIndex(current: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return -1
  const safeCurrent = current < 0 || current >= count ? 0 : current
  return (safeCurrent + direction + count) % count
}
