import type { OutlineNode } from '@shared/types'

export interface FlatOutlineNode {
  node: OutlineNode
  depth: number
}

export function flattenOutline(
  nodes: OutlineNode[],
  collapsedNodeIds: ReadonlySet<string> = new Set()
): FlatOutlineNode[] {
  const children = new Map<string | null, OutlineNode[]>()
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? []
    list.push(node)
    children.set(node.parentId, list)
  }
  for (const list of children.values()) {
    list.sort((left, right) => left.sortOrder - right.sortOrder)
  }

  const result: FlatOutlineNode[] = []
  const visited = new Set<string>()
  const hideDescendants = (parentId: string): void => {
    for (const child of children.get(parentId) ?? []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      hideDescendants(child.id)
    }
  }
  const appendNode = (node: OutlineNode, depth: number): void => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    result.push({ node, depth })
    if (collapsedNodeIds.has(node.id)) hideDescendants(node.id)
    else append(node.id, depth + 1)
  }
  const append = (parentId: string | null, depth: number): void => {
    for (const node of children.get(parentId) ?? []) {
      appendNode(node, depth)
    }
  }
  append(null, 0)

  for (const node of nodes) {
    appendNode(node, 0)
  }
  return result
}
