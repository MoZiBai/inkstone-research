export interface PageItemPartition<T> {
  currentPageItems: T[]
  otherPageItems: T[]
}

export function partitionItemsByPage<T>(
  items: readonly T[],
  currentPage: number,
  pageOf: (item: T) => number | null
): PageItemPartition<T> {
  const currentPageItems: T[] = []
  const otherPageItems: T[] = []
  for (const item of items) {
    if (pageOf(item) === currentPage) currentPageItems.push(item)
    else otherPageItems.push(item)
  }
  return { currentPageItems, otherPageItems }
}
