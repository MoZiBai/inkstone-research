import type { DocumentGroup, DocumentSummary } from '@shared/types'

export interface DocumentGroupTreeNode {
  group: DocumentGroup
  children: DocumentGroupTreeNode[]
  documents: DocumentSummary[]
}

export function buildDocumentGroupTree(
  groups: DocumentGroup[],
  documents: DocumentSummary[],
  includeEmpty = true
): { roots: DocumentGroupTreeNode[]; unclassified: DocumentSummary[] } {
  const nodes = new Map<string, DocumentGroupTreeNode>()
  for (const group of groups) {
    nodes.set(group.id, { group, children: [], documents: [] })
  }

  const roots: DocumentGroupTreeNode[] = []
  for (const node of nodes.values()) {
    const parent = node.group.parentId ? nodes.get(node.group.parentId) : null
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }

  const unclassified: DocumentSummary[] = []
  for (const document of documents) {
    const node = document.groupId ? nodes.get(document.groupId) : null
    if (node) node.documents.push(document)
    else unclassified.push(document)
  }

  const sortNodes = (items: DocumentGroupTreeNode[]): DocumentGroupTreeNode[] => items
    .sort((first, second) => first.group.sortOrder - second.group.sortOrder || first.group.name.localeCompare(second.group.name, 'zh-CN'))
    .flatMap((node) => {
      node.children = sortNodes(node.children)
      if (!includeEmpty && node.documents.length === 0 && node.children.length === 0) return []
      return [node]
    })

  return { roots: sortNodes(roots), unclassified }
}

export function countDocumentsInGroup(node: DocumentGroupTreeNode): number {
  return node.documents.length + node.children.reduce((total, child) => total + countDocumentsInGroup(child), 0)
}

export function descendantDocumentGroupIds(groups: DocumentGroup[], groupId: string): Set<string> {
  const descendants = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const group of groups) {
      if (group.parentId === groupId || (group.parentId && descendants.has(group.parentId))) {
        if (!descendants.has(group.id)) {
          descendants.add(group.id)
          changed = true
        }
      }
    }
  }
  return descendants
}

export function flattenDocumentGroups(
  roots: DocumentGroupTreeNode[],
  depth = 0
): Array<{ group: DocumentGroup; depth: number }> {
  return roots.flatMap((node) => [
    { group: node.group, depth },
    ...flattenDocumentGroups(node.children, depth + 1)
  ])
}
