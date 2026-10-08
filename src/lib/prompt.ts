/**
 * A drop-in, promise-based replacement for `window.prompt()` — same
 * "await it, get the entered string or null back" call shape at every
 * site that used to block on the browser's own native prompt, but
 * rendered as an ordinary `Modal` (PromptDialog.tsx) that picks up this
 * app's own fonts, colors, and dark/light theming instead of whatever the
 * OS/browser chrome looks like. See `lib/confirm.ts`'s own doc comment —
 * same shape, one module-level pending-request slot plus a subscribe
 * function, `PromptHost` the one thing that actually renders it.
 *
 * Resolves to `null` on Cancel, exactly like `window.prompt()` — unlike
 * the native dialog, Cancel here is unambiguous (a real modal always has
 * the option to represent "nothing entered" distinctly from "cancelled"
 * — `window.prompt()` returning `null` for *both* no longer needs working
 * around at the call site).
 */
export interface PromptOptions {
  /** Pre-fills the input — the native dialog's own third argument. */
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
}

interface PendingPrompt {
  message: string
  options: PromptOptions
  resolve: (value: string | null) => void
}

let pending: PendingPrompt | null = null
const listeners = new Set<(req: PendingPrompt | null) => void>()

function notify() {
  for (const listener of listeners) listener(pending)
}

/**
 * Shows the prompt modal and resolves to the entered text, or `null` if
 * cancelled — `const title = await promptDialog('Title?')` is the direct
 * replacement for `const title = prompt('Title?')`. Only one prompt can
 * be pending at a time, same as the confirm dialog right next to this.
 */
export function promptDialog(message: string, options: PromptOptions = {}): Promise<string | null> {
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

/** Subscribes to the currently-pending prompt (null when none is showing), firing immediately with the current value. Returns an unsubscribe function. */
export function subscribePrompt(listener: (req: PendingPrompt | null) => void): () => void {
  listeners.add(listener)
  listener(pending)
  return () => listeners.delete(listener)
}

export type { PendingPrompt }
