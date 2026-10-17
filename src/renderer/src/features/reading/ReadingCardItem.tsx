import { useState } from 'react'
import { FilePenLine, FileText } from 'lucide-react'
import type { ProjectCardView } from '@shared/types'
import { CardText } from '../../components/CardText'

export function ReadingCardItem({ card, currentPage = false, onLocate, onEdit }: {
  card: ProjectCardView
  currentPage?: boolean
  onLocate: () => void
  onEdit: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return <article className={`reading-card-item ${currentPage ? 'current-page' : ''}`}>
    <button type="button" className="reading-reference-item" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className="reading-reference-page">{card.pdfPage ?? '—'}</span>
      <span>
        <CardText card={card} compact={!expanded} />
        <small>{expanded ? '收起全文' : '展开完整笔记与摘录'}</small>
      </span>
    </button>
    <div className="reading-card-actions">
      <button type="button" onClick={onLocate}><FileText size={13} />查看原文</button>
      <button type="button" onClick={onEdit}><FilePenLine size={13} />编辑卡片</button>
    </div>
  </article>
}
