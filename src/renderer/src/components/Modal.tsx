import { X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const modalStack: HTMLElement[] = []

interface ModalProps {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
  width?: 'small' | 'medium' | 'large'
  hasUnsavedChanges?: boolean
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  width = 'medium',
  hasUnsavedChanges = false
}: ModalProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  const dirtyRef = useRef(hasUnsavedChanges)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const confirmingDiscardRef = useRef(confirmingDiscard)
  closeRef.current = onClose
  dirtyRef.current = hasUnsavedChanges
  confirmingDiscardRef.current = confirmingDiscard

  const requestClose = useCallback((): void => {
    if (dirtyRef.current) setConfirmingDiscard(true)
    else closeRef.current()
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalStack.push(dialog)
    const focusFrame = window.requestAnimationFrame(() => {
      const target =
        dialog.querySelector<HTMLElement>('[autofocus]') ??
        dialog.querySelector<HTMLElement>(
          'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ;(target ?? dialog).focus()
    })

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (modalStack.at(-1) !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (confirmingDiscardRef.current) setConfirmingDiscard(false)
        else requestClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusScope = confirmingDiscardRef.current
        ? dialog.querySelector<HTMLElement>('.modal-discard-card') ?? dialog
        : dialog
      const focusable = Array.from(
        focusScope.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.offsetParent !== null)
      if (focusable.length === 0) {
        event.preventDefault()
        focusScope.focus()
        return
      }
      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      const index = modalStack.lastIndexOf(dialog)
      if (index >= 0) modalStack.splice(index, 1)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [requestClose])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={requestClose}>
      <section
        ref={dialogRef}
        className={`modal-card modal-${width}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-unsaved={hasUnsavedChanges ? 'true' : undefined}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onClickCapture={(event) => {
          if (!(event.target instanceof Element) || !event.target.closest('[data-modal-close]')) return
          event.preventDefault()
          event.stopPropagation()
          requestClose()
        }}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="icon-button" type="button" onClick={requestClose} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
        {confirmingDiscard ? (
          <div className="modal-discard-shield" role="alertdialog" aria-modal="true" aria-label="放弃未保存的修改？">
            <div className="modal-discard-card">
              <h3>放弃未保存的修改？</h3>
              <p>当前表单已经修改。继续关闭会丢失尚未保存的内容。</p>
              <div className="modal-actions">
                <button className="button ghost" type="button" autoFocus onClick={() => setConfirmingDiscard(false)}>
                  继续编辑
                </button>
                <button className="button danger" type="button" onClick={() => closeRef.current()}>
                  放弃修改
                </button>
              </div>
            </div>
          </div>
        ) : null}
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
        <button className="button ghost" type="button" data-modal-close>
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
