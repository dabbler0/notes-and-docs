/**
 * A drop-in, promise-based replacement for `window.confirm()` — same
 * "await it, get a boolean back" call shape at every site that used to
 * block on the browser's own native dialog, but rendered as an ordinary
 * `Modal` (ConfirmDialog.tsx) that picks up this app's own fonts, colors,
 * and dark/light theming instead of whatever the OS/browser chrome looks
 * like. `confirmDialog()` itself has no React/Preact dependency — it's
 * callable from a plain async function anywhere (a model handler, an event
 * callback) exactly like `confirm()` was — and just records the pending
 * request in this one module-level slot; `ConfirmHost`, mounted once near
 * the app's root, is the only thing that actually renders it, subscribing
 * via `subscribeConfirm` the same way a tiny external store would.
 */
export interface ConfirmOptions {
  /** Defaults to 'Confirm' — set for a request where a specific verb ("Delete", "Disconnect", "Discard changes") reads far more clearly than a generic yes/no ever could, the same reason a native `confirm()` dialog's fixed "OK" often doesn't say enough on its own. */
  confirmLabel?: string
  cancelLabel?: string
  /** Styles the confirm button as destructive (red) rather than the ordinary primary color — for anything that deletes or otherwise can't be undone, matching this app's own `.btn-danger` used elsewhere for the same kind of action. */
  danger?: boolean
}

interface PendingConfirm {
  message: string
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

let pending: PendingConfirm | null = null
const listeners = new Set<(req: PendingConfirm | null) => void>()

function notify() {
  for (const listener of listeners) listener(pending)
}

/**
 * Shows the confirmation modal and resolves to whether the user confirmed
 * — `if (!(await confirmDialog('Delete this?'))) return` is the exact
 * replacement for `if (!confirm('Delete this?')) return`. Only one
 * confirmation can be pending at a time (same as the browser's own native
 * dialog, which is modal to the whole page); a second call while one is
 * already showing replaces it rather than queuing, since nothing in this
 * app ever fires two confirmations back to back on purpose.
 */
export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    pending = {
      message,
      options,
      resolve: (value) => {
        pending = null
        notify()
        resolve(value)
      },
    }
    notify()
  })
}

/** Subscribes to the currently-pending confirmation (null when none is showing), firing immediately with the current value — the shape `ConfirmHost`'s own `useEffect` expects. Returns an unsubscribe function. */
export function subscribeConfirm(listener: (req: PendingConfirm | null) => void): () => void {
  listeners.add(listener)
  listener(pending)
  return () => listeners.delete(listener)
}

export type { PendingConfirm }
