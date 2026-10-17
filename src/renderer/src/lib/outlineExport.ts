import type { WorkspaceSnapshot } from '@shared/types'
import { flattenOutline } from './outline'
import { buildOutlineWorkspaceIndexes } from './workspaceCollections'

// Exports saved content, independently of the current filters and collapsed nodes.
export function outlineToMarkdown(snapshot: WorkspaceSnapshot): string {
  const project = snapshot.projects.find((item) => item.id === snapshot.currentProjectId)
  const lines = [`# ${headingText(project?.name ?? '写作提纲')}`, '']
  const indexes = buildOutlineWorkspaceIndexes(snapshot.outlineNodes, snapshot.cards, snapshot.outlineLinks)
  for (const { node, depth, number } of flattenOutline(snapshot.outlineNodes)) {
    lines.push(`${'#'.repeat(Math.min(depth + 2, 6))} ${number} ${headingText(node.title)}`, '')
    for (const [label, value] of [['核心论点', node.coreArgument], ['写作说明', node.notes], ['待解决问题', node.openQuestions]]) {
      if (value?.trim()) lines.push(`**${label}**`, '', value, '')
    }
    const links = [...(indexes.linksByNodeId.get(node.id) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)
    for (const link of links) {
      const card = indexes.cardsById.get(link.projectCardId)
      if (!card) continue
      lines.push('---', '')
      if (card.comment.trim()) lines.push('**我的笔记**', '', card.comment, '')
      lines.push('**原文摘录**', '', ...card.displayText.split(/\r?\n/).map((line) => `> ${line}`), '')
      const source = [card.documentTitle, card.documentAuthors, card.documentYear?.toString(),
        card.printPage ? `印刷第 ${card.printPage} 页` : '', card.pdfPage ? `PDF 第 ${card.pdfPage} 页` : ''].filter(Boolean)
      lines.push(`来源：${source.map((part) => headingText(part as string)).join(' · ')}`, '')
      if (link.note.trim()) lines.push('**本节使用说明**', '', link.note, '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function headingText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&')
}
