const separators = /[\n,，、;；]+/
export function splitTagDraft(value: string): { committed: string[]; draft: string } {
  const tokens = value.split(separators)
  const draft = tokens.pop() ?? ''
  return { committed: parseTags(tokens.join('、')), draft }
}

export function joinTagDraft(committed: string[], draft = ''): string {
  return committed.length ? `${committed.join('、')}、${draft}` : draft
}
export function parseTags(value: string): string[] {
  return [...new Set(value.split(separators).map((tag) => tag.trim()).filter(Boolean))]
}
export function completeTag(value: string, tag: string): string {
  const tokens = value.split(separators)
  tokens.pop()
  return [...new Set([...tokens.map((item) => item.trim()).filter(Boolean), tag])].join('、') + '、'
}
export function suggestTags(value: string, available: string[]): string[] {
  const tokens = value.split(separators)
  const query = tokens.pop()?.trim().toLocaleLowerCase() ?? ''
  const committed = new Set(tokens.map((item) => item.trim()))
  return [...new Set(available)].filter((tag) => !committed.has(tag) && (!query || tag.toLocaleLowerCase().includes(query))).slice(0, 8)
}
