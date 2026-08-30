import { X } from 'lucide-react'
import type { ReactNode } from 'react'

interface ModalProps {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
  width?: 'small' | 'medium' | 'large'
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  width = 'medium'
}: ModalProps): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`modal-card modal-${width}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </section>
    </div>
  )
}

interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  dangerous?: boolean
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  dangerous = false
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <Modal title={title} onClose={onCancel} width="small">
      <p className="confirm-description">{description}</p>
      <div className="modal-actions">
        <button className="button ghost" type="button" onClick={onCancel}>
          取消
        </button>
        <button
          className={`button ${dangerous ? 'danger' : 'primary'}`}
          type="button"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
