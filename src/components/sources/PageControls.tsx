import { useEffect, useState } from 'preact/hooks'

/** Prev/Next plus a "Page [N] of M" control shared by `PdfViewer` and
 * `TextViewer` — the number in the middle is a real input, so jumping
 * straight to a known page doesn't mean clicking Next/Prev over and over. */
export function PageControls({ page, numPages, onPageChange }: { page: number; numPages: number; onPageChange: (page: number) => void }) {
  const [inputValue, setInputValue] = useState(String(page))

  // Keep the box in sync with the real current page whenever it changes
  // from elsewhere (Prev/Next, search jumping pages, switching sources) —
  // but only while the user isn't actively mid-edit, so a page turn
  // doesn't yank the caret out of a value they're still typing.
  useEffect(() => {
    setInputValue(String(page))
  }, [page])

  function commit() {
    // Genuinely non-numeric input isn't reachable through a real
    // <input type="number"> (browsers already block typing letters into
    // one) — the practical "invalid" case is an emptied-out box — but an
    // in-range value is clamped either direction (0 up to 1, a number
    // past the end down to the last page) rather than only clamping one
    // way, so the box behaves consistently regardless of which edge was
    // overshot.
    const trimmed = inputValue.trim()
    const n = Math.trunc(Number(trimmed))
    if (trimmed !== '' && Number.isFinite(n)) {
      onPageChange(Math.min(Math.max(1, n), numPages))
    } else {
      setInputValue(String(page))
    }
  }

  return (
    <div className="pdf-controls">
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        ← Prev
      </button>
      <span className="muted pdf-page-jump">
        Page{' '}
        <input
          type="number"
          className="pdf-page-jump-input"
          min={1}
          max={numPages}
          value={inputValue}
          onInput={(e) => setInputValue((e.target as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            commit()
          }}
        />{' '}
        of {numPages}
      </span>
      <button className="btn btn-sm" disabled={page >= numPages} onClick={() => onPageChange(page + 1)}>
        Next →
      </button>
    </div>
  )
}
