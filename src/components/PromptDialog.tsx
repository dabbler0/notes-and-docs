import { useEffect, useRef, useState } from 'preact/hooks'
import { Modal } from './Modal'
import { subscribePrompt, type PendingPrompt } from '../lib/prompt'

/**
 * Renders whatever `promptDialog()` (lib/prompt.ts) currently has
 * pending, or nothing at all — mount this once, near the app's own root
 * (see App.tsx, right alongside `ConfirmHost`), not per-feature.
 */
export function PromptHost() {
  const [pending, setPending] = useState<PendingPrompt | null>(null)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => subscribePrompt(setPending), [])

  // Seeds the input from this prompt's own defaultValue each time a *new*
  // one opens — keyed off `pending` itself (a fresh object every call)
  // rather than running on every render, so typing doesn't get stomped
  // back to the default on some unrelated re-render while this is open.
  useEffect(() => {
    setValue(pending?.options.defaultValue ?? '')
  }, [pending])

  useEffect(() => {
    if (pending) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [pending])

  if (!pending) return null
  const { message, options, resolve } = pending

  return (
    <Modal onClose={() => resolve(null)}>
      <p style={{ margin: '0 0 10px', whiteSpace: 'pre-wrap' }}>{message}</p>
      <div className="field">
        <input
          ref={inputRef}
          value={value}
          placeholder={options.placeholder}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') resolve(value)
          }}
        />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={() => resolve(null)}>
          {options.cancelLabel ?? 'Cancel'}
        </button>
        <button className="btn btn-primary" onClick={() => resolve(value)}>
          {options.confirmLabel ?? 'OK'}
        </button>
      </div>
    </Modal>
  )
}
