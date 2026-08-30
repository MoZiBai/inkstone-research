import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: React.ReactNode
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={24} strokeWidth={1.6} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}
