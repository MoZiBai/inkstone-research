import type {
  OutlineCardLink,
  OutlineNode,
  ProjectCardView,
  SynthesisCategory
} from '@shared/types'

export type CardStateFilter = 'all' | 'active' | 'excluded'

export function filterProjectCards(
  cards: ProjectCardView[],
  normalizedQuery: string,
  state: CardStateFilter = 'all'
): ProjectCardView[] {
  return cards.filter((card) => {
    if (state !== 'all' && card.synthesisState !== state) return false
    if (!normalizedQuery) return true
    return [
      card.displayText,
      card.comment,
      card.documentTitle,
      card.documentAuthors,
      ...card.tags
    ]
      .join('\n')
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  })
}

export function groupCardsByDocument(
  cards: ProjectCardView[]
): Map<string, ProjectCardView[]> {
  const grouped = new Map<string, ProjectCardView[]>()
  for (const card of cards) {
    const group = grouped.get(card.documentId) ?? []
    group.push(card)
    grouped.set(card.documentId, group)
  }
  return grouped
}

export function groupCardsByCategory(
  cards: ProjectCardView[],
  categories: SynthesisCategory[]
): Map<string, ProjectCardView[]> {
  const grouped = new Map<string, ProjectCardView[]>(
    categories.map((category) => [category.id, []])
  )
  const defaultCategoryId = categories.find((category) => category.isDefault)?.id ?? null
  for (const card of cards) {
    const categoryId = card.categoryId ?? defaultCategoryId
    if (!categoryId) continue
    const group = grouped.get(categoryId) ?? []
    group.push(card)
    grouped.set(categoryId, group)
  }
  return grouped
}

export interface OutlineWorkspaceIndexes {
  cardsById: Map<string, ProjectCardView>
  nodesById: Map<string, OutlineNode>
  linksByNodeId: Map<string, OutlineCardLink[]>
  linkedCardIdsByNodeId: Map<string, Set<string>>
  usageTitlesByCardId: Map<string, string[]>
}

export function buildOutlineWorkspaceIndexes(
  nodes: OutlineNode[],
  cards: ProjectCardView[],
  links: OutlineCardLink[]
): OutlineWorkspaceIndexes {
  const cardsById = new Map(cards.map((card) => [card.id, card]))
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const linksByNodeId = new Map<string, OutlineCardLink[]>()
  const linkedCardIdsByNodeId = new Map<string, Set<string>>()
  const usageTitlesByCardId = new Map<string, string[]>()

  for (const link of links) {
    const nodeLinks = linksByNodeId.get(link.outlineNodeId) ?? []
    nodeLinks.push(link)
    linksByNodeId.set(link.outlineNodeId, nodeLinks)

    const linkedIds = linkedCardIdsByNodeId.get(link.outlineNodeId) ?? new Set<string>()
    linkedIds.add(link.projectCardId)
    linkedCardIdsByNodeId.set(link.outlineNodeId, linkedIds)

    const nodeTitle = nodesById.get(link.outlineNodeId)?.title
    if (nodeTitle) {
      const titles = usageTitlesByCardId.get(link.projectCardId) ?? []
      titles.push(nodeTitle)
      usageTitlesByCardId.set(link.projectCardId, titles)
    }
  }

  return {
    cardsById,
    nodesById,
    linksByNodeId,
    linkedCardIdsByNodeId,
    usageTitlesByCardId
  }
}
