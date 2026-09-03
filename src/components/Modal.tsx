import type { ComponentChildren } from 'preact'

export function Modal({ onClose, wide, children }: { onClose: () => void; wide?: boolean; children: ComponentChildren }) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={`modal${wide ? ' wide' : ''}`}>{children}</div>
    </div>
  )
}
