import type { OutlineNode } from '@shared/types'

export interface FlatOutlineNode {
  node: OutlineNode
  depth: number
  number: string
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
  const appendNode = (node: OutlineNode, depth: number, number: string): void => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    result.push({ node, depth, number })
    if (collapsedNodeIds.has(node.id)) hideDescendants(node.id)
    else append(node.id, depth + 1, `${number}.`)
  }
  const append = (parentId: string | null, depth: number, prefix: string): void => {
    for (const [index, node] of (children.get(parentId) ?? []).entries()) {
      appendNode(node, depth, `${prefix}${index + 1}`)
    }
  }
  append(null, 0, '')

  let orphanIndex = (children.get(null) ?? []).length + 1
  for (const node of nodes) {
    if (visited.has(node.id)) continue
    appendNode(node, 0, String(orphanIndex))
    orphanIndex += 1
  }
  return result
}
