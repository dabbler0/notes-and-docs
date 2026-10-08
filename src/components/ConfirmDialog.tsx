import { useEffect, useState } from 'preact/hooks'
import { Modal } from './Modal'
import { subscribeConfirm, type PendingConfirm } from '../lib/confirm'

/**
 * Renders whatever `confirmDialog()` (lib/confirm.ts) currently has
 * pending, or nothing at all — mount this once, near the app's own root
 * (see App.tsx), not per-feature; every call site across the app shares
 * this one instance via the module-level store it subscribes to.
 */
export function ConfirmHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  useEffect(() => subscribeConfirm(setPending), [])

  if (!pending) return null
  const { message, options, resolve } = pending

  return (
    <Modal onClose={() => resolve(false)}>
      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{message}</p>
      <div className="modal-actions">
        <button className="btn" autoFocus onClick={() => resolve(false)}>
          {options.cancelLabel ?? 'Cancel'}
        </button>
        <button className={`btn ${options.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => resolve(true)}>
          {options.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </Modal>
  )
}
