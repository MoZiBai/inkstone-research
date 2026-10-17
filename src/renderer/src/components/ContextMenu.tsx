import { useLayoutEffect, useEffect, useRef, useState } from 'react'

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
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - (rect?.width ?? 228) - 8)), top: Math.max(8, Math.min(y, window.innerHeight - (rect?.height ?? 80) - 8)) })
  }, [x, y, items.length])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let restoreFocus = true
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      restoreFocus = false
      closeRef.current()
    }
    const close = (): void => { restoreFocus = false; closeRef.current() }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault()
        else restoreFocus = false
        closeRef.current()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      const index = buttons.findIndex((button) => button === document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', closeOnEscape)
      if (restoreFocus && previousFocus?.isConnected && (!document.activeElement || document.activeElement === document.body || menuRef.current?.contains(document.activeElement))) previousFocus.focus({ preventScroll: true })
    }
  }, [])


  return (
    <div
      ref={menuRef}
      className="app-context-menu"
      style={position}
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
