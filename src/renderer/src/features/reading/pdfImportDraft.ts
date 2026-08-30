export function titleAfterPdfSelection(
  path: string,
  targetDocumentId: string | null,
  currentTitle: string
): string {
  if (targetDocumentId) return currentTitle
  return fileName(path).replace(/\.pdf$/i, '')
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
