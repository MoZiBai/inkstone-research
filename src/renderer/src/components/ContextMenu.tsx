import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
  onSelect: () => void
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  ariaLabel: string
  onClose: () => void
}

export function ContextMenu({
  x,
  y,
  items,
  ariaLabel,
  onClose
}: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      onClose()
    }
    const close = (): void => onClose()
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  const left = Math.max(8, Math.min(x, window.innerWidth - 228))
  const top = Math.max(8, Math.min(y, window.innerHeight - Math.max(80, items.length * 36 + 16)))

  return (
    <div
      ref={menuRef}
      className="app-context-menu"
      style={{ left, top }}
      role="menu"
      aria-label={ariaLabel}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {items.map((item) => (
        <button
          className={`${item.danger ? 'danger' : ''} ${item.separatorBefore ? 'separator-before' : ''}`}
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
        >
          <span>{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  )
}
