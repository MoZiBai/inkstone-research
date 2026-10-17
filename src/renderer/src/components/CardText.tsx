import type { ProjectCardView } from '@shared/types'

export function CardText({ card, compact = false }: { card: ProjectCardView; compact?: boolean }): React.JSX.Element {
  return <div className={`card-text ${compact ? 'compact' : ''}`}>
    {card.comment ? <div className="card-text-thought"><span>我的笔记</span><p>{card.comment}</p></div> : null}
    <div className="card-text-quote"><span>原文摘录</span><blockquote>{card.displayText}</blockquote></div>
  </div>
}
