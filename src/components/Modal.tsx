import type { ComponentChildren } from 'preact'
import { useIsMobile } from '../lib/useIsMobile'

/**
 * Every dialog in the app goes through here, which is what makes "no modals
 * on mobile — every modal is its own view instead" a one-place change: below
 * the mobile breakpoint this renders as a full-screen page (no backdrop to
 * tap through, no cramped centered card, a pinned bar standing in for "go
 * back") instead of the desktop's centered overlay.
 */
export function Modal({ onClose, wide, children }: { onClose: () => void; wide?: boolean; children: ComponentChildren }) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <div className="modal-page">
        <button className="modal-page-back" onClick={onClose}>
          ← Back
        </button>
        <div className="modal-page-content">{children}</div>
      </div>
    )
  }

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
